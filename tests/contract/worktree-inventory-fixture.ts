import { GitError } from "../../src/git/error.ts";
import type { Worktree } from "../../src/domain/worktree.ts";
import type { WorktreeInventory } from "../../src/git/worktrees.ts";

const NOT_A_REPOSITORY = 128;

export interface MemoryWorktreeRepository {
	/** Canonical fixture lookup key, also accepted by list and the controller. */
	cwd: string;
	/** Explicit linked-checkout or subdirectory keys belonging to this repository. */
	aliases?: readonly string[];
	/** Ordered Git observations, copied when seeded or replaced. */
	worktrees: readonly Worktree[];
}

export interface MemoryWorktreeInventory extends WorktreeInventory {
	/** Replace this repository's next observation without changing earlier results. */
	replace: (cwd: string, worktrees: readonly Worktree[]) => void;
	/** Reject reads of this repository with a named Git failure until recovered. */
	fail: (cwd: string, error: GitError) => void;
	/** Resume reads of the last stored observation. */
	recover: (cwd: string) => void;
}

interface RepositoryState {
	/** Latest independent ordered observation. */
	worktrees: Worktree[];
	/** Named read fault, absent during normal observations. */
	failure: GitError | undefined;
}

/** Test-only inventory; aliases are explicit membership, not filesystem emulation. */
export function createMemoryWorktreeInventory(options: {
	/** Independent repositories known to this fixture instance. */
	repositories: readonly MemoryWorktreeRepository[];
}): MemoryWorktreeInventory {
	const memberships = new Map<string, RepositoryState>();
	for (const repository of options.repositories) {
		const state: RepositoryState = {
			failure: undefined,
			worktrees: cloneWorktrees(repository.worktrees),
		};
		for (const cwd of [repository.cwd, ...(repository.aliases ?? [])]) {
			if (memberships.has(cwd)) {
				throw new Error(`Duplicate worktree inventory fixture cwd: ${cwd}`);
			}
			memberships.set(cwd, state);
		}
	}
	const repositoryFor = (cwd: string): RepositoryState => {
		const state = memberships.get(cwd);
		if (!state) {
			throw new GitError(
				["-C", cwd, "worktree", "list", "--porcelain"],
				"Unknown fixture repository",
				NOT_A_REPOSITORY,
			);
		}
		return state;
	};
	return {
		// eslint-disable-next-line require-await -- Async preserves rejected-Promise semantics for unknown cwd.
		async list(cwd) {
			const state = repositoryFor(cwd);
			if (state.failure) {
				throw state.failure;
			}
			return cloneWorktrees(state.worktrees);
		},
		replace(cwd, worktrees) {
			repositoryFor(cwd).worktrees = cloneWorktrees(worktrees);
		},
		fail(cwd, error) {
			repositoryFor(cwd).failure = error;
		},
		recover(cwd) {
			repositoryFor(cwd).failure = undefined;
		},
	};
}

// --- Private helpers ---

function cloneWorktrees(worktrees: readonly Worktree[]): Worktree[] {
	return worktrees.map((worktree) => ({
		...worktree,
		pool: worktree.pool && { ...worktree.pool },
	}));
}
