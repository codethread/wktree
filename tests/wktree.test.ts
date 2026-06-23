import {afterAll, afterEach, beforeEach, describe, expect, test} from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import {homedir, tmpdir} from "node:os";
import {basename, join, resolve} from "node:path";
import {LiveGitRunner} from "../src/git/executor";
import {
	branchExistsInList,
	parseTrunkFromRemoteShow,
	parseTrunkFromSymbolicRef,
	parseWorktreeList,
} from "../src/git/worktrees";
import type {Deps} from "../src/main";
import {
	buildPoolState,
	ConfigError,
	dispatch,
	EXIT_CODES,
	explainPolicy,
	generatePostCreateScript,
	HookError,
	LiveHookRunner,
	PickerCancelled,
	parseConfig,
	resolveEffectiveCommand,
} from "../src/main";

const integrationDescribe = process.env.WKTREE_SKIP_INTEGRATION === "1" ? describe.skip : describe;

const deps: Deps = {
	git: new LiveGitRunner(),
	hooks: {runInline: async () => undefined},
	picker: {
		pick: async () => ({key: "", display: "", preview: ""}),
		confirm: async () => true,
	},
	progress: {
		banner: () => undefined,
		stream: () => undefined,
		error: () => undefined,
	},
};

describe("wktree dispatch", () => {
	test("prints help with exit code 0", async () => {
		const result = await dispatch("--help", [], deps);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Usage: wktree <subcommand>");
	});

	test("prints usage with exit code 12 for unknown subcommands", async () => {
		const result = await dispatch("somebogus", [], deps);
		expect(result.exitCode).toBe(12);
		expect(result.stderr).toContain("Usage: wktree <subcommand>");
	});
});

describe("parseConfig", () => {
	test("parses a valid pooled project", () => {
		const config = parseConfig(`
[[project]]
name = "app"
root = "~/work/app"
command = "yarn install"
pool_size = 5
`);

		expect(config.projects).toEqual([
			{
				name: "app",
				root: resolve(homedir(), "work/app"),
				command: "yarn install",
				poolSize: 5,
				copyModeDefault: "copy",
				copy: [],
			},
		]);
	});

	test("parses a valid non-pooled project with default name and no copy field", () => {
		const config = parseConfig(`
[[project]]
root = "./relative/repo"
command = "echo ready"
`);

		expect(config.projects).toEqual([
			{
				name: "repo",
				root: resolve("./relative/repo"),
				command: "echo ready",
				poolSize: null,
				copyModeDefault: "copy",
				copy: [],
			},
		]);
	});

	test("parses string copy entries", () => {
		expect(
			parseConfig(`
[[project]]
root = "/tmp/repo"
command = "echo ok"
copy = [".env"]
`).projects[0]?.copy,
		).toEqual([{from: ".env", to: [".env"], mode: "copy"}]);
	});

	test("parses object copy entries with single and multiple destinations", () => {
		expect(
			parseConfig(`
[[project]]
root = "/tmp/repo"
command = "echo ok"
copy = [{ from = ".env", to = [".env.local", ".env.test"] }]
`).projects[0]?.copy,
		).toEqual([{from: ".env", to: [".env.local", ".env.test"], mode: "copy"}]);
	});

	test("parses project copy mode default and per-entry overrides", () => {
		const project = parseConfig(`
[[project]]
root = "/tmp/repo"
command = "echo ok"
copy_mode_default = "symlink"
copy = [".env", { from = "local.env", to = "local.env", mode = "copy" }]
`).projects[0];

		expect(project?.copyModeDefault).toBe("symlink");
		expect(project?.copy).toEqual([
			{from: ".env", to: [".env"], mode: "symlink"},
			{from: "local.env", to: ["local.env"], mode: "copy"},
		]);
	});

	test("parses mixed pooled and non-pooled projects", () => {
		const config = parseConfig(`
[[project]]
root = "/tmp/one"
command = "echo one"

[[project]]
root = "/tmp/two"
command = "echo two"
pool_size = 2
`);

		expect(config.projects).toHaveLength(2);
		expect(config.projects[0]?.poolSize).toBeNull();
		expect(config.projects[1]?.poolSize).toBe(2);
	});

	test("ignores unknown fields on project entries", () => {
		const config = parseConfig(`
[[project]]
root = "/tmp/unknown"
command = "echo ok"
future_field = "ignored"
`);

		expect(config.projects[0]).toEqual({
			name: "unknown",
			root: "/tmp/unknown",
			command: "echo ok",
			poolSize: null,
			copyModeDefault: "copy",
			copy: [],
		});
	});

	test.each([
		{name: "missing root", toml: '[[project]]\ncommand = "echo ok"', message: "root"},
		{
			name: "pool_size zero",
			toml: '[[project]]\nroot = "/tmp/repo"\ncommand = "x"\npool_size = 0',
			message: "pool_size",
		},
		{
			name: "pool_size negative",
			toml: '[[project]]\nroot = "/tmp/repo"\ncommand = "x"\npool_size = -1',
			message: "pool_size",
		},
		{
			name: "pool_size non-integer",
			toml: '[[project]]\nroot = "/tmp/repo"\ncommand = "x"\npool_size = 1.5',
			message: "pool_size",
		},
	])("throws ConfigError for $name", ({toml, message}) => {
		expect(() => parseConfig(toml)).toThrow(ConfigError);
		expect(() => parseConfig(toml)).toThrow(message);
	});

	test("rejects duplicate expanded roots", () => {
		expect(() =>
			parseConfig(`
[[project]]
root = "~/same"
command = "echo one"

[[project]]
root = "${resolve(homedir(), "same")}"
command = "echo two"
`),
		).toThrow(ConfigError);
	});

	test("rejects legacy post_create entries with migration hint", () => {
		expect(() =>
			parseConfig(`
[[post_create]]
root = "/tmp/repo"
command = "echo old"
`),
		).toThrow("rename [[post_create]] to [[project]]");
	});

	test("rejects shell field with bash-only hint", () => {
		expect(() =>
			parseConfig(`
[[project]]
root = "/tmp/repo"
command = "echo ok"
shell = "nu"
`),
		).toThrow("command always runs under bash");
	});

	test("resolves built-in policy defaults", () => {
		const policy = explainPolicy(parseConfig(""), "/tmp/repo");
		expect(policy.addPolicy).toBe("origin_default");
		expect(policy.finishPolicy).toEqual({
			enabled: true,
			strategy: "ff_only",
			push: false,
			removeWorktree: false,
			deleteBranch: false,
		});
	});

	test("matching rules apply in file order with later fields winning", () => {
		const config = parseConfig(`
[[rule]]
root_glob = "/tmp/**"
command = "echo first"
[rule.add]
policy = "fresh_canonical"
[rule.finish]
strategy = "squash"
push = true

[[rule]]
root_glob = "/tmp/repo"
command = "echo second"
[rule.finish]
push = false
remove_worktree = true
`);
		const policy = explainPolicy(config, "/tmp/repo");
		expect(policy.matchedRules.map((rule) => rule.rootGlob)).toEqual(["/tmp/**", "/tmp/repo"]);
		expect(policy.addPolicy).toBe("fresh_canonical");
		expect(policy.finishPolicy).toMatchObject({strategy: "squash", push: false, removeWorktree: true});
		expect(resolveEffectiveCommand(config, "/tmp/repo")).toEqual({
			command: "echo second",
			source: "rule:/tmp/repo",
		});
	});

	test("exact project command overrides inherited rule command", () => {
		const config = parseConfig(`
[[rule]]
root_glob = "/tmp/**"
command = "echo rule"

[[project]]
root = "/tmp/repo"
command = "echo project"
`);
		expect(resolveEffectiveCommand(config, "/tmp/repo")).toEqual({
			command: "echo project",
			source: "project:/tmp/repo",
		});
	});

	test("inherited rule command satisfies pooled and copy setup requirement", () => {
		const config = parseConfig(`
[[rule]]
root_glob = "/tmp/**"
command = "echo inherited"

[[project]]
root = "/tmp/repo"
pool_size = 1
copy = [".env"]
`);
		expect(config.projects[0]?.command).toBeNull();
		expect(resolveEffectiveCommand(config, "/tmp/repo").command).toBe("echo inherited");
	});

	test.each([
		{name: "pool_size", extra: "pool_size = 1"},
		{name: "copy", extra: 'copy = [".env"]'},
		{name: "copy_mode_default", extra: 'copy_mode_default = "symlink"'},
	])("requires command when project uses $name", ({extra}) => {
		expect(() =>
			parseConfig(`
[[project]]
root = "/tmp/repo"
${extra}
`),
		).toThrow(ConfigError);
	});

	test("exact project overrides matching rule and can omit command for policy only", () => {
		const config = parseConfig(`
[[rule]]
root_glob = "/tmp/**"
[rule.add]
policy = "fresh_canonical"
[rule.finish]
strategy = "squash"

[[project]]
name = "repo"
root = "/tmp/repo"
[project.add]
policy = "origin_default"
[project.finish]
enabled = false
`);
		const project = config.projects[0];
		expect(project?.command).toBeNull();
		const policy = explainPolicy(config, "/tmp/repo");
		expect(policy.project?.name).toBe("repo");
		expect(policy.addPolicy).toBe("origin_default");
		expect(policy.finishPolicy).toMatchObject({enabled: false, strategy: "squash"});
	});

	test("finish policy merges field-by-field across defaults rules and project", () => {
		const policy = explainPolicy(
			parseConfig(`
[defaults.finish]
strategy = "rebase_ff"
push = true

[[rule]]
root_glob = "/tmp/**"
[rule.finish]
remove_worktree = true

[[project]]
root = "/tmp/repo"
[project.finish]
delete_branch = true
`),
			"/tmp/repo",
		);
		expect(policy.finishPolicy).toEqual({
			enabled: true,
			strategy: "rebase_ff",
			push: true,
			removeWorktree: true,
			deleteBranch: true,
		});
	});

	test.each([
		{config: '[defaults.add]\npolicy = "bad"', message: "policy"},
		{config: '[defaults.finish]\nstrategy = "bad"', message: "strategy"},
		{config: '[defaults.finish]\npush = "yes"', message: "boolean"},
		{config: '[[rule]]\nroot_glob = "~repo/*"', message: "root_glob"},
		{config: 'defaults = "bad"', message: "defaults"},
		{config: '[defaults.add]\npolciy = "fresh_canonical"', message: "unknown field"},
		{config: "[defaults.finish]\nremoveWorktree = true", message: "unknown field"},
	])("invalid policy config fails loudly", ({config, message}) => {
		expect(() => parseConfig(config)).toThrow(ConfigError);
		expect(() => parseConfig(config)).toThrow(message);
	});
});

describe("git worktree parsers", () => {
	test("parses a canonical-only worktree", () => {
		const worktrees = parseWorktreeList(`worktree /repo\nHEAD abc123\nbranch refs/heads/main\n`);

		expect(worktrees).toEqual([
			{
				path: "/repo",
				head: "abc123",
				branch: "main",
				branchRef: "refs/heads/main",
				detached: false,
				bare: false,
				canonical: true,
				pool: null,
			},
		]);
	});

	test("annotates free and taken pool slots", () => {
		const worktrees = parseWorktreeList(
			`worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /repo__feat1\nHEAD bbb\nbranch refs/heads/wk-pool/feat1\n\nworktree /repo__feat2\nHEAD ccc\nbranch refs/heads/my-feature\n`,
		);

		expect(worktrees[1]?.pool).toEqual({index: 1, placeholder: true});
		expect(worktrees[1]?.branch).toBe("wk-pool/feat1");
		expect(worktrees[2]?.pool).toEqual({index: 2, placeholder: false});
		expect(worktrees[2]?.branch).toBe("my-feature");
	});

	test("parses detached HEAD without a branch", () => {
		const worktrees = parseWorktreeList(`worktree /repo\nHEAD abc123\ndetached\n`);

		expect(worktrees[0]?.detached).toBe(true);
		expect(worktrees[0]?.branch).toBeNull();
		expect(worktrees[0]?.branchRef).toBeNull();
	});

	test("parses bare repositories", () => {
		const worktrees = parseWorktreeList(`worktree /repo.git\nbare\n`);

		expect(worktrees[0]?.bare).toBe(true);
		expect(worktrees[0]?.head).toBeNull();
	});

	test("parses symbolic-ref trunk names", () => {
		expect(parseTrunkFromSymbolicRef("refs/remotes/origin/main\n")).toBe("main");
		expect(parseTrunkFromSymbolicRef("refs/remotes/origin/develop\n")).toBe("develop");
		expect(parseTrunkFromSymbolicRef("\n")).toBeNull();
	});

	test("parses remote show default branch", () => {
		expect(
			parseTrunkFromRemoteShow(
				"* remote origin\n  Fetch URL: git@example.test/repo\n  HEAD branch: develop\n",
			),
		).toBe("develop");
		expect(parseTrunkFromRemoteShow("* remote origin\n  Fetch URL: git@example.test/repo\n")).toBeNull();
		expect(parseTrunkFromRemoteShow("* remote origin\n  HEAD branch: (unknown)\n")).toBeNull();
	});

	test("checks exact branch existence from branch list output", () => {
		expect(branchExistsInList("* main\n  feature\n  feature-extra\n", "feature")).toBe(true);
		expect(branchExistsInList("* main\n+ checked-out-elsewhere\n", "checked-out-elsewhere")).toBe(true);
		expect(branchExistsInList("* main\n  feature-extra\n", "feature")).toBe(false);
	});
});

