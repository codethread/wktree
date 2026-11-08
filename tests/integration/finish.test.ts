import { EXIT_CODES, dispatch } from "../../src/index";
import {
	commitFile,
	commitOnRemoteDefault,
	createWorktree,
	deps,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
import { expect, test } from "bun:test";
import { gitOut, useTmpHome } from "./lifecycle-helpers.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { readFile, writeFile } from "node:fs/promises";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { join } from "node:path";

const tmp = useTmpHome("wktree-finish-test-");
const { initRepoWithOrigin } = useOriginFixture();

async function prepareFinish(branch: string, policy = "") {
	const { remote, root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", copyToml: policy, root, tmp: tmp.dir });
	await createWorktree({ root, branch, path: `${root}__${branch.replaceAll("/", "--")}` });
	return { remote, root, worktreePath: `${root}__${branch.replaceAll("/", "--")}` };
}

test("finish disabled blocks before integration with JSON payload #test-193", async () => {
	const { root, worktreePath } = await prepareFinish(
		"feature/disabled-finish",
		"[project.finish]\nenabled = false\n",
	);
	await commitFile({
		content: "disabled\n",
		message: "disabled work",
		path: "disabled.txt",
		repo: worktreePath,
	});
	const originalHead = await gitOut(root, "rev-parse", "HEAD");

	const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		message: expect.stringContaining("finish is disabled"),
		reason: "blocked",
	});
	expect(await gitOut(root, "rev-parse", "HEAD")).toBe(originalHead);
});
test("refuses finish from canonical root #test-198", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });

	const result = await dispatch("finish", ["--cwd", root, "--json"], deps);

	expect(result.exitCode).toBe(EXIT_CODES.UNSAFE);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		reason: "canonical_root",
	});
});
test("refuses dirty source worktree #test-197", async () => {
	const { worktreePath } = await prepareFinish("feature/dirty-finish");
	await writeFile(join(worktreePath, "dirty.txt"), "dirty\n");

	const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		reason: "dirty_worktree",
	});
});
test("enforces target freshness before integration #test-195", async () => {
	const { remote, root, worktreePath } = await prepareFinish("feature/stale-target");
	await commitFile({
		content: "source\n",
		message: "source work",
		path: "source.txt",
		repo: worktreePath,
	});
	await commitOnRemoteDefault({
		content: "fresh\n",
		message: "fresh remote",
		path: "remote-fresh.txt",
		remote,
	});
	const originalHead = await gitOut(root, "rev-parse", "HEAD");

	const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		reason: "target_not_fresh",
	});
	expect(await gitOut(root, "rev-parse", "HEAD")).toBe(originalHead);
});
test("ff_only moves the canonical default branch to the source branch #test-194", async () => {
	const { root, worktreePath } = await prepareFinish("feature/finish");
	await commitFile({
		content: "finished\n",
		message: "finished work",
		path: "finished.txt",
		repo: worktreePath,
	});
	const sourceHead = await gitOut(worktreePath, "rev-parse", "HEAD");

	const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "ready",
		root,
		source_branch: "feature/finish",
		strategy: "ff_only",
		target_branch: "main",
		worktree_path: worktreePath,
	});
	expect(await gitOut(root, "rev-parse", "HEAD")).toBe(sourceHead);
	expect(await readFile(join(root, "finished.txt"), "utf8")).toBe("finished\n");
});
test("non-json finish prints a one-line summary to stderr #test-196", async () => {
	const { worktreePath } = await prepareFinish("feature/human-finish");
	await commitFile({
		content: "human\n",
		message: "human work",
		path: "human.txt",
		repo: worktreePath,
	});

	const result = await dispatch("finish", ["--cwd", worktreePath], deps);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(result.stdout).toBeUndefined();
	expect(result.stderr).toBe("wktree: finished feature/human-finish into main\n");
});
