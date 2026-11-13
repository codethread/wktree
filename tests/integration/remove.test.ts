import { EXIT_CODES, UsageError, dispatch } from "../../src/index";
import {
	commitFile,
	createWorktree,
	deps,
	pathExists,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
import { expect, test } from "bun:test";
import { gitSucceeds, useTmpHome } from "./lifecycle-helpers.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { join } from "node:path";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { mkdir } from "node:fs/promises";

const tmp = useTmpHome("wktree-remove-test-");
const { initRepoWithOrigin } = useOriginFixture();

async function setupUnmergedWorktree(home: string, branch: string) {
	const { root } = await initRepoWithOrigin(home);
	writeConfig({ command: "echo ready", root, tmp: home });
	await createWorktree({ root, branch, path: `${root}__${branch.replaceAll("/", "--")}` });
	const path = `${root}__${branch.replaceAll("/", "--")}`;
	await commitFile({ content: "work\n", message: "unmerged", path: "unmerged.txt", repo: path });
	return { path, root };
}

test("removes a worktree and branch #test-228", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });
	await createWorktree({ root, branch: "feature/remove", path: `${root}__feature--remove` });

	const result = await dispatch(
		"remove",
		["--cwd", root, "--branch", "feature/remove", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	const plan = JSON.parse(result.stdout ?? "{}");
	expect(await pathExists(`${root}__feature--remove`)).toBe(false);
	expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/remove")).toBe(false);
	expect(plan).toMatchObject({
		kind: "ready",
		removed: true,
		session: {
			name: "repo__feature--remove",
			path: `${root}__feature--remove`,
		},
		worktree_path: `${root}__feature--remove`,
	});
});

test("removes the worktree containing --cwd with boolean --self #test-230", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });
	await createWorktree({ root, branch: "feature/self", path: `${root}__feature--self` });
	const worktreePath = `${root}__feature--self`;
	const nested = join(worktreePath, "nested");
	await mkdir(nested, { recursive: true });

	const result = await dispatch("remove", ["--cwd", nested, "--self", "--json"], deps);

	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "ready",
		removed: true,
		worktree_path: worktreePath,
	});
	expect(await pathExists(worktreePath)).toBe(false);
});

test("non-json remove prints a one-line summary to stderr #test-229", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });
	await createWorktree({
		root,
		branch: "feature/human-remove",
		path: `${root}__feature--human-remove`,
	});

	const result = await dispatch(
		"remove",
		["--cwd", root, "--branch", "feature/human-remove"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(result.stdout).toBeUndefined();
	expect(result.stderr).toBe(`wktree: removed worktree at ${root}__feature--human-remove\n`);
});

test("unmerged branch fails without --force and succeeds with --force #test-232", async () => {
	const { path, root } = await setupUnmergedWorktree(tmp.dir, "feature/unmerged");

	const blocked = await dispatch(
		"remove",
		["--cwd", root, "--branch", "feature/unmerged", "--json"],
		deps,
	);
	expect(blocked.exitCode).toBe(EXIT_CODES.UNSAFE);
	expect(JSON.parse(blocked.stdout ?? "{}")).toMatchObject({
		branch: "feature/unmerged",
		kind: "blocked",
		reason: "unmerged_branch",
		worktree_path: path,
	});
	expect(await pathExists(path)).toBe(true);

	await dispatch(
		"remove",
		["--cwd", root, "--branch", "feature/unmerged", "--force", "--json"],
		deps,
	);
	expect(await pathExists(path)).toBe(false);
	expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/unmerged")).toBe(
		false,
	);
});

test("machine json remove reports blocked outcomes with unsafe exit codes #test-233", async () => {
	const { path, root } = await setupUnmergedWorktree(tmp.dir, "feature/unmerged-json");

	const result = await dispatch(
		"remove",
		["--cwd", root, "--branch", "feature/unmerged-json", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.UNSAFE);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		branch: "feature/unmerged-json",
		kind: "blocked",
		reason: "unmerged_branch",
		worktree_path: path,
	});
	expect(await pathExists(path)).toBe(true);
});

test("refuses canonical root and requires exactly one target selector #test-234", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });

	const canonicalRoot = await dispatch("remove", ["--cwd", root, "--self", "--json"], deps);
	expect(canonicalRoot.exitCode).toBe(EXIT_CODES.UNSAFE);
	expect(JSON.parse(canonicalRoot.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		reason: "canonical_root",
	});
	const { failure } = await dispatch("remove", ["--cwd", root, "--json"], deps);
	expect(failure).toBeInstanceOf(UsageError);
});