describe("post-create scripts", () => {
	test("generates non-pooled post-create script", () => {
		expect(
			generatePostCreateScript({
				projectName: "app",
				root: "/tmp/repo",
				created: "/tmp/repo__feature",
				command: "echo ready",
				pooled: false,
			}),
		).toMatchSnapshot();
	});

	test("generates pooled post-create script with marker tail", () => {
		expect(
			generatePostCreateScript({
				projectName: "app",
				root: "/tmp/repo",
				created: "/tmp/repo__feat1",
				command: "echo ready",
				pooled: true,
			}),
		).toMatchSnapshot();
	});

	test("single-quotes paths with spaces and embedded quotes", () => {
		const script = generatePostCreateScript({
			projectName: "quoted",
			root: "/tmp/root with spaces",
			created: "/tmp/root with spaces__feat1",
			command: 'echo "$WK_CREATED"',
			pooled: false,
		});

		expect(script).toContain("export WK_ROOT='/tmp/root with spaces'");
		expect(script).toContain('echo "$WK_CREATED"');
	});
});

describe("LiveHookRunner", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wktree-hook-test-"));
	});

	afterEach(() => {
		rmSync(tmp, {recursive: true, force: true});
	});

	test("streams output before process exit", async () => {
		const script = join(tmp, "hook.sh");
		// sleep 0.1 ensures "second" hasn't arrived when we check after the first-line promise resolves
		writeFileSync(script, "echo first\nsleep 0.1\necho second\n");
		chmodSync(script, 0o755);
		const seen: string[] = [];
		const runner = new LiveHookRunner();

		let resolveFirstLine!: () => void;
		const firstLine = new Promise<void>((r) => {
			resolveFirstLine = r;
		});

		const promise = runner.runInline(script, tmp, {}, (stream, line) => {
			seen.push(`${stream}:${line}`);
			resolveFirstLine();
		});

		await firstLine;
		expect(seen).toEqual(["stdout:first"]);
		await promise;
		expect(seen).toEqual(["stdout:first", "stdout:second"]);
	});

	test("throws HookError with exit code and slot path on failure", async () => {
		const script = join(tmp, "hook.sh");
		writeFileSync(script, "echo bad >&2\nexit 7\n");
		chmodSync(script, 0o755);
		const runner = new LiveHookRunner();

		try {
			await runner.runInline(script, tmp, {}, () => undefined);
			throw new Error("expected hook to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(HookError);
			expect((error as HookError).hookExitCode).toBe(7);
			expect((error as HookError).slotPath).toBe(tmp);
		}
	});
});

describe("LiveGitRunner", () => {
	test("runs git --version", async () => {
		const git = new LiveGitRunner();
		const result = await git.run(["--version"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("git version");
	});
});

integrationDescribe("wktree non-pool add", () => {
	let tmp: string;
	let originalConfigHome: string | undefined;
	let originalHome: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wktree-add-test-"));
		originalConfigHome = process.env.XDG_CONFIG_HOME;
		originalHome = process.env.HOME;
		process.env.HOME = tmp;
	});

	afterEach(() => {
		if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalConfigHome;
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		rmSync(tmp, {recursive: true, force: true});
	});

	test("adds a new branch, writes ready JSON to stdout, and post-create script is re-executable", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, `echo hook > "$WK_CREATED/hook-sentinel"`);

		const result = await dispatch("add", ["--cwd", root, "--branch", "feature/new", "--json"], deps);

		expect(result.exitCode).toBe(0);
		const worktreePath = `${root}__feature--new`;
		expect(existsSync(join(worktreePath, ".git"))).toBe(true);
		const plan = JSON.parse(result.stdout ?? "{}");
		expect(plan).toMatchObject({
			kind: "ready",
			worktree_path: worktreePath,
			branch: "feature/new",
			root,
			title: "feature/new",
			created_new_branch: true,
			session: {
				name: basename(worktreePath).replaceAll(".", "_"),
				path: worktreePath,
			},
		});
		expect(plan.post_create_script_path).toContain(`/${plan.session.name}.wktree.`);
		expect(plan.post_create_script_path).toEndWith("/post-create.sh");
		await run(["bash", plan.post_create_script_path]);
		await run(["bash", plan.post_create_script_path]);
		expect(readFileSync(join(worktreePath, "hook-sentinel"), "utf8")).toBe("hook\n");
	});

	test("uses inherited rule command for a repo without exact project config", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		const configHome = join(tmp, "config-rule-command");
		mkdirSync(join(configHome, "ct-worktrees"), {recursive: true});
		writeFileSync(
			join(configHome, "ct-worktrees", "trees.toml"),
			`[[rule]]\nroot_glob = "${realpathSync(tmp)}/**"\ncommand = '''\necho inherited > "$WK_CREATED/rule-sentinel"\n'''\n`,
		);
		process.env.XDG_CONFIG_HOME = configHome;

		const result = await dispatch("add", ["--cwd", root, "--branch", "feature/rule-command", "--json"], deps);
		const plan = JSON.parse(result.stdout ?? "{}");
		await run(["bash", plan.post_create_script_path]);

		expect(plan.post_create_script_path).toEndWith("/post-create.sh");
		expect(readFileSync(join(`${root}__feature--rule-command`, "rule-sentinel"), "utf8")).toBe("inherited\n");
	});

	test("copies configured files before returning the post-create script", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, ".env"), "SECRET=setup\n");
		writeConfig(tmp, root, 'cat .env > "$WK_CREATED/hook-read-env"', undefined, 'copy = [".env"]\n');

		const result = await dispatch("add", ["--cwd", root, "--branch", "feature/copy-setup", "--json"], deps);
		const worktreePath = `${root}__feature--copy-setup`;
		const plan = JSON.parse(result.stdout ?? "{}");

		expect(readFileSync(join(worktreePath, ".env"), "utf8")).toBe("SECRET=setup\n");
		expect((await run(["git", "-C", worktreePath, "status", "--porcelain"])).stdout).toBe("");
		await run(["bash", plan.post_create_script_path]);
		expect(readFileSync(join(worktreePath, "hook-read-env"), "utf8")).toBe("SECRET=setup\n");
	});

	test("copy setup failure during add rolls back the new worktree and branch", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo should-not-run", undefined, 'copy = [".env.missing"]\n');

		await expect(
			dispatch("add", ["--cwd", root, "--branch", "feature/copy-fail", "--json"], deps),
		).rejects.toThrow("copy source does not exist");

		expect(existsSync(`${root}__feature--copy-fail`)).toBe(false);
		expect(
			(await runRaw(["git", "-C", root, "show-ref", "--verify", "refs/heads/feature/copy-fail"])).exitCode,
		).not.toBe(0);
	});

	test("copy setup failure during add restores an existing branch tip", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		await createRemoteBranch(remote, "feature/restore-tip");
		await run(["git", "-C", root, "fetch", "origin"]);
		await run(["git", "-C", root, "branch", "feature/restore-tip", "main"]);
		const originalHead = (
			await run(["git", "-C", root, "rev-parse", "refs/heads/feature/restore-tip"])
		).stdout.trim();
		writeConfig(tmp, root, "echo should-not-run", undefined, 'copy = [".env.missing"]\n');

		await expect(
			dispatch("add", ["--cwd", root, "--branch", "feature/restore-tip", "--json"], deps),
		).rejects.toThrow("copy source does not exist");

		expect(existsSync(`${root}__feature--restore-tip`)).toBe(false);
		expect(
			(await run(["git", "-C", root, "rev-parse", "refs/heads/feature/restore-tip"])).stdout.trim(),
		).toBe(originalHead);
	});

	test.each([
		{
			name: "existing local",
			branch: "feature/local",
			setup: async (root: string) => run(["git", "-C", root, "branch", "feature/local"]),
		},
		{
			name: "existing remote-only",
			branch: "feature/remote",
			setup: async (_root: string, remote: string) => createRemoteBranch(remote, "feature/remote"),
		},
		{
			name: "existing local and remote",
			branch: "feature/both",
			setup: async (root: string, remote: string) => {
				await createRemoteBranch(remote, "feature/both");
				await run(["git", "-C", root, "fetch", "origin"]);
				await run(["git", "-C", root, "branch", "feature/both", "origin/feature/both"]);
			},
		},
	])("adds $name branch", async ({branch, setup}) => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		await setup(root, remote);
		writeConfig(tmp, root, "echo ready");

		const result = await dispatch("add", ["--cwd", root, "--branch", branch, "--json"], deps);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout ?? "{}").worktree_path).toBe(`${root}__${branch.replaceAll("/", "--")}`);
	});

	test("fresh_canonical preserves existing branch add behavior after policy fetch", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		await run(["git", "-C", root, "branch", "feature/existing-fresh"]);
		writeConfig(tmp, root, "echo ready", undefined, '[project.add]\npolicy = "fresh_canonical"\n');
		writeFileSync(join(root, "dirty-canonical.txt"), "dirty\n");

		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/existing-fresh", "--json"],
			deps,
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			kind: "ready",
			worktree_path: `${root}__feature--existing-fresh`,
			created_new_branch: false,
		});
	});

	test("warns but succeeds when local branch has diverged from remote", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		await createRemoteBranch(remote, "feature/diverged");
		await run(["git", "-C", root, "fetch", "origin"]);
		await run(["git", "-C", root, "checkout", "-b", "feature/diverged", "main"]);
		writeFileSync(join(root, "local.txt"), "local\n");
		await run(["git", "-C", root, "add", "local.txt"]);
		await run(["git", "-C", root, "commit", "-m", "local"]);
		await run(["git", "-C", root, "checkout", "main"]);
		writeConfig(tmp, root, "echo ready");
		const warnings: string[] = [];
		const warnDeps = {...deps, progress: {...deps.progress, error: (msg: string) => warnings.push(msg)}};

		const result = await dispatch("add", ["--cwd", root, "--branch", "feature/diverged", "--json"], warnDeps);

		expect(result.exitCode).toBe(0);
		expect(warnings.join("\n")).toContain("couldn't fast-forward");
	});

	test("defaults new branches to origin default branch instead of current HEAD", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await run(["git", "-C", root, "checkout", "-b", "local/current"]);
		writeFileSync(join(root, "current-only.txt"), "current\n");
		await run(["git", "-C", root, "add", "current-only.txt"]);
		await run(["git", "-C", root, "commit", "-m", "current only"]);

		await dispatch("add", ["--cwd", root, "--branch", "feature/default-base", "--json"], deps);

		const missing = await Bun.spawn(
			["git", "-C", `${root}__feature--default-base`, "show", "HEAD:current-only.txt"],
			{stdout: "pipe", stderr: "pipe"},
		).exited;
		expect(missing).not.toBe(0);
	});

	test("origin_default creates new branches from fetched origin default without mutating canonical root", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await commitOnRemoteDefault({
			remote,
			path: "remote-only.txt",
			content: "remote default\n",
			message: "remote default update",
		});
		const originalHead = (await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim();

		await dispatch("add", ["--cwd", root, "--branch", "feature/origin-default", "--json"], deps);

		expect((await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
		expect(
			(await run(["git", "-C", `${root}__feature--origin-default`, "show", "HEAD:remote-only.txt"])).stdout,
		).toBe("remote default\n");
	});

	test("fresh_canonical fast-forwards clean canonical default before creating a branch", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, '[project.add]\npolicy = "fresh_canonical"\n');
		await commitOnRemoteDefault({
			remote,
			path: "fresh.txt",
			content: "fresh\n",
			message: "fresh default update",
		});

		await dispatch("add", ["--cwd", root, "--branch", "feature/fresh", "--json"], deps);

		expect((await run(["git", "-C", root, "show", "HEAD:fresh.txt"])).stdout).toBe("fresh\n");
		expect((await run(["git", "-C", `${root}__feature--fresh`, "show", "HEAD:fresh.txt"])).stdout).toBe(
			"fresh\n",
		);
	});

	test("fresh_canonical blocks dirty canonical root with JSON reason", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, '[project.add]\npolicy = "fresh_canonical"\n');
		await commitOnRemoteDefault({
			remote,
			path: "dirty-block.txt",
			content: "remote\n",
			message: "dirty block update",
		});
		writeFileSync(join(root, "dirty.txt"), "dirty\n");

		const result = await dispatch("add", ["--cwd", root, "--branch", "feature/dirty-block", "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "dirty_canonical"});
		expect(existsSync(`${root}__feature--dirty-block`)).toBe(false);
	});

	test("fresh_canonical blocks wrong canonical branch with JSON reason", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, '[project.add]\npolicy = "fresh_canonical"\n');
		await commitOnRemoteDefault({
			remote,
			path: "wrong-branch.txt",
			content: "remote\n",
			message: "wrong branch update",
		});
		await run(["git", "-C", root, "checkout", "-b", "other"]);

		const result = await dispatch("add", ["--cwd", root, "--branch", "feature/wrong-branch", "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			kind: "blocked",
			reason: "wrong_canonical_branch",
		});
		expect(existsSync(`${root}__feature--wrong-branch`)).toBe(false);
	});

	test("fresh_canonical blocks non-fast-forward canonical update with JSON reason", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, '[project.add]\npolicy = "fresh_canonical"\n');
		await commitOnRemoteDefault({
			remote,
			path: "non-ff-remote.txt",
			content: "remote\n",
			message: "non ff remote update",
		});
		writeFileSync(join(root, "local-main.txt"), "local\n");
		await run(["git", "-C", root, "add", "local-main.txt"]);
		await run(["git", "-C", root, "commit", "-m", "local main update"]);

		const result = await dispatch("add", ["--cwd", root, "--branch", "feature/non-ff", "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "non_ff_canonical"});
		expect(existsSync(`${root}__feature--non-ff`)).toBe(false);
	});

	test("fresh_canonical explicit base bypasses canonical update requirement", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		await createRemoteBranch(remote, "base/stacked");
		writeConfig(tmp, root, "echo ready", undefined, '[project.add]\npolicy = "fresh_canonical"\n');
		writeFileSync(join(root, "dirty-canonical.txt"), "dirty\n");

		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/from-explicit-base", "--base", "base/stacked", "--json"],
			deps,
		);

		expect(result.exitCode).toBe(0);
		expect(
			(await run(["git", "-C", `${root}__feature--from-explicit-base`, "show", "HEAD:remote.txt"])).stdout,
		).toBe("base/stacked\n");
	});

	test("uses --base for a new branch and warns when --base is ignored for existing branch", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		await createRemoteBranch(remote, "base/topic");
		writeConfig(tmp, root, "echo ready");
		const warnings: string[] = [];
		const warnDeps = {...deps, progress: {...deps.progress, error: (msg: string) => warnings.push(msg)}};

		await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/from-base", "--base", "base/topic", "--json"],
			warnDeps,
		);
		const baseFile = await run(["git", "-C", `${root}__feature--from-base`, "show", "HEAD:remote.txt"]);
		expect(baseFile.stdout).toBe("base/topic\n");

		await run(["git", "-C", root, "checkout", "-b", "local/base"]);
		writeFileSync(join(root, "local-base.txt"), "local base\n");
		await run(["git", "-C", root, "add", "local-base.txt"]);
		await run(["git", "-C", root, "commit", "-m", "local base"]);
		await run(["git", "-C", root, "checkout", "main"]);
		await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/from-local-base", "--base", "local/base", "--json"],
			warnDeps,
		);
		expect(
			(await run(["git", "-C", `${root}__feature--from-local-base`, "show", "HEAD:local-base.txt"])).stdout,
		).toBe("local base\n");

		await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/from-base", "--base", "base/topic", "--json"],
			warnDeps,
		).catch(() => undefined);
		expect(warnings.join("\n")).toContain("--base ignored");
	}, 15000);

	test("accepts --force for wrapper compatibility", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/force", "--force", "--json"],
			deps,
		);

		expect(result.exitCode).toBe(0);
		expect(existsSync(`${root}__feature--force`)).toBe(true);
	});

	test("without project config post_create_script_path is null", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		process.env.XDG_CONFIG_HOME = join(tmp, "empty-config");

		const result = await dispatch("add", ["--cwd", root, "--branch", "feature/no-project", "--json"], deps);

		expect(JSON.parse(result.stdout ?? "{}").post_create_script_path).toBeNull();
	});

	test("rejects reserved pool branch prefix", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		await expect(
			dispatch("add", ["--cwd", root, "--branch", "wk-pool/feat1", "--json"], deps),
		).rejects.toThrow("reserved");
	});
});

