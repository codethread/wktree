import { EXIT_CODES, PreRemoteCheckError, dispatch } from "../../src/index";
import {
	commitFile,
	createPoolSlot,
	pathExists,
	run,
	testDeps,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
import { commitOnRemoteDefault, createRemoteBranch } from "./remote-history.ts";
import { expect, test } from "bun:test";
import { gitOut, gitSucceeds, gitText, useTmpHome } from "./lifecycle-helpers.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { join } from "node:path";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { writeFile } from "node:fs/promises";

const SINGLE_SLOT = 1;
const TWO_SLOTS = 2;

const tmp = useTmpHome("wktree-pool-add-policy-test-");
const { initRepoWithOrigin } = useOriginFixture();

async function prepareDivergedPool() {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	await createRemoteBranch(remote, "feature/diverged-pool");
	await run(["git", "-C", root, "fetch", "origin"]);
	await run(["git", "-C", root, "checkout", "-b", "feature/diverged-pool", "main"]);
	await commitFile({ content: "local\n", message: "local", path: "local.txt", repo: root });
	await run(["git", "-C", root, "checkout", "main"]);
	writeConfig({ command: "echo ready", poolSize: TWO_SLOTS, root, tmp: tmp.dir });
	return root;
}

test("pre_remote_check blocks pooled status before remote trunk detection #test-131", async () => {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	await commitOnRemoteDefault({
		content: "remote\n",
		message: "remote before blocked status",
		path: "pooled-status-remote.txt",
		remote,
	});
	writeConfig({
		command: "echo ready",
		copyToml: 'pre_remote_check = "echo pooled blocked >&2; exit 7"\n',
		poolSize: SINGLE_SLOT,
		root,
		tmp: tmp.dir,
	});

	const result = await dispatch("status", ["--cwd", root, "--json"], testDeps());

	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(result.stderr).toBeUndefined();
	expect(result.failure).toBeInstanceOf(PreRemoteCheckError);
	expect(result.failure).toMatchObject({ stderr: "pooled blocked" });
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		ok: false,
		reason: "pre_remote_check_failed",
	});
	expect(await gitSucceeds(root, "show", "origin/main:pooled-status-remote.txt")).toBe(false);
});
test("fresh_canonical blocks dirty canonical root before pooled slot allocation #test-129", async () => {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	writeConfig({
		command: "echo ready",
		copyToml: '[project.add]\npolicy = "fresh_canonical"\n',
		poolSize: SINGLE_SLOT,
		root,
		tmp: tmp.dir,
	});
	await commitOnRemoteDefault({
		content: "remote\n",
		message: "pooled dirty block update",
		path: "pooled-dirty-block.txt",
		remote,
	});
	await writeFile(join(root, "dirty.txt"), "dirty\n");

	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/pooled-dirty-block", "--json"],
		testDeps(),
	);

	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		reason: "dirty_canonical",
	});
	expect(await pathExists(`${root}__feat1`)).toBe(false);
	expect(
		await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/pooled-dirty-block"),
	).toBe(false);
});
test("fresh_canonical fast-forwards canonical root before pooled branch checkout #test-125", async () => {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	writeConfig({
		command: "echo ready",
		copyToml: '[project.add]\npolicy = "fresh_canonical"\n',
		poolSize: SINGLE_SLOT,
		root,
		tmp: tmp.dir,
	});
	await createPoolSlot({ branch: "wk-pool/feat1", index: SINGLE_SLOT, initialized: true, root });
	await commitOnRemoteDefault({
		content: "fresh pooled\n",
		message: "pooled fresh update",
		path: "pooled-fresh.txt",
		remote,
	});

	await dispatch("add", ["--cwd", root, "--branch", "feature/pooled-fresh", "--json"], testDeps());

	expect(await gitText(root, "show", "HEAD:pooled-fresh.txt")).toBe("fresh pooled\n");
	expect(await gitText(`${root}__feat1`, "show", "HEAD:pooled-fresh.txt")).toBe("fresh pooled\n");
	expect(await gitOut(`${root}__feat1`, "branch", "--show-current")).toBe("feature/pooled-fresh");
});
test("origin_default pooled add uses fetched origin default without mutating canonical root #test-126", async () => {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", poolSize: SINGLE_SLOT, root, tmp: tmp.dir });
	await createPoolSlot({ branch: "wk-pool/feat1", index: SINGLE_SLOT, initialized: true, root });
	await commitOnRemoteDefault({
		content: "origin default\n",
		message: "pooled origin default update",
		path: "pooled-origin-default.txt",
		remote,
	});
	const originalHead = await gitOut(root, "rev-parse", "HEAD");

	await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/pooled-origin-default", "--json"],
		testDeps(),
	);

	expect(await gitOut(root, "rev-parse", "HEAD")).toBe(originalHead);
	expect(await gitText(`${root}__feat1`, "show", "HEAD:pooled-origin-default.txt")).toBe(
		"origin default\n",
	);
});
test("fresh_canonical pooled explicit base bypasses canonical update requirement #test-128", async () => {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	await createRemoteBranch(remote, "base/policy-check");
	writeConfig({
		command: "echo ready",
		copyToml: '[project.add]\npolicy = "fresh_canonical"\n',
		poolSize: SINGLE_SLOT,
		root,
		tmp: tmp.dir,
	});
	await createPoolSlot({ branch: "wk-pool/feat1", index: SINGLE_SLOT, initialized: true, root });
	await writeFile(join(root, "dirty.txt"), "dirty\n");

	const result = await dispatch(
		"add",
		[
			"--cwd",
			root,
			"--branch",
			"feature/pooled-from-base",
			"--base",
			"base/policy-check",
			"--json",
		],
		testDeps(),
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		branch: "feature/pooled-from-base",
		kind: "ready",
		worktree_path: `${root}__feat1`,
	});
	expect(await gitText(`${root}__feat1`, "show", "HEAD:remote.txt")).toBe("base/policy-check\n");
});
test("fresh_canonical policy failure does not recycle an occupied pooled slot #test-130", async () => {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	writeConfig({
		command: "echo ready",
		copyToml: '[project.add]\npolicy = "fresh_canonical"\n',
		poolSize: SINGLE_SLOT,
		root,
		tmp: tmp.dir,
	});
	await createPoolSlot({ branch: "feature/occupied", index: SINGLE_SLOT, initialized: true, root });
	await commitOnRemoteDefault({
		content: "remote\n",
		message: "pooled recycle block update",
		path: "pooled-recycle-block.txt",
		remote,
	});
	await writeFile(join(root, "dirty.txt"), "dirty\n");

	const result = await dispatch(
		"add",
		[
			"--cwd",
			root,
			"--branch",
			"feature/blocked-recycle",
			"--json",
			"--slot",
			`${root}__feat1`,
			"--force",
		],
		testDeps(),
	);

	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		reason: "dirty_canonical",
	});
	expect(await gitOut(`${root}__feat1`, "branch", "--show-current")).toBe("feature/occupied");
	expect(
		await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/blocked-recycle"),
	).toBe(false);
});
test("warns for diverged branches and rejects duplicates without side effects #test-127", async () => {
	const root = await prepareDivergedPool();
	const warnDeps = testDeps();

	const diverged = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/diverged-pool", "--json"],
		warnDeps,
	);
	expect(JSON.parse(diverged.stdout ?? "{}").diagnostics).toMatchInlineSnapshot(`
	  [
	    "[wk-pool] initializing feat1…",
	    "warning: couldn't fast-forward from origin/feature/diverged-pool; preserving local work",
	  ]
	`);

	const duplicate = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/diverged-pool", "--json"],
		testDeps(),
	);
	expect(JSON.parse(duplicate.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		message: expect.stringContaining(`${root}__feat1`),
		reason: "duplicate_branch",
	});
	expect(await pathExists(`${root}__feat2`)).toBe(false);
});
