import { EXIT_CODES, dispatch } from "../../src/index";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { chmod, readFile, writeFile } from "node:fs/promises";
import {
	commitFile,
	commitOnRemoteDefault,
	createWorktree,
	deps,
	pathExists,
	testDeps,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
import { expect, test } from "bun:test";
import { finishArgs, finishPolicy, readCheckoutState, readFinishState } from "./finish-helpers.ts";
import { gitOut, gitSucceeds, useTmpHome } from "./lifecycle-helpers.ts";
import { GitError } from "../../src/git/error.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { join } from "node:path";

const COMMIT_AND_PARENT = 2;
const EXECUTABLE_MODE = 0o755;

const tmp = useTmpHome("wktree-finish-strategies-test-");
const { initRepoWithOrigin } = useOriginFixture();

async function prepareFinish(branch: string, policy = "") {
	const { remote, root } = await initRepoWithOrigin(tmp.dir);
	const worktreePath = `${root}__${branch.replaceAll("/", "--")}`;
	writeConfig({ command: "echo ready", copyToml: policy, root, tmp: tmp.dir });
	await createWorktree({ root, branch, path: worktreePath, startPoint: "origin/main" });
	return { branch, remote, root, worktreePath };
}

async function assertRebasedHistory(root: string, targetHead: string) {
	expect(await gitOut(root, "rev-parse", "HEAD")).toBe(
		await gitOut(root, "rev-parse", "refs/heads/feature/rebase-finish"),
	);
	const parents = await gitOut(root, "rev-list", "--parents", "-n", "1", "HEAD");
	expect(parents.split(" ")).toHaveLength(COMMIT_AND_PARENT);
	expect(await gitOut(root, "rev-parse", "HEAD~1")).toBe(targetHead);
	expect(await readFile(join(root, "source-rebased.txt"), "utf8")).toBe("source\n");
}

async function assertConflictPreserved({
	result,
	root,
	sourceHead,
	targetHead,
	worktreePath,
}: {
	result: Awaited<ReturnType<typeof dispatch>>;
	root: string;
	sourceHead: string;
	targetHead: string;
	worktreePath: string;
}) {
	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		cleanup_actions: [],
		integrated: false,
		kind: "blocked",
		reason: "conflict",
	});
	expect(await gitOut(root, "rev-parse", "HEAD")).toBe(targetHead);
	expect(await gitOut(root, "status", "--porcelain=v1")).toBe("");
	expect(await gitOut(root, "write-tree")).toBe(await gitOut(root, "rev-parse", "HEAD^{tree}"));
	expect(await gitOut(root, "ls-files", "--unmerged")).toBe("");
	expect(await gitOut(root, "rev-parse", "refs/heads/feature/squash-conflict")).toBe(sourceHead);
	expect(await pathExists(worktreePath)).toBe(true);
	expect(await gitSucceeds(root, "rev-parse", "--verify", "MERGE_HEAD")).toBe(false);
}