integrationDescribe("wktree finish", () => {
	let tmp: string;
	let originalConfigHome: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wktree-finish-test-"));
		originalConfigHome = process.env.XDG_CONFIG_HOME;
	});

	afterEach(() => {
		if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalConfigHome;
		rmSync(tmp, {recursive: true, force: true});
	});

	test("finish disabled blocks before integration with JSON payload", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, "[project.finish]\nenabled = false\n");
		await dispatch("add", ["--cwd", root, "--branch", "feature/disabled-finish", "--json"], deps);
		const worktreePath = `${root}__feature--disabled-finish`;
		await commitFile({
			repo: worktreePath,
			path: "disabled.txt",
			content: "disabled\n",
			message: "disabled work",
		});
		const originalHead = (await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim();

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			kind: "blocked",
			reason: "blocked",
			message: expect.stringContaining("finish is disabled"),
		});
		expect((await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
	});

	test("refuses finish from canonical root", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");

		const result = await dispatch("finish", ["--cwd", root, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.UNSAFE);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "canonical_root"});
	});

	test("refuses dirty source worktree", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/dirty-finish", "--json"], deps);
		const worktreePath = `${root}__feature--dirty-finish`;
		writeFileSync(join(worktreePath, "dirty.txt"), "dirty\n");

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "dirty_worktree"});
	});

	test("enforces target freshness before integration", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/stale-target", "--json"], deps);
		const worktreePath = `${root}__feature--stale-target`;
		await commitFile({repo: worktreePath, path: "source.txt", content: "source\n", message: "source work"});
		await commitOnRemoteDefault({
			remote,
			path: "remote-fresh.txt",
			content: "fresh\n",
			message: "fresh remote",
		});
		const originalHead = (await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim();

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "target_not_fresh"});
		expect((await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
	});

	test("ff_only moves the canonical default branch to the source branch", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/finish", "--json"], deps);
		const worktreePath = `${root}__feature--finish`;
		await commitFile({
			repo: worktreePath,
			path: "finished.txt",
			content: "finished\n",
			message: "finished work",
		});
		const sourceHead = (await run(["git", "-C", worktreePath, "rev-parse", "HEAD"])).stdout.trim();

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json", "--strategy", "ff_only"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			kind: "ready",
			root,
			worktree_path: worktreePath,
			source_branch: "feature/finish",
			target_branch: "main",
			strategy: "ff_only",
		});
		expect((await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(sourceHead);
		expect(readFileSync(join(root, "finished.txt"), "utf8")).toBe("finished\n");
	});

	test("pushes target branch after successful finish when enabled", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, "[project.finish]\npush = true\n");
		await dispatch("add", ["--cwd", root, "--branch", "feature/push-finish", "--json"], deps);
		const worktreePath = `${root}__feature--push-finish`;
		await commitFile({repo: worktreePath, path: "pushed.txt", content: "pushed\n", message: "pushed work"});

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({cleanup_actions: ["push"]});
		expect((await run(["git", "-C", remote, "show", "main:pushed.txt"])).stdout).toBe("pushed\n");
	});

	test("push rejection blocks configured cleanup and preserves source worktree and branch", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(
			tmp,
			root,
			"echo ready",
			undefined,
			"[project.finish]\npush = true\nremove_worktree = true\ndelete_branch = true\n",
		);
		await dispatch("add", ["--cwd", root, "--branch", "feature/push-reject", "--json"], deps);
		const worktreePath = `${root}__feature--push-reject`;
		await commitFile({repo: worktreePath, path: "reject.txt", content: "source\n", message: "source work"});
		writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(remote, "hooks", "pre-receive"), 0o755);

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "push_rejected"});
		expect(existsSync(worktreePath)).toBe(true);
		expect(
			(await runRaw(["git", "-C", root, "show-ref", "--verify", "refs/heads/feature/push-reject"])).exitCode,
		).toBe(0);
	});

	test("removes a non-pooled source worktree after finish when cleanup is enabled", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, "[project.finish]\nremove_worktree = true\n");
		await dispatch("add", ["--cwd", root, "--branch", "feature/remove-after-finish", "--json"], deps);
		const worktreePath = `${root}__feature--remove-after-finish`;
		await commitFile({repo: worktreePath, path: "remove.txt", content: "remove\n", message: "remove work"});

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({cleanup_actions: ["remove_worktree"]});
		expect(existsSync(worktreePath)).toBe(false);
		expect(
			(await runRaw(["git", "-C", root, "show-ref", "--verify", "refs/heads/feature/remove-after-finish"]))
				.exitCode,
		).toBe(0);
	});

	test("recycles a pooled local-only source worktree after finish while preserving ignored files", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(
			tmp,
			root,
			"mkdir -p node_modules; touch node_modules/.keep",
			1,
			"[project.finish]\nremove_worktree = true\n",
		);
		await dispatch("ensure", ["--cwd", root], testDeps());
		const excludePath = (
			await run(["git", "-C", `${root}__feat1`, "rev-parse", "--git-path", "info/exclude"])
		).stdout.trim();
		writeFileSync(resolve(`${root}__feat1`, excludePath), "node_modules/\n");
		await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/pooled-finish", "--slot", `${root}__feat1`, "--json"],
			testDeps(),
		);
		await commitFile({
			repo: `${root}__feat1`,
			path: "pooled.txt",
			content: "pooled\n",
			message: "pooled work",
		});

		const result = await dispatch("finish", ["--cwd", `${root}__feat1`, "--json"], testDeps());

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({cleanup_actions: ["recycle_worktree"]});
		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"wk-pool/feat1",
		);
		expect(existsSync(join(`${root}__feat1`, "node_modules", ".keep"))).toBe(true);
	});

	test("deletes source branch after squash finish when configured", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(
			tmp,
			root,
			"echo ready",
			undefined,
			'[project.finish]\nstrategy = "squash"\nremove_worktree = true\ndelete_branch = true\n',
		);
		await dispatch("add", ["--cwd", root, "--branch", "feature/delete-after-squash", "--json"], deps);
		const worktreePath = `${root}__feature--delete-after-squash`;
		await commitFile({
			repo: worktreePath,
			path: "squash-delete.txt",
			content: "delete\n",
			message: "delete work",
		});

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			cleanup_actions: ["remove_worktree", "delete_branch"],
		});
		expect(
			(await runRaw(["git", "-C", root, "show-ref", "--verify", "refs/heads/feature/delete-after-squash"]))
				.exitCode,
		).not.toBe(0);
	});

	test("explicit finish cleanup flags enable push, removal, and branch deletion", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/flag-cleanup", "--json"], deps);
		const worktreePath = `${root}__feature--flag-cleanup`;
		await commitFile({
			repo: worktreePath,
			path: "flag-cleanup.txt",
			content: "flags\n",
			message: "flag cleanup",
		});

		const result = await dispatch(
			"finish",
			["--cwd", worktreePath, "--json", "--push", "--remove-worktree", "--delete-branch"],
			deps,
		);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			cleanup_actions: ["push", "remove_worktree", "delete_branch"],
		});
		expect((await run(["git", "-C", remote, "show", "main:flag-cleanup.txt"])).stdout).toBe("flags\n");
		expect(existsSync(worktreePath)).toBe(false);
		expect(
			(await runRaw(["git", "-C", root, "show-ref", "--verify", "refs/heads/feature/flag-cleanup"])).exitCode,
		).not.toBe(0);
	});

	test("cleanup refusal returns structured payload without integration or force deletion", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, "[project.finish]\ndelete_branch = true\n");
		await dispatch("add", ["--cwd", root, "--branch", "feature/delete-without-remove", "--json"], deps);
		const worktreePath = `${root}__feature--delete-without-remove`;
		await commitFile({
			repo: worktreePath,
			path: "cleanup-refusal.txt",
			content: "cleanup\n",
			message: "cleanup work",
		});
		const originalHead = (await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim();

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.UNSAFE);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "unsafe"});
		expect((await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
		expect((await runRaw(["git", "-C", root, "show", "HEAD:cleanup-refusal.txt"])).exitCode).not.toBe(0);
		expect(existsSync(worktreePath)).toBe(true);
		expect(
			(await runRaw(["git", "-C", root, "show-ref", "--verify", "refs/heads/feature/delete-without-remove"]))
				.exitCode,
		).toBe(0);
	});

	test("squash integrates source changes as one deterministic target commit", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, '[project.finish]\nstrategy = "squash"\n');
		await dispatch("add", ["--cwd", root, "--branch", "feature/squash-finish", "--json"], deps);
		const worktreePath = `${root}__feature--squash-finish`;
		await commitFile({repo: worktreePath, path: "one.txt", content: "one\n", message: "one"});
		await commitFile({repo: worktreePath, path: "two.txt", content: "two\n", message: "two"});
		const beforeHead = (await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim();

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({strategy: "squash"});
		expect((await run(["git", "-C", root, "log", "-1", "--format=%s"])).stdout.trim()).toBe(
			"finish: feature/squash-finish",
		);
		expect((await run(["git", "-C", root, "rev-list", "--count", `${beforeHead}..HEAD`])).stdout.trim()).toBe(
			"1",
		);
		expect(readFileSync(join(root, "one.txt"), "utf8")).toBe("one\n");
		expect(readFileSync(join(root, "two.txt"), "utf8")).toBe("two\n");
	});

	test("merge_commit integrates source with an explicit merge commit", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, '[project.finish]\nstrategy = "merge_commit"\n');
		await dispatch("add", ["--cwd", root, "--branch", "feature/merge-finish", "--json"], deps);
		const worktreePath = `${root}__feature--merge-finish`;
		await commitFile({
			repo: worktreePath,
			path: "merge-source.txt",
			content: "source\n",
			message: "source work",
		});

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({strategy: "merge_commit"});
		expect(
			(await run(["git", "-C", root, "rev-list", "--parents", "-n", "1", "HEAD"])).stdout.trim().split(" "),
		).toHaveLength(3);
		expect(readFileSync(join(root, "merge-source.txt"), "utf8")).toBe("source\n");
	});

	test("rebase_ff rebases source onto target then fast-forwards target", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, '[project.finish]\nstrategy = "rebase_ff"\n');
		await dispatch("add", ["--cwd", root, "--branch", "feature/rebase-finish", "--json"], deps);
		const worktreePath = `${root}__feature--rebase-finish`;
		await commitFile({
			repo: worktreePath,
			path: "source-rebased.txt",
			content: "source\n",
			message: "source work",
		});
		await commitFile({repo: root, path: "target-base.txt", content: "target\n", message: "target work"});
		const targetHead = (await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim();

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({strategy: "rebase_ff"});
		expect((await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(
			(await run(["git", "-C", root, "rev-parse", "refs/heads/feature/rebase-finish"])).stdout.trim(),
		);
		expect(
			(await run(["git", "-C", root, "rev-list", "--parents", "-n", "1", "HEAD"])).stdout.trim().split(" "),
		).toHaveLength(2);
		expect((await run(["git", "-C", root, "rev-parse", "HEAD~1"])).stdout.trim()).toBe(targetHead);
		expect(readFileSync(join(root, "source-rebased.txt"), "utf8")).toBe("source\n");
	});

	test("non-ff strategy conflict emits structured refusal", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, '[project.finish]\nstrategy = "squash"\n');
		await dispatch("add", ["--cwd", root, "--branch", "feature/squash-conflict", "--json"], deps);
		const worktreePath = `${root}__feature--squash-conflict`;
		await commitFile({repo: worktreePath, path: "README.md", content: "source\n", message: "source change"});
		await commitFile({repo: root, path: "README.md", content: "target\n", message: "target change"});
		const targetHead = (await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim();
		const sourceHead = (await run(["git", "-C", worktreePath, "rev-parse", "HEAD"])).stdout.trim();

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "conflict"});
		expect((await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(targetHead);
		expect(
			(await run(["git", "-C", root, "rev-parse", "refs/heads/feature/squash-conflict"])).stdout.trim(),
		).toBe(sourceHead);
		expect(existsSync(worktreePath)).toBe(true);
	});

	test("invalid CLI strategy fails before fresh_canonical mutates target", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, '[project.add]\npolicy = "fresh_canonical"\n');
		await dispatch("add", ["--cwd", root, "--branch", "feature/bad-strategy", "--json"], deps);
		const worktreePath = `${root}__feature--bad-strategy`;
		await commitFile({
			repo: worktreePath,
			path: "bad-strategy.txt",
			content: "source\n",
			message: "source work",
		});
		await commitOnRemoteDefault({
			remote,
			path: "remote-before-usage.txt",
			content: "remote\n",
			message: "remote work",
		});
		const originalHead = (await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim();

		await expect(
			dispatch("finish", ["--cwd", worktreePath, "--json", "--strategy", "bad"], deps),
		).rejects.toThrow("--strategy must be ff_only");
		expect((await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
	});

	test("explicit CLI strategy overrides configured finish strategy", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, '[project.finish]\nstrategy = "squash"\n');
		await dispatch("add", ["--cwd", root, "--branch", "feature/strategy-override", "--json"], deps);
		const worktreePath = `${root}__feature--strategy-override`;
		await commitFile({
			repo: worktreePath,
			path: "override.txt",
			content: "override\n",
			message: "override work",
		});
		const sourceHead = (await run(["git", "-C", worktreePath, "rev-parse", "HEAD"])).stdout.trim();

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json", "--strategy", "ff_only"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({strategy: "ff_only"});
		expect((await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(sourceHead);
		expect((await run(["git", "-C", root, "log", "-1", "--format=%s"])).stdout.trim()).toBe("override work");
	});

	test("fresh_canonical conflict refuses without first fast-forwarding target", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", undefined, '[project.add]\npolicy = "fresh_canonical"\n');
		await dispatch("add", ["--cwd", root, "--branch", "feature/fresh-conflict", "--json"], deps);
		const worktreePath = `${root}__feature--fresh-conflict`;
		await commitFile({repo: worktreePath, path: "source.txt", content: "source\n", message: "source work"});
		await commitOnRemoteDefault({
			remote,
			path: "remote-fresh.txt",
			content: "fresh\n",
			message: "fresh remote",
		});
		const originalHead = (await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim();

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "conflict"});
		expect((await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
		expect((await runRaw(["git", "-C", root, "show", "HEAD:remote-fresh.txt"])).exitCode).not.toBe(0);
	});

	test("non-fast-forward ff_only refuses without target modification", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/divergent-finish", "--json"], deps);
		const worktreePath = `${root}__feature--divergent-finish`;
		await commitFile({
			repo: worktreePath,
			path: "source-only.txt",
			content: "source\n",
			message: "source work",
		});
		await commitFile({repo: root, path: "target-only.txt", content: "target\n", message: "target work"});
		const targetHead = (await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim();

		const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "conflict"});
		expect((await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(targetHead);
	});
});

