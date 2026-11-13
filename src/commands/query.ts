import { CanonicalRootError, EXIT_CODES, UsageError, WktreeError } from "../errors.ts";
import type { CommandResult, OutputMode } from "../protocol.ts";
import { encodeBranch, worktreePathForName } from "../domain/worktree.ts";
import {
	finalizeReadyResult,
	finalizeStructuredResult,
	formatConfigSummary,
	formatWorktreeList,
	formatWorktreeTree,
	parseOptions,
	parseOutputMode,
	requireOption,
	toConfigExplainPayload,
	toListJson,
	toTreePayload,
} from "../protocol.ts";
import {
	readWorktreeTree,
	resolveCanonicalRoot,
	resolveWorktreeContainingPath,
} from "../application/repository.ts";
import type { Deps } from "../services.ts";
import type { Worktree } from "../domain/worktree.ts";
import { listWorktrees } from "../git/worktrees.ts";

interface QueryRequest {
	/** Checkout the caller is working from. */
	cwd: string;
	/** Requested output rendering. */
	output: OutputMode;
}

interface PathRequest {
	/** Branch whose worktree path is requested. */
	branch: string;
	/** Checkout the caller is working from. */
	cwd: string;
}

export async function rootCommand(args: string[], deps: Deps): Promise<CommandResult> {
	const opts = parseOptions(args);
	const cwd = requireOption(opts, "cwd");
	const canonicalRoot = requireCanonical(await deps.worktrees.list(cwd)).path;
	return { exitCode: EXIT_CODES.SUCCESS, stdout: `${canonicalRoot}\n` };
}

export async function listCommand(args: string[], deps: Deps): Promise<CommandResult> {
	const request = parseQueryRequest(args);
	const worktrees = await deps.worktrees.list(request.cwd);
	return renderList(worktrees, request.output);
}

export async function treeCommand(args: string[], deps: Deps): Promise<CommandResult> {
	const request = parseQueryRequest(args);
	const tree = await readWorktreeTree(deps.git, request.cwd);
	if (request.output.json) {
		return finalizeStructuredResult(toTreePayload(tree), request.output);
	}
	return { exitCode: EXIT_CODES.SUCCESS, stdout: formatWorktreeTree(tree) };
}

export async function pathCommand(args: string[], deps: Deps): Promise<CommandResult> {
	const request = parsePathRequest(args);
	const worktrees = await listWorktrees(deps.git, request.cwd);
	const canonical = requireCanonical(worktrees);
	const config = deps.config.read(canonical.path);
	const existing = worktrees.find((worktree) => worktree.branch === request.branch);
	if (existing) {
		return { exitCode: EXIT_CODES.SUCCESS, stdout: `${existing.path}\n` };
	}
	const explanation = deps.config.explain(config, canonical.path);
	const path = worktreePathForName(
		canonical.path,
		encodeBranch(request.branch),
		explanation.worktreeLocation,
	);
	return { exitCode: EXIT_CODES.SUCCESS, stdout: `${path}\n` };
}

export async function copyCommand(args: string[], deps: Deps): Promise<CommandResult> {
	const request = parseQueryRequest(args);
	const worktrees = await listWorktrees(deps.git, request.cwd);
	const canonical = requireCanonical(worktrees);
	const config = deps.config.read(canonical.path);
	const target = resolveCopyTarget({ canonical, cwd: request.cwd, deps, worktrees });
	const { project } = deps.config.explain(config, canonical.path);
	const copied = await deps.files.copy({
		root: canonical.path,
		target: target.path,
		entries: project?.copy ?? [],
		git: deps.git,
	});
	const payload = {
		copied,
		exclude_paths: [...new Set(copied.map((entry) => entry.to))].toSorted(),
		kind: "ready",
		root: canonical.path,
		worktree_path: target.path,
	};
	return finalizeReadyResult({
		output: request.output,
		payload,
		summary: `wktree: copied ${payload.copied.length} items into ${payload.worktree_path}`,
	});
}

export async function configCommand(args: string[], deps: Deps): Promise<CommandResult> {
	const [topic, ...rest] = args;
	if (topic !== "explain") {
		throw new UsageError("expected config explain");
	}
	const request = parseQueryRequest(rest);
	const canonicalRoot = await resolveCanonicalRoot(deps.git, request.cwd);
	const payload = toConfigExplainPayload(
		deps.config.explain(deps.config.read(canonicalRoot), canonicalRoot),
	);
	if (request.output.json) {
		return finalizeStructuredResult(payload, request.output);
	}
	return { exitCode: EXIT_CODES.SUCCESS, stdout: formatConfigSummary(payload) };
}
// --- Private functions ---

function requireCanonical(worktrees: Worktree[]): Worktree {
	const canonical = worktrees.find((worktree) => worktree.canonical);
	if (!canonical) {
		throw new WktreeError("couldn't determine canonical worktree");
	}
	return canonical;
}

function parseQueryRequest(args: string[]): QueryRequest {
	const opts = parseOptions(args);
	return { cwd: requireOption(opts, "cwd"), output: parseOutputMode(opts) };
}

function parsePathRequest(args: string[]): PathRequest {
	const opts = parseOptions(args);
	const cwd = requireOption(opts, "cwd");
	return { branch: requireOption(opts, "branch"), cwd };
}

function renderList(worktrees: Worktree[], output: OutputMode): CommandResult {
	if (output.json) {
		return finalizeStructuredResult(
			{ kind: "list", worktrees: worktrees.map((worktree) => toListJson(worktree)) },
			output,
		);
	}
	return { exitCode: EXIT_CODES.SUCCESS, stdout: formatWorktreeList(worktrees) };
}

function resolveCopyTarget(options: {
	canonical: Worktree;
	cwd: string;
	deps: Deps;
	worktrees: Worktree[];
}): Worktree {
	const target = resolveWorktreeContainingPath(options.worktrees, options.cwd, options.deps.files);
	if (!target) {
		throw new UsageError(`no worktree contains cwd: ${options.cwd}`);
	}
	if (
		options.deps.files.normalizePath(target.path) ===
		options.deps.files.normalizePath(options.canonical.path)
	) {
		throw new CanonicalRootError("refusing to copy setup into canonical root");
	}
	return target;
}
