// eslint-disable import/max-dependencies -- Add keeps native inventory reads on its operation-scoped runner.
import {
	CanonicalRootError,
	DuplicateBranchError,
	UsageError,
	withFailureContext,
} from "../errors.ts";
import type { CommandResult, OutputMode, ReadyAddPayload } from "../protocol.ts";
import type { PolicyExplanation, TreesConfig } from "../domain/config.ts";
import {
	addWorktree,
	captureExistingBranchHead,
	mergeOriginIfPresent,
	prepareAddBranch,
	rollbackAdd,
	withoutLazyFetch,
} from "./add-worktree.ts";
import { encodeBranch, worktreePathForName } from "../domain/worktree.ts";
import {
	finalizeReadyResult,
	parseOptions,
	parseOutputMode,
	requireOption,
	toAddPayload,
} from "../protocol.ts";
import { resolveCanonicalRoot, resolveWorktreeContainingPath } from "../application/repository.ts";
import { runBootstrap, runPreRemoteCheck } from "../application/hooks.ts";
import type { Deps } from "../services.ts";
import type { Worktree } from "../domain/worktree.ts";
import { focusWorktree } from "../application/interactive.ts";
import { listWorktrees } from "../git/worktrees.ts";
import { projectNameFor } from "../domain/config.ts";

interface AddRequest {
	/** Explicit starting ref or no override. */
	base: string | null;
	/** Select the branch containing cwd as the starting ref. */
	baseCurrent: boolean;
	/** Requested branch. */
	branch: string;
	/** Caller checkout. */
	cwd: string;
	/** Permit shell/session focus. */
	interactive: boolean;
	/** Suppress Wktree-controlled network IO while retaining cached-ref policy. */
	noNetwork: boolean;
	/** Omit bootstrap while retaining copies and safety. */
	skipCommand: boolean;
	/** Output rendering mode. */
	output: OutputMode;
}
interface AddContext {
	/** Resolved starting ref. */
	base: string | null;
	/** Loaded configuration. */
	config: TreesConfig;
	/** Injected command services. */
	deps: Deps;
	/** Canonical-root policy. */
	explanation: PolicyExplanation;
	/** Parsed CLI request. */
	request: AddRequest;
	/** Canonical repository root. */
	root: string;
}
type Checkout = Awaited<ReturnType<typeof prepareCheckout>>;

export async function addCommand(args: string[], deps: Deps): Promise<CommandResult> {
	const request = parseAddRequest(args);
	try {
		let operationDeps = deps;
		if (request.noNetwork) {
			operationDeps = { ...deps, git: withoutLazyFetch(deps.git) };
		}
		const context = await prepareAdd(request, operationDeps);
		return await addCheckout(context);
	} catch (error) {
		throw withFailureContext(error, {
			branch: request.branch,
		});
	}
}
// --- Private functions ---

function optionalRef(value: string | boolean | undefined): string | null {
	if (typeof value === "string") {
		return value;
	}
	// eslint-disable-next-line unicorn/no-null -- Branch application APIs model an absent override with null.
	return null;
}

function parseAddRequest(args: string[]): AddRequest {
	const opts = parseOptions(args);
	const cwd = requireOption(opts, "cwd");
	const branch = requireOption(opts, "branch");
	const request = {
		base: optionalRef(opts.base),
		baseCurrent: opts["base-current"] === true,
		branch,
		cwd,
		interactive: opts.interactive === true,
		noNetwork: opts["no-network"] === true,
		skipCommand: opts["skip-command"] === true,
		output: parseOutputMode(opts),
	};
	if (request.baseCurrent && request.base !== null) {
		throw new UsageError("--base-current cannot be combined with --base");
	}
	return request;
}

function resolveRequestedBase(
	request: AddRequest,
	worktrees: Worktree[],
	deps: Deps,
): string | null {
	if (!request.baseCurrent) {
		return request.base;
	}
	const current = resolveWorktreeContainingPath(worktrees, request.cwd, deps.files);
	if (!current?.branch) {
		throw new UsageError("--base-current requires the worktree containing --cwd to be on a branch");
	}
	return current.branch;
}

async function inspectAddTarget(context: AddContext): Promise<string | null> {
	const { deps, request, root } = context;
	const worktrees = await listWorktrees(deps.git, root);
	const existing = worktrees.find((worktree) => worktree.branch === request.branch);
	if (existing) {
		throw new DuplicateBranchError(
			`branch ${request.branch} is already checked out at ${existing.path}`,
		);
	}
	return resolveRequestedBase(request, worktrees, deps);
}