integrationDescribe("wktree copy", () => {
	let tmp: string;
	let originalConfigHome: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wktree-copy-test-"));
		originalConfigHome = process.env.XDG_CONFIG_HOME;
	});

	afterEach(() => {
		if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalConfigHome;
		rmSync(tmp, {recursive: true, force: true});
	});

	test("reports ready JSON for a non-canonical worktree with no copy config", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/copy", "--json"], deps);
		const worktreePath = `${root}__feature--copy`;

		const nestedCwd = join(worktreePath, "nested", "dir");
		mkdirSync(nestedCwd, {recursive: true});

		const result = await dispatch("copy", ["--cwd", nestedCwd, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}")).toEqual({
			kind: "ready",
			root,
			worktree_path: worktreePath,
			copied: [],
			exclude_paths: [],
		});
	});

	test("refuses canonical root with JSON blocked payload", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");

		const result = await dispatch("copy", ["--cwd", root, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.UNSAFE);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			kind: "blocked",
			reason: "canonical_root",
		});
	});

	test("copies a root-relative file and reports copied JSON", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, ".env"), "SECRET=one\n");
		writeConfig(tmp, root, "echo ready", undefined, 'copy = [".env"]\n');
		await dispatch("add", ["--cwd", root, "--branch", "feature/copy", "--json"], deps);
		const worktreePath = `${root}__feature--copy`;

		const result = await dispatch("copy", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(readFileSync(join(worktreePath, ".env"), "utf8")).toBe("SECRET=one\n");
		expect(JSON.parse(result.stdout ?? "{}")).toEqual({
			kind: "ready",
			root,
			worktree_path: worktreePath,
			copied: [{from: join(root, ".env"), to: ".env", type: "file"}],
			exclude_paths: [".env"],
		});
	});

	test("rerunning copy replaces an untracked destination with current source", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, ".env"), "first\n");
		writeConfig(tmp, root, "echo ready", undefined, 'copy = [".env"]\n');
		await dispatch("add", ["--cwd", root, "--branch", "feature/replace", "--json"], deps);
		const worktreePath = `${root}__feature--replace`;
		await dispatch("copy", ["--cwd", worktreePath], deps);
		writeFileSync(join(root, ".env"), "second\n");
		writeFileSync(join(worktreePath, ".env"), "local edit\n");

		await dispatch("copy", ["--cwd", worktreePath], deps);

		expect(readFileSync(join(worktreePath, ".env"), "utf8")).toBe("second\n");
	});

	test("tracked destination blocks with unsafe JSON and leaves file intact", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, "tracked-copy.txt"), "source\n");
		await run(["git", "-C", root, "add", "tracked-copy.txt"]);
		await run(["git", "-C", root, "commit", "-m", "add tracked copy"]);
		await run(["git", "-C", root, "push", "origin", "main"]);
		writeFileSync(join(root, "tracked-copy.txt"), "new source\n");
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/tracked-copy", "--json"], deps);
		writeConfig(tmp, root, "echo ready", undefined, 'copy = ["tracked-copy.txt"]\n');
		const worktreePath = `${root}__feature--tracked-copy`;

		const result = await dispatch("copy", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.UNSAFE);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "unsafe"});
		expect(readFileSync(join(worktreePath, "tracked-copy.txt"), "utf8")).toBe("source\n");
	});

	test.each([
		"",
		"/tmp/abs",
		"~/secret",
		"../escape",
	])("invalid copy string %p fails as config error without stdout", async (path) => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", `feature/invalid-${path.length}`, "--json"], deps);
		writeConfig(tmp, root, "echo ready", undefined, `copy = [${JSON.stringify(path)}]\n`);

		await expect(
			dispatch("copy", ["--cwd", `${root}__feature--invalid-${path.length}`, "--json"], deps),
		).rejects.toMatchObject({exitCode: EXIT_CODES.USAGE});
	});

	test("missing source fails as config error without structured stdout", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/missing-copy", "--json"], deps);
		writeConfig(tmp, root, "echo ready", undefined, 'copy = [".env.missing"]\n');

		await expect(
			dispatch("copy", ["--cwd", `${root}__feature--missing-copy`, "--json"], deps),
		).rejects.toMatchObject({
			message: expect.stringContaining("copy source does not exist"),
			exitCode: EXIT_CODES.USAGE,
		});
	});

	test("symlink source files fail as config errors in copy mode", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, ".env.real"), "real\n");
		symlinkSync(".env.real", join(root, ".env.link"));
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/symlink-source", "--json"], deps);
		writeConfig(tmp, root, "echo ready", undefined, 'copy = [".env.link"]\n');

		await expect(
			dispatch("copy", ["--cwd", `${root}__feature--symlink-source`, "--json"], deps),
		).rejects.toMatchObject({
			message: expect.stringContaining("not a regular file"),
			exitCode: EXIT_CODES.USAGE,
		});
	});

	test("symlink mode creates destination symlinks to resolved source targets", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		const externalTarget = join(tmp, "external.env");
		writeFileSync(externalTarget, "external\n");
		symlinkSync(externalTarget, join(root, ".env"));
		writeConfig(tmp, root, "echo ready", undefined, 'copy_mode_default = "symlink"\ncopy = [".env"]\n');
		await dispatch("add", ["--cwd", root, "--branch", "feature/symlink-mode", "--json"], deps);
		const worktreePath = `${root}__feature--symlink-mode`;

		const result = await dispatch("copy", ["--cwd", worktreePath, "--json"], deps);
		const destination = join(worktreePath, ".env");

		expect(lstatSync(destination).isSymbolicLink()).toBe(true);
		const resolvedTarget = realpathSync(externalTarget);
		expect(readlinkSync(destination)).toBe(resolvedTarget);
		expect(readFileSync(destination, "utf8")).toBe("external\n");
		expect(JSON.parse(result.stdout ?? "{}").copied).toEqual([
			{from: resolvedTarget, to: ".env", type: "symlink"},
		]);
	});

	test("copy preflights all entries before replacing destinations", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, ".env"), "source\n");
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/preflight", "--json"], deps);
		writeConfig(tmp, root, "echo ready", undefined, 'copy = [".env", ".env.missing"]\n');
		const worktreePath = `${root}__feature--preflight`;
		writeFileSync(join(worktreePath, ".env"), "do not replace\n");

		await expect(dispatch("copy", ["--cwd", worktreePath, "--json"], deps)).rejects.toMatchObject({
			exitCode: EXIT_CODES.USAGE,
		});

		expect(readFileSync(join(worktreePath, ".env"), "utf8")).toBe("do not replace\n");
	});

	test("copies object file sources from root-relative, absolute, and home paths", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, "root.env"), "root\n");
		const absoluteSource = join(tmp, "absolute.env");
		writeFileSync(absoluteSource, "absolute\n");
		const homeRelative = `.wktree-test-${basename(tmp)}.env`;
		const homeSource = join(homedir(), homeRelative);
		writeFileSync(homeSource, "home\n");
		try {
			writeConfig(
				tmp,
				root,
				"echo ready",
				undefined,
				`copy = [\n  { from = "root.env", to = "copied/root.env" },\n  { from = ${JSON.stringify(absoluteSource)}, to = "copied/absolute.env" },\n  { from = "~/${homeRelative}", to = ["copied/home.env", "copied/home-again.env"] },\n]\n`,
			);
			await dispatch("add", ["--cwd", root, "--branch", "feature/object-files", "--json"], deps);
			const worktreePath = `${root}__feature--object-files`;

			const result = await dispatch("copy", ["--cwd", worktreePath, "--json"], deps);
			const payload = JSON.parse(result.stdout ?? "{}");

			expect(readFileSync(join(worktreePath, "copied/root.env"), "utf8")).toBe("root\n");
			expect(readFileSync(join(worktreePath, "copied/absolute.env"), "utf8")).toBe("absolute\n");
			expect(readFileSync(join(worktreePath, "copied/home-again.env"), "utf8")).toBe("home\n");
			expect(payload.copied).toEqual([
				{from: join(root, "root.env"), to: "copied/root.env", type: "file"},
				{from: absoluteSource, to: "copied/absolute.env", type: "file"},
				{from: homeSource, to: "copied/home.env", type: "file"},
				{from: homeSource, to: "copied/home-again.env", type: "file"},
			]);
			expect(payload.exclude_paths).toEqual([
				"copied/absolute.env",
				"copied/home-again.env",
				"copied/home.env",
				"copied/root.env",
			]);
		} finally {
			rmSync(homeSource, {force: true});
		}
	});

	test("copies directories to exact final destinations and removes stale files on rerun", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		mkdirSync(join(root, "skill-dir"));
		writeFileSync(join(root, "skill-dir", "foo.ts"), "one\n");
		writeConfig(
			tmp,
			root,
			"echo ready",
			undefined,
			'copy = [{ from = "skill-dir", to = [".claude/skills/skill-dir", ".pi/agents/skill-dir"] }]\n',
		);
		await dispatch("add", ["--cwd", root, "--branch", "feature/dir-copy", "--json"], deps);
		const worktreePath = `${root}__feature--dir-copy`;
		await dispatch("copy", ["--cwd", worktreePath], deps);
		writeFileSync(join(worktreePath, ".claude/skills/skill-dir", "stale.ts"), "stale\n");
		rmSync(join(root, "skill-dir", "foo.ts"));
		writeFileSync(join(root, "skill-dir", "bar.ts"), "two\n");

		const result = await dispatch("copy", ["--cwd", worktreePath, "--json"], deps);

		expect(existsSync(join(worktreePath, ".claude/skills/skill-dir", "stale.ts"))).toBe(false);
		expect(readFileSync(join(worktreePath, ".claude/skills/skill-dir", "bar.ts"), "utf8")).toBe("two\n");
		expect(readFileSync(join(worktreePath, ".pi/agents/skill-dir", "bar.ts"), "utf8")).toBe("two\n");
		expect(JSON.parse(result.stdout ?? "{}").copied).toEqual([
			{from: join(root, "skill-dir"), to: ".claude/skills/skill-dir", type: "directory"},
			{from: join(root, "skill-dir"), to: ".pi/agents/skill-dir", type: "directory"},
		]);
	});

	test("tracked descendants under directory destinations block with unsafe JSON", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		mkdirSync(join(root, "src-dir"));
		writeFileSync(join(root, "src-dir", "foo.txt"), "source\n");
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/tracked-desc", "--json"], deps);
		writeConfig(tmp, root, "echo ready", undefined, 'copy = [{ from = "src-dir", to = "tracked-dir" }]\n');
		const worktreePath = `${root}__feature--tracked-desc`;
		mkdirSync(join(worktreePath, "tracked-dir"));
		writeFileSync(join(worktreePath, "tracked-dir", "keep.txt"), "tracked\n");
		await run(["git", "-C", worktreePath, "add", "tracked-dir/keep.txt"]);
		await run(["git", "-C", worktreePath, "commit", "-m", "tracked descendant"]);

		const result = await dispatch("copy", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.UNSAFE);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "unsafe"});
		expect(readFileSync(join(worktreePath, "tracked-dir", "keep.txt"), "utf8")).toBe("tracked\n");
	});

	test("tracked destination ancestors block with unsafe JSON", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, ".env"), "source\n");
		writeFileSync(join(root, "tracked-file"), "tracked\n");
		await run(["git", "-C", root, "add", "tracked-file"]);
		await run(["git", "-C", root, "commit", "-m", "tracked ancestor"]);
		await run(["git", "-C", root, "push", "origin", "main"]);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/tracked-ancestor", "--json"], deps);
		writeConfig(
			tmp,
			root,
			"echo ready",
			undefined,
			'copy = [{ from = ".env", to = "tracked-file/nested" }]\n',
		);

		const result = await dispatch("copy", ["--cwd", `${root}__feature--tracked-ancestor`, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.UNSAFE);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "unsafe"});
	});

	test("untracked file inside tracked directory destination is allowed", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, "source.txt"), "source\n");
		mkdirSync(join(root, ".claude"));
		writeFileSync(join(root, ".claude", "settings.json"), '{"tracked":true}\n');
		await run(["git", "-C", root, "add", "source.txt", ".claude/settings.json"]);
		await run(["git", "-C", root, "commit", "-m", "track claude settings"]);
		await run(["git", "-C", root, "push", "origin", "main"]);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/tracked-dir-ancestor", "--json"], deps);
		writeConfig(
			tmp,
			root,
			"echo ready",
			undefined,
			'copy = [{ from = "source.txt", to = ".claude/settings.local.json" }]\n',
		);
		const worktreePath = `${root}__feature--tracked-dir-ancestor`;

		const result = await dispatch("copy", ["--cwd", worktreePath, "--json"], deps);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(readFileSync(join(worktreePath, ".claude", "settings.local.json"), "utf8")).toBe("source\n");
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			kind: "ready",
			root,
			worktree_path: worktreePath,
			copied: [{from: join(root, "source.txt"), to: ".claude/settings.local.json", type: "file"}],
			exclude_paths: [".claude/settings.local.json"],
		});
	});

	test("deduplicates exclude paths across entries and multi-target destinations", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, ".env"), "one\n");
		writeConfig(
			tmp,
			root,
			"echo ready",
			undefined,
			'copy = [".env", { from = ".env", to = [".env", "copy.env"] }, { from = ".env", to = "copy.env" }]\n',
		);
		await dispatch("add", ["--cwd", root, "--branch", "feature/dedup", "--json"], deps);

		const payload = JSON.parse(
			(await dispatch("copy", ["--cwd", `${root}__feature--dedup`, "--json"], deps)).stdout ?? "{}",
		);

		expect(payload.exclude_paths).toEqual([".env", "copy.env"]);
	});

	test.each([
		{name: "missing from", config: 'copy = [{ to = ".env" }]'},
		{name: "missing to", config: 'copy = [{ from = ".env" }]'},
		{name: "empty from", config: 'copy = [{ from = "", to = ".env" }]'},
		{name: "empty to", config: 'copy = [{ from = ".env", to = "" }]'},
		{name: "absolute to", config: 'copy = [{ from = ".env", to = "/tmp/.env" }]'},
		{name: "home to", config: 'copy = [{ from = ".env", to = "~/.env" }]'},
		{name: "leading home to", config: 'copy = [{ from = ".env", to = "~secret" }]'},
		{name: "escaping to", config: 'copy = [{ from = ".env", to = "../.env" }]'},
	])("invalid object config $name fails as config error", async ({config}) => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/invalid-object", "--json"], deps);
		writeConfig(tmp, root, "echo ready", undefined, `${config}\n`);

		await expect(
			dispatch("copy", ["--cwd", `${root}__feature--invalid-object`, "--json"], deps),
		).rejects.toMatchObject({
			exitCode: EXIT_CODES.USAGE,
		});
	});

	test("env-var and glob-looking object sources are treated literally", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, "$SECRET*.env"), "literal\n");
		writeConfig(
			tmp,
			root,
			"echo ready",
			undefined,
			'copy = [{ from = "$SECRET*.env", to = "literal.env" }]\n',
		);
		await dispatch("add", ["--cwd", root, "--branch", "feature/literal", "--json"], deps);

		await dispatch("copy", ["--cwd", `${root}__feature--literal`], deps);

		expect(readFileSync(join(`${root}__feature--literal`, "literal.env"), "utf8")).toBe("literal\n");
	});

	test("follows symlinked shared exclude path", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		const excludePath = (
			await run(["git", "-C", root, "rev-parse", "--git-path", "info/exclude"])
		).stdout.trim();
		const realExclude = join(tmp, "real-exclude");
		rmSync(resolve(root, excludePath));
		symlinkSync(realExclude, resolve(root, excludePath));
		writeFileSync(realExclude, "*.log\n");
		writeFileSync(join(root, ".env"), "ignored\n");
		writeConfig(tmp, root, "echo ready", undefined, 'copy = [".env"]\n');
		await dispatch("add", ["--cwd", root, "--branch", "feature/symlink-exclude", "--json"], deps);

		await dispatch("copy", ["--cwd", `${root}__feature--symlink-exclude`], deps);

		expect(readFileSync(realExclude, "utf8")).toBe("*.log\n# wktree-start\n.env\n# wktree-end\n");
		expect((await run(["test", "-L", resolve(root, excludePath)])).exitCode).toBe(0);
	});

	test("exclude fence is idempotent, preserves unrelated lines, removes when copy is removed, and ignores copied files", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		const excludePath = (
			await run(["git", "-C", root, "rev-parse", "--git-path", "info/exclude"])
		).stdout.trim();
		writeFileSync(resolve(root, excludePath), "*.log\n");
		writeFileSync(join(root, ".env"), "ignored\n");
		writeConfig(tmp, root, "echo ready", undefined, 'copy = [".env"]\n');
		await dispatch("add", ["--cwd", root, "--branch", "feature/ignore-copy", "--json"], deps);
		const worktreePath = `${root}__feature--ignore-copy`;
		await dispatch("copy", ["--cwd", worktreePath], deps);
		await dispatch("copy", ["--cwd", worktreePath], deps);

		const withFence = readFileSync(resolve(root, excludePath), "utf8");
		expect(withFence).toBe("*.log\n# wktree-start\n.env\n# wktree-end\n");
		expect((await run(["git", "-C", worktreePath, "status", "--porcelain"])).stdout).toBe("");

		writeConfig(tmp, root, "echo ready");
		await dispatch("copy", ["--cwd", worktreePath], deps);

		expect(readFileSync(resolve(root, excludePath), "utf8")).toBe("*.log\n");
	});
});

