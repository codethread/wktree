import type { BranchState, Slot } from "../domain/worktree.ts";
import type { Deps, GitRunner, ProgressReporter } from "../services.ts";
import {
	createCanonicalGitObservations,
	createLocalGitRefs,
	detectBranchState,
	detectOriginDefaultBranch,
	resolveDefaultBaseForNewBranch,
	resolveLocalBaseCommit,
	resolveOfflinePoolResetCommit,
} from "../application/branches.ts";
import { EXIT_CODES } from "../errors.ts";
import type { TreesConfig } from "../domain/config.ts";

export async function prepareAddBranch(options: {
	base: string | null;
	branch: string;
	config: TreesConfig;
	deps: Deps;
	root: string;
	noNetwork: boolean;
}) {
	const { branch, deps, root, noNetwork } = options;
	if (!noNetwork) {
		await deps.git.run(["-C", root, "fetch", "origin"]);
	}
	const branchState = await detectBranchState(deps.git, root, branch);
	return { base: await resolveBranchBase(options, branchState), branchState };
}

export async function resolvePoolResetCommit(options: {
	base: string | null;
	deps: Deps;
	noNetwork: boolean;
	root: string;
}): Promise<string> {
	const { base, deps, noNetwork, root } = options;
	if (!noNetwork) {
		const trunk = await detectOriginDefaultBranch(deps.git, root);
		return resolveLocalBaseCommit(createLocalGitRefs(deps.git, root), `origin/${trunk}`);
	}
	return resolveOfflinePoolResetCommit(createLocalGitRefs(deps.git, root), base);
}

export async function captureExistingBranchHead(options: {
	git: GitRunner;
	root: string;
	branch: string;
	branchState: BranchState;
}): Promise<string | null> {
	const { git, root, branch, branchState } = options;
	if (branchState !== "local" && branchState !== "local-remote") {
		// eslint-disable-next-line unicorn/no-null -- AddPlan serializes absent rollback heads as explicit null.
		return null;
	}
	const result = await git.run(["-C", root, "rev-parse", `refs/heads/${branch}`]);
	return result.stdout.trim();
}

export async function restoreBranchRef(options: {
	git: GitRunner;
	root: string;
	branch: string;
	branchState: BranchState;
	originalBranchHead: string | null;
}): Promise<void> {
	const { git, root, branch, branchState, originalBranchHead } = options;
	if (branchState === "none" || branchState === "remote") {
		await git.runRaw(["-C", root, "branch", "-D", branch]);
		return;
	}
	if (originalBranchHead) {
		await git.runRaw(["-C", root, "branch", "-f", branch, originalBranchHead]);
	}
}

export async function rollbackNonPoolAdd(options: {
	git: GitRunner;
	root: string;
	worktreePath: string;
	branch: string;
	branchState: BranchState;
	originalBranchHead: string | null;
}): Promise<void> {
	const { git, root, worktreePath, branch, branchState, originalBranchHead } = options;
	await git.runRaw(["-C", root, "worktree", "remove", "--force", worktreePath]);
	await restoreBranchRef({ branch, branchState, git, originalBranchHead, root });
}

export async function rollbackPooledAllocation(options: {
	git: GitRunner;
	root: string;
	slot: Slot;
	branch: string;
	branchState: BranchState;
	originalBranchHead: string | null;
	resetCommit: string;
}): Promise<void> {
	const { resetCommit, git, root, slot, branch, branchState, originalBranchHead } = options;
	const placeholderBranch = `wk-pool/feat${slot.index}`;
	await git.runRaw(["-C", slot.path, "checkout", "-f", "-B", placeholderBranch, resetCommit]);
	await git.runRaw(["-C", slot.path, "reset", "--hard", placeholderBranch]);
	await git.runRaw(["-C", slot.path, "clean", "-fd"]);
	await restoreBranchRef({ branch, branchState, git, originalBranchHead, root });
}

export async function addNonPoolWorktree(options: {
	git: GitRunner;
	root: string;
	path: string;
	branch: string;
	state: BranchState;
	base: string | null;
	progress: ProgressReporter;
}): Promise<void> {
	const { git, root, path, branch, state, base, progress } = options;
	warnIgnoredBase(state, base, progress);
	if (state === "local" || state === "local-remote") {
		await git.run(["-C", root, "worktree", "add", path, branch]);
		return;
	}
	if (state === "remote") {
		await git.run([
			"-C",
			root,
			"worktree",
			"add",
			"--no-track",
			"-b",
			branch,
			path,
			`origin/${branch}`,
		]);
		return;
	}
	const startPoint = base ?? "HEAD";
	await git.run(["-C", root, "worktree", "add", "--no-track", "-b", branch, path, startPoint]);
}

export async function checkoutBranchInSlot(options: {
	git: GitRunner;
	slotPath: string;
	branch: string;
	state: BranchState;
	base: string | null;
	progress: ProgressReporter;
}): Promise<void> {
	const { git, slotPath, branch, state, base, progress } = options;
	warnIgnoredBase(state, base, progress);
	if (state === "local" || state === "local-remote") {
		await git.run(["-C", slotPath, "checkout", branch]);
		return;
	}
	if (state === "remote") {
		await git.run(["-C", slotPath, "checkout", "--no-track", "-B", branch, `origin/${branch}`]);
		return;
	}
	const startPoint = base ?? "HEAD";
	await git.run(["-C", slotPath, "checkout", "--no-track", "-B", branch, startPoint]);
}

export async function mergeOriginIfPresent(options: {
	git: GitRunner;
	worktreePath: string;
	branch: string;
	progress: ProgressReporter;
}): Promise<void> {
	const { git, worktreePath, branch, progress } = options;
	const remote = await git.runRaw([
		"-C",
		worktreePath,
		"show-ref",
		"--verify",
		`refs/remotes/origin/${branch}`,
	]);
	if (remote.exitCode !== EXIT_CODES.SUCCESS) {
		return;
	}
	const merge = await git.runRaw(["-C", worktreePath, "merge", "--ff-only", `origin/${branch}`]);
	if (merge.exitCode !== EXIT_CODES.SUCCESS) {
		progress.error(`warning: couldn't fast-forward from origin/${branch}; preserving local work`);
	}
}
// --- Private functions ---

async function resolveBranchBase(
	options: Parameters<typeof prepareAddBranch>[number],
	branchState: BranchState,
): Promise<string | null> {
	const { base, deps, config, noNetwork, root } = options;
	const defaultBase = await resolveDefaultBaseForNewBranch({
		refs: createLocalGitRefs(deps.git, root),
		canonical: createCanonicalGitObservations(deps.git, root),
		base,
		branchState,
		git: deps.git,
		noNetwork,
		policy: deps.config.explain(config, root).addPolicy,
		root,
	});
	const selectedBase = base ?? defaultBase;
	if (branchState === "none" && selectedBase) {
		return resolveLocalBaseCommit(createLocalGitRefs(deps.git, root), selectedBase);
	}
	return selectedBase;
}

function warnIgnoredBase(
	state: BranchState,
	base: string | null,
	progress: ProgressReporter,
): void {
	if (state !== "none" && base) {
		progress.error("--base ignored: branch already exists");
	}
}

export { withoutLazyFetch } from "../git/executor.ts";
