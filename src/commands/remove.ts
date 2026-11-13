/* eslint-disable import/max-dependencies -- Route local proof cleanup alongside the existing lifecycle command. */
import type { CommandResult, OutputMode } from "../protocol.ts";
import { UsageError, WktreeError, withFailureContext } from "../errors.ts";
import {
	assertBranchIntegratedInto,
	assertBranchSafelyDeletable,
} from "../application/branches.ts";
import {
	finalizeReadyResult,
	parseOptions,
	parseOutputMode,
	requireOption,
	toRemovePayload,
} from "../protocol.ts";
import type { Deps } from "../services.ts";
import type { TreesConfig } from "../domain/config.ts";
import type { Worktree } from "../domain/worktree.ts";
import { listWorktrees } from "../git/worktrees.ts";
import { planLeaveWorktree } from "../application/interactive.ts";
import { removeLocalCommand } from "./remove-local.ts";
import { resolveRemoveTarget } from "../application/repository.ts";
import { runPreRemoteCheck } from "../application/hooks.ts";

interface RemoveRequest {
	/** Branch selected with --branch, when not using --self. */
	branch: string | null;
	/** Checkout the caller is working from. */
	cwd: string;
	/** Whether safety checks are skipped for a forced removal. */
	force: boolean;
	/** Origin-tracking ref that must contain the branch, when supplied. */
	integratedInto: string | null;
	/** Whether the invocation may hand the shell to another worktree first. */
	interactive: boolean;
	/** Whether the checked-out branch is retained. */
	keepBranch: boolean;
	/** Requested output rendering. */
	output: OutputMode;
	/** Whether the worktree containing cwd is the removal target. */
	self: boolean;
}

interface RemoveContext {
	/** First worktree in Git's listing. */
	canonical: Worktree;
	/** Loaded repository configuration. */
	config: TreesConfig;
	/** Worktrees observed before removal. */
	worktrees: Worktree[];
}

interface RemoveOperation {
	/** Service boundary for the command invocation. */
	deps: Deps;
	/** Validated command-line request. */
	request: RemoveRequest;
	/** Repository state observed before removal. */
	context: RemoveContext;
	/** Worktree selected for removal. */
	target: Worktree;
}

export function removeCommand(args: string[], deps: Deps): Promise<CommandResult> {
	if (args.includes("--integrated-into-local")) {
		return removeLocalCommand(args, deps);
	}
	return removeStandardCommand(args, deps);
}

async function removeStandardCommand(args: string[], deps: Deps): Promise<CommandResult> {
	const request = parseRemoveRequest(args);
	let targetPath: string | undefined = undefined;
	try {
		const context = await resolveRemoveContext(request, deps);
		await runRemovalPreflight(request, deps, context);
		const target = resolveRemoveTarget({
			canonicalRoot: context.canonical.path,
			cwd: request.cwd,
			files: deps.files,
			selector: { branch: request.branch, self: request.self },
			worktrees: context.worktrees,
		});
		targetPath = target.path;
		return await removeTarget({ context, deps, request, target });
	} catch (error) {
		throw withFailureContext(error, {
			branch: request.branch ?? undefined,
			worktree_path: targetPath,
		});
	}
}
// --- Private functions ---

function optionalRef(value: string | boolean | undefined): string | null {
	if (typeof value === "string") {
		return value;
	}
	// eslint-disable-next-line unicorn/no-null -- resolveRemoveTarget models an absent branch/ref as null.
	return null;
}

function parseRemoveRequest(args: string[]): RemoveRequest {
	const opts = parseOptions(args);
	if (opts["expected-source"] || opts["expected-target"]) {
		throw new UsageError("review pins require --integrated-into-local");
	}
	const request: RemoveRequest = {
		branch: optionalRef(opts.branch),
		cwd: requireOption(opts, "cwd"),
		force: opts.force === true,
		integratedInto: optionalRef(opts["integrated-into"]),
		interactive: opts.interactive === true,
		keepBranch: opts["keep-branch"] === true,
		output: parseOutputMode(opts),
		self: opts.self === true,
	};
	assertRemoveRequest(request);
	return request;
}

