import { EXIT_CODES, dispatch } from "../../src/index";
import {
	commitFile,
	createWorktree,
	deps,
	pathExists,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
import { expect, test } from "bun:test";
import { gitOut, gitSucceeds, gitText, useTmpHome } from "./lifecycle-helpers.ts";

const tmp = useTmpHome("wktree-finish-cleanup-test-");
const { initRepoWithOrigin } = useOriginFixture();

async function prepareFinish(branch: string, policy = "") {
	const { remote, root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", copyToml: policy, root, tmp: tmp.dir });
	const worktreePath = `${root}__${branch.replaceAll("/", "--")}`;
	await createWorktree({ branch, path: worktreePath, root });
	return { remote, root, worktreePath };
}

test("removes a non-pooled source worktree after finish when cleanup is enabled #test-225", async () => {
	const { root, worktreePath } = await prepareFinish(
		"feature/remove-after-finish",
		"[project.finish]\nremove_worktree = true\n",
	);
	await commitFile({
		content: "remove\n",
		message: "remove work",
		path: "remove.txt",
		repo: worktreePath,
	});

	const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		cleanup_actions: ["remove_worktree"],
	});
	expect(await pathExists(worktreePath)).toBe(false);
	expect(
		await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/remove-after-finish"),
	).toBe(true);
});

test("deletes source branch after squash finish when configured #test-226", async () => {
	const { root, worktreePath } = await prepareFinish(
		"feature/delete-after-squash",
		'[project.finish]\nstrategy = "squash"\nremove_worktree = true\ndelete_branch = true\n',
	);
	await commitFile({
		content: "delete\n",
		message: "delete work",
		path: "squash-delete.txt",
		repo: worktreePath,
	});

	const result = await dispatch(
		"finish",
		["--cwd", worktreePath, "--title", "chore: squash delete work", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		cleanup_actions: ["remove_worktree", "delete_branch"],
	});
	expect(
		await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/delete-after-squash"),
	).toBe(false);
});
test("configured finish cleanup enables push, removal, and branch deletion #test-224", async () => {
	const { remote, root, worktreePath } = await prepareFinish(
		"feature/policy-cleanup",
		"[project.finish]\npush = true\nremove_worktree = true\ndelete_branch = true\n",
	);
	await commitFile({
		content: "policy\n",
		message: "policy cleanup",
		path: "policy-cleanup.txt",
		repo: worktreePath,
	});

	const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		cleanup_actions: ["push", "remove_worktree", "delete_branch"],
	});
	expect(await gitText(remote, "show", "main:policy-cleanup.txt")).toBe("policy\n");
	expect(await pathExists(worktreePath)).toBe(false);
	expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/policy-cleanup")).toBe(
		false,
	);
});
test("cleanup refusal returns structured payload without integration or force deletion #test-227", async () => {
	const { root, worktreePath } = await prepareFinish(
		"feature/delete-without-remove",
		"[project.finish]\ndelete_branch = true\n",
	);
	await commitFile({
		content: "cleanup\n",
		message: "cleanup work",
		path: "cleanup-refusal.txt",
		repo: worktreePath,
	});
	const originalHead = await gitOut(root, "rev-parse", "HEAD");

	const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

	expect(result.exitCode).toBe(EXIT_CODES.UNSAFE);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({ kind: "blocked", reason: "unsafe" });
	expect(await gitOut(root, "rev-parse", "HEAD")).toBe(originalHead);
	expect(await gitSucceeds(root, "show", "HEAD:cleanup-refusal.txt")).toBe(false);
	expect(await pathExists(worktreePath)).toBe(true);
	expect(
		await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/delete-without-remove"),
	).toBe(true);
});
