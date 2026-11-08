import { ConfigError, EXIT_CODES, dispatch } from "../../src/index";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	commitFile,
	createWorktree,
	deps,
	restoreTestEnv,
	run,
	setTestEnv,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { join, resolve } from "node:path";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { tmpdir } from "node:os";

const { initRepoWithOrigin } = useOriginFixture();

let tmp = "";

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "wktree-copy-test-"));
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

async function initTrackedDescendant() {
	const { root } = await initRepoWithOrigin(tmp);
	await mkdir(join(root, "src-dir"));
	await writeFile(join(root, "src-dir", "foo.txt"), "source\n");
	writeConfig({ command: "echo ready", root, tmp });
	await createWorktree({
		root,
		branch: "feature/tracked-desc",
		path: `${root}__feature--tracked-desc`,
	});
	writeConfig({
		command: "echo ready",
		copyToml: 'copy = [{ from = "src-dir", to = "tracked-dir" }]\n',
		root,
		tmp,
	});
	const worktreePath = `${root}__feature--tracked-desc`;
	await mkdir(join(worktreePath, "tracked-dir"));
	await commitFile({
		content: "tracked\n",
		message: "tracked descendant",
		path: "tracked-dir/keep.txt",
		repo: worktreePath,
	});
	return { worktreePath };
}

test("tracked descendants under directory destinations block with unsafe JSON #test-170", async () => {
	const { worktreePath } = await initTrackedDescendant();

	const result = await dispatch("copy", ["--cwd", worktreePath, "--json"], deps);

	expect(result.exitCode).toBe(EXIT_CODES.UNSAFE);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({ kind: "blocked", reason: "unsafe" });
	expect(await readFile(join(worktreePath, "tracked-dir", "keep.txt"), "utf8")).toBe("tracked\n");
});

async function initTrackedAncestor() {
	const { root } = await initRepoWithOrigin(tmp);
	await writeFile(join(root, ".env"), "source\n");
	await writeFile(join(root, "tracked-file"), "tracked\n");
	await run(["git", "-C", root, "add", "tracked-file"]);
	await run(["git", "-C", root, "commit", "-m", "tracked ancestor"]);
	writeConfig({ command: "echo ready", root, tmp });
	await createWorktree({
		root,
		branch: "feature/tracked-ancestor",
		path: `${root}__feature--tracked-ancestor`,
	});
	writeConfig({
		command: "echo ready",
		copyToml: 'copy = [{ from = ".env", to = "tracked-file/nested" }]\n',
		root,
		tmp,
	});
	return { root };
}

test("tracked destination ancestors block with unsafe JSON #test-169", async () => {
	const { root } = await initTrackedAncestor();

	const result = await dispatch(
		"copy",
		["--cwd", `${root}__feature--tracked-ancestor`, "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.UNSAFE);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({ kind: "blocked", reason: "unsafe" });
});

async function commitTrackedSettings(root: string) {
	await mkdir(join(root, ".claude"));
	await writeFile(join(root, ".claude", "settings.json"), '{"tracked":true}\n');
	await run(["git", "-C", root, "add", "source.txt", ".claude/settings.json"]);
	await run(["git", "-C", root, "commit", "-m", "track claude settings"]);
}

async function initTrackedDirectory() {
	const { root } = await initRepoWithOrigin(tmp);
	await writeFile(join(root, "source.txt"), "source\n");
	await commitTrackedSettings(root);
	writeConfig({ command: "echo ready", root, tmp });
	await createWorktree({
		root,
		branch: "feature/tracked-dir-ancestor",
		path: `${root}__feature--tracked-dir-ancestor`,
	});
	writeConfig({
		command: "echo ready",
		copyToml: 'copy = [{ from = "source.txt", to = ".claude/settings.local.json" }]\n',
		root,
		tmp,
	});
	const worktreePath = `${root}__feature--tracked-dir-ancestor`;
	return { root, worktreePath };
}

test("untracked file inside tracked directory destination is allowed #test-168", async () => {
	const { root, worktreePath } = await initTrackedDirectory();

	const result = await dispatch("copy", ["--cwd", worktreePath, "--json"], deps);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(await readFile(join(worktreePath, ".claude", "settings.local.json"), "utf8")).toBe(
		"source\n",
	);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		copied: [{ from: join(root, "source.txt"), to: ".claude/settings.local.json", type: "file" }],
		exclude_paths: [".claude/settings.local.json"],
		kind: "ready",
		root,
		worktree_path: worktreePath,
	});
});

