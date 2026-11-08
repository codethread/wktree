import {
	DirtyCanonicalError,
	EXIT_CODES,
	GitError,
	NonFastForwardCanonicalError,
	UsageError,
	dispatch,
} from "../../src/index";
import { commitFile, pathExists, run, testDeps, useOriginFixture, writeConfig } from "./support.ts";
import { commitOnRemoteDefault, createRemoteBranch } from "./remote-history.ts";
import { expect, test } from "bun:test";
import { gitOut, gitSucceeds, runCli, useTmpHome } from "./lifecycle-helpers.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Real Git fixtures exercise filesystem boundaries.
import { rm, writeFile } from "node:fs/promises";
// oxlint-disable-next-line import/no-nodejs-modules -- Real Git fixtures exercise filesystem boundaries.
import { join } from "node:path";

const tmp = useTmpHome("wktree-add-offline-");
const OBJECT_DIRECTORY_LENGTH = 2;
const OBJECT_DIRECTORY_START = 0;
const EXISTING_REF = {
	local: "HEAD",
	"local-remote": "origin/feature/offline",
	remote: "origin/feature/offline",
};
const { initRepoWithOrigin } = useOriginFixture();

async function offlineFixture(policy = "origin_default") {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	writeConfig({
		command: "echo bootstrap-ran",
		copyToml: `pre_remote_check = "exit 9"\n[project.add]\npolicy = "${policy}"\n`,
		root,
		tmp: tmp.dir,
	});
	await run(["git", "-C", root, "remote", "set-url", "origin", join(tmp.dir, "absent.git")]);
	return { root, remote };
}

async function offlineAdd(root: string, extra: string[] = [], launcher = false) {
	const args = ["--cwd", root, "--branch", "feature/offline", "--no-network", "--json", ...extra];
	if (launcher) {
		return runCli(["add", ...args]);
	}
	const result = await dispatch("add", args, testDeps());
	return { ...result, stdout: result.stdout ?? "" };
}

async function aheadDevelop(policy: string) {
	const { root, remote } = await offlineFixture(policy);
	const localTip = await gitOut(root, "rev-parse", "HEAD");
	await commitOnRemoteDefault({
		content: "remote\n",
		message: "ahead",
		path: "ahead.txt",
		remote,
	});
	await run(["git", "-C", root, "fetch", remote, "main:refs/remotes/origin/develop"]);
	await run(["git", "-C", root, "branch", "-m", "main", "develop"]);
	await run([
		"git",
		"-C",
		root,
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
		"refs/remotes/origin/develop",
	]);
	const cachedTip = await gitOut(root, "rev-parse", "origin/develop");
	return { root, localTip, cachedTip };
}

