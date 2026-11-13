import { expect, test } from "bun:test";
import { PreRemoteCheckError } from "../../src/errors.ts";
import type { TreesConfig } from "../../src/domain/config.ts";
import { explainPolicy } from "../../src/domain/config.ts";
import { parseWorktreeList } from "../../src/git/worktrees.ts";
import { runPreRemoteCheck } from "../../src/application/hooks.ts";
import { toListJson } from "../../src/protocol.ts";

test("preflight uses the injected command runner and preserves failure diagnostics", async () => {
	const config: TreesConfig = {
		defaults: {},
		projects: [],
		rules: [
			{
				// eslint-disable-next-line unicorn/no-null -- This rule supplies no bootstrap command.
				command: null,
				preRemoteCheck: "check-network",
				rootGlob: "/repo",
			},
		],
		worktreeLocation: "sibling",
	};
	const calls: string[][] = [];
	await expect(
		runPreRemoteCheck(
			{
				config: { explain: explainPolicy, read: () => config },
				hooks: {
					runCommand: (script, cwd) => {
						calls.push([script, cwd]);
						return Promise.resolve({ exitCode: 1, stderr: ["offline"], stdout: [] });
					},
					runInline: () => Promise.resolve(),
				},
			},
			{ config, operation: "wktree add", root: "/repo" },
		),
	).rejects.toMatchObject({
		exitCode: 10,
		name: PreRemoteCheckError.name,
		stderr: "offline",
	});
	expect(calls).toEqual([["check-network", "/repo"]]);
});

test("list rendering retains Git metadata when worktree values are copied", () => {
	const worktrees = parseWorktreeList(
		"worktree /repo\nHEAD abc\nbranch refs/heads/main\nlocked maintenance\nprunable missing checkout\n",
	);
	expect(worktrees.map((worktree) => toListJson({ ...worktree }))).toMatchObject([
		{
			lock_reason: "maintenance",
			locked: true,
			prunable: true,
			prunable_reason: "missing checkout",
			session: { name: "repo", path: "/repo" },
		},
	]);
});