function assertRemoveRequest(request: RemoveRequest): void {
	if ((request.branch && request.self) || (!request.branch && !request.self)) {
		throw new UsageError("provide exactly one of --branch or --self");
	}
	if (request.integratedInto && request.keepBranch) {
		throw new UsageError("--integrated-into cannot be combined with --keep-branch");
	}
	if (request.integratedInto && request.force) {
		throw new UsageError("--integrated-into cannot be combined with --force");
	}
	if (request.integratedInto && !request.integratedInto.startsWith("origin/")) {
		throw new UsageError("--integrated-into must name an origin remote-tracking ref");
	}
}

async function resolveRemoveContext(request: RemoveRequest, deps: Deps): Promise<RemoveContext> {
	const worktrees = await listWorktrees(deps.git, request.cwd);
	const canonical = worktrees.find((worktree) => worktree.canonical);
	if (!canonical) {
		throw new WktreeError("couldn't determine canonical worktree");
	}
	const config = deps.config.read(canonical.path);
	return {
		canonical,
		config,
		worktrees,
	};
}

async function runRemovalPreflight(
	request: RemoveRequest,
	deps: Deps,
	context: RemoveContext,
): Promise<void> {
	const { canonical, config } = context;
	if (!request.integratedInto) {
		return;
	}
	await runPreRemoteCheck(deps, { config, operation: "wktree remove", root: canonical.path });
	await deps.git.run(["-C", canonical.path, "fetch", "origin"]);
}

function buildAfterOutput(operation: RemoveOperation): (() => Promise<void>) | undefined {
	const { context, deps, request, target } = operation;
	if (request.interactive) {
		return planLeaveWorktree(deps, {
			cwd: request.cwd,
			root: context.canonical.path,
			worktreePath: target.path,
		});
	}
	return undefined;
}

async function assertRemovableBranch(operation: RemoveOperation): Promise<void> {
	const { context, deps, request, target } = operation;
	if (!target.branch || request.force || request.keepBranch) {
		return;
	}
	if (request.integratedInto) {
		await assertBranchIntegratedInto({
			branch: target.branch,
			git: deps.git,
			integratedInto: request.integratedInto,
			root: context.canonical.path,
			worktreePath: target.path,
		});
		return;
	}
	await assertBranchSafelyDeletable(deps.git, context.canonical.path, target.branch);
}

async function deleteTargetBranch(operation: RemoveOperation): Promise<void> {
	const { context, deps, request, target } = operation;
	if (!target.branch || request.keepBranch) {
		return;
	}
	let deleteFlag = "-d";
	if (request.force || request.integratedInto) {
		deleteFlag = "-D";
	}
	await deps.git.run(["-C", context.canonical.path, "branch", deleteFlag, target.branch]);
}

async function removeInputWorktree(operation: RemoveOperation): Promise<void> {
	const { context, deps, request, target } = operation;
	const removeArgs = ["-C", context.canonical.path, "worktree", "remove"];
	if (request.force) {
		removeArgs.push("--force");
	}
	removeArgs.push(target.path);
	await deps.git.run(removeArgs);
	await deleteTargetBranch(operation);
}

async function removeTarget(operation: RemoveOperation): Promise<CommandResult> {
	const { deps, request, target } = operation;
	const afterOutput = buildAfterOutput(operation);
	await assertRemovableBranch(operation);
	await removeInputWorktree(operation);
	const payload = toRemovePayload({
		removed: !deps.files.exists(target.path),
		worktreePath: target.path,
	});
	return finalizeReadyResult({
		afterOutput,
		output: request.output,
		payload,
		summary: `wktree: removed worktree at ${payload.worktree_path}`,
	});
}