async function missingDefault() {
	const { root } = await offlineFixture();
	const tip = await gitOut(root, "rev-parse", "HEAD");
	await run(["git", "-C", root, "checkout", "-b", "other"]);
	await run(["git", "-C", root, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
	return { root, tip };
}

async function existingBranch(state: keyof typeof EXISTING_REF) {
	const { root, remote } = await offlineFixture();
	if (state !== "remote") {
		await run(["git", "-C", root, "branch", "feature/offline"]);
	}
	if (state !== "local") {
		await createRemoteBranch(remote, "feature/offline");
		await run([
			"git",
			"-C",
			root,
			"fetch",
			remote,
			"feature/offline:refs/remotes/origin/feature/offline",
		]);
	}
	const expected = await gitOut(root, "rev-parse", EXISTING_REF[state]);
	return { root, expected };
}

async function copyFixture() {
	const { root } = await initRepoWithOrigin(tmp.dir);
	await writeFile(join(root, ".env"), "copied\n");
	writeConfig({
		command: "exit 7",
		copyToml: 'copy = [".env", { from = ".env", to = "linked.env", mode = "symlink" }]\n',
		root,
		tmp: tmp.dir,
	});
	return root;
}

async function stackedFixture() {
	const { root } = await offlineFixture("fresh_canonical");
	await run(["git", "-C", root, "checkout", "-b", "stack"]);
	await commitFile({ content: "stack\n", message: "stack", path: "stack.txt", repo: root });
	const tip = await gitOut(root, "rev-parse", "HEAD");
	return { root, tip };
}

async function nestedCopyFixture() {
	const root = await copyFixture();
	writeConfig({
		command: "exit 7",
		copyToml: 'copy = [".env"]\nworktree_location = "nested"\n',
		root,
		tmp: tmp.dir,
	});
	return root;
}

test.each(["local", "remote"] as const)(
	"offline existing %s branch uses local state according to cached branch state #test-175",
	async (state) => {
		const { root, expected } = await existingBranch(state);
		// One CLI case checks --no-network forwarding; other branch states use dispatch.
		const result = await offlineAdd(root, [], state === "local");
		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(await gitOut(root, "rev-parse", "feature/offline")).toBe(expected);
	},
);

test("offline base-current uses cwd's branch and missing explicit refs fail before creation #test-180", async () => {
	const { root, tip } = await stackedFixture();
	const missing = await offlineAdd(root, ["--base", "absent"]);
	expect(missing.exitCode).toBe(EXIT_CODES.USAGE);
	expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/offline")).toBe(false);
	const result = await offlineAdd(root, ["--base-current"]);
	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(await gitOut(root, "rev-parse", "feature/offline")).toBe(tip);
});

test.each([{ flags: ["--skip-command"] }, { flags: ["--skip-command", "--no-network"] }])(
	"skip-command retains regular copy/symlink setup (flags=$flags) #test-182",
	async ({ flags }) => {
		const root = await copyFixture();
		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/skip", "--json", ...flags],
			testDeps(),
		);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(payload).toMatchObject({ kind: "ready", setup_output: [] });
		expect(payload.diagnostics.join("\n")).toContain("--skip-command");
		expect(await Bun.file(`${root}__feature--skip/.env`).text()).toBe("copied\n");
		expect(await Bun.file(`${root}__feature--skip/linked.env`).text()).toBe("copied\n");
	},
);

test("offline scopes every injected Git call against implicit object fetching #test-185", async () => {
	const root = await nestedCopyFixture();
	const live = testDeps();
	const calls: string[][] = [];
	const record = (args: string[]) => {
		calls.push(args);
		return live.git.runRaw(args);
	};
	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/offline", "--no-network", "--skip-command", "--json"],
		testDeps({ git: { run: record, runRaw: record } }),
	);
	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(calls).not.toEqual([]);
	expect(calls.every((args) => args.includes("--no-lazy-fetch"))).toBe(true);
	expect(calls.some((args) => args.includes("fetch") || args.includes("remote"))).toBe(false);
});

test.each(["tag", "commit", "full-ref"])(
	"offline explicit local %s base works without default metadata #test-183",
	async (kind) => {
		const { root, tip } = await missingDefault();
		await run(["git", "-C", root, "tag", "start", tip]);
		const refs = { tag: "start", commit: tip, "full-ref": "refs/remotes/origin/main" };
		const result = await offlineAdd(root, ["--base", refs[kind as keyof typeof refs]]);
		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(await gitOut(root, "rev-parse", "feature/offline")).toBe(tip);
	},
);