async function prepareAdd(request: AddRequest, deps: Deps): Promise<AddContext> {
	const root = await resolveCanonicalRoot(deps.git, request.cwd);
	const config = deps.config.read(root);
	const explanation = deps.config.explain(config, root);
	const context = { base: request.base, config, deps, explanation, request, root };
	context.base = await inspectAddTarget(context);
	await prepareAddHooks(context);
	return context;
}

async function prepareAddHooks(context: AddContext): Promise<void> {
	const { config, deps, request, root } = context;
	if (request.noNetwork) {
		deps.progress.banner(
			"wktree: --no-network: using cached/local refs; remote checks and fetch skipped",
		);
	} else {
		await runPreRemoteCheck(deps, { config, operation: "wktree add", root });
	}
	if (request.skipCommand) {
		deps.progress.banner(
			"wktree: --skip-command: configured bootstrap skipped; copy setup retained",
		);
	}
}

async function prepareCheckout(context: AddContext) {
	const { base, config, deps, explanation, request, root } = context;
	const worktreePath = worktreePathForName(
		root,
		encodeBranch(request.branch),
		explanation.worktreeLocation,
	);
	if (deps.files.normalizePath(worktreePath) === deps.files.normalizePath(root)) {
		throw new CanonicalRootError("refusing to use canonical root as worktree target");
	}
	const { base: startBase, branchState } = await prepareAddBranch({
		base,
		branch: request.branch,
		config,
		deps,
		noNetwork: request.noNetwork,
		root,
	});
	const originalBranchHead = await captureExistingBranchHead({
		branch: request.branch,
		branchState,
		git: deps.git,
		root,
	});
	return { ...context, base: startBase, branchState, originalBranchHead, worktreePath };
}

async function populateCheckout(checkout: Checkout): Promise<void> {
	const { deps, explanation, request, root, worktreePath } = checkout;
	await mergeOriginIfPresent({
		branch: request.branch,
		git: deps.git,
		progress: deps.progress,
		worktreePath,
	});
	if (explanation.project) {
		await deps.files.copy({
			root,
			target: worktreePath,
			entries: explanation.project.copy,
			git: deps.git,
		});
	}
	if (!request.skipCommand && explanation.command.command) {
		await runBootstrap(deps, {
			command: explanation.command.command,
			created: worktreePath,
			projectName: projectNameFor(explanation.project, root),
			root,
		});
	}
}

async function createCheckout(checkout: Checkout): Promise<void> {
	const { base, branchState, deps, explanation, originalBranchHead, request, root, worktreePath } =
		checkout;
	await deps.files.prepareParent({
		root,
		path: worktreePath,
		location: explanation.worktreeLocation,
		git: deps.git,
	});
	await addWorktree({
		base,
		branch: request.branch,
		git: deps.git,
		path: worktreePath,
		progress: deps.progress,
		root,
		state: branchState,
	});
	try {
		await populateCheckout(checkout);
	} catch (error) {
		await rollbackAdd({
			branch: request.branch,
			branchState,
			git: deps.git,
			originalBranchHead,
			root,
			worktreePath,
		});
		throw error;
	}
}

function finalizeAdd(context: AddContext, payload: ReadyAddPayload): CommandResult {
	let afterOutput: (() => Promise<void>) | undefined = undefined;
	if (context.request.interactive) {
		afterOutput = () =>
			focusWorktree(context.deps, { path: payload.worktree_path, title: payload.title });
	}
	return finalizeReadyResult({
		afterOutput,
		output: context.request.output,
		payload,
		summary: `wktree: added ${payload.branch} at ${payload.worktree_path}`,
	});
}

async function addCheckout(context: AddContext): Promise<CommandResult> {
	const checkout = await prepareCheckout(context);
	await createCheckout(checkout);
	const { branchState, originalBranchHead, request, root, worktreePath } = checkout;
	const payload = toAddPayload({
		branch: request.branch,
		createdNewBranch: branchState === "none" || branchState === "remote",
		rollbackBranchHead: originalBranchHead,
		root,
		title: request.branch,
		worktreePath,
	});
	return finalizeAdd(context, payload);
}