test("copy command reports ConfigError for an object entry without a source #test-173", async () => {
	const { root } = await initRepoWithOrigin(tmp);
	writeConfig({ command: "echo ready", root, tmp });
	await createWorktree({
		root,
		branch: "feature/invalid-object",
		path: `${root}__feature--invalid-object`,
	});
	writeConfig({ command: "echo ready", copyToml: 'copy = [{ to = ".env" }]\n', root, tmp });

	const result = await dispatch(
		"copy",
		["--cwd", `${root}__feature--invalid-object`, "--json"],
		deps,
	);
	expect(result.failure).toBeInstanceOf(ConfigError);
});

async function sharedExcludePath(root: string) {
	const result = await run(["git", "-C", root, "rev-parse", "--git-path", "info/exclude"]);
	return result.stdout.trim();
}

async function initSymlinkedExclude() {
	const { root } = await initRepoWithOrigin(tmp);
	const excludePath = await sharedExcludePath(root);
	const realExclude = join(tmp, "real-exclude");
	await rm(resolve(root, excludePath));
	await symlink(realExclude, resolve(root, excludePath));
	await writeFile(realExclude, "*.log\n");
	await writeFile(join(root, ".env"), "ignored\n");
	writeConfig({ command: "echo ready", copyToml: 'copy = [".env"]\n', root, tmp });
	await createWorktree({
		root,
		branch: "feature/symlink-exclude",
		path: `${root}__feature--symlink-exclude`,
	});
	return { excludePath, realExclude, root };
}

test("follows symlinked shared exclude path #test-174", async () => {
	const { root, realExclude, excludePath } = await initSymlinkedExclude();

	await dispatch("copy", ["--cwd", `${root}__feature--symlink-exclude`], deps);

	expect(await readFile(realExclude, "utf8")).toBe("*.log\n# wktree-start\n.env\n# wktree-end\n");
	const excludeStat = await lstat(resolve(root, excludePath));
	expect(excludeStat.isSymbolicLink()).toBe(true);
});

async function initExcludeFence() {
	const { root } = await initRepoWithOrigin(tmp);
	const excludePath = await sharedExcludePath(root);
	await writeFile(resolve(root, excludePath), "*.log\n");
	await writeFile(join(root, ".env"), "ignored\n");
	writeConfig({ command: "echo ready", copyToml: 'copy = [".env"]\n', root, tmp });
	await createWorktree({
		root,
		branch: "feature/ignore-copy",
		path: `${root}__feature--ignore-copy`,
	});
	const worktreePath = `${root}__feature--ignore-copy`;
	return { excludePath, root, worktreePath };
}

test(
	"exclude fence is idempotent, preserves unrelated lines, removes when copy is removed, and ignores " +
		"copied files #test-171",
	async () => {
		const { root, excludePath, worktreePath } = await initExcludeFence();

		await dispatch("copy", ["--cwd", worktreePath], deps);
		await dispatch("copy", ["--cwd", worktreePath], deps);

		const withFence = await readFile(resolve(root, excludePath), "utf8");
		expect(withFence).toBe("*.log\n# wktree-start\n.env\n# wktree-end\n");
		const status = await run(["git", "-C", worktreePath, "status", "--porcelain"]);
		expect(status.stdout).toBe("");

		writeConfig({ command: "echo ready", root, tmp });
		await dispatch("copy", ["--cwd", worktreePath], deps);

		expect(await readFile(resolve(root, excludePath), "utf8")).toBe("*.log\n");
	},
);
