/* eslint-disable unicorn/no-null -- Parser assertions retain explicit-null absent metadata. */
import {
	branchExistsInList,
	parseTrunkFromRemoteShow,
	parseTrunkFromSymbolicRef,
	parseWorktreeList,
} from "../../src/git/worktrees.ts";
import { describe, expect, test } from "bun:test";

const FIRST_WORKTREE = 0;

const checkoutCases = [
	{
		expected: {
			bare: false,
			branch: "main",
			branchRef: "refs/heads/main",
			detached: false,
			head: "abc123",
			path: "/repo",
		},
		input: "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n",
		name: "branch",
	},
	{
		expected: {
			bare: false,
			// eslint-disable-next-line unicorn/no-null -- Porcelain reports no branch for a detached checkout.
			branch: null,
			// eslint-disable-next-line unicorn/no-null -- Porcelain reports no branch ref for a detached checkout.
			branchRef: null,
			detached: true,
			head: "abc123",
			path: "/repo",
		},
		input: "worktree /repo\nHEAD abc123\ndetached\n",
		name: "detached",
	},
	{
		expected: {
			bare: true,
			// eslint-disable-next-line unicorn/no-null -- Porcelain reports no branch for a bare checkout.
			branch: null,
			// eslint-disable-next-line unicorn/no-null -- Porcelain reports no branch ref for a bare checkout.
			branchRef: null,
			detached: false,
			// eslint-disable-next-line unicorn/no-null -- Porcelain reports no HEAD for a bare checkout.
			head: null,
			path: "/repo.git",
		},
		input: "worktree /repo.git\nbare\n",
		name: "bare",
	},
];

const poolCases = [
	{ branch: "wk-pool/feat1", index: 1, path: "/repo__feat1", placeholder: true },
	{ branch: "my-feature", index: 2, path: "/repo__feat2", placeholder: false },
	{ branch: "wk-pool/feat3", index: 3, path: "/repo/.worktrees/feat3", placeholder: true },
	{ branch: "wk-pool/feat4", index: 4, path: "/repo/.wktree/feat4", placeholder: true },
];

const symbolicRefCases = [
	{ expected: "main", input: "refs/remotes/origin/main\n", name: "main" },
	{ expected: "develop", input: "refs/remotes/origin/develop\n", name: "develop" },
	// eslint-disable-next-line unicorn/no-null -- Empty symbolic-ref output has no trunk.
	{ expected: null, input: "\n", name: "empty output" },
];

const remoteShowCases = [
	{
		expected: "develop",
		input: "* remote origin\n  Fetch URL: git@example.test/repo\n  HEAD branch: develop\n",
		name: "declared HEAD",
	},
	{
		// eslint-disable-next-line unicorn/no-null -- A remote without a HEAD branch has no trunk.
		expected: null,
		input: "* remote origin\n  Fetch URL: git@example.test/repo\n",
		name: "missing HEAD",
	},
	// eslint-disable-next-line unicorn/no-null -- An unknown remote HEAD has no trunk.
	{ expected: null, input: "* remote origin\n  HEAD branch: (unknown)\n", name: "unknown HEAD" },
];

const branchMatchCases = [
	{ branch: "feature", exists: true, output: "* main\n  feature\n  feature-extra\n" },
	{ branch: "checked-out-elsewhere", exists: true, output: "* main\n+ checked-out-elsewhere\n" },
	{ branch: "feature", exists: false, output: "* main\n  feature-extra\n" },
];

describe("git worktree parsers", () => {
	test.each(checkoutCases)("parses a $name checkout", ({ input, expected }) => {
		expect(parseWorktreeList(input)).toEqual([
			{
				...expected,
				canonical: true,
				// eslint-disable-next-line unicorn/no-null -- Porcelain omits a lock reason when unlocked.
				lockReason: null,
				locked: false,
				// eslint-disable-next-line unicorn/no-null -- A canonical checkout has no pool slot.
				pool: null,
				prunable: false,
				// eslint-disable-next-line unicorn/no-null -- Porcelain omits a prunable reason when not prunable.
				prunableReason: null,
			},
		]);
	});

	test.each(poolCases)("recognizes pool slot $path", ({ path, branch, index, placeholder }) => {
		const [, slot] = parseWorktreeList(
			`worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${path}\nHEAD bbb\nbranch refs/heads/${branch}\n`,
		);
		expect(slot).toMatchObject({ branch, canonical: false, path, pool: { index, placeholder } });
	});

	test.each(symbolicRefCases)("parses symbolic-ref: $name", ({ input, expected }) => {
		expect(parseTrunkFromSymbolicRef(input)).toBe(expected);
	});

	test.each(remoteShowCases)("parses remote show: $name", ({ input, expected }) => {
		expect(parseTrunkFromRemoteShow(input)).toBe(expected);
	});

	test.each(branchMatchCases)(
		"matches exact branch $branch in $output",
		({ output, branch, exists }) => {
			expect(branchExistsInList(output, branch)).toBe(exists);
		},
	);
});

test.each([
	{ fields: "locked", locked: true, lockReason: null, prunable: false, prunableReason: null },
	{
		fields: "locked keep slot",
		locked: true,
		lockReason: "keep slot",
		prunable: false,
		prunableReason: null,
	},
	{ fields: "prunable", locked: false, lockReason: null, prunable: true, prunableReason: null },
	{
		fields: "prunable gitdir file points to non-existent location",
		locked: false,
		lockReason: null,
		prunable: true,
		prunableReason: "gitdir file points to non-existent location",
	},
])("preserves porcelain markers and reason distinctions: $fields", ({ fields, ...expected }) => {
	expect(
		parseWorktreeList(`worktree /repo with spaces\nHEAD abc123\n${fields}\n`)[FIRST_WORKTREE],
	).toMatchObject({ path: "/repo with spaces", ...expected });
});

test("rejects malformed porcelain without a worktree path", () => {
	expect(() => parseWorktreeList("HEAD abc123\nbranch refs/heads/main\n")).toThrow(Error);
});
