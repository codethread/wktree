import {
	BlockedError,
	CanonicalRootError,
	EXIT_CODES,
	UsageError,
	WktreeError,
} from "../errors.ts";
import type { GitRunner, WorkspaceFiles } from "../services.ts";
import type { TreeComparison, Worktree, WorktreeTree } from "../domain/worktree.ts";
import { buildWorktreeTree, worktreeCommit } from "../domain/worktree.ts";
import { GitError } from "../git/error.ts";
import { listWorktrees } from "../git/worktrees.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- resolve cwd at the filesystem boundary
import { resolve } from "node:path";
import { resolveTreeDefaultBranch } from "./branches.ts";
import { withoutLazyFetch } from "../git/executor.ts";

const GIT_NOT_ANCESTOR = 1;
const NO_HEADS = 0;

/** Snapshot inventory and default tip once; all history queries use local immutable OIDs. */
export async function readWorktreeTree(runner: GitRunner, cwd: string): Promise<WorktreeTree> {
	const git = withoutLazyFetch(runner);
	const worktrees = await listWorktrees(git, cwd);
	const { defaultBranch, comparisons } = await readDefaultComparisons(git, cwd, worktrees);
	const ancestors = await readWorktreeAncestors(git, cwd, worktrees);
	return buildWorktreeTree({ worktrees, ancestors, defaultBranch, comparisons });
}

export async function resolveCanonicalRoot(git: GitRunner, cwd: string): Promise<string> {
	const worktrees = await listWorktrees(git, cwd);
	const canonical = worktrees.find((worktree) => worktree.canonical);
	if (!canonical) {
		throw new WktreeError("couldn't determine canonical worktree");
	}
	return canonical.path;
}

export function resolveWorktreeContainingPath(
	worktrees: Worktree[],
	cwd: string,
	files: WorkspaceFiles,
): Worktree | undefined {
	const normalizedCwd = files.normalizePath(resolve(cwd));
	const [mostSpecific] = worktrees
		.filter((worktree) => pathContains(files.normalizePath(worktree.path), normalizedCwd))
		.toSorted((left, right) => right.path.length - left.path.length);
	return mostSpecific;
}

export function resolveRemoveTarget(options: {
	/** Git's current worktree inventory. */
	worktrees: Worktree[];
	/** Protected canonical checkout. */
	canonicalRoot: string;
	/** Invoking directory for self-selection. */
	cwd: string;
	/** Requested branch or invoking worktree. */
	selector: { branch: string | null; self: boolean };
	/** Filesystem canonicalization boundary. */
	files: WorkspaceFiles;
}): Worktree {
	const { worktrees, canonicalRoot, cwd, selector, files } = options;
	const target = findRemoveTarget({ cwd, files, selector, worktrees });
	if (!target) {
		if (selector.branch) {
			throw new BlockedError(`no worktree found for branch ${selector.branch}`);
		}
		throw new UsageError(`no worktree contains cwd: ${cwd}`);
	}
	if (files.normalizePath(target.path) === files.normalizePath(canonicalRoot)) {
		throw new CanonicalRootError("refusing to remove canonical root");
	}
	return target;
}

export function pathContains(parent: string, child: string): boolean {
	return child === parent || child.startsWith(`${parent}/`);
}
// --- Private functions ---

async function readDefaultComparisons(git: GitRunner, cwd: string, worktrees: Worktree[]) {
	const heads = new Set(
		worktrees.map((worktree) => worktreeCommit(worktree)).filter((head) => head !== undefined),
	);
	const comparisons = new Map<string, TreeComparison>();
	if (heads.size === NO_HEADS) {
		return { defaultBranch: undefined, comparisons };
	}
	const defaultBranch = await resolveTreeDefaultBranch(git, cwd);
	for (const head of heads) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- Bound the number of Git subprocesses.
		const comparison = await compareWithDefault({ git, cwd, baseline: defaultBranch.head, head });
		comparisons.set(head, comparison);
	}
	return { defaultBranch, comparisons };
}

async function readWorktreeAncestors(git: GitRunner, cwd: string, worktrees: Worktree[]) {
	const heads = [
		...new Set(
			worktrees.map((worktree) => worktreeCommit(worktree)).filter((head) => head !== undefined),
		),
	];
	const ancestors = new Map<string, Set<string>>();
	for (const head of heads) {
		const candidates = new Set<string>();
		for (const candidate of heads.filter((other) => other !== head)) {
			// Bound Git subprocesses instead of spawning a quadratic number concurrently.
			// oxlint-disable-next-line eslint/no-await-in-loop
			if (await isAncestor({ ancestor: candidate, cwd, git, head })) {
				candidates.add(candidate);
			}
		}
		ancestors.set(head, candidates);
	}
	return ancestors;
}

async function compareWithDefault(options: {
	/** Injected local-only Git process boundary. */
	git: GitRunner;
	/** Repository whose history is read. */
	cwd: string;
	/** Immutable default branch commit. */
	baseline: string;
	/** Immutable worktree commit. */
	head: string;
}): Promise<TreeComparison> {
	const { git, cwd, baseline, head } = options;
	const counts = await git.run([
		"-C",
		cwd,
		"rev-list",
		"--left-right",
		"--count",
		`${baseline}...${head}`,
	]);
	const match = /^(?<behind>\d+)\s+(?<ahead>\d+)$/u.exec(counts.stdout.trim());
	if (!match?.groups) {
		throw new WktreeError(`invalid Git ahead/behind counts: ${counts.stdout.trim()}`);
	}
	return {
		ahead: Number(match.groups.ahead),
		behind: Number(match.groups.behind),
		kind: await readCommonAncestry(git, cwd, [baseline, head]),
	};
}

async function readCommonAncestry(
	git: GitRunner,
	cwd: string,
	heads: [string, string],
): Promise<TreeComparison["kind"]> {
	const args = ["-C", cwd, "merge-base", ...heads];
	const common = await git.runRaw(args);
	if (common.exitCode === GIT_NOT_ANCESTOR) {
		return "no_common_ancestor";
	}
	if (common.exitCode !== EXIT_CODES.SUCCESS) {
		throw new GitError(args, common.stderr, common.exitCode);
	}
	return "related";
}

async function isAncestor(options: {
	/** Git process boundary. */
	git: GitRunner;
	/** Path inside the repository whose object database is queried. */
	cwd: string;
	/** Candidate ancestor's snapshotted commit OID. */
	ancestor: string;
	/** Descendant's snapshotted commit OID. */
	head: string;
}): Promise<boolean> {
	const { ancestor, cwd, git, head } = options;
	const args = ["-C", cwd, "merge-base", "--is-ancestor", ancestor, head];
	const result = await git.runRaw(args);
	if (result.exitCode !== EXIT_CODES.SUCCESS && result.exitCode !== GIT_NOT_ANCESTOR) {
		throw new GitError(args, result.stderr, result.exitCode);
	}
	return result.exitCode === EXIT_CODES.SUCCESS;
}

function findRemoveTarget(options: {
	cwd: string;
	files: WorkspaceFiles;
	selector: { branch: string | null; self: boolean };
	worktrees: Worktree[];
}): Worktree | undefined {
	const { cwd, files, selector, worktrees } = options;
	if (selector.branch) {
		return worktrees.find((worktree) => worktree.branch === selector.branch);
	}
	return resolveWorktreeContainingPath(worktrees, cwd, files);
}
