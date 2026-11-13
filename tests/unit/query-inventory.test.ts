/* eslint-disable unicorn/no-null -- The public Worktree/JSON contract uses explicit nulls. */
import { EXIT_CODES, dispatch } from "../../src/index";
import { createPolicyDeps, worktreeFixture } from "./policy-fixture.ts";
import { expect, mock, test } from "bun:test";
import { GitError } from "../../src/git/error.ts";
import { createMemoryWorktreeInventory } from "../contract/worktree-inventory-fixture.ts";

const ABSENT_INDEX = -1;
const LINKED_WORKTREE_INDEX = 1;
const REGISTERED_WORKTREES = 3;
const GIT_FAILURE = 128;

const root = "/repo";
const feature = `${root}__feature`;

function inventoryDeps() {
	return createPolicyDeps({
		worktrees: createMemoryWorktreeInventory({
			repositories: [
				{
					cwd: root,
					aliases: [feature, `${feature}/src`],
					worktrees: [
						worktreeFixture(root, { canonical: true }),
						worktreeFixture(feature, { branch: "feature", branchRef: "refs/heads/feature" }),
					],
				},
			],
		}),
	});
}

test("root finds the canonical checkout from a linked subdirectory", async () => {
	const result = await dispatch("root", ["--cwd", `${feature}/src`], inventoryDeps());
	expect(result).toEqual({ exitCode: EXIT_CODES.SUCCESS, stdout: `${root}\n` });
});

test("list preserves inventory order and public JSON fields without policy I/O", async () => {
	const deps = inventoryDeps();
	const text = await dispatch("list", ["--cwd", feature], deps);
	expect(text.stdout).toContain(`${root}  `);
	expect(text.stdout).toContain("[main]");
	expect(text.stdout).toContain("[canonical]");
	expect(text.stdout?.indexOf(root)).toBeLessThan(text.stdout?.indexOf(feature) ?? ABSENT_INDEX);

	const result = await dispatch("list", ["--cwd", root, "--json"], deps);
	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(JSON.parse(result.stdout ?? "{}")).toEqual({
		kind: "list",
		ok: true,
		diagnostics: [],
		setup_output: [],
		worktrees: [
			{
				path: root,
				session: { name: "repo", path: root },
				head: "abc123",
				branch: "main",
				branch_ref: "refs/heads/main",
				canonical: true,
				bare: false,
				detached: false,
				locked: false,
				lock_reason: null,
				prunable: false,
				prunable_reason: null,
				pool: null,
			},
			{
				path: feature,
				session: { name: "repo__feature", path: feature },
				head: "abc123",
				branch: "feature",
				branch_ref: "refs/heads/feature",
				canonical: false,
				bare: false,
				detached: false,
				locked: false,
				lock_reason: null,
				prunable: false,
				prunable_reason: null,
				pool: null,
			},
		],
	});
});

test("JSON list reads each registered worktree from one inventory #test-291", async () => {
	const memory = createMemoryWorktreeInventory({
		repositories: [
			{
				cwd: root,
				aliases: [],
				worktrees: [
					worktreeFixture(root, { canonical: true }),
					worktreeFixture(`${root}__ready`, {
						branch: "feature/ready",
						branchRef: "refs/heads/feature/ready",
					}),
					worktreeFixture(`${root}__legacy`, {
						branch: "feature/legacy",
						branchRef: "refs/heads/feature/legacy",
					}),
				],
			},
		],
	});
	const list = mock((cwd: string) => memory.list(cwd));
	const result = await dispatch(
		"list",
		["--cwd", root, "--json"],
		createPolicyDeps({ worktrees: { list } }),
	);
	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(result.stderr).toBeUndefined();
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		diagnostics: [],
		kind: "list",
		ok: true,
		setup_output: [],
		worktrees: [
			{ canonical: true, path: root, pool: null },
			{ path: `${root}__ready`, branch: "feature/ready", pool: null },
			{ path: `${root}__legacy`, branch: "feature/legacy", pool: null },
		],
	});
	expect(list.mock.calls).toEqual([[root]]);
	expect(await memory.list(root)).toHaveLength(REGISTERED_WORKTREES);
});

test("list preserves locked state on an ordinary worktree", async () => {
	const deps = createPolicyDeps({
		worktrees: createMemoryWorktreeInventory({
			repositories: [
				{
					cwd: root,
					aliases: [],
					worktrees: [
						worktreeFixture(root, { canonical: true }),
						worktreeFixture(`${root}__locked`, {
							branch: "feature/locked",
							branchRef: "refs/heads/feature/locked",
							locked: true,
							lockReason: "keep worktree",
						}),
					],
				},
			],
		}),
	});
	const text = await dispatch("list", ["--cwd", root], deps);
	expect(text.stdout).toContain("[feature/locked]");
	const result = await dispatch("list", ["--cwd", root, "--json"], deps);
	expect(JSON.parse(result.stdout ?? "{}").worktrees[LINKED_WORKTREE_INDEX]).toMatchObject({
		locked: true,
		lock_reason: "keep worktree",
		pool: null,
	});
});

test.each(["root", "list"])("%s preserves inventory failures at dispatch", async (command) => {
	const error = new GitError(["worktree", "list"], "inventory unavailable", GIT_FAILURE);
	const result = await dispatch(
		command,
		["--cwd", root, "--json"],
		createPolicyDeps({ worktrees: { list: () => Promise.reject(error) } }),
	);
	expect(result.failure).toBe(error);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({ ok: false, reason: "git_failed" });
});
