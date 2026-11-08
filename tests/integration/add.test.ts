import { EXIT_CODES, ReservedPrefixError, dispatch } from "../../src/index";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { basename, join } from "node:path";
import {
	deps,
	pathExists,
	run,
	setTestEnv,
	testDeps,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
import { expect, test } from "bun:test";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { runCli, useTmpHome } from "./lifecycle-helpers.ts";
import { createRemoteBranch } from "./remote-history.ts";

const tmp = useTmpHome("wktree-add-test-");
const { initRepoWithOrigin } = useOriginFixture();

async function prepareExistingBranch(branch: string, source: string) {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	if (source !== "local") {
		await createRemoteBranch(remote, branch);
	}
	if (source === "local") {
		await run(["git", "-C", root, "branch", branch]);
	}
	if (source === "both") {
		await run(["git", "-C", root, "fetch", "origin"]);
		await run(["git", "-C", root, "branch", branch, `origin/${branch}`]);
	}
	return root;
}

// oxlint-disable-next-line max-statements -- Verify native setup and its default scratch destination together.
test("adds a new branch, runs setup, and writes ready JSON to stdout #test-245", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: `echo "$WK_ROOT" > "$WK_CREATED/hook-sentinel"`, root, tmp: tmp.dir });
	const live = testDeps();
	setTestEnv("XDG_STATE_HOME", "relative/state");
	const result = await dispatch("add", ["--cwd", root, "--branch", "feature/new", "--json"], {
		...live,
		hooks: {
			...live.hooks,
			runInline: (path, options) => {
				expect(path).toStartWith(join(tmp.dir, ".local/state/wktree/"));
				return live.hooks.runInline(path, options);
			},
		},
	});

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	const worktreePath = `${root}__feature--new`;
	expect(await pathExists(join(worktreePath, ".git"))).toBe(true);
	const plan = JSON.parse(result.stdout ?? "{}");
	expect(plan).toMatchObject({
		branch: "feature/new",
		created_new_branch: true,
		kind: "ready",
		// oxlint-disable-next-line unicorn/no-null -- The JSON protocol explicitly reports absent script paths as null.
		post_create_script_path: null,
		root,
		session: {
			name: basename(worktreePath).replaceAll(".", "_"),
			path: worktreePath,
		},
		title: "feature/new",
		worktree_path: worktreePath,
	});
	expect(await readFile(join(worktreePath, "hook-sentinel"), "utf8")).toBe(`${root}\n`);
});
test("--json captures setup output in the payload and keeps stderr silent #test-246", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo setup-stdout\necho setup-stderr >&2", root, tmp: tmp.dir });

	const { stdout, stderr, exitCode } = await runCli([
		"add",
		"--cwd",
		root,
		"--branch",
		"feature/noisy",
		"--json",
	]);

	expect(exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(stderr).toBe("");
	const payload = JSON.parse(stdout);
	expect(payload).toMatchObject({ branch: "feature/noisy", kind: "ready", ok: true });
	expect(payload.setup_output).toContainEqual({ line: "setup-stdout", stream: "stdout" });
	expect(payload.setup_output).toContainEqual({ line: "setup-stderr", stream: "stderr" });
});
test("uses inherited rule command for a repo without exact project config #test-248", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	const configHome = join(tmp.dir, "config-rule-command");
	await mkdir(configHome, { recursive: true });
	await writeFile(
		join(configHome, "wktree.toml"),
		`[[rule]]\n` +
			`root_glob = "${await realpath(tmp.dir)}/**"\n` +
			`command = '''\n` +
			`echo inherited > "$WK_CREATED/rule-sentinel"\n` +
			`'''\n`,
	);
	setTestEnv("XDG_CONFIG_HOME", configHome);

	await dispatch("add", ["--cwd", root, "--branch", "feature/rule-command", "--json"], testDeps());

	expect(await readFile(join(`${root}__feature--rule-command`, "rule-sentinel"), "utf8")).toBe(
		"inherited\n",
	);
});
test("copies configured files before running setup #test-247", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	await writeFile(join(root, ".env"), "SECRET=setup\n");
	writeConfig({
		command: 'cat .env > "$WK_CREATED/hook-read-env"',
		copyToml: 'copy = [".env"]\n',
		root,
		tmp: tmp.dir,
	});

	await dispatch("add", ["--cwd", root, "--branch", "feature/copy-setup", "--json"], testDeps());
	const worktreePath = `${root}__feature--copy-setup`;

	expect(await readFile(join(worktreePath, ".env"), "utf8")).toBe("SECRET=setup\n");
	expect(await readFile(join(worktreePath, "hook-read-env"), "utf8")).toBe("SECRET=setup\n");
});
test.each([
	{ branch: "feature/local", name: "existing local", source: "local" },
	{ branch: "feature/remote", name: "existing remote-only", source: "remote" },
	{ branch: "feature/both", name: "existing local and remote", source: "both" },
])("adds $name branch #test-244", async ({ branch, source }) => {
	const root = await prepareExistingBranch(branch, source);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });

	const result = await dispatch("add", ["--cwd", root, "--branch", branch, "--json"], deps);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(JSON.parse(result.stdout ?? "{}").worktree_path).toBe(
		`${root}__${branch.replaceAll("/", "--")}`,
	);
});
test("non-json add prints a one-line summary to stderr #test-251", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });

	const result = await dispatch("add", ["--cwd", root, "--branch", "feature/human"], deps);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(result.stdout).toBeUndefined();
	expect(result.stderr).toBe(`wktree: added feature/human at ${root}__feature--human\n`);
});
test("accepts --force for wrapper compatibility #test-249", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });
	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/force", "--force", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(await pathExists(`${root}__feature--force`)).toBe(true);
});
test("without project config post_create_script_path is null #test-250", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	setTestEnv("XDG_CONFIG_HOME", join(tmp.dir, "empty-config"));

	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/no-project", "--json"],
		deps,
	);

	expect(JSON.parse(result.stdout ?? "{}").post_create_script_path).toBeNull();
});
test("rejects reserved pool branch prefix #test-252", async () => {
	// Reserved branch syntax is refused before repository discovery.
	const root = "/unused";
	const { failure } = await dispatch(
		"add",
		["--cwd", root, "--branch", "wk-pool/feat1", "--json"],
		deps,
	);
	expect(failure).toBeInstanceOf(ReservedPrefixError);
});