integrationDescribe("wktree non-pool remove", () => {
	let tmp: string;
	let originalConfigHome: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wktree-remove-test-"));
		originalConfigHome = process.env.XDG_CONFIG_HOME;
	});

	afterEach(() => {
		if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalConfigHome;
		rmSync(tmp, {recursive: true, force: true});
	});

	test("removes a non-pool worktree and branch", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/remove", "--json"], deps);

		const result = await dispatch("remove", ["--cwd", root, "--branch", "feature/remove", "--json"], deps);

		expect(result.exitCode).toBe(0);
		const plan = JSON.parse(result.stdout ?? "{}");
		expect(existsSync(`${root}__feature--remove`)).toBe(false);
		expect(
			(await runRaw(["git", "-C", root, "show-ref", "--verify", "refs/heads/feature/remove"])).exitCode,
		).not.toBe(0);
		expect(plan).toMatchObject({
			kind: "ready",
			worktree_path: `${root}__feature--remove`,
			removed: true,
			session: {
				name: "repo__feature--remove",
				path: `${root}__feature--remove`,
			},
		});
	});

	test("removes by --self path", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/self", "--json"], deps);

		await dispatch("remove", ["--cwd", root, "--self", `${root}__feature--self`, "--json"], deps);

		expect(existsSync(`${root}__feature--self`)).toBe(false);
	});

	test("removes non-pool branches whose encoded paths resemble pool slots", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feat1", "--json"], deps);

		await dispatch("remove", ["--cwd", root, "--branch", "feat1", "--json"], deps);

		expect(existsSync(`${root}__feat1`)).toBe(false);
	});

	test("unmerged branch fails without --force and succeeds with --force", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/unmerged", "--json"], deps);
		writeFileSync(join(`${root}__feature--unmerged`, "unmerged.txt"), "work\n");
		await run(["git", "-C", `${root}__feature--unmerged`, "add", "unmerged.txt"]);
		await run(["git", "-C", `${root}__feature--unmerged`, "commit", "-m", "unmerged"]);

		const blocked = await dispatch("remove", ["--cwd", root, "--branch", "feature/unmerged", "--json"], deps);
		expect(blocked.exitCode).toBe(EXIT_CODES.UNSAFE);
		expect(JSON.parse(blocked.stdout ?? "{}")).toMatchObject({
			kind: "blocked",
			reason: "unmerged_branch",
			branch: "feature/unmerged",
			worktree_path: `${root}__feature--unmerged`,
		});
		expect(existsSync(`${root}__feature--unmerged`)).toBe(true);

		await dispatch("remove", ["--cwd", root, "--branch", "feature/unmerged", "--force", "--json"], deps);
		expect(existsSync(`${root}__feature--unmerged`)).toBe(false);
		expect(
			(await runRaw(["git", "-C", root, "show-ref", "--verify", "refs/heads/feature/unmerged"])).exitCode,
		).not.toBe(0);
	});

	test("machine json remove reports blocked outcomes with unsafe exit codes", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");
		await dispatch("add", ["--cwd", root, "--branch", "feature/unmerged-json", "--json"], deps);
		writeFileSync(join(`${root}__feature--unmerged-json`, "unmerged.txt"), "work\n");
		await run(["git", "-C", `${root}__feature--unmerged-json`, "add", "unmerged.txt"]);
		await run(["git", "-C", `${root}__feature--unmerged-json`, "commit", "-m", "unmerged"]);

		const result = await dispatch(
			"remove",
			["--cwd", root, "--branch", "feature/unmerged-json", "--json"],
			deps,
		);

		expect(result.exitCode).toBe(EXIT_CODES.UNSAFE);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			kind: "blocked",
			reason: "unmerged_branch",
			branch: "feature/unmerged-json",
			worktree_path: `${root}__feature--unmerged-json`,
		});
		expect(existsSync(`${root}__feature--unmerged-json`)).toBe(true);
	});

	test("refuses canonical root and non-worktree targets", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready");

		const canonicalRoot = await dispatch("remove", ["--cwd", root, "--self", root, "--json"], deps);
		expect(canonicalRoot.exitCode).toBe(EXIT_CODES.UNSAFE);
		expect(JSON.parse(canonicalRoot.stdout ?? "{}")).toMatchObject({
			kind: "blocked",
			reason: "canonical_root",
		});
		await expect(
			dispatch("remove", ["--cwd", root, "--self", join(tmp, "missing"), "--json"], deps),
		).rejects.toThrow("not a git worktree");
	});
});

