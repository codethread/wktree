import { BlockedError, EXIT_CODES, dispatch } from "../../src/index";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	deps,
	initRepo,
	restoreTestEnv,
	run,
	setTestEnv,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { join } from "node:path";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { tmpdir } from "node:os";

const { initRepoWithOrigin } = useOriginFixture();

let tmp = "";

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "wktree-test-"));
	setTestEnv("HOME", tmp);
	setTestEnv("XDG_STATE_HOME", join(tmp, "state"));
	setTestEnv("GIT_CONFIG_NOSYSTEM", "1");
	setTestEnv("GIT_CONFIG_GLOBAL", join(tmp, "gitconfig"));
	setTestEnv("XDG_CONFIG_HOME", join(tmp, "config"));
});

afterEach(async () => {
	restoreTestEnv();
	await rm(tmp, { force: true, recursive: true });
});

async function initQueryRepo() {
	const root = join(tmp, "repo");
	await initRepo(root);
	return realpath(root);
}

async function writeRawConfig(configHome: string, content: string) {
	await mkdir(configHome, { recursive: true });
	await writeFile(join(configHome, "wktree.toml"), content);
	setTestEnv("XDG_CONFIG_HOME", configHome);
}

async function assertCanonicalList(root: string) {
	const listResult = await dispatch("list", ["--cwd", root], deps);
	expect(listResult.stdout).toContain(`${root}  `);
	expect(listResult.stdout).toContain("[main]");
	expect(listResult.stdout).toContain("[canonical]");

	const jsonResult = await dispatch("list", ["--cwd", root, "--json"], deps);
	const parsed = JSON.parse(jsonResult.stdout ?? "{}");
	const [canonical] = parsed.worktrees;
	expect(parsed).toMatchObject({ diagnostics: [], kind: "list", ok: true, setup_output: [] });
	expect(canonical).toMatchObject({
		branch: "main",
		branch_ref: "refs/heads/main",
		canonical: true,
		locked: false,
		path: root,
		// oxlint-disable-next-line unicorn/no-null -- Assert the explicit-null JSON protocol contract.
		pool: null,
		prunable: false,
	});
	expect(canonical.branchRef).toBeUndefined();
}

test("root, list, json list, and non-pool path against a real repo #test-292", async () => {
	const root = await initQueryRepo();
	writeConfig({ command: "echo ready", root, tmp });

	const rootResult = await dispatch("root", ["--cwd", root], deps);
	expect(rootResult.stdout).toBe(`${root}\n`);

	await assertCanonicalList(root);

	const pathResult = await dispatch("path", ["--cwd", root, "--branch", "feature/cool"], deps);
	expect(pathResult.stdout).toBe(`${root}__feature--cool\n`);
});

test("config explain reports effective policy JSON #test-293", async () => {
	const root = await initQueryRepo();
	const configHome = join(tmp, ".config");
	await writeRawConfig(
		configHome,
		`[defaults.finish]\n` +
			`strategy = "rebase_ff"\n` +
			`\n` +
			`[[rule]]\n` +
			`root_glob = "${await realpath(tmp)}/**"\n` +
			`[rule.add]\n` +
			`policy = "fresh_canonical"\n` +
			`[rule.finish]\n` +
			`push = true\n` +
			`\n` +
			`[[project]]\n` +
			`name = "repo"\n` +
			`root = "${root}"\n` +
			`[project.finish]\n` +
			`delete_branch = true\n`,
	);

	setTestEnv("XDG_CONFIG_HOME", "");
	const result = await dispatch("config", ["explain", "--cwd", root, "--json"], deps);
	const payload = JSON.parse(result.stdout ?? "{}");

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(payload).toEqual({
		add: { policy: "fresh_canonical" },
		// oxlint-disable-next-line unicorn/no-null -- Assert the explicit-null JSON protocol contract.
		command: { source: null, value: null },
		diagnostics: [],
		finish: {
			delete_branch: true,
			enabled: true,
			push: true,
			remove_worktree: false,
			strategy: "rebase_ff",
		},
		kind: "config_explain",
		matched_rules: [{ root_glob: `${await realpath(tmp)}/**` }],
		ok: true,
		// oxlint-disable-next-line unicorn/no-null -- Assert the explicit-null JSON protocol contract.
		pre_remote_check: { source: null, value: null },
		project: { name: "repo", root },
		root,
		setup: {
			copy: [],
			copy_mode_default: "copy",
			name: "repo",
			// oxlint-disable-next-line unicorn/no-null -- No configured pool has an explicit null size.
			pool_size: null,
		},
		setup_output: [],
		worktree_location: "sibling",
	});
});

test("list remains available with malformed config #test-294", async () => {
	const root = await initQueryRepo();
	await writeRawConfig(join(tmp, "config"), "[[project]]\nroot = ");

	await assertCanonicalList(root);
});

async function initLockedPool() {
	const configRoot = join(tmp, "repo");
	const { root } = await initRepoWithOrigin(tmp);
	await run(["git", "-C", root, "worktree", "add", "-b", "wk-pool/feat1", `${root}__feat1`]);
	await run(["git", "-C", root, "worktree", "lock", "--reason", "keep slot", `${root}__feat1`]);
	const configHome = join(tmp, "config");
	await writeRawConfig(
		configHome,
		`[[project]]\nroot = "${configRoot}"\ncommand = "echo ready"\npool_size = 1\n`,
	);
	return root;
}

test("pooled path refuses an unallocated branch #test-290", async () => {
	const root = await initLockedPool();

	const { failure } = await dispatch("path", ["--cwd", root, "--branch", "feature/cool"], deps);
	expect(failure).toBeInstanceOf(BlockedError);
});
