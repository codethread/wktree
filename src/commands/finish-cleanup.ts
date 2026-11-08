import type { Deps, GitRunner, WorkspaceFiles } from "../services.ts";
import { EXIT_CODES, PushRejectedError, UsageError } from "../errors.ts";
import type { PolicyExplanation, ProjectConfig, WorktreeLocation } from "../domain/config.ts";
import { buildPoolState, ensurePlaceholderBranch } from "../application/pool.ts";
import type { Worktree } from "../domain/worktree.ts";
import { assertCleanSource } from "./finish-integration.ts";
import { listWorktrees } from "../git/worktrees.ts";
import { planLeaveWorktree } from "../application/interactive.ts";

type FinishPolicyPlan = PolicyExplanation["finishPolicy"];
interface FinishRequest {
	/** Caller checkout. */
	cwd: string;
	/** Permit shell/session handoff. */
	interactive: boolean;
}

interface CleanupOptions {
	/** Cleanup steps completed and reported in failure context. */
	cleanupActions: string[];
	/** Service boundary for the command invocation. */
	deps: Deps;
	/** Resolved policy for the canonical root. */
	explanation: PolicyExplanation;
	/** Validated cleanup policy. */
	plan: FinishPolicyPlan;
	/** Project matching the canonical root, when configured. */
	project: ProjectConfig | undefined;
	/** Validated command-line request. */
	request: FinishRequest;
	/** Canonical path reported by Git, used for cleanup mutations. */
	root: string;
	/** Source worktree selected by cwd. */
	source: Worktree;
}

export async function pushAndCleanup(
	options: CleanupOptions & {
		plan: FinishPolicyPlan;
		targetBranch: string;
	},
): Promise<(() => Promise<void>) | undefined> {
	await pushFinishedBranch({
		cleanupActions: options.cleanupActions,
		deps: options.deps,
		plan: options.plan,
		root: options.root,
		targetBranch: options.targetBranch,
	});
	return cleanupSourceWorktree(options);
}
// --- Private functions ---

async function pushFinishedBranch(options: {
	cleanupActions: string[];
	deps: Deps;
	plan: FinishPolicyPlan;
	root: string;
	targetBranch: string;
}): Promise<void> {
	if (!options.plan.push) {
		return;
	}
	const pushed = await options.deps.git.runRaw([
		"-C",
		options.root,
		"push",
		"origin",
		options.targetBranch,
	]);
	if (pushed.exitCode !== EXIT_CODES.SUCCESS) {
		throw new PushRejectedError(`push rejected for ${options.targetBranch}`);
	}
	options.cleanupActions.push("push");
}

async function recycleFinishedSlot(options: {
	deleteBranch: boolean;
	files: WorkspaceFiles;
	git: GitRunner;
	project: ProjectConfig;
	root: string;
	source: Worktree;
	sourceBranch: string;
	worktreeLocation: WorktreeLocation;
}): Promise<void> {
	const state = await buildPoolState({
		deps: { files: options.files, git: options.git },
		location: options.worktreeLocation,
		project: options.project,
		worktrees: await listWorktrees(options.git, options.root),
	});
	const slot = state.slots.find(
		(candidate) =>
			options.files.normalizePath(candidate.path) ===
			options.files.normalizePath(options.source.path),
	);
	if (!slot) {
		throw new UsageError(`pool slot not found: ${options.source.path}`);
	}
	const placeholderBranch = `wk-pool/feat${slot.index}`;
	await ensurePlaceholderBranch({
		branch: placeholderBranch,
		git: options.git,
		root: options.root,
		trunk: state.trunk,
	});
	await options.git.run([
		"-C",
		options.source.path,
		"checkout",
		"-B",
		placeholderBranch,
		`origin/${state.trunk}`,
	]);
	if (options.deleteBranch) {
		await options.git.run(["-C", options.root, "branch", "-D", options.sourceBranch]);
	}
}

async function cleanupFinishedWorktree(options: {
	deleteBranch: boolean;
	files: WorkspaceFiles;
	git: GitRunner;
	project: ProjectConfig | undefined;
	root: string;
	source: Worktree;
	worktreeLocation: WorktreeLocation;
}): Promise<void> {
	const { deleteBranch, files, git, project, root, source, worktreeLocation } = options;
	if (!source.branch) {
		throw new UsageError("finish cleanup requires a source branch");
	}
	await assertCleanSource(git, source);
	if (project?.poolSize && source.pool) {
		await recycleFinishedSlot({
			deleteBranch,
			files,
			git,
			project,
			root,
			source,
			sourceBranch: source.branch,
			worktreeLocation,
		});
		return;
	}
	await git.run(["-C", root, "worktree", "remove", source.path]);
	if (deleteBranch) {
		await git.run(["-C", root, "branch", "-D", source.branch]);
	}
}

function cleanupActionFor(source: Worktree): string {
	if (source.pool) {
		return "recycle_worktree";
	}
	return "remove_worktree";
}

async function cleanupSourceWorktree(
	options: CleanupOptions,
): Promise<(() => Promise<void>) | undefined> {
	if (!options.plan.removeWorktree) {
		return undefined;
	}
	let afterOutput: (() => Promise<void>) | undefined = undefined;
	if (options.request.interactive) {
		afterOutput = planLeaveWorktree(options.deps, {
			cwd: options.request.cwd,
			root: options.root,
			worktreePath: options.source.path,
		});
	}
	await cleanupFinishedWorktree({
		deleteBranch: options.plan.deleteBranch,
		files: options.deps.files,
		git: options.deps.git,
		project: options.project,
		root: options.root,
		source: options.source,
		worktreeLocation: options.explanation.worktreeLocation,
	});
	options.cleanupActions.push(cleanupActionFor(options.source));
	if (options.plan.deleteBranch) {
		options.cleanupActions.push("delete_branch");
	}
	return afterOutput;
}