async function missingObjectFixture() {
	const { root } = await offlineFixture();
	await commitFile({
		content: "missing blob\n",
		message: "promised object",
		path: "promised.txt",
		repo: root,
	});
	await run(["git", "-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
	const blob = await gitOut(root, "rev-parse", "HEAD:promised.txt");
	await run(["git", "-C", root, "config", "remote.origin.promisor", "true"]);
	await rm(
		join(
			root,
			".git",
			"objects",
			blob.slice(OBJECT_DIRECTORY_START, OBJECT_DIRECTORY_LENGTH),
			blob.slice(OBJECT_DIRECTORY_LENGTH),
		),
	);
	return root;
}

test("offline missing promised checkout object fails loudly without implicit fetch #test-184", async () => {
	const root = await missingObjectFixture();
	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/missing", "--no-network", "--skip-command", "--json"],
		testDeps(),
	);
	expect(result.failure).toBeInstanceOf(GitError);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({ kind: "error", reason: "git_failed" });
	expect(JSON.parse(result.stdout ?? "{}").message).not.toContain("absent.git");
});

async function unsafeCanonical(state: string) {
	const { root } = await aheadDevelop("fresh_canonical");
	if (state === "uncached-dirty") {
		await run(["git", "-C", root, "update-ref", "-d", "refs/remotes/origin/develop"]);
		await writeFile(join(root, "dirty.txt"), "dirty\n");
	} else {
		await commitFile({ content: "local\n", message: "local", path: "local.txt", repo: root });
	}
	return root;
}

// Refusal ordering is covered in ../unit/canonical-default.test.ts; these cases check lifecycle effects.
test.each([
	{ state: "diverged", failure: NonFastForwardCanonicalError },
	{ state: "uncached-dirty", failure: DirtyCanonicalError },
])(
	"offline fresh_canonical refuses $state without changing local work #test-179",
	async ({ state, failure }) => {
		const root = await unsafeCanonical(state);
		const tip = await gitOut(root, "rev-parse", "HEAD");
		const status = await gitOut(root, "status", "--porcelain=v1");
		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/offline", "--no-network", "--json"],
			testDeps(),
		);
		expect(result.failure).toBeInstanceOf(failure);
		expect(await gitOut(root, "rev-parse", "HEAD")).toBe(tip);
		expect(await gitOut(root, "status", "--porcelain=v1")).toBe(status);
		expect(await pathExists(`${root}__feature--offline`)).toBe(false);
		expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/offline")).toBe(
			false,
		);
	},
);

test(
	"offline origin_default uses cached default with absent local default and dirty " +
		"other checkout #test-177",
	async () => {
		const { root, cachedTip } = await aheadDevelop("origin_default");
		await run(["git", "-C", root, "checkout", "-b", "other"]);
		await run(["git", "-C", root, "branch", "-D", "develop"]);
		await writeFile(join(root, "dirty.txt"), "dirty\n");
		const current = await gitOut(root, "rev-parse", "HEAD");
		const result = await offlineAdd(root);
		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(await gitOut(root, "rev-parse", "feature/offline")).toBe(cachedTip);
		expect(await gitOut(root, "rev-parse", "HEAD")).toBe(current);
		expect(await Bun.file(join(root, "dirty.txt")).text()).toBe("dirty\n");
	},
);

test("offline existing diverged branch warns and preserves its local commit #test-178", async () => {
	const { root } = await existingBranch("local-remote");
	await run(["git", "-C", root, "checkout", "feature/offline"]);
	await commitFile({ content: "local\n", message: "local", path: "local.txt", repo: root });
	const tip = await gitOut(root, "rev-parse", "HEAD");
	await run(["git", "-C", root, "checkout", "main"]);
	const result = await offlineAdd(root);
	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(JSON.parse(result.stdout).diagnostics.join("\n")).toContain("preserving local work");
	expect(await gitOut(root, "rev-parse", "feature/offline")).toBe(tip);
});

test(
	"offline present cached ref with missing commit fails instead of falling back to " +
		"local default #test-186",
	async () => {
		const { root } = await offlineFixture();
		const refPath = join(root, ".git", "refs", "remotes", "origin", "main");
		await writeFile(refPath, "1111111111111111111111111111111111111111\n");
		await run(["git", "-C", root, "config", "remote.origin.promisor", "true"]);
		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/offline", "--no-network", "--skip-command", "--json"],
			testDeps(),
		);
		expect(result.failure).toBeInstanceOf(UsageError);
		expect(JSON.parse(result.stdout ?? "{}").message).not.toContain("absent.git");
		expect(await pathExists(`${root}__feature--offline`)).toBe(false);
	},
);
