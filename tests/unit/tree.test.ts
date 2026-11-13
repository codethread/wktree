import { expect, test } from "bun:test";
import { formatWorktreeTree, toTreePayload } from "../../src/protocol-payloads.ts";
import type { Worktree } from "../../src/domain/worktree.ts";
import { buildWorktreeTree } from "../../src/domain/worktree.ts";

// eslint-disable-next-line unicorn/no-null -- Worktree uses null for absent metadata.
const absent = null;
const worktrees: Worktree[] = [
	{ path: "/repo", head: "D", branch: "trunk", canonical: true, pool: absent },
	{ path: "/repo/feature-a", head: "A", branch: "feature/a", canonical: false, pool: absent },
	{ path: "/repo/feature-b", head: "B", branch: "feature/b", canonical: false, pool: absent },
	{ path: "/repo/old", head: "B", branch: "old", canonical: false, pool: absent },
	{ path: "/repo/parent", head: "P", branch: "parent", canonical: false, pool: absent },
	{
		path: "/repo/at-parent",
		head: "P",
		branch: "feature/at-parent",
		canonical: false,
		pool: absent,
	},
	{ path: "/repo/child", head: "C", branch: "child", canonical: false, pool: absent },
	{ path: "/repo/sibling", head: "Q", branch: "sibling", canonical: false, pool: absent },
	{ path: "/repo/stack", head: "R", branch: "stack", canonical: false, pool: absent },
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

test("every worktree participates in inferred feature stacks", () => {
	expect(formatWorktreeTree(buildTree())).toMatchInlineSnapshot(`
	  "Worktrees (default-branch groups; inferred feature stacks, not creation history)
	  └── trunk [canonical] [default]
	      ├── feature/a [0 ahead, 2 behind]
	      ├── feature/b = old [same HEAD] [0 ahead, 1 behind]
	      ├── parent = feature/at-parent [same HEAD] [1 ahead, 2 behind]
	      │   └── stack [2 ahead, 2 behind]
	      │       └── child [3 ahead, 2 behind]
	      └── sibling [1 ahead, 1 behind]
	  "
	`);
});

test("JSON preserves all equal-HEAD worktrees and infers their feature parents", () => {
	const payload = toTreePayload(buildTree());
	expect(payload.default_branch).toEqual({ branch: "trunk", ref: "refs/heads/trunk", head: "D" });
	expect(
		payload.nodes
			.flatMap((node) => node.worktrees)
			.map((worktree) => worktree.path)
			.toSorted(),
	).toEqual(worktrees.map((worktree) => worktree.path).toSorted());
	expect(payload.nodes.find((node) => node.id === "P")).toMatchObject({
		comparison: { kind: "related", ahead: 1, behind: 2 },
		worktrees: [{ branch: "parent" }, { branch: "feature/at-parent" }],
		parentage: { kind: "unknown", reason: "no_ancestor" },
	});
	expect(payload.nodes.find((node) => node.id === "C")).toMatchObject({
		parentage: { kind: "inferred", head: "R" },
	});
	expect(
		payload.nodes.filter((node) => node.parentage.kind === "inferred").map((node) => node.id),
	).toEqual(["C", "R"]);
});

function buildTree() {
	// Default history A--B--D; P forks at A, Q at B, and P--R--C is a feature stack.
	return buildWorktreeTree({
		worktrees,
		defaultBranch: { branch: "trunk", ref: "refs/heads/trunk", head: "D" },
		comparisons: new Map([
			["D", { kind: "related", ahead: 0, behind: 0 }],
			["A", { kind: "related", ahead: 0, behind: 2 }],
			["B", { kind: "related", ahead: 0, behind: 1 }],
			["P", { kind: "related", ahead: 1, behind: 2 }],
			["Q", { kind: "related", ahead: 1, behind: 1 }],
			["R", { kind: "related", ahead: 2, behind: 2 }],
			["C", { kind: "related", ahead: 3, behind: 2 }],
		]),
		ancestors: new Map([
			["D", new Set(["A", "B"])],
			["B", new Set(["A"])],
			["P", new Set(["A"])],
			["Q", new Set(["A", "B"])],
			["R", new Set(["A", "P"])],
			["C", new Set(["A", "P", "R"])],
		]),
	});
}