integrationDescribe("wktree pool status", () => {
	let tmp: string;
	let originalConfigHome: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wktree-status-test-"));
		originalConfigHome = process.env.XDG_CONFIG_HOME;
	});

	afterEach(() => {
		if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalConfigHome;
		rmSync(tmp, {recursive: true, force: true});
	});

	test("reports absent slots for an empty pool", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", 2);
		const worktrees = parseWorktreeList(
			(await run(["git", "-C", root, "worktree", "list", "--porcelain"])).stdout,
		);

		const state = await buildPoolState(
			{name: "repo", root, command: "echo ready", poolSize: 2, copyModeDefault: "copy", copy: []},
			worktrees,
			new LiveGitRunner(),
		);

		expect(state).toMatchObject({root, trunk: "main", size: 2});
		expect(state.slots.map((slot) => ({exists: slot.exists, initialized: slot.initialized}))).toEqual([
			{exists: false, initialized: false},
			{exists: false, initialized: false},
		]);
	});

	test("status JSON reports free, taken, dirty, and half-initialized slots", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", 4);
		await createPoolSlot(root, 1, "wk-pool/feat1", true);
		await createPoolSlot(root, 2, "feature/taken", true);
		await createPoolSlot(root, 3, "feature/dirty", true);
		writeFileSync(join(`${root}__feat3`, "dirty.txt"), "dirty\n");
		await createPoolSlot(root, 4, "wk-pool/feat4", false);

		const result = await dispatch("status", ["--cwd", root], deps);
		const state = JSON.parse(result.stdout ?? "{}");

		expect(state.root).toBe(root);
		expect(state.trunk).toBe("main");
		expect(state.slots[0]).toMatchObject({
			index: 1,
			exists: true,
			branch: "wk-pool/feat1",
			placeholder: true,
			dirty: false,
			initialized: true,
		});
		expect(state.slots[1]).toMatchObject({
			index: 2,
			exists: true,
			branch: "feature/taken",
			placeholder: false,
			dirty: false,
			initialized: true,
		});
		expect(state.slots[2]).toMatchObject({
			index: 3,
			exists: true,
			branch: "feature/dirty",
			dirty: true,
			initialized: true,
		});
		expect(state.slots[3]).toMatchObject({index: 4, exists: true, placeholder: true, initialized: false});
		expect(state.slots[0].lastCommitIso).toContain("T");
		expect(state.slots[0].lastCommitSubject).toBe("initial");
	});

	test("gitignored files do not mark a slot dirty and non-pooled status is empty", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", 1);
		await createPoolSlot(root, 1, "wk-pool/feat1", true);
		writeFileSync(join(`${root}__feat1`, ".gitignore"), "node_modules/\n");
		await run(["git", "-C", `${root}__feat1`, "add", ".gitignore"]);
		await run(["git", "-C", `${root}__feat1`, "commit", "-m", "ignore node_modules"]);
		mkdirSync(join(`${root}__feat1`, "node_modules"));
		writeFileSync(join(`${root}__feat1`, "node_modules", "ignored.txt"), "ignored\n");

		const pooled = JSON.parse((await dispatch("status", ["--cwd", root], deps)).stdout ?? "{}");
		expect(pooled.slots[0].dirty).toBe(false);

		writeConfig(tmp, root, "echo ready");
		const nonPooled = JSON.parse((await dispatch("status", ["--cwd", root], deps)).stdout ?? "{}");
		expect(nonPooled).toEqual({root, trunk: null, size: 0, slots: []});
	});
});

integrationDescribe("wktree read-only commands", () => {
	let tmp: string;
	let originalConfigHome: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wktree-test-"));
		originalConfigHome = process.env.XDG_CONFIG_HOME;
	});

	afterEach(() => {
		if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalConfigHome;
		rmSync(tmp, {recursive: true, force: true});
	});

	test("root, list, json list, and non-pool path against a real repo", async () => {
		let root = join(tmp, "repo");
		await initRepo(root);
		root = realpathSync(root);
		const configHome = join(tmp, "config");
		mkdirSync(join(configHome, "ct-worktrees"), {recursive: true});
		writeFileSync(
			join(configHome, "ct-worktrees", "trees.toml"),
			`[[project]]\nroot = "${root}"\ncommand = "echo ready"\n`,
		);
		process.env.XDG_CONFIG_HOME = configHome;

		const rootResult = await dispatch("root", ["--cwd", root], deps);
		expect(rootResult.stdout).toBe(`${root}\n`);

		const listResult = await dispatch("list", ["--cwd", root], deps);
		expect(listResult.stdout).toContain(`${root}  `);
		expect(listResult.stdout).toContain("[main]");
		expect(listResult.stdout).toContain("[canonical]");

		const jsonResult = await dispatch("list", ["--cwd", root, "--json"], deps);
		const parsed = JSON.parse(jsonResult.stdout ?? "[]");
		expect(parsed[0]).toMatchObject({
			path: root,
			branch: "main",
			branch_ref: "refs/heads/main",
			locked: false,
			prunable: false,
			canonical: true,
			pool: null,
		});
		expect(parsed[0].branchRef).toBeUndefined();

		const pathResult = await dispatch("path", ["--cwd", root, "--branch", "feature/cool"], deps);
		expect(pathResult.stdout).toBe(`${root}__feature--cool\n`);
	});

	test("config explain reports effective policy JSON", async () => {
		let root = join(tmp, "repo");
		await initRepo(root);
		root = realpathSync(root);
		const configHome = join(tmp, "config-explain");
		mkdirSync(join(configHome, "ct-worktrees"), {recursive: true});
		writeFileSync(
			join(configHome, "ct-worktrees", "trees.toml"),
			`[defaults.finish]\nstrategy = "rebase_ff"\n\n[[rule]]\nroot_glob = "${realpathSync(tmp)}/**"\n[rule.add]\npolicy = "fresh_canonical"\n[rule.finish]\npush = true\n\n[[project]]\nname = "repo"\nroot = "${root}"\n[project.finish]\ndelete_branch = true\n`,
		);
		process.env.XDG_CONFIG_HOME = configHome;

		const result = await dispatch("config", ["explain", "--cwd", root, "--json"], deps);
		const payload = JSON.parse(result.stdout ?? "{}");

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(payload).toEqual({
			kind: "config_explain",
			root,
			matched_rules: [{root_glob: `${realpathSync(tmp)}/**`}],
			project: {name: "repo", root},
			command: {source: null, value: null},
			add: {policy: "fresh_canonical"},
			finish: {
				enabled: true,
				strategy: "rebase_ff",
				push: true,
				remove_worktree: false,
				delete_branch: true,
			},
		});
	});

	test("list fails fast on malformed config", async () => {
		let root = join(tmp, "repo");
		await initRepo(root);
		root = realpathSync(root);
		const configHome = join(tmp, "config");
		mkdirSync(join(configHome, "ct-worktrees"), {recursive: true});
		writeFileSync(join(configHome, "ct-worktrees", "trees.toml"), "[[project]]\nroot = ");
		process.env.XDG_CONFIG_HOME = configHome;

		await expect(dispatch("list", ["--cwd", root], deps)).rejects.toThrow(ConfigError);
	});

	test("list annotates pool slots and path refuses pooled repos before slot state exists", async () => {
		const configRoot = join(tmp, "repo");
		const {root} = await initRepoWithOrigin(tmp);
		await run(["git", "-C", root, "branch", "wk-pool/feat1"]);
		await run(["git", "-C", root, "worktree", "add", `${root}__feat1`, "wk-pool/feat1"]);
		await run(["git", "-C", root, "worktree", "lock", "--reason", "keep slot", `${root}__feat1`]);
		const configHome = join(tmp, "config");
		mkdirSync(join(configHome, "ct-worktrees"), {recursive: true});
		writeFileSync(
			join(configHome, "ct-worktrees", "trees.toml"),
			`[[project]]\nroot = "${configRoot}"\ncommand = "echo ready"\npool_size = 1\n`,
		);
		process.env.XDG_CONFIG_HOME = configHome;

		const listResult = await dispatch("list", ["--cwd", root], deps);
		expect(listResult.stdout).toContain("[pool:free]");
		const jsonResult = await dispatch("list", ["--cwd", root, "--json"], deps);
		const json = JSON.parse(jsonResult.stdout ?? "[]");
		expect(json[1]).toMatchObject({locked: true, lock_reason: "keep slot"});

		await expect(dispatch("path", ["--cwd", root, "--branch", "feature/cool"], deps)).rejects.toThrow(
			"no pooled worktree",
		);
	});
});

