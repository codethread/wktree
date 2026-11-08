import { EXIT_CODES, dispatch } from "../../src/index";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	commitFile,
	createTestCdDirective,
	createTestMultiplexer,
	createWorktree,
	pathExists,
	restoreTestEnv,
	setTestEnv,
	testDeps,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
/* oxlint-disable-next-line import/no-nodejs-modules -- interactive fixtures create real repositories on disk */
import { mkdtemp, rm } from "node:fs/promises";
import type { Deps } from "../../src/services.ts";
/* oxlint-disable-next-line import/no-nodejs-modules -- fixture paths are built with node:path */
import { join } from "node:path";
/* oxlint-disable-next-line import/no-nodejs-modules -- fixtures live in the host temporary directory */
import { tmpdir } from "node:os";

const POOL_SIZE = 1;

const { initRepoWithOrigin } = useOriginFixture();

function interactiveDeps(attached = true) {
	const log: string[] = [];
	const multiplexer = createTestMultiplexer(attached, log);
	const cdDirective = createTestCdDirective(log);
	const warnings: string[] = [];
	const deps = testDeps({
		cdDirective,
		multiplexer,
		progress: {
			banner: () => {},
			error: (msg) => warnings.push(msg),
			stream: () => {},
		},
	});
	return { cdDirective, deps, log, multiplexer, warnings };
}

async function run(subcommand: string, args: string[], deps: Deps) {
	const result = await dispatch(subcommand, args, deps);
	await result.afterOutput?.();
	return result;
}

let tmp = "";
let root = "";

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "wktree-interactive-test-"));
	setTestEnv("HOME", tmp);
	setTestEnv("XDG_STATE_HOME", join(tmp, "state"));
	setTestEnv("GIT_CONFIG_NOSYSTEM", "1");
	setTestEnv("GIT_CONFIG_GLOBAL", join(tmp, "gitconfig"));
	setTestEnv("XDG_CONFIG_HOME", join(tmp, "config"));
	({ root } = await initRepoWithOrigin(tmp));
	writeConfig({ command: "echo ready", root, tmp });
});

afterEach(async () => {
	restoreTestEnv();
	await rm(tmp, { force: true, recursive: true });
});

describe("wktree --interactive add", () => {
	test("add opens the new worktree's session after output #test-218", async () => {
		const { deps, log, multiplexer } = interactiveDeps();

		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/open", "--json", "--interactive"],
			deps,
		);

		expect(log).toEqual([]);
		await result.afterOutput?.();
		expect(multiplexer.opened).toEqual([
			{
				name: "repo__feature--open",
				path: `${root}__feature--open`,
				title: "feature/open",
			},
		]);
		expect(log).toEqual([`open ${root}__feature--open`]);
	});

	test("add outside a multiplexer writes the worktree path to the cd directive #test-223", async () => {
		const { deps, log } = interactiveDeps(false);

		await run("add", ["--cwd", root, "--branch", "feature/cd", "--interactive"], deps);

		expect(log).toEqual([`cd ${root}__feature--cd`]);
	});

	test("without --interactive, add and remove make no session calls or cd directive #test-221", async () => {
		const { deps, log } = interactiveDeps();

		await run("add", ["--cwd", root, "--branch", "feature/quiet", "--json"], deps);
		const worktreePath = `${root}__feature--quiet`;
		const result = await run(
			"remove",
			["--cwd", worktreePath, "--branch", "feature/quiet", "--json"],
			deps,
		);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(result.afterOutput).toBeUndefined();
		expect(log).toEqual([]);
	});
});

describe("wktree --interactive remove", () => {
	test("remove from inside the worktree writes the canonical root, then closes sessions last #test-222", async () => {
		const { deps, log } = interactiveDeps();
		await createWorktree({ root, branch: "feature/leave", path: `${root}__feature--leave` });
		const worktreePath = `${root}__feature--leave`;

		const result = await dispatch(
			"remove",
			["--cwd", join(worktreePath, "."), "--branch", "feature/leave", "--json", "--interactive"],
			deps,
		);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(await pathExists(worktreePath)).toBe(false);
		expect(log).toEqual([]);

		await result.afterOutput?.();
		expect(log).toEqual([`cd ${root}`, `close ${worktreePath}`]);
	});

	test("remove from outside the worktree closes sessions without a cd directive #test-220", async () => {
		const { deps, log } = interactiveDeps();
		await createWorktree({ root, branch: "feature/other", path: `${root}__feature--other` });

		await run(
			"remove",
			["--cwd", root, "--branch", "feature/other", "--json", "--interactive"],
			deps,
		);

		expect(log).toEqual([`close ${root}__feature--other`]);
	});
});

describe("wktree --interactive sessions", () => {
	test("pooled add opens the slot and pooled remove leaves and closes it #test-217", async () => {
		writeConfig({ command: "echo ready", poolSize: POOL_SIZE, root, tmp });
		const { deps, log } = interactiveDeps();
		const slotPath = `${root}__feat1`;

		await run(
			"add",
			["--cwd", root, "--branch", "feature/pooled", "--json", "--interactive"],
			deps,
		);
		await run(
			"remove",
			["--cwd", slotPath, "--branch", "feature/pooled", "--keep-branch", "--json", "--interactive"],
			deps,
		);

		expect(await pathExists(slotPath)).toBe(true);
		expect(log).toEqual([`open ${slotPath}`, `cd ${root}`, `close ${slotPath}`]);
	});

	test("session failures warn without undoing the removal #test-219", async () => {
		const { deps, warnings } = interactiveDeps();
		await createWorktree({ root, branch: "feature/warn", path: `${root}__feature--warn` });
		warnings.length = 0;
		deps.multiplexer.closeUnder = () => Promise.reject(new Error("tmux exploded"));

		const result = await run(
			"remove",
			["--cwd", root, "--branch", "feature/warn", "--json", "--interactive"],
			deps,
		);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(await pathExists(`${root}__feature--warn`)).toBe(false);
		expect(warnings).toEqual(["warning: couldn't close multiplexer sessions: tmux exploded"]);
	});
});

describe("wktree --interactive finish", () => {
	test("finish cleanup leaves the removed worktree and closes its sessions #test-215", async () => {
		writeConfig({
			command: "echo ready",
			copyToml: "[project.finish]\nremove_worktree = true\n",
			root,
			tmp,
		});
		const { deps, log } = interactiveDeps();
		await createWorktree({ root, branch: "feature/finish", path: `${root}__feature--finish` });
		const worktreePath = `${root}__feature--finish`;
		await commitFile({ content: "a\n", message: "work", path: "a.txt", repo: worktreePath });

		const result = await dispatch(
			"finish",
			["--cwd", worktreePath, "--json", "--interactive"],
			deps,
		);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(log).toEqual([]);
		await result.afterOutput?.();
		expect(log).toEqual([`cd ${root}`, `close ${worktreePath}`]);
	});

	test("finish without cleanup leaves sessions alone #test-216", async () => {
		const { deps, log } = interactiveDeps();
		await createWorktree({ root, branch: "feature/keep", path: `${root}__feature--keep` });
		const worktreePath = `${root}__feature--keep`;
		await commitFile({ content: "b\n", message: "work", path: "b.txt", repo: worktreePath });

		const result = await run("finish", ["--cwd", worktreePath, "--json", "--interactive"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(log).toEqual([]);
	});
});