test.each([{ fresh: false }, { fresh: true }])(
	"rebase_ff rebases source before advancing target (fresh=$fresh) #test-86",
	async ({ fresh }) => {
		const fixture = await prepareFinish("feature/rebase-finish", finishPolicy("rebase_ff", fresh));
		await commitFile({
			content: "source\n",
			message: "source work",
			path: "source-rebased.txt",
			repo: fixture.worktreePath,
		});
		const targetHead = await commitTargetChange(fixture, fresh, "target-base.txt");
		const result = await dispatch("finish", finishArgs(fixture.worktreePath, "rebase_ff"), deps);
		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({ strategy: "rebase_ff" });
		await assertRebasedHistory(fixture.root, targetHead);
	},
);
test.each([{ fresh: false, allowance: "#test-71" }])(
	"rebase_ff replay conflict leaves canonical unchanged (fresh=$fresh) $allowance",
	async ({ fresh }) => {
		const fixture = await prepareReplayConflict(fresh);
		const before = await readFinishState(fixture);
		const sourceBefore = await readCheckoutState(fixture.worktreePath);
		const result = await dispatch("finish", finishArgs(fixture.worktreePath, "rebase_ff"), deps);
		await assertConflictPreserved({
			...fixture,
			result,
			sourceHead: before.sourceBranchHead,
			targetHead: before.canonical.head,
		});
		expect(await readFinishState(fixture)).toEqual(before);
		expect(await gitOut(fixture.worktreePath, "ls-files", "--unmerged")).not.toBe("");
		await gitOut(fixture.worktreePath, "rebase", "--abort");
		expect(await readCheckoutState(fixture.worktreePath)).toEqual(sourceBefore);
	},
);
test("finish uses the configured squash strategy and runs the commit hook #test-85", async () => {
	const { root, worktreePath } = await prepareFinish(
		"feature/configured-strategy",
		'[project.finish]\nstrategy = "squash"\n',
	);
	await commitFile({
		content: "configured\n",
		message: "configured work",
		path: "configured.txt",
		repo: worktreePath,
	});
	const evidence = await installSuccessfulHook(root, "pre-commit");

	const result = await dispatch(
		"finish",
		["--cwd", worktreePath, "--title", "chore: configured squash", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({ strategy: "squash" });
	expect(await gitOut(root, "log", "-1", "--format=%s")).toBe("chore: configured squash");
	const hookCwd = await readFile(evidence, "utf8");
	expect(hookCwd.trim()).toBe(root);
});
test("merge preview errors fail loudly before fresh_canonical advancement #test-87", async () => {
	const fixture = await prepareFinish("feature/preview-error", finishPolicy("squash", true));
	await commitFile({
		content: "source\n",
		message: "source work",
		path: "source.txt",
		repo: fixture.worktreePath,
	});
	await commitTargetChange(fixture, true, "remote.txt");
	const before = await readFinishState(fixture);
	const failingDeps = testDeps({
		git: {
			run: deps.git.run,
			runRaw: async (args, options) => {
				if (args.includes("merge-tree")) {
					return { exitCode: 129, stderr: "merge preview unavailable", stdout: "" };
				}
				return await deps.git.runRaw(args, options);
			},
		},
	});
	const result = await dispatch("finish", finishArgs(fixture.worktreePath, "squash"), failingDeps);
	expect(result.failure).toBeInstanceOf(GitError);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		reason: "git_failed",
		integrated: false,
		cleanup_actions: [],
	});
	expect(await readFinishState(fixture)).toEqual(before);
});
test("non-fast-forward ff_only refuses without target modification #test-88", async () => {
	const { root, worktreePath } = await prepareFinish("feature/divergent-finish");
	await commitFile({
		content: "source\n",
		message: "source work",
		path: "source-only.txt",
		repo: worktreePath,
	});
	await commitFile({
		content: "target\n",
		message: "target work",
		path: "target-only.txt",
		repo: root,
	});
	const targetState = await readCheckoutState(root);

	const result = await dispatch("finish", ["--cwd", worktreePath, "--json"], deps);

	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		reason: "conflict",
	});
	expect(await readCheckoutState(root)).toEqual(targetState);
});

test("fresh_canonical advances the target before squash integration #test-84", async () => {
	const { remote, root, worktreePath } = await prepareFinish(
		"feature/fresh-squash",
		'[project.add]\npolicy = "fresh_canonical"\n[project.finish]\nstrategy = "squash"\n',
	);
	await commitFile({
		content: "source\n",
		message: "source work",
		path: "source.txt",
		repo: worktreePath,
	});
	await commitOnRemoteDefault({
		content: "remote\n",
		message: "advance origin",
		path: "remote.txt",
		remote,
	});

	const result = await dispatch(
		"finish",
		["--cwd", worktreePath, "--title", "chore: fresh squash", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(await gitOut(root, "rev-parse", "HEAD^")).toBe(
		await gitOut(root, "rev-parse", "origin/main"),
	);
	expect(await readFile(join(root, "source.txt"), "utf8")).toBe("source\n");
});

// --- Private functions ---

async function installSuccessfulHook(root: string, name: string): Promise<string> {
	const hook = join(root, ".git", "hooks", name);
	const evidence = join(tmp.dir, name);
	await writeFile(hook, `#!/bin/sh\npwd > "${evidence}"\n`);
	await chmod(hook, EXECUTABLE_MODE);
	return evidence;
}

async function commitTargetChange(
	fixture: Awaited<ReturnType<typeof prepareFinish>>,
	fresh: boolean,
	path: string,
): Promise<string> {
	const change = { content: "target change\n", message: "target work", path };
	if (fresh) {
		await commitOnRemoteDefault({ ...change, remote: fixture.remote });
		return await gitOut(fixture.remote, "rev-parse", "HEAD");
	}
	await commitFile({ ...change, repo: fixture.root });
	return await gitOut(fixture.root, "rev-parse", "HEAD");
}

async function prepareReplayConflict(fresh: boolean) {
	const fixture = await prepareFinish(
		"feature/squash-conflict",
		finishPolicy("rebase_ff", fresh, true),
	);
	await commitFile({
		content: "temporary source change\n",
		message: "source change",
		path: "README.md",
		repo: fixture.worktreePath,
	});
	await commitFile({
		content: "hello\n",
		message: "restore source file",
		path: "README.md",
		repo: fixture.worktreePath,
	});
	await commitFile({
		content: "source\n",
		message: "source addition",
		path: "source-only.txt",
		repo: fixture.worktreePath,
	});
	const targetHead = await commitTargetChange(fixture, fresh, "README.md");
	await gitOut(fixture.root, "fetch", "origin");
	// A tip merge is clean, but replaying the first source commit conflicts.
	expect(
		await gitSucceeds(fixture.root, "merge-tree", "--write-tree", targetHead, fixture.branch),
	).toBe(true);
	return fixture;
}
