import type { GitResult, GitRunOptions } from "../../src/services.ts";
import { expect, test } from "bun:test";
import { PreRemoteCheckError } from "../../src/errors.ts";
import type { TreesConfig } from "../../src/domain/config.ts";
import { buildPoolState } from "../../src/application/pool.ts";
import { explainPolicy } from "../../src/domain/config.ts";
import { parseWorktreeList } from "../../src/git/worktrees.ts";
import { runPreRemoteCheck } from "../../src/application/hooks.ts";
import { toListJson } from "../../src/protocol.ts";

function run(args: string[], _options?: GitRunOptions): Promise<GitResult> {
	let stdout = "";
	if (args.includes("symbolic-ref")) {
		stdout = "refs/remotes/origin/main\n";
	} else if (args.includes("log")) {
		stdout = "2026-01-01T00:00:00Z\u001Finitial\n";
	} else if (args.includes("rev-parse")) {
		stdout = "../repo/.git/worktrees/feat1/wk-pool-initialized\n";
	}
	return Promise.resolve({ exitCode: 0, stderr: "", stdout });
}

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

test("pool status observes initialization through the injected filesystem", async () => {
	const worktrees = parseWorktreeList(
		"worktree /repo\n" +
			"HEAD abc\n" +
			"branch refs/heads/main\n" +
			"\n" +
			"worktree /repo__feat1\n" +
			"HEAD abc\n" +
			"branch refs/heads/wk-pool/feat1\n",
	);

	const observedPaths: string[] = [];
	const state = await buildPoolState({
		deps: {
			files: {
				exists: (path) => {
					observedPaths.push(path);
					return true;
				},
				normalizePath: (path) => path,
			},
			git: { run, runRaw: run },
		},
		project: {
			command: "setup",
			copy: [],
			copyModeDefault: "copy",
			name: "repo",
			poolSize: 1,
			root: "/repo",
		},
		worktrees,
	});
	const [slot] = state.slots;
	expect(slot).toMatchObject({ dirty: false, initialized: true, placeholder: true });
	expect(observedPaths).toEqual(["/repo/.git/worktrees/feat1/wk-pool-initialized"]);
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