integrationDescribe("wktree pooled add", () => {
	let tmp: string;
	let originalConfigHome: string | undefined;
	let originalHome: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wktree-pool-add-test-"));
		originalConfigHome = process.env.XDG_CONFIG_HOME;
		originalHome = process.env.HOME;
		process.env.HOME = tmp;
	});

	afterEach(() => {
		if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalConfigHome;
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		rmSync(tmp, {recursive: true, force: true});
	});

	test("fresh_canonical blocks dirty canonical root before pooled slot allocation", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", 1, '[project.add]\npolicy = "fresh_canonical"\n');
		await commitOnRemoteDefault({
			remote,
			path: "pooled-dirty-block.txt",
			content: "remote\n",
			message: "pooled dirty block update",
		});
		writeFileSync(join(root, "dirty.txt"), "dirty\n");

		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/pooled-dirty-block", "--json"],
			testDeps(),
		);

		expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "dirty_canonical"});
		expect(existsSync(`${root}__feat1`)).toBe(false);
		expect(
			(await runRaw(["git", "-C", root, "show-ref", "--verify", "refs/heads/feature/pooled-dirty-block"]))
				.exitCode,
		).not.toBe(0);
	});

	test("fresh_canonical fast-forwards canonical root before pooled branch checkout", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", 1, '[project.add]\npolicy = "fresh_canonical"\n');
		await commitOnRemoteDefault({
			remote,
			path: "pooled-fresh.txt",
			content: "fresh pooled\n",
			message: "pooled fresh update",
		});

		await dispatch("add", ["--cwd", root, "--branch", "feature/pooled-fresh", "--json"], testDeps());

		expect((await run(["git", "-C", root, "show", "HEAD:pooled-fresh.txt"])).stdout).toBe("fresh pooled\n");
		expect((await run(["git", "-C", `${root}__feat1`, "show", "HEAD:pooled-fresh.txt"])).stdout).toBe(
			"fresh pooled\n",
		);
		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"feature/pooled-fresh",
		);
	});

	test("origin_default pooled add uses fetched origin default without mutating canonical root", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", 1);
		await commitOnRemoteDefault({
			remote,
			path: "pooled-origin-default.txt",
			content: "origin default\n",
			message: "pooled origin default update",
		});
		const originalHead = (await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim();

		await dispatch("add", ["--cwd", root, "--branch", "feature/pooled-origin-default", "--json"], testDeps());

		expect((await run(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
		expect(
			(await run(["git", "-C", `${root}__feat1`, "show", "HEAD:pooled-origin-default.txt"])).stdout,
		).toBe("origin default\n");
	});

	test("fresh_canonical pooled explicit base bypasses canonical update requirement", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		await createRemoteBranch(remote, "base/policy-check");
		writeConfig(tmp, root, "echo ready", 1, '[project.add]\npolicy = "fresh_canonical"\n');
		writeFileSync(join(root, "dirty.txt"), "dirty\n");

		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/pooled-from-base", "--base", "base/policy-check", "--json"],
			testDeps(),
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			kind: "ready",
			worktree_path: `${root}__feat1`,
			branch: "feature/pooled-from-base",
		});
		expect((await run(["git", "-C", `${root}__feat1`, "show", "HEAD:remote.txt"])).stdout).toBe(
			"base/policy-check\n",
		);
	});

	test("fresh_canonical policy failure does not recycle an occupied pooled slot", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", 1, '[project.add]\npolicy = "fresh_canonical"\n');
		await dispatch("add", ["--cwd", root, "--branch", "feature/occupied", "--json"], testDeps());
		await commitOnRemoteDefault({
			remote,
			path: "pooled-recycle-block.txt",
			content: "remote\n",
			message: "pooled recycle block update",
		});
		writeFileSync(join(root, "dirty.txt"), "dirty\n");

		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/blocked-recycle", "--json", "--slot", `${root}__feat1`, "--force"],
			testDeps(),
		);

		expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({kind: "blocked", reason: "dirty_canonical"});
		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"feature/occupied",
		);
		expect(
			(await runRaw(["git", "-C", root, "show-ref", "--verify", "refs/heads/feature/blocked-recycle"]))
				.exitCode,
		).not.toBe(0);
	});

	test("allocates the lowest initialized free slot and writes a pooled post-create script", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "touch pooled-sentinel", 2);
		await dispatch("ensure", ["--cwd", root], testDeps());

		const result = await dispatch("add", ["--cwd", root, "--branch", "feature/pooled", "--json"], testDeps());

		const plan = JSON.parse(result.stdout ?? "{}");
		const postCreateScriptPath = plan.post_create_script_path as string;
		expect(plan).toMatchObject({
			worktree_path: `${root}__feat1`,
			branch: "feature/pooled",
			created_new_branch: true,
		});
		expect(postCreateScriptPath).toContain(".wktree.");
		expect(postCreateScriptPath).toEndWith("/post-create.sh");
		expect(readFileSync(postCreateScriptPath, "utf8")).toContain("wk-pool-initialized");
		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"feature/pooled",
		);
		expect((await run(["git", "-C", `${root}__feat2`, "branch", "--show-current"])).stdout.trim()).toBe(
			"wk-pool/feat2",
		);
	});

	test("copies into allocated slot after checkout and before post-create script", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, ".env"), "pooled\n");
		writeConfig(tmp, root, 'cat .env > "$WK_CREATED/allocated-read"', 1, 'copy = [".env"]\n');
		await dispatch("ensure", ["--cwd", root], testDeps());

		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/allocated-copy", "--json"],
			testDeps(),
		);
		const plan = JSON.parse(result.stdout ?? "{}");

		expect(readFileSync(join(`${root}__feat1`, ".env"), "utf8")).toBe("pooled\n");
		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"feature/allocated-copy",
		);
		await run(["bash", plan.post_create_script_path]);
		expect(readFileSync(join(`${root}__feat1`, "allocated-read"), "utf8")).toBe("pooled\n");
	});

	test("copy setup failure during allocation restores the slot placeholder", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", 1);
		await dispatch("ensure", ["--cwd", root], testDeps());
		writeConfig(tmp, root, "echo should-not-run", 1, 'copy = [".env.missing"]\n');

		await expect(
			dispatch("add", ["--cwd", root, "--branch", "feature/allocated-copy-fail", "--json"], testDeps()),
		).rejects.toThrow("copy source does not exist");

		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"wk-pool/feat1",
		);
		expect(
			(await runRaw(["git", "-C", root, "show-ref", "--verify", "refs/heads/feature/allocated-copy-fail"]))
				.exitCode,
		).not.toBe(0);
	});

	test("copy setup failure during allocation restores an existing branch tip", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		await createRemoteBranch(remote, "feature/pool-restore-tip");
		await run(["git", "-C", root, "fetch", "origin"]);
		await run(["git", "-C", root, "branch", "feature/pool-restore-tip", "main"]);
		const originalHead = (
			await run(["git", "-C", root, "rev-parse", "refs/heads/feature/pool-restore-tip"])
		).stdout.trim();
		writeConfig(tmp, root, "echo ready", 1);
		await dispatch("ensure", ["--cwd", root], testDeps());
		writeConfig(tmp, root, "echo should-not-run", 1, 'copy = [".env.missing"]\n');

		await expect(
			dispatch("add", ["--cwd", root, "--branch", "feature/pool-restore-tip", "--json"], testDeps()),
		).rejects.toThrow("copy source does not exist");

		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"wk-pool/feat1",
		);
		expect(
			(await run(["git", "-C", root, "rev-parse", "refs/heads/feature/pool-restore-tip"])).stdout.trim(),
		).toBe(originalHead);
	});

	test.each([
		{
			name: "existing remote-only",
			branch: "feature/remote-pool",
			setup: async (_root: string, remote: string) => createRemoteBranch(remote, "feature/remote-pool"),
		},
		{
			name: "existing local",
			branch: "feature/local-pool",
			setup: async (root: string) => run(["git", "-C", root, "branch", "feature/local-pool"]),
		},
	])("allocates $name branch", async ({branch, setup}) => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		await setup(root, remote);
		writeConfig(tmp, root, "echo ready", 1);

		await dispatch("add", ["--cwd", root, "--branch", branch, "--json"], testDeps());

		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			branch,
		);
	});

	test("warns for diverged branches and rejects duplicates without side effects", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		await createRemoteBranch(remote, "feature/diverged-pool");
		await run(["git", "-C", root, "fetch", "origin"]);
		await run(["git", "-C", root, "checkout", "-b", "feature/diverged-pool", "main"]);
		writeFileSync(join(root, "local.txt"), "local\n");
		await run(["git", "-C", root, "add", "local.txt"]);
		await run(["git", "-C", root, "commit", "-m", "local"]);
		await run(["git", "-C", root, "checkout", "main"]);
		writeConfig(tmp, root, "echo ready", 2);
		const warnings: string[] = [];
		const warnDeps = testDeps({progress: {...deps.progress, error: (msg: string) => warnings.push(msg)}});

		await dispatch("add", ["--cwd", root, "--branch", "feature/diverged-pool", "--json"], warnDeps);
		expect(warnings.join("\n")).toContain("couldn't fast-forward");

		await expect(
			dispatch("add", ["--cwd", root, "--branch", "feature/diverged-pool", "--json"], testDeps()),
		).rejects.toThrow(`${root}__feat1`);
		expect((await run(["git", "-C", `${root}__feat2`, "branch", "--show-current"])).stdout.trim()).toBe(
			"wk-pool/feat2",
		);
	});

	test("rejects duplicate canonical branch and reserved branch before allocation", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", 1);

		await expect(dispatch("add", ["--cwd", root, "--branch", "main", "--json"], testDeps())).rejects.toThrow(
			root,
		);
		await expect(
			dispatch("add", ["--cwd", root, "--branch", "wk-pool/feat9", "--json"], testDeps()),
		).rejects.toThrow("reserved");
		expect(existsSync(`${root}__feat1`)).toBe(false);
	});

	test("pooled path finds allocated branch and --base only affects new branches", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		await createRemoteBranch(remote, "base/pool");
		await run(["git", "-C", root, "fetch", "origin"]);
		await run(["git", "-C", root, "branch", "feature/existing-base"]);
		writeConfig(tmp, root, "echo ready", 2);
		const warnings: string[] = [];
		const warnDeps = testDeps({progress: {...deps.progress, error: (msg: string) => warnings.push(msg)}});

		await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/from-base", "--base", "base/pool", "--json"],
			warnDeps,
		);
		expect((await run(["git", "-C", `${root}__feat1`, "show", "HEAD:remote.txt"])).stdout).toBe(
			"base/pool\n",
		);
		expect((await dispatch("path", ["--cwd", root, "--branch", "feature/from-base"], warnDeps)).stdout).toBe(
			`${root}__feat1\n`,
		);
		await expect(dispatch("path", ["--cwd", root, "--branch", "feature/missing"], warnDeps)).rejects.toThrow(
			"no pooled worktree",
		);

		await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/existing-base", "--base", "base/pool", "--json"],
			warnDeps,
		);
		expect(warnings.join("\n")).toContain("--base ignored");
	});

	test("machine json add reports pool_full and --slot selects a specific slot", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", 1);
		await dispatch("add", ["--cwd", root, "--branch", "feature/one", "--json"], testDeps());

		const blocked = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/two", "--json"],
			testDeps({picker: new TestPicker(null, true)}),
		);

		expect(blocked.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(blocked.stdout ?? "{}")).toMatchObject({
			kind: "pool_full",
			root,
			branch: "feature/two",
			candidates: [
				{
					slot: 1,
					path: `${root}__feat1`,
					branch: "feature/one",
					dirty: false,
					local_only: true,
				},
			],
		});

		const selected = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/two", "--json", "--slot", `${root}__feat1`, "--force"],
			testDeps({picker: new TestPicker(null, true)}),
		);

		expect(selected.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(selected.stdout ?? "{}")).toMatchObject({
			kind: "ready",
			worktree_path: `${root}__feat1`,
			branch: "feature/two",
			session: {name: "repo__feat1", path: `${root}__feat1`},
		});
		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"feature/two",
		);
	});

	test("machine json pool_full bypasses picker and leaves the occupied slot untouched", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", 1);
		await dispatch("add", ["--cwd", root, "--branch", "feature/one", "--json"], testDeps());
		await run(["git", "-C", `${root}__feat1`, "branch", "--set-upstream-to", "origin/main", "feature/one"]);
		const picker = new TestPicker("1", true);

		const blocked = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/two", "--json"],
			testDeps({picker}),
		);

		expect(blocked.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(blocked.stdout ?? "{}")).toMatchObject({
			kind: "pool_full",
			branch: "feature/two",
			candidates: [{slot: 1, path: `${root}__feat1`, branch: "feature/one"}],
		});
		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"feature/one",
		);
		expect(picker.items).toEqual([]);
		expect(picker.confirmCalls).toBe(0);
	});

	test("machine json pool_full ignores picker state and --force without mutating the slot", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", 1);
		await dispatch("add", ["--cwd", root, "--branch", "feature/one", "--json"], testDeps());

		const cancelPicker = new TestPicker(null, true);
		const cancelBlocked = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/cancel", "--json"],
			testDeps({picker: cancelPicker}),
		);
		expect(cancelBlocked.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(cancelBlocked.stdout ?? "{}")).toMatchObject({
			kind: "pool_full",
			branch: "feature/cancel",
		});
		expect(cancelPicker.items).toEqual([]);
		expect(cancelPicker.confirmCalls).toBe(0);
		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"feature/one",
		);

		const noPicker = new TestPicker("1", false);
		const noBlocked = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/no", "--json"],
			testDeps({picker: noPicker}),
		);
		expect(noBlocked.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(noBlocked.stdout ?? "{}")).toMatchObject({kind: "pool_full", branch: "feature/no"});
		expect(noPicker.items).toEqual([]);
		expect(noPicker.confirmCalls).toBe(0);
		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"feature/one",
		);

		const forcePicker = new TestPicker("1", false);
		const forceBlocked = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/forced", "--force", "--json"],
			testDeps({picker: forcePicker}),
		);
		expect(forceBlocked.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(forceBlocked.stdout ?? "{}")).toMatchObject({
			kind: "pool_full",
			branch: "feature/forced",
		});
		expect(forcePicker.items).toEqual([]);
		expect(forcePicker.confirmCalls).toBe(0);
		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"feature/one",
		);
	});
});

integrationDescribe("wktree recycle", () => {
	let tmp: string;
	let originalConfigHome: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wktree-recycle-test-"));
		originalConfigHome = process.env.XDG_CONFIG_HOME;
	});

	afterEach(() => {
		if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalConfigHome;
		rmSync(tmp, {recursive: true, force: true});
	});

	test("safe recycle resets slot to placeholder and remove delegates with removed false", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		await createRemoteBranch(remote, "feature/safe");
		writeConfig(tmp, root, "echo ready", 1);
		await dispatch("add", ["--cwd", root, "--branch", "feature/safe", "--json"], testDeps());
		await run([
			"git",
			"-C",
			`${root}__feat1`,
			"branch",
			"--set-upstream-to",
			"origin/feature/safe",
			"feature/safe",
		]);

		const result = await dispatch(
			"remove",
			["--cwd", root, "--branch", "feature/safe", "--json"],
			testDeps(),
		);

		expect(existsSync(`${root}__feat1`)).toBe(true);
		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"wk-pool/feat1",
		);
		expect(
			(await runRaw(["git", "-C", root, "show-ref", "--verify", "refs/heads/feature/safe"])).exitCode,
		).not.toBe(0);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			kind: "ready",
			worktree_path: `${root}__feat1`,
			removed: false,
			session: {
				name: "repo__feat1",
				path: `${root}__feat1`,
			},
		});
	});

	test("safe preflight blocks dirty slots and leaves branch untouched", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo ready", 1);
		await dispatch("add", ["--cwd", root, "--branch", "feature/dirty", "--json"], testDeps());
		writeFileSync(join(`${root}__feat1`, "dirty.txt"), "dirty\n");

		await expect(
			dispatch("recycle", ["--cwd", root, "--slot", `${root}__feat1`], testDeps()),
		).rejects.toThrow("uncommitted changes");

		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"feature/dirty",
		);
		expect(existsSync(join(`${root}__feat1`, "dirty.txt"))).toBe(true);
	});

	test("forced recycle discards tracked and untracked dirt but preserves gitignored node_modules", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, ".gitignore"), "node_modules/\n");
		await run(["git", "-C", root, "add", ".gitignore"]);
		await run(["git", "-C", root, "commit", "-m", "ignore modules"]);
		await run(["git", "-C", root, "push", "origin", "main"]);
		writeConfig(tmp, root, "echo ready", 1);
		await dispatch("add", ["--cwd", root, "--branch", "feature/force-recycle", "--json"], testDeps());
		writeFileSync(join(`${root}__feat1`, "tracked.txt"), "tracked\n");
		await run(["git", "-C", `${root}__feat1`, "add", "tracked.txt"]);
		await run(["git", "-C", `${root}__feat1`, "commit", "-m", "local unmerged"]);
		writeFileSync(join(`${root}__feat1`, "untracked.txt"), "untracked\n");
		mkdirSync(join(`${root}__feat1`, "node_modules"));
		writeFileSync(join(`${root}__feat1`, "node_modules", "keep.txt"), "keep\n");

		await dispatch("recycle", ["--cwd", root, "--slot", `${root}__feat1`, "--force"], testDeps());

		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"wk-pool/feat1",
		);
		expect(existsSync(join(`${root}__feat1`, "tracked.txt"))).toBe(false);
		expect(existsSync(join(`${root}__feat1`, "untracked.txt"))).toBe(false);
		expect(existsSync(join(`${root}__feat1`, "node_modules", "keep.txt"))).toBe(true);
		expect(
			(await runRaw(["git", "-C", root, "show-ref", "--verify", "refs/heads/feature/force-recycle"]))
				.exitCode,
		).not.toBe(0);
	});

	test("missing or unmerged upstream blocks safe recycle", async () => {
		const {root, remote} = await initRepoWithOrigin(tmp);
		await createRemoteBranch(remote, "feature/upstream-blocked");
		writeConfig(tmp, root, "echo ready", 1);
		await dispatch("add", ["--cwd", root, "--branch", "feature/upstream-blocked", "--json"], testDeps());
		await expect(
			dispatch("recycle", ["--cwd", root, "--slot", `${root}__feat1`], testDeps()),
		).rejects.toThrow("no upstream");
		await run([
			"git",
			"-C",
			`${root}__feat1`,
			"branch",
			"--set-upstream-to",
			"origin/feature/upstream-blocked",
			"feature/upstream-blocked",
		]);
		writeFileSync(join(`${root}__feat1`, "ahead.txt"), "ahead\n");
		await run(["git", "-C", `${root}__feat1`, "add", "ahead.txt"]);
		await run(["git", "-C", `${root}__feat1`, "commit", "-m", "ahead"]);

		await expect(
			dispatch("recycle", ["--cwd", root, "--slot", `${root}__feat1`], testDeps()),
		).rejects.toThrow("not merged");
		expect((await run(["git", "-C", `${root}__feat1`, "branch", "--show-current"])).stdout.trim()).toBe(
			"feature/upstream-blocked",
		);
	});
});

