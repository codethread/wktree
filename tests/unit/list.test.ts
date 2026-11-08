import { expect, test } from "bun:test";
import type { Worktree } from "../../src/domain/worktree.ts";
import { formatWorktreeList } from "../../src/protocol-payloads.ts";

// eslint-disable-next-line unicorn/no-null -- Worktree uses null for absent metadata.
const absent = null;
const worktrees: Worktree[] = [
	{ path: "/repo", head: "1234567890abcdef", branch: "main", canonical: true, pool: absent },
	{
		path: "/repo__feat1",
		head: "abcdef1234567890",
		branch: "feature/ready",
		canonical: false,
		pool: { index: 1, placeholder: false },
	},
	{
		path: "/repo__feat2",
		head: "1234567890abcdef",
		branch: "wk-pool/feat2",
		canonical: false,
		pool: { index: 2, placeholder: true },
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

test("list text renders canonical and pool-slot markers from supplied inventory", () => {
	expect(formatWorktreeList(worktrees)).toMatchInlineSnapshot(`
		"/repo  1234567 [main] [canonical]
		/repo__feat1  abcdef1 [feature/ready] [pool:feat1]
		/repo__feat2  1234567 [wk-pool/feat2] [pool:free]
		"
	`);
});
