import type { CommitRead, LocalGitRefs } from "../../src/application/branches.ts";

export interface RefState {
	/** Locally designated default branch, independent of available refs. */
	defaultBranch: string | null;
	/** Full ref names present in this observation. */
	refs: readonly string[];
	/** Explicit resolution outcomes for refs the scenario can read. */
	commits: Readonly<Record<string, CommitRead>>;
}

export interface RefFixture extends LocalGitRefs {
	/** Recorded read calls, used to verify bypass and fallback decisions. */
	reads: string[];
}

export function createRefFixture(state: RefState): RefFixture {
	const reads: string[] = [];
	return {
		reads,
		defaultBranch() {
			reads.push("defaultBranch");
			return Promise.resolve(state.defaultBranch);
		},
		hasRef(ref) {
			reads.push(`hasRef:${ref}`);
			return Promise.resolve(state.refs.includes(ref));
		},
		commit(ref) {
			reads.push(`commit:${ref}`);
			const result = state.commits[ref];
			if (!result) {
				throw new Error(`Fixture has no commit observation for ${ref}`);
			}
			return Promise.resolve(result);
		},
	};
}
