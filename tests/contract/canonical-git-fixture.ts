import type {
	AncestryProof,
	CanonicalCheckout,
	CanonicalGitObservations,
} from "../../src/application/branches.ts";

/** Typed observations checked against native Git in canonical-git.test.ts. */
export interface CanonicalState {
	/** Porcelain-status classification for the canonical worktree. */
	cleanliness: "clean" | "dirty";
	/** Current branch or detached HEAD. */
	checkout: CanonicalCheckout;
	/** Explicit HEAD ancestry outcomes keyed by each target ref the scenario can read. */
	ancestry: Readonly<Record<string, AncestryProof>>;
}

export interface CanonicalFixture extends CanonicalGitObservations {
	/** Calls in read order, with ancestry targets recorded as headAncestry:<ref>. */
	reads: string[];
}

/** Serve typed observations without I/O; an unspecified ancestry target fails the test. */
export function createCanonicalFixture(state: CanonicalState): CanonicalFixture {
	const reads: string[] = [];
	return {
		reads,
		cleanliness() {
			reads.push("cleanliness");
			return Promise.resolve(state.cleanliness);
		},
		checkout() {
			reads.push("checkout");
			return Promise.resolve({ ...state.checkout });
		},
		headAncestry(ref) {
			reads.push(`headAncestry:${ref}`);
			const result = state.ancestry[ref];
			if (!result) {
				throw new Error(`Fixture has no ancestry observation for ${ref}`);
			}
			return Promise.resolve(result);
		},
	};
}
