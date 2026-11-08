// eslint-disable import/max-dependencies -- Add keeps native inventory reads on its operation-scoped runner.
import {
	CanonicalRootError,
	DuplicateBranchError,
	EXIT_CODES,
	ReservedPrefixError,
	UsageError,
	withFailureContext,
} from "../errors.ts";
import type { CommandResult, OutputMode, PoolFullPayload, ReadyAddPayload } from "../protocol.ts";
import type { PolicyExplanation, TreesConfig } from "../domain/config.ts";
import {
	addNonPoolWorktree,
	captureExistingBranchHead,
	mergeOriginIfPresent,
	prepareAddBranch,
	rollbackNonPoolAdd,
	withoutLazyFetch,
} from "./add-worktree.ts";
import { encodeBranch, worktreePathForName } from "../domain/worktree.ts";
import {
	finalizeReadyResult,
	finalizeStructuredResult,
	parseOptions,
	parseOutputMode,
	requireOption,
	toAddPayload,
} from "../protocol.ts";
import { resolveCanonicalRoot, resolveWorktreeContainingPath } from "../application/repository.ts";
import { runBootstrap, runPreRemoteCheck } from "../application/hooks.ts";
import type { Deps } from "../services.ts";
import type { Worktree } from "../domain/worktree.ts";
import { addPooledWorktree } from "./add-pool.ts";
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
	/** Permit forced pool recycling. */
	force: boolean;
	/** Permit shell/session focus. */
	interactive: boolean;
	/** Suppress Wktree-controlled network IO while retaining cached-ref policy. */
	noNetwork: boolean;
	/** Omit bootstrap while retaining copies and safety. */
	skipCommand: boolean;
	/** Output rendering mode. */
	output: OutputMode;
	/** Explicit pool slot override. */
	slotPath: string | null;
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
		if (context.explanation.project?.poolSize) {
			return addFromPool(context, context.explanation.project);
		}
		return await addStandalone(context);
	} catch (error) {
		throw withFailureContext(error, {
			branch: request.branch,
			slot_path: request.slotPath ?? undefined,
		});
	}
}
// --- Private functions ---

function optionalRef(value: string | boolean | undefined): string | null {
	if (typeof value === "string") {
		return value;
	}
	// eslint-disable-next-line unicorn/no-null -- Branch/pool application APIs model an absent override with null.
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
		force: opts.force === true,
		interactive: opts.interactive === true,
		noNetwork: opts["no-network"] === true,
		skipCommand: opts["skip-command"] === true,
		output: parseOutputMode(opts),
		slotPath: optionalRef(opts.slot),
	};
	if (request.baseCurrent && request.base !== null) {
		throw new UsageError("--base-current cannot be combined with --base");
	}
	if (branch.startsWith("wk-pool/")) {
		throw new ReservedPrefixError("branch names starting with wk-pool/ are reserved");
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
	const { deps, explanation, request, root } = context;
	const worktrees = await listWorktrees(deps.git, root);
	const existing = worktrees.find((worktree) => worktree.branch === request.branch);
	if (existing) {
		throw new DuplicateBranchError(
			`branch ${request.branch} is already checked out at ${existing.path}`,
		);
	}
	const base = resolveRequestedBase(request, worktrees, deps);
	if (request.slotPath && !explanation.project?.poolSize) {
		throw new UsageError("--slot is only valid for pooled projects");
	}
	return base;
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
			pooled: false,
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
	await addNonPoolWorktree({
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
		await rollbackNonPoolAdd({
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

function finalizeAdd(
	context: AddContext,
	payload: ReadyAddPayload | PoolFullPayload,
): CommandResult {
	if (payload.kind === "pool_full") {
		return finalizeStructuredResult(payload, context.request.output, EXIT_CODES.BLOCKED);
	}
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

async function addStandalone(context: AddContext): Promise<CommandResult> {
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

async function addFromPool(
	context: AddContext,
	project: NonNullable<PolicyExplanation["project"]>,
): Promise<CommandResult> {
	const { base, config, deps, explanation, request, root } = context;
	const payload = await addPooledWorktree({
		base,
		branch: request.branch,
		command: explanation.command.command,
		config,
		deps,
		force: request.force,
		interactive: request.interactive,
		json: request.output.json,
		noNetwork: request.noNetwork,
		skipCommand: request.skipCommand,
		project,
		root,
		slotPath: request.slotPath,
		worktreeLocation: explanation.worktreeLocation,
	});
	return finalizeAdd(context, payload);
}
