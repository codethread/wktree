import { EXIT_CODES, dispatch } from "../../src/index";
import {
	commitFile,
	commitOnRemoteDefault,
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
import { writeFile } from "node:fs/promises";

const tmp = useTmpHome("wktree-remove-squash-test-");
const { initRepoWithOrigin } = useOriginFixture();

test("removes a clean squash-integrated branch after fetching its claimed target #test-164", async () => {
	const { remote, root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });
	await createWorktree({ branch: "feature/squash", path: `${root}__feature--squash`, root });
	await commitFile({
		content: "work\n",
		message: "feature work",
		path: "work.txt",
		repo: `${root}__feature--squash`,
	});
	await commitOnRemoteDefault({
		content: "work\n",
		message: "squash feature",
		path: "work.txt",
		remote,
	});
	await commitOnRemoteDefault({
		content: "later\n",
		message: "later work",
		path: "later.txt",
		remote,
	});

	const result = await dispatch(
		"remove",
		["--cwd", root, "--branch", "feature/squash", "--integrated-into", "origin/main", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(await pathExists(`${root}__feature--squash`)).toBe(false);
	expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/squash")).toBe(false);
});

test("refuses squash-aware removal when the target lacks source content #test-166", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });
	await createWorktree({
		branch: "feature/not-integrated",
		path: `${root}__feature--not-integrated`,
		root,
	});
	await commitFile({
		content: "work\n",
		message: "feature work",
		path: "work.txt",
		repo: `${root}__feature--not-integrated`,
	});

	const result = await dispatch(
		"remove",
		[
			"--cwd",
			root,
			"--branch",
			"feature/not-integrated",
			"--integrated-into",
			"origin/main",
			"--json",
		],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.UNSAFE);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		branch: "feature/not-integrated",
		kind: "blocked",
		reason: "unmerged_branch",
		worktree_path: `${root}__feature--not-integrated`,
	});
	expect(await pathExists(`${root}__feature--not-integrated`)).toBe(true);
});

test("refuses squash-aware removal of a dirty worktree #test-165", async () => {
	const { remote, root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });
	await createWorktree({
		branch: "feature/dirty-squash",
		path: `${root}__feature--dirty-squash`,
		root,
	});
	await commitFile({
		content: "work\n",
		message: "feature work",
		path: "work.txt",
		repo: `${root}__feature--dirty-squash`,
	});
	await commitOnRemoteDefault({
		content: "work\n",
		message: "squash feature",
		path: "work.txt",
		remote,
	});
	await writeFile(join(`${root}__feature--dirty-squash`, "uncommitted.txt"), "keep\n");

	const result = await dispatch(
		"remove",
		[
			"--cwd",
			root,
			"--branch",
			"feature/dirty-squash",
			"--integrated-into",
			"origin/main",
			"--json",
		],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		branch: "feature/dirty-squash",
		kind: "blocked",
		reason: "dirty_worktree",
	});
	expect(await pathExists(join(`${root}__feature--dirty-squash`, "uncommitted.txt"))).toBe(true);
});

test("keep-branch removes a clean unmerged worktree and preserves its branch #test-167", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });
	await createWorktree({
		branch: "feature/squash-merged",
		path: `${root}__feature--squash-merged`,
		root,
	});
	await commitFile({
		content: "work\n",
		message: "work",
		path: "work.txt",
		repo: `${root}__feature--squash-merged`,
	});

	const result = await dispatch(
		"remove",
		["--cwd", root, "--branch", "feature/squash-merged", "--keep-branch", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(await pathExists(`${root}__feature--squash-merged`)).toBe(false);
	expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/squash-merged")).toBe(
		true,
	);
});
