import { EXIT_CODES, dispatch } from "../../src/index";
import { commitFile, deps, pathExists, run, useOriginFixture, writeConfig } from "./support.ts";
import { commitOnRemoteDefault, createRemoteBranch } from "./remote-history.ts";
import { expect, test } from "bun:test";
import { gitOut, gitText, useTmpHome } from "./lifecycle-helpers.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { join } from "node:path";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { writeFile } from "node:fs/promises";

const tmp = useTmpHome("wktree-add-policy-test-");
const { initRepoWithOrigin } = useOriginFixture();

test("fresh_canonical preserves existing branch add behavior after policy fetch #test-153", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	await run(["git", "-C", root, "branch", "feature/existing-fresh"]);
	writeConfig({
		command: "echo ready",
		copyToml: '[project.add]\npolicy = "fresh_canonical"\n',
		root,
		tmp: tmp.dir,
	});
	await writeFile(join(root, "dirty-canonical.txt"), "dirty\n");

	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/existing-fresh", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		created_new_branch: false,
		kind: "ready",
		worktree_path: `${root}__feature--existing-fresh`,
	});
});
test("warns but succeeds when local branch has diverged from remote #test-149", async () => {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	await createRemoteBranch(remote, "feature/diverged");
	await run(["git", "-C", root, "fetch", "origin"]);
	await run(["git", "-C", root, "checkout", "-b", "feature/diverged", "main"]);
	await commitFile({ content: "local\n", message: "local", path: "local.txt", repo: root });
	await run(["git", "-C", root, "checkout", "main"]);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });

	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/diverged", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(JSON.parse(result.stdout ?? "{}").diagnostics).toMatchInlineSnapshot(`
	  [
	    "warning: couldn't fast-forward from origin/feature/diverged; preserving local work",
	  ]
	`);
});
test("defaults new branches to origin default branch instead of current HEAD #test-155", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });
	await run(["git", "-C", root, "checkout", "-b", "local/current"]);
	await commitFile({
		content: "current\n",
		message: "current only",
		path: "current-only.txt",
		repo: root,
	});

	await dispatch("add", ["--cwd", root, "--branch", "feature/default-base", "--json"], deps);

	const missing = await Bun.spawn(
		["git", "-C", `${root}__feature--default-base`, "show", "HEAD:current-only.txt"],
		{ stderr: "pipe", stdout: "pipe" },
	).exited;
	expect(missing).not.toBe(EXIT_CODES.SUCCESS);
});
test(
	"origin_default creates new branches from fetched origin default without mutating " +
		"canonical root #test-152",
	async () => {
		const { root, remote } = await initRepoWithOrigin(tmp.dir);
		writeConfig({ command: "echo ready", root, tmp: tmp.dir });
		await commitOnRemoteDefault({
			content: "remote default\n",
			message: "remote default update",
			path: "remote-only.txt",
			remote,
		});
		const originalHead = await gitOut(root, "rev-parse", "HEAD");

		await dispatch("add", ["--cwd", root, "--branch", "feature/origin-default", "--json"], deps);

		expect(await gitOut(root, "rev-parse", "HEAD")).toBe(originalHead);
		expect(await gitText(`${root}__feature--origin-default`, "show", "HEAD:remote-only.txt")).toBe(
			"remote default\n",
		);
	},
);
test("fresh_canonical fast-forwards clean canonical default before creating a branch #test-150", async () => {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	writeConfig({
		command: "echo ready",
		copyToml: '[project.add]\npolicy = "fresh_canonical"\n',
		root,
		tmp: tmp.dir,
	});
	await commitOnRemoteDefault({
		content: "fresh\n",
		message: "fresh default update",
		path: "fresh.txt",
		remote,
	});

	await dispatch("add", ["--cwd", root, "--branch", "feature/fresh", "--json"], deps);

	expect(await gitText(root, "show", "HEAD:fresh.txt")).toBe("fresh\n");
	expect(await gitText(`${root}__feature--fresh`, "show", "HEAD:fresh.txt")).toBe("fresh\n");
});
test("fresh_canonical blocks dirty canonical root with JSON reason #test-156", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({
		command: "echo ready",
		copyToml: '[project.add]\npolicy = "fresh_canonical"\n',
		root,
		tmp: tmp.dir,
	});
	await writeFile(join(root, "dirty.txt"), "dirty\n");

	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/dirty-block", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		reason: "dirty_canonical",
	});
	expect(await pathExists(`${root}__feature--dirty-block`)).toBe(false);
});
test("fresh_canonical blocks wrong canonical branch with JSON reason #test-154", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({
		command: "echo ready",
		copyToml: '[project.add]\npolicy = "fresh_canonical"\n',
		root,
		tmp: tmp.dir,
	});
	await run(["git", "-C", root, "checkout", "-b", "other"]);

	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/wrong-branch", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		reason: "wrong_canonical_branch",
	});
	expect(await pathExists(`${root}__feature--wrong-branch`)).toBe(false);
});
test("fresh_canonical blocks non-fast-forward canonical update with JSON reason #test-151", async () => {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	writeConfig({
		command: "echo ready",
		copyToml: '[project.add]\npolicy = "fresh_canonical"\n',
		root,
		tmp: tmp.dir,
	});
	await commitOnRemoteDefault({
		content: "remote\n",
		message: "non ff remote update",
		path: "non-ff-remote.txt",
		remote,
	});
	await commitFile({
		content: "local\n",
		message: "local main update",
		path: "local-main.txt",
		repo: root,
	});

	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/non-ff", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		reason: "non_ff_canonical",
	});
	expect(await pathExists(`${root}__feature--non-ff`)).toBe(false);
});
test("fresh_canonical explicit base bypasses canonical update requirement #test-148", async () => {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	await createRemoteBranch(remote, "base/stacked");
	writeConfig({
		command: "echo ready",
		copyToml: '[project.add]\npolicy = "fresh_canonical"\n',
		root,
		tmp: tmp.dir,
	});
	await writeFile(join(root, "dirty-canonical.txt"), "dirty\n");

	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/from-explicit-base", "--base", "base/stacked", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(await gitText(`${root}__feature--from-explicit-base`, "show", "HEAD:remote.txt")).toBe(
		"base/stacked\n",
	);
});
