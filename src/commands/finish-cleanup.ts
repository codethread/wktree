import type { Deps, GitRunner } from "../services.ts";
import { EXIT_CODES, PushRejectedError, UsageError } from "../errors.ts";
import type { PolicyExplanation } from "../domain/config.ts";
import type { Worktree } from "../domain/worktree.ts";
import { assertCleanSource } from "./finish-integration.ts";
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
	/** Validated cleanup policy. */
	plan: FinishPolicyPlan;
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

async function cleanupFinishedWorktree(options: {
	deleteBranch: boolean;
	git: GitRunner;
	root: string;
	source: Worktree;
}): Promise<void> {
	const { deleteBranch, git, root, source } = options;
	if (!source.branch) {
		throw new UsageError("finish cleanup requires a source branch");
	}
	await assertCleanSource(git, source);
	await git.run(["-C", root, "worktree", "remove", source.path]);
	if (deleteBranch) {
		await git.run(["-C", root, "branch", "-D", source.branch]);
	}
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
		git: options.deps.git,
		root: options.root,
		source: options.source,
	});
	options.cleanupActions.push("remove_worktree");
	if (options.plan.deleteBranch) {
		options.cleanupActions.push("delete_branch");
	}
	return afterOutput;
}
