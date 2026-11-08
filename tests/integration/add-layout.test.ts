import { createWorktree, deps, pathExists, run, setTestEnv, useOriginFixture } from "./support.ts";
import { expect, test } from "bun:test";
import { gitText, useTmpHome } from "./lifecycle-helpers.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dispatch } from "../../src/index";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { join } from "node:path";

const tmp = useTmpHome("wktree-add-test-");
const { initRepoWithOrigin } = useOriginFixture();

async function prepareNestedRoot() {
	const { root } = await initRepoWithOrigin(tmp.dir);
	const configHome = join(tmp.dir, "config-nested");
	await mkdir(configHome, { recursive: true });
	await writeFile(
		join(configHome, "wktree.toml"),
		`worktree_location = "sibling"\n\n[[project]]\nroot = "${root}"\nworktree_location = "nested"\n`,
	);
	setTestEnv("XDG_CONFIG_HOME", configHome);
	return root;
}

async function prepareLegacyWorktrees() {
	const { root } = await initRepoWithOrigin(tmp.dir);
	const configHome = join(tmp.dir, "config-mixed-layout");
	await mkdir(configHome, { recursive: true });
	setTestEnv("XDG_CONFIG_HOME", configHome);
	await writeFile(join(configHome, "wktree.toml"), 'worktree_location = "sibling"\n');
	await createWorktree({ root, branch: "feature/legacy", path: `${root}__feature--legacy` });
	const manualPath = join(tmp.dir, "manual-worktree");
	await run(["git", "-C", root, "worktree", "add", "-b", "feature/manual", manualPath]);
	const resolvedManualPath = await realpath(manualPath);
	return { configHome, manualPath: resolvedManualPath, root };
}

async function prepareMixedLayout() {
	const { configHome, manualPath, root } = await prepareLegacyWorktrees();
	await writeFile(join(configHome, "wktree.toml"), 'worktree_location = "nested"\n');
	const nestedPath = join(root, ".worktrees", "feature--new");
	await dispatch("add", ["--cwd", root, "--branch", "feature/new", "--json"], deps);
	return { legacyPath: `${root}__feature--legacy`, manualPath, nestedPath, root };
}

test("creates nested worktrees under the canonical root without dirtying it #test-199", async () => {
	const root = await prepareNestedRoot();
	const worktreePath = join(root, ".worktrees", "feature--nested");

	const pathResult = await dispatch("path", ["--cwd", root, "--branch", "feature/nested"], deps);
	const addResult = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/nested", "--json"],
		deps,
	);

	expect(pathResult.stdout).toBe(`${worktreePath}\n`);
	expect(JSON.parse(addResult.stdout ?? "{}")).toMatchObject({
		session: { name: "repo__feature--nested", path: worktreePath },
		worktree_path: worktreePath,
	});
	expect(await pathExists(join(worktreePath, ".git"))).toBe(true);
	expect(await gitText(root, "status", "--porcelain")).toBe("");
});
test("keeps legacy and manual worktrees discoverable after changing location #test-200", async () => {
	const { root, legacyPath, manualPath, nestedPath } = await prepareMixedLayout();

	const legacy = await dispatch("path", ["--cwd", root, "--branch", "feature/legacy"], deps);
	expect(legacy.stdout).toBe(`${legacyPath}\n`);
	const manual = await dispatch("path", ["--cwd", root, "--branch", "feature/manual"], deps);
	expect(manual.stdout).toBe(`${manualPath}\n`);
	const listing = await dispatch("list", ["--cwd", root, "--json"], deps);
	const listed = JSON.parse(listing.stdout ?? "{}");
	expect(listed.worktrees.map((worktree: { path: string }) => worktree.path)).toEqual(
		expect.arrayContaining([root, legacyPath, manualPath, nestedPath]),
	);
	const duplicate = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/legacy", "--json"],
		deps,
	);
	expect(JSON.parse(duplicate.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		message: expect.stringContaining(legacyPath),
		reason: "duplicate_branch",
	});
});
