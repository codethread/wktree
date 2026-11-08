import type { Deps } from "../../src/services.ts";
import type { Worktree } from "../../src/domain/worktree.ts";

/**
 * No-I/O policy defaults: every operation throws unless its service is explicitly replaced.
 * Inventory consumers can inject ../contract/worktree-inventory-fixture.ts's memory adapter.
 */
export function createPolicyDeps(overrides: Partial<Deps> = {}): Deps {
	return {
		skills: { getSkills: unexpected, getSkillFile: unexpected },
		git: { run: unexpected, runRaw: unexpected },
		worktrees: { list: unexpected },
		config: { read: unexpected, explain: unexpected },
		files: {
			normalizePath: unexpected,
			exists: unexpected,
			prepareParent: unexpected,
			copy: unexpected,
			writePostCreateScript: unexpected,
		},
		hooks: { runInline: unexpected, runCommand: unexpected },
		picker: { pick: unexpected, confirm: unexpected },
		multiplexer: {
			attached: false,
			open: unexpected,
			closeUnder: unexpected,
			previewCommand: unexpected,
		},
		cdDirective: { write: unexpected },
		progress: { banner: unexpected, stream: unexpected, error: unexpected },
		clock: { now: unexpected },
		...overrides,
	};
}

/* eslint-disable unicorn/no-null -- Fixtures use the explicit-null Worktree model. */
/** Trusted policy input, not a porcelain parser or filesystem fixture. */
export function worktreeFixture(path: string, overrides: Partial<Worktree> = {}): Worktree {
	return {
		path,
		head: "abc123",
		branch: "main",
		branchRef: "refs/heads/main",
		canonical: false,
		bare: false,
		detached: false,
		locked: false,
		lockReason: null,
		prunable: false,
		prunableReason: null,
		pool: null,
		...overrides,
	};
}

function unexpected(): never {
	throw new Error("Unexpected policy dependency call");
}
