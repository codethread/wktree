import { ConfigError, EXIT_CODES, HookError, PreRemoteCheckError, dispatch } from "../../src/index";
import { commitOnRemoteDefault, createRemoteBranch } from "./remote-history.ts";
import { deps, pathExists, run, testDeps, useOriginFixture, writeConfig } from "./support.ts";
import { expect, test } from "bun:test";
import { gitOut, gitSucceeds, useTmpHome } from "./lifecycle-helpers.ts";

const tmp = useTmpHome("wktree-add-rollback-test-");
const { initRepoWithOrigin } = useOriginFixture();

function assertBlockedPrecheck(result: Awaited<ReturnType<typeof dispatch>>) {
	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(result.stderr).toBeUndefined();
	expect(result.failure).toBeInstanceOf(PreRemoteCheckError);
	expect(result.failure).toMatchObject({ stderr: "precheck blocked" });
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		ok: false,
		reason: "pre_remote_check_failed",
	});
}

test("setup failure rolls back the new worktree and branch #test-238", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo failing >&2\nexit 7", root, tmp: tmp.dir });

	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/setup-fail", "--json"],
		testDeps(),
	);

	expect(result.failure).toBeInstanceOf(HookError);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		branch: "feature/setup-fail",
		kind: "error",
		ok: false,
		reason: "setup_failed",
		setup_exit_code: 7,
		setup_output: expect.arrayContaining([{ line: "failing", stream: "stderr" }]),
	});

	expect(await pathExists(`${root}__feature--setup-fail`)).toBe(false);
	expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/setup-fail")).toBe(
		false,
	);
});
test("setup failure restores an existing branch tip #test-240", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	await run(["git", "-C", root, "branch", "feature/setup-restore"]);
	const originalHead = await gitOut(root, "rev-parse", "refs/heads/feature/setup-restore");
	writeConfig({ command: "exit 7", root, tmp: tmp.dir });

	const { failure } = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/setup-restore", "--json"],
		testDeps(),
	);
	expect(failure).toBeInstanceOf(HookError);

	expect(await pathExists(`${root}__feature--setup-restore`)).toBe(false);
	expect(await gitOut(root, "rev-parse", "refs/heads/feature/setup-restore")).toBe(originalHead);
});
test("copy setup failure during add rolls back the new worktree and branch #test-239", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({
		command: "echo should-not-run",
		copyToml: 'copy = [".env.missing"]\n',
		root,
		tmp: tmp.dir,
	});

	const { failure } = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/copy-fail", "--json"],
		deps,
	);
	expect(failure).toBeInstanceOf(ConfigError);

	expect(await pathExists(`${root}__feature--copy-fail`)).toBe(false);
	expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/copy-fail")).toBe(
		false,
	);
});
test("copy setup failure during add restores an existing branch tip #test-237", async () => {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	await createRemoteBranch(remote, "feature/restore-tip");
	await run(["git", "-C", root, "fetch", "origin"]);
	await run(["git", "-C", root, "branch", "feature/restore-tip", "main"]);
	const originalHead = await gitOut(root, "rev-parse", "refs/heads/feature/restore-tip");
	writeConfig({
		command: "echo should-not-run",
		copyToml: 'copy = [".env.missing"]\n',
		root,
		tmp: tmp.dir,
	});

	const { failure } = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/restore-tip", "--json"],
		deps,
	);
	expect(failure).toBeInstanceOf(ConfigError);

	expect(await pathExists(`${root}__feature--restore-tip`)).toBe(false);
	expect(await gitOut(root, "rev-parse", "refs/heads/feature/restore-tip")).toBe(originalHead);
});
test("pre_remote_check blocks add before fetch and reports its stderr #test-241", async () => {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	await commitOnRemoteDefault({
		content: "remote\n",
		message: "remote before blocked add",
		path: "precheck-remote.txt",
		remote,
	});
	writeConfig({
		command: "echo ready",
		copyToml: "pre_remote_check = '''\necho precheck blocked >&2\nexit 7\n'''\n",
		root,
		tmp: tmp.dir,
	});

	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/precheck-blocked", "--json"],
		deps,
	);

	assertBlockedPrecheck(result);
	expect(await pathExists(`${root}__feature--precheck-blocked`)).toBe(false);
	expect(await gitSucceeds(root, "show", "origin/main:precheck-remote.txt")).toBe(false);
});
