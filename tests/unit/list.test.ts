import { expect, test } from "bun:test";
import type { Worktree } from "../../src/domain/worktree.ts";
import { formatWorktreeList } from "../../src/protocol-payloads.ts";

// eslint-disable-next-line unicorn/no-null -- Worktree uses null for absent metadata.
const absent = null;
const worktrees: Worktree[] = [
	{ path: "/repo", head: "1234567890abcdef", branch: "main", canonical: true, pool: absent },
	{
		path: "/repo/feature-ready",
		head: "abcdef1234567890",
		branch: "feature/ready",
		canonical: false,
		pool: absent,
	},
	{
		path: "/repo/feature-legacy",
		head: "1234567890abcdef",
		branch: "feature/legacy",
		canonical: false,
		pool: absent,
	},
].map((worktree) =>
	Object.assign(worktree, {
		branchRef: `refs/heads/${worktree.branch}`,
		detached: false,
		bare: false,
		locked: false,
		lockReason: absent,
		prunable: false,
		prunableReason: absent,
	}),
);

test("list text renders branch and canonical labels from supplied inventory", () => {
	expect(formatWorktreeList(worktrees)).toMatchInlineSnapshot(`
		"/repo  1234567 [main] [canonical]
		/repo/feature-ready  abcdef1 [feature/ready]
		/repo/feature-legacy  1234567 [feature/legacy]
		"
	`);
});
