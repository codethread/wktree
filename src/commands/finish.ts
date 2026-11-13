// eslint-disable import/max-dependencies -- Finish still combines native inventory reads with lifecycle services.
import {
	BlockedError,
	CanonicalRootError,
	UnsafeOperationError,
	UsageError,
	WktreeError,
	withFailureContext,
} from "../errors.ts";
import type { CommandResult, OutputMode } from "../protocol.ts";
import type { FinishStrategy, PolicyExplanation, TreesConfig } from "../domain/config.ts";
import {
	assertCleanSource,
	assertFinishTargetReady,
	integrateSource,
	parseIntegrationPlan,
	prepareSourceIntegration,
} from "./finish-integration.ts";
import { finalizeReadyResult, parseOptions, parseOutputMode, requireOption } from "../protocol.ts";
import type { Deps } from "../services.ts";
import type { IntegrationPlan } from "./finish-integration.ts";
import type { Worktree } from "../domain/worktree.ts";
import { detectOriginDefaultBranch } from "../application/branches.ts";
import { listWorktrees } from "../git/worktrees.ts";
import { pushAndCleanup } from "./finish-cleanup.ts";
import { resolveWorktreeContainingPath } from "../application/repository.ts";
import { runPreRemoteCheck } from "../application/hooks.ts";

type FinishPolicyPlan = PolicyExplanation["finishPolicy"];

interface FinishRequest {
	/** Checkout the caller is working from. */
	cwd: string;
	/** Whether the invocation may hand the shell to the canonical worktree first. */
	interactive: boolean;
	/** Requested output rendering. */
	output: OutputMode;
	/** Raw --title value; the squash plan validates it. */
	title: string | boolean | undefined;
	/** Raw --body value; the squash plan validates it. */
	body: string | boolean | undefined;
}

interface FinishState {
	/** Cleanup steps completed and reported in failure context. */
	cleanupActions: string[];
	/** Whether source changes reached the target branch. */
	integrated: boolean;
	/** Source branch observed during resolution, when reached. */
	sourceBranch: string | undefined;
	/** Source worktree path observed during resolution, when reached. */
	worktreePath: string | undefined;
}

interface FinishSourceInfo {
	/** First worktree in Git's listing. */
	canonical: Worktree;
	/** Loaded repository configuration. */
	config: TreesConfig;
	/** Resolved policy for the canonical root. */
	explanation: PolicyExplanation;
	/** Source worktree selected by cwd. */
	source: Worktree;
	/** Checked-out source branch. */
	sourceBranch: string;
}

interface FinishTargetInfo {
	/** Validated cleanup and integration policy. */
	plan: FinishPolicyPlan;
	/** Origin default branch name. */
	targetBranch: string;
	/** Immutable target commit checked before canonical advancement. */
	targetRef: string;
}

export async function finishCommand(args: string[], deps: Deps): Promise<CommandResult> {
	const request = parseFinishRequest(args);
	const state: FinishState = {
		cleanupActions: [],
		integrated: false,
		sourceBranch: undefined,
		worktreePath: undefined,
	};
	try {
		return await executeFinish(request, deps, state);
	} catch (error) {
		throw withFailureContext(error, {
			branch: state.sourceBranch,
			cleanup_actions: state.cleanupActions,
			integrated: state.integrated,
			worktree_path: state.worktreePath,
		});
	}
}
// --- Private functions ---

function parseFinishRequest(args: string[]): FinishRequest {
	const opts = parseOptions(args);
	const cwd = requireOption(opts, "cwd");
	for (const key of Object.keys(opts)) {
		if (
			key !== "cwd" &&
			key !== "json" &&
			key !== "interactive" &&
			key !== "title" &&
			key !== "body"
		) {
			throw new UsageError(`unknown option --${key}`);
		}
	}
	return {
		body: opts.body,
		cwd,
		interactive: opts.interactive === true,
		output: parseOutputMode(opts),
		title: opts.title,
	};
}

function resolveSourceWorktree(options: {
	canonical: Worktree;
	cwd: string;
	deps: Deps;
	state: FinishState;
	worktrees: Worktree[];
}): { source: Worktree; sourceBranch: string } {
	const source = resolveWorktreeContainingPath(options.worktrees, options.cwd, options.deps.files);
	if (!source) {
		throw new UsageError(`no worktree contains cwd: ${options.cwd}`);
	}
	options.state.worktreePath = source.path;
	if (
		options.deps.files.normalizePath(source.path) ===
		options.deps.files.normalizePath(options.canonical.path)
	) {
		throw new CanonicalRootError("refusing to finish from canonical root");
	}
	if (!source.branch) {
		throw new UsageError("finish requires a source worktree checked out on a branch");
	}
	options.state.sourceBranch = source.branch;
	return { source, sourceBranch: source.branch };
}