integrationDescribe("wktree ensure", () => {
	let tmp: string;
	let originalConfigHome: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wktree-ensure-test-"));
		originalConfigHome = process.env.XDG_CONFIG_HOME;
	});

	afterEach(() => {
		if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalConfigHome;
		rmSync(tmp, {recursive: true, force: true});
	});

	test("materialises slots sequentially and streams hook output", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo hook-$WK_CREATED; touch sentinel", 2);
		const events: string[] = [];
		const liveDeps = testDeps({
			progress: {
				banner: (line: string) => {
					events.push(line);
				},
				stream: (_stream: "stdout" | "stderr", line: string) => {
					events.push(line);
				},
				error: () => undefined,
			},
		});

		await dispatch("ensure", ["--cwd", root], liveDeps);

		expect(events[0]).toBe("[wk-pool] initializing feat1…");
		expect(events.some((event) => event.includes("__feat1"))).toBe(true);
		expect(events.indexOf("[wk-pool] initializing feat1…")).toBeLessThan(
			events.indexOf("[wk-pool] initializing feat2…"),
		);
		expect(existsSync(join(`${root}__feat1`, "sentinel"))).toBe(true);
		expect(existsSync(join(`${root}__feat2`, "sentinel"))).toBe(true);
	});

	test("copies files before pooled ensure hooks run", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, ".env"), "ensure-copy\n");
		writeConfig(tmp, root, 'cat .env > "$WK_CREATED/hook-read-env"', 2, 'copy = [".env"]\n');

		await dispatch("ensure", ["--cwd", root], testDeps());

		expect(readFileSync(join(`${root}__feat1`, "hook-read-env"), "utf8")).toBe("ensure-copy\n");
		expect(readFileSync(join(`${root}__feat2`, "hook-read-env"), "utf8")).toBe("ensure-copy\n");
		expect((await run(["git", "-C", `${root}__feat1`, "status", "--porcelain", "--", ".env"])).stdout).toBe(
			"",
		);
	});

	test("hook failure rolls back only in-flight slot and rerun recovers", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(
			tmp,
			root,
			'case "$WK_CREATED" in *__feat2) if [ ! -f "$WK_ROOT/recover" ]; then exit 7; fi;; esac; touch sentinel',
			3,
		);

		await expect(dispatch("ensure", ["--cwd", root], testDeps())).rejects.toThrow(HookError);
		expect(existsSync(`${root}__feat1`)).toBe(true);
		expect(existsSync(`${root}__feat2`)).toBe(false);
		expect(existsSync(`${root}__feat3`)).toBe(false);

		writeFileSync(join(root, "recover"), "ok\n");
		await dispatch("ensure", ["--cwd", root], testDeps());
		expect(existsSync(join(`${root}__feat3`, "sentinel"))).toBe(true);
	});

	test("half-init reruns hook and preserves existing slot on failure", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo rerun >> hook.log", 1);
		await createPoolSlot(root, 1, "wk-pool/feat1", false);

		await dispatch("ensure", ["--cwd", root], testDeps());

		expect(readFileSync(join(`${root}__feat1`, "hook.log"), "utf8")).toContain("rerun");
		const marker = (
			await run(["git", "-C", `${root}__feat1`, "rev-parse", "--git-path", "wk-pool-initialized"])
		).stdout.trim();
		expect(existsSync(resolve(`${root}__feat1`, marker))).toBe(true);

		writeConfig(tmp, root, "exit 9", 2);
		await createPoolSlot(root, 2, "wk-pool/feat2", false);
		await expect(dispatch("ensure", ["--cwd", root], testDeps())).rejects.toThrow(HookError);
		expect(existsSync(`${root}__feat2`)).toBe(true);
	});

	test("copy failure rolls back newly-created pooled slots", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "touch should-not-run", 1, 'copy = [".env.missing"]\n');

		await expect(dispatch("ensure", ["--cwd", root], testDeps())).rejects.toMatchObject({
			exitCode: EXIT_CODES.USAGE,
		});

		expect(existsSync(`${root}__feat1`)).toBe(false);
	});

	test("copy failure preserves existing half-initialized pooled slots", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "touch should-not-run", 2, 'copy = [".env.missing"]\n');
		await createPoolSlot(root, 1, "wk-pool/feat1", true);
		await createPoolSlot(root, 2, "wk-pool/feat2", false);

		await expect(dispatch("ensure", ["--cwd", root], testDeps())).rejects.toMatchObject({
			exitCode: EXIT_CODES.USAGE,
		});

		expect(existsSync(`${root}__feat2`)).toBe(true);
		expect(existsSync(join(`${root}__feat2`, "should-not-run"))).toBe(false);
		const marker = (
			await run(["git", "-C", `${root}__feat2`, "rev-parse", "--git-path", "wk-pool-initialized"])
		).stdout.trim();
		expect(existsSync(resolve(`${root}__feat2`, marker))).toBe(false);
	});

	test("list json keeps pool initialization stdout out of structured output", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeConfig(tmp, root, "echo setup-output", 1);
		const diagnostics: string[] = [];

		const result = await dispatch(
			"list",
			["--cwd", root, "--json"],
			testDeps({progress: {...deps.progress, error: (msg: string) => diagnostics.push(msg)}}),
		);

		expect(() => JSON.parse(result.stdout ?? "")).not.toThrow();
		expect(diagnostics).toContain("setup-output");
	});

	test("list and pooled remove trigger first-run ensure", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, ".env"), "ensured-copy\n");
		writeConfig(tmp, root, "echo setup-output; touch ensured", 1, 'copy = [".env"]\n');

		const listResult = await dispatch("list", ["--cwd", root], testDeps());
		expect(listResult.stdout).toContain("[pool:free]");
		expect(existsSync(join(`${root}__feat1`, "ensured"))).toBe(true);
		expect(readFileSync(join(`${root}__feat1`, ".env"), "utf8")).toBe("ensured-copy\n");

		rmSync(`${root}__feat1`, {recursive: true, force: true});
		await run(["git", "-C", root, "worktree", "prune"]);
		const blocked = await dispatch(
			"remove",
			["--cwd", root, "--self", `${root}__feat1`, "--json"],
			testDeps(),
		);
		expect(blocked.exitCode).toBe(EXIT_CODES.UNSAFE);
		expect(JSON.parse(blocked.stdout ?? "{}")).toMatchObject({
			kind: "blocked",
			reason: "dirty_slot",
			worktree_path: `${root}__feat1`,
		});
		expect(readFileSync(join(`${root}__feat1`, ".env"), "utf8")).toBe("ensured-copy\n");
		expect((await run(["git", "-C", `${root}__feat1`, "status", "--porcelain", "--", ".env"])).stdout).toBe(
			"",
		);
	});

	test("pooled remove-triggered ensure copies into half-initialized slots", async () => {
		const {root} = await initRepoWithOrigin(tmp);
		writeFileSync(join(root, ".env"), "half-remove-copy\n");
		writeConfig(tmp, root, "touch ensured", 1, 'copy = [".env"]\n');
		await createPoolSlot(root, 1, "wk-pool/feat1", false);

		const blocked = await dispatch(
			"remove",
			["--cwd", root, "--self", `${root}__feat1`, "--json"],
			testDeps(),
		);

		expect(blocked.exitCode).toBe(EXIT_CODES.UNSAFE);
		expect(readFileSync(join(`${root}__feat1`, ".env"), "utf8")).toBe("half-remove-copy\n");
	});
});

class TestPicker {
	items: {key: string; display: string; preview: string}[] = [];
	confirmCalls = 0;

	constructor(
		private choice: string | null,
		private confirmed: boolean,
	) {}

	async pick(items: {key: string; display: string; preview: string}[]) {
		this.items = items;
		if (this.choice === null) throw new PickerCancelled();
		const item = items.find((candidate) => candidate.key === this.choice);
		if (!item) throw new PickerCancelled();
		return item;
	}

	async confirm() {
		this.confirmCalls++;
		return this.confirmed;
	}
}

function testDeps(overrides: Partial<Deps> = {}): Deps {
	return {
		git: new LiveGitRunner(),
		hooks: new LiveHookRunner(),
		picker: deps.picker,
		progress: deps.progress,
		...overrides,
	};
}

function writeConfig(
	...args: [tmp: string, root: string, command: string, poolSize?: number, copyToml?: string]
) {
	const [tmp, root, command, poolSize, copyToml] = args;
	const configHome = join(tmp, "config");
	mkdirSync(join(configHome, "ct-worktrees"), {recursive: true});
	writeFileSync(
		join(configHome, "ct-worktrees", "trees.toml"),
		`[[project]]\nroot = "${root}"\ncommand = '''\n${command}\n'''\n${poolSize ? `pool_size = ${poolSize}\n` : ""}${copyToml ?? ""}`,
	);
	process.env.XDG_CONFIG_HOME = configHome;
}

let baseOriginFixture: {root: string; remote: string; tmp: string} | null = null;

afterAll(() => {
	if (baseOriginFixture) rmSync(baseOriginFixture.tmp, {recursive: true, force: true});
});

async function initRepoWithOrigin(tmp: string) {
	const fixture = await ensureBaseOriginFixture();
	let root = join(tmp, "repo");
	const remote = join(tmp, "origin.git");
	cpSync(fixture.root, root, {recursive: true});
	cpSync(fixture.remote, remote, {recursive: true});
	root = realpathSync(root);
	await run(["git", "-C", root, "remote", "set-url", "origin", remote]);
	return {root, remote};
}

async function ensureBaseOriginFixture() {
	if (baseOriginFixture) return baseOriginFixture;
	const tmp = mkdtempSync(join(tmpdir(), "wktree-origin-fixture-"));
	let root = join(tmp, "repo");
	await initRepo(root);
	root = realpathSync(root);
	const remote = join(tmp, "origin.git");
	await run(["git", "init", "--bare", remote]);
	await run(["git", "-C", root, "remote", "add", "origin", remote]);
	await run(["git", "-C", root, "push", "-u", "origin", "main"]);
	await run(["git", "-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
	await run(["git", "-C", root, "remote", "set-head", "origin", "-a"]);
	baseOriginFixture = {root, remote, tmp};
	return baseOriginFixture;
}

async function createPoolSlot(...args: [root: string, index: number, branch: string, initialized: boolean]) {
	const [root, index, branch, initialized] = args;
	await run(["git", "-C", root, "branch", branch]);
	const slotPath = `${root}__feat${index}`;
	await run(["git", "-C", root, "worktree", "add", slotPath, branch]);
	if (initialized) {
		const marker = (
			await run(["git", "-C", slotPath, "rev-parse", "--git-path", "wk-pool-initialized"])
		).stdout.trim();
		writeFileSync(resolve(slotPath, marker), "");
	}
}

async function createRemoteBranch(remote: string, branch: string) {
	const clone = mkdtempSync(join(tmpdir(), "wktree-remote-clone-"));
	try {
		await run(["git", "clone", remote, clone]);
		await run(["git", "-C", clone, "config", "user.email", "test@example.test"]);
		await run(["git", "-C", clone, "config", "user.name", "Test User"]);
		await run(["git", "-C", clone, "checkout", "-b", branch]);
		writeFileSync(join(clone, "remote.txt"), `${branch}\n`);
		await run(["git", "-C", clone, "add", "remote.txt"]);
		await run(["git", "-C", clone, "commit", "-m", `remote ${branch}`]);
		await run(["git", "-C", clone, "push", "origin", branch]);
	} finally {
		rmSync(clone, {recursive: true, force: true});
	}
}

async function commitFile(change: {repo: string; path: string; content: string; message: string}) {
	writeFileSync(join(change.repo, change.path), change.content);
	await run(["git", "-C", change.repo, "add", change.path]);
	await run(["git", "-C", change.repo, "commit", "-m", change.message]);
}

async function commitOnRemoteDefault(change: {
	remote: string;
	path: string;
	content: string;
	message: string;
}) {
	const clone = mkdtempSync(join(tmpdir(), "wktree-remote-default-"));
	try {
		await run(["git", "clone", change.remote, clone]);
		await run(["git", "-C", clone, "config", "user.email", "test@example.test"]);
		await run(["git", "-C", clone, "config", "user.name", "Test User"]);
		writeFileSync(join(clone, change.path), change.content);
		await run(["git", "-C", clone, "add", change.path]);
		await run(["git", "-C", clone, "commit", "-m", change.message]);
		await run(["git", "-C", clone, "push", "origin", "HEAD:main"]);
	} finally {
		rmSync(clone, {recursive: true, force: true});
	}
}

async function initRepo(root: string) {
	mkdirSync(root, {recursive: true});
	await run(["git", "init", "-b", "main", root]);
	await run(["git", "-C", root, "config", "user.email", "test@example.test"]);
	await run(["git", "-C", root, "config", "user.name", "Test User"]);
	writeFileSync(join(root, "README.md"), "hello\n");
	await run(["git", "-C", root, "add", "README.md"]);
	await run(["git", "-C", root, "commit", "-m", "initial"]);
}

async function run(cmd: string[]) {
	const result = await runRaw(cmd);
	if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
	return result;
}

async function runRaw(cmd: string[]) {
	const proc = Bun.spawn(cmd, {stdout: "pipe", stderr: "pipe"});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {stdout, stderr, exitCode};
}
