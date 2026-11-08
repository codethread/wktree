/* eslint-disable import/max-dependencies --
 * Integration dependencies pair the inventory adapter with the selected GitRunner.
 */
// Integration suites create real Git worktrees and fixture files on disk.
// oxlint-disable-next-line import/no-nodejs-modules
import { access, appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
// Fixture copies and inline config writes use the synchronous filesystem API.
// oxlint-disable-next-line import/no-nodejs-modules
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
/* oxlint-disable-next-line import/no-nodejs-modules -- fixtures build paths inside their temporary roots */
import { join, resolve } from "node:path";
import type { Deps } from "../../src/index";
import { EXIT_CODES } from "../../src/errors.ts";
import { afterAll } from "bun:test";
import { createGitWorktreeInventory } from "../../src/git/worktrees.ts";
import { createLiveDeps } from "../../src/live-deps.ts";
import { createTestCdDirective } from "./fakes/test-cd-directive.ts";
import { createTestMultiplexer } from "./fakes/test-multiplexer.ts";
/* oxlint-disable-next-line import/no-nodejs-modules -- fixtures need the host temporary directory */
import { tmpdir } from "node:os";

const savedEnv = new Map<string, string | undefined>();
const liveDeps = createLiveDeps();

export const deps: Deps = {
	...liveDeps,
	cdDirective: createTestCdDirective(),
	hooks: { runCommand: liveDeps.hooks.runCommand, runInline: async () => {} },
	multiplexer: createTestMultiplexer(),
	picker: {
		confirm: () => Promise.resolve(true),
		pick: () => Promise.resolve({ display: "", key: "", preview: "" }),
	},
	progress: {
		banner: () => {},
		error: () => {},
		stream: () => {},
	},
};

interface OriginFixture {
	/** Bare Git repository used as the fixture's remote origin. */
	remote: string;
	/** Working repository with an origin remote configured. */
	root: string;
	/** Temporary directory containing the repositories. */
	tmp: string;
}

export function setTestEnv(name: string, value: string): void {
	if (!savedEnv.has(name)) {
		savedEnv.set(name, process.env[name]);
	}
	process.env[name] = value;
}

export function restoreTestEnv(): void {
	for (const [name, value] of savedEnv) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
	savedEnv.clear();
}

/** Async existsSync replacement; Bun.file().exists() is false for directories. */
export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export function testDeps(overrides: Partial<Deps> = {}): Deps {
	const live = createLiveDeps();
	const git = overrides.git ?? live.git;
	return {
		...live,
		git,
		worktrees: createGitWorktreeInventory(git),
		cdDirective: createTestCdDirective(),
		multiplexer: createTestMultiplexer(),
		picker: deps.picker,
		progress: deps.progress,
		...overrides,
	};
}

/** Write configuration synchronously so integration suites can call this helper inline. */
export function writeConfig(options: {
	tmp: string;
	root: string;
	command: string;
	poolSize?: number;
	copyToml?: string;
}): void {
	const { tmp, root, command, poolSize, copyToml } = options;
	const configHome = join(tmp, "config");
	// oxlint-disable-next-line node/no-sync
	mkdirSync(configHome, { recursive: true });
	let poolLine = "";
	if (poolSize) {
		poolLine = `pool_size = ${poolSize}\n`;
	}
	// oxlint-disable-next-line node/no-sync
	writeFileSync(
		join(configHome, "wktree.toml"),
		`[[project]]\nroot = "${root}"\ncommand = '''\n${command}\n'''\n${poolLine}${copyToml ?? ""}`,
	);
	setTestEnv("XDG_CONFIG_HOME", configHome);
}

export function useOriginFixture() {
	const state: { base?: OriginFixture } = {};

	afterAll(async () => {
		if (state.base) {
			await rm(state.base.tmp, { force: true, recursive: true });
		}
	});

	const ensureBaseOriginFixture = async (): Promise<OriginFixture> => {
		state.base ??= await buildBaseOriginFixture();
		return state.base;
	};

	const initRepoWithOrigin = async (tmp: string) => {
		const fixture = await ensureBaseOriginFixture();
		const root = join(tmp, "repo");
		const remote = join(tmp, "origin.git");
		// oxlint-disable-next-line node/no-sync
		cpSync(fixture.root, root, { recursive: true });
		// oxlint-disable-next-line node/no-sync
		cpSync(fixture.remote, remote, { recursive: true });
		// Retarget the single origin URL from buildBaseOriginFixture in this test's copied config.
		const configPath = join(root, ".git", "config");
		// oxlint-disable-next-line node/no-sync
		const config = readFileSync(configPath, "utf8");
		// oxlint-disable-next-line node/no-sync
		writeFileSync(configPath, config.replace(fixture.remote, remote));
		return { remote, root: await realpath(root) };
	};

	return { initRepoWithOrigin };
}

export async function createPoolSlot(options: {
	root: string;
	index: number;
	branch: string;
	initialized: boolean;
	startPoint?: string;
}): Promise<void> {
	const { index, initialized, ...worktree } = options;
	const { root } = worktree;
	const slotPath = `${root}__feat${index}`;
	await createWorktree({ ...worktree, path: slotPath });
	if (initialized) {
		const result = await run([
			"git",
			"-C",
			slotPath,
			"rev-parse",
			"--git-path",
			"wk-pool-initialized",
		]);
		await writeFile(resolve(slotPath, result.stdout.trim()), "");
	}
}

/** Prepare a real worktree without running the lifecycle operation under test. */
export async function createWorktree(options: {
	root: string;
	branch: string;
	path: string;
	startPoint?: string;
}): Promise<void> {
	const { root, branch, path, startPoint } = options;
	const args = ["git", "-C", root, "worktree", "add", "--no-track", "-b", branch, path];
	if (startPoint) {
		args.push(startPoint);
	}
	await run(args);
}

export async function createRemoteBranch(remote: string, branch: string): Promise<void> {
	const worktree = await mkdtemp(join(tmpdir(), "wktree-remote-branch-"));
	try {
		await createWorktree({ branch, path: worktree, root: remote });
		await commitFile({
			content: `${branch}\n`,
			message: `remote ${branch}`,
			path: "remote.txt",
			repo: worktree,
		});
	} finally {
		await run(["git", "-C", remote, "worktree", "remove", "--force", worktree]);
	}
}

export async function commitFile(change: {
	content: string;
	message: string;
	path: string;
	repo: string;
}): Promise<void> {
	await writeFile(join(change.repo, change.path), change.content);
	await run(["git", "-C", change.repo, "add", change.path]);
	await run(["git", "-C", change.repo, "commit", "-m", change.message]);
}

export async function commitOnRemoteDefault(change: {
	content: string;
	message: string;
	path: string;
	remote: string;
}): Promise<void> {
	const worktree = await mkdtemp(join(tmpdir(), "wktree-remote-default-"));
	try {
		await run(["git", "-C", change.remote, "worktree", "add", worktree, "main"]);
		await commitFile({ ...change, repo: worktree });
	} finally {
		await run(["git", "-C", change.remote, "worktree", "remove", "--force", worktree]);
	}
}

export async function initRepo(root: string): Promise<void> {
	await mkdir(root, { recursive: true });
	await run(["git", "init", "--template=", "-b", "main", root]);
	await configureGitFixture(join(root, ".git"));
	await writeFile(join(root, "README.md"), "hello\n");
	await run(["git", "-C", root, "add", "README.md"]);
	await run(["git", "-C", root, "commit", "-m", "initial"]);
}

export async function run(cmd: string[], input = "") {
	const result = await runRaw(cmd, input);
	if (result.exitCode !== EXIT_CODES.SUCCESS) {
		throw new Error(`${cmd.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
	}
	return result;
}

export async function runRaw(cmd: string[], input = "") {
	const proc = Bun.spawn(cmd, { stdin: new Blob([input]), stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stderr, stdout };
}

// Private integration fixture and Git helpers.

async function configureGitFixture(gitDirectory: string): Promise<void> {
	await Promise.all([
		appendFile(
			join(gitDirectory, "config"),
			"\n[user]\n\temail = test@example.test\n\tname = Test User\n",
		),
		mkdir(join(gitDirectory, "hooks"), { recursive: true }),
		mkdir(join(gitDirectory, "info"), { recursive: true }),
	]);
	// Retain hook installation and shared-exclude fixtures without copying Git sample templates.
	await writeFile(join(gitDirectory, "info", "exclude"), "");
}

async function buildBaseOriginFixture(): Promise<OriginFixture> {
	const tmp = await mkdtemp(join(tmpdir(), "wktree-origin-fixture-"));
	const remote = join(tmp, "origin.git");
	await run(["git", "init", "--template=", "--bare", "-b", "main", remote]);
	await configureGitFixture(remote);
	// Seed the initial history in one native Git operation, without a throwaway working checkout.
	await run(
		["git", "-C", remote, "fast-import", "--quiet"],
		"commit refs/heads/main\n" +
			"committer Test User <test@example.test> 1700000000 +0000\n" +
			"data 8\n" +
			"initial\n" +
			"\n" +
			"M 100644 inline README.md\n" +
			"data 6\n" +
			"hello\n" +
			"\n" +
			"\n" +
			"done\n",
	);
	await run(["git", "clone", "--template=", remote, join(tmp, "repo")]);
	const root = await realpath(join(tmp, "repo"));
	await configureGitFixture(join(root, ".git"));
	return { remote, root, tmp };
}

export { createTestCdDirective } from "./fakes/test-cd-directive.ts";
export { createTestMultiplexer } from "./fakes/test-multiplexer.ts";
export { createTestPicker } from "./fakes/test-picker.ts";
export type { TestPicker } from "./fakes/test-picker.ts";