async function resolveFinishSource(
	request: FinishRequest,
	deps: Deps,
	state: FinishState,
): Promise<FinishSourceInfo> {
	const worktrees = await listWorktrees(deps.git, request.cwd);
	const canonical = worktrees.find((worktree) => worktree.canonical);
	if (!canonical) {
		throw new WktreeError("couldn't determine canonical worktree");
	}
	const config = deps.config.read(canonical.path);
	const { source, sourceBranch } = resolveSourceWorktree({
		canonical,
		cwd: request.cwd,
		deps,
		state,
		worktrees,
	});
	const explanation = deps.config.explain(config, canonical.path);
	return { canonical, config, explanation, source, sourceBranch };
}

function resolveFinishPolicy(explanation: PolicyExplanation): FinishPolicyPlan {
	const { finishPolicy } = explanation;
	if (!finishPolicy.enabled) {
		throw new BlockedError("finish is disabled for this repository");
	}
	const { deleteBranch, removeWorktree } = finishPolicy;
	if (deleteBranch && !removeWorktree) {
		throw new UnsafeOperationError(
			"cannot delete source branch while its worktree remains checked out; enable remove_worktree cleanup",
		);
	}
	return finishPolicy;
}

async function prepareFinishTarget(
	source: FinishSourceInfo,
	deps: Deps,
): Promise<FinishTargetInfo> {
	await runPreRemoteCheck(deps, {
		config: source.config,
		operation: "wktree finish",
		root: source.canonical.path,
	});
	const plan = resolveFinishPolicy(source.explanation);
	await assertCleanSource(deps.git, source.source);
	await deps.git.run(["-C", source.canonical.path, "fetch", "origin"]);
	const targetBranch = await detectOriginDefaultBranch(deps.git, source.canonical.path);
	const readyRef = await assertFinishTargetReady({
		git: deps.git,
		policy: source.explanation.addPolicy,
		root: source.canonical.path,
		targetBranch,
	});
	const targetCommit = await deps.git.run([
		"-C",
		source.canonical.path,
		"rev-parse",
		"--verify",
		`${readyRef}^{commit}`,
	]);
	const targetRef = targetCommit.stdout.trim();
	return { plan, targetBranch, targetRef };
}

function readyFinishResult(options: {
	afterOutput: (() => Promise<void>) | undefined;
	cleanupActions: string[];
	output: OutputMode;
	root: string;
	sourceBranch: string;
	sourcePath: string;
	strategy: FinishStrategy;
	targetBranch: string;
}): CommandResult {
	const payload = {
		cleanup_actions: options.cleanupActions,
		kind: "ready",
		root: options.root,
		source_branch: options.sourceBranch,
		strategy: options.strategy,
		target_branch: options.targetBranch,
		worktree_path: options.sourcePath,
	};
	return finalizeReadyResult({
		afterOutput: options.afterOutput,
		output: options.output,
		payload,
		summary: `wktree: finished ${payload.source_branch} into ${payload.target_branch}`,
	});
}

async function executeFinish(
	request: FinishRequest,
	deps: Deps,
	state: FinishState,
): Promise<CommandResult> {
	const source = await resolveFinishSource(request, deps, state);
	const integration = parseIntegrationPlan(
		source.explanation.finishPolicy.strategy,
		request.title,
		request.body,
	);
	const target = await prepareFinishTarget(source, deps);
	await integratePreparedSource({ source, target, integration, deps });
	state.integrated = true;
	const afterOutput = await pushAndCleanup({
		cleanupActions: state.cleanupActions,
		deps,
		plan: target.plan,
		request,
		root: source.canonical.path,
		source: source.source,
		targetBranch: target.targetBranch,
	});
	return readyFinishResult({
		afterOutput,
		cleanupActions: state.cleanupActions,
		output: request.output,
		root: source.canonical.path,
		sourceBranch: source.sourceBranch,
		sourcePath: source.source.path,
		strategy: target.plan.strategy,
		targetBranch: target.targetBranch,
	});
}

async function integratePreparedSource(options: {
	source: FinishSourceInfo;
	target: FinishTargetInfo;
	integration: IntegrationPlan;
	deps: Deps;
}): Promise<void> {
	const { source, target, integration, deps } = options;
	const integrationOptions = {
		canonicalPath: source.canonical.path,
		git: deps.git,
		sourceBranch: source.sourceBranch,
		sourcePath: source.source.path,
		targetBranch: target.targetBranch,
		targetRef: target.targetRef,
	};
	await prepareSourceIntegration(integrationOptions, integration);
	if (source.explanation.addPolicy === "fresh_canonical") {
		await deps.git.run(["-C", source.canonical.path, "merge", "--ff-only", target.targetRef]);
	}
	await integrateSource(integrationOptions, integration);
}
