/* eslint-disable unicorn/no-null -- The public Worktree/JSON contract uses explicit nulls. */
import { EXIT_CODES, dispatch } from "../../src/index";
import { createPolicyDeps, worktreeFixture } from "./policy-fixture.ts";
import { expect, mock, test } from "bun:test";
import { GitError } from "../../src/git/error.ts";
import { createMemoryWorktreeInventory } from "../contract/worktree-inventory-fixture.ts";

const ABSENT_INDEX = -1;
const SLOT_INDEX = 1;
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

test("JSON list reads one inventory and leaves missing pool slots absent #test-291", async () => {
	const memory = createMemoryWorktreeInventory({
		repositories: [
			{
				cwd: root,
				aliases: [],
				worktrees: [
					worktreeFixture(root, { canonical: true }),
					worktreeFixture(`${root}__feat1`, {
						branch: "feature/ready",
						branchRef: "refs/heads/feature/ready",
						pool: { index: 1, placeholder: false },
					}),
					worktreeFixture(`${root}__feat2`, {
						branch: "wk-pool/feat2",
						branchRef: "refs/heads/wk-pool/feat2",
						pool: { index: 2, placeholder: true },
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
	expect(result.stdout).not.toContain(`${root}__feat3`);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		diagnostics: [],
		kind: "list",
		ok: true,
		setup_output: [],
		worktrees: [
			{ canonical: true, path: root },
			{ path: `${root}__feat1`, branch: "feature/ready", pool: { index: 1, placeholder: false } },
			{ path: `${root}__feat2`, branch: "wk-pool/feat2", pool: { index: 2, placeholder: true } },
		],
	});
	expect(list.mock.calls).toEqual([[root]]);
	expect(await memory.list(root)).toHaveLength(REGISTERED_WORKTREES);
});

test("list annotates locked pool slots", async () => {
	const deps = createPolicyDeps({
		worktrees: createMemoryWorktreeInventory({
			repositories: [
				{
					cwd: root,
					aliases: [],
					worktrees: [
						worktreeFixture(root, { canonical: true }),
						worktreeFixture(`${root}__feat1`, {
							branch: "wk-pool/feat1",
							branchRef: "refs/heads/wk-pool/feat1",
							locked: true,
							lockReason: "keep slot",
							pool: { index: 1, placeholder: true },
						}),
					],
				},
			],
		}),
	});
	const text = await dispatch("list", ["--cwd", root], deps);
	expect(text.stdout).toContain("[pool:free]");
	const result = await dispatch("list", ["--cwd", root, "--json"], deps);
	expect(JSON.parse(result.stdout ?? "{}").worktrees[SLOT_INDEX]).toMatchObject({
		locked: true,
		lock_reason: "keep slot",
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
