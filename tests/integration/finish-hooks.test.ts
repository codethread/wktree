import { EXIT_CODES, dispatch } from "../../src/index";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { chmod, writeFile } from "node:fs/promises";
import {
	commitFile,
	commitOnRemoteDefault,
	createWorktree,
	deps,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
import { expect, test } from "bun:test";
import { finishArgs, finishPolicy, readCheckoutState, readFinishState } from "./finish-helpers.ts";
import { gitOut, useTmpHome } from "./lifecycle-helpers.ts";
import { GitError } from "../../src/git/error.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { join } from "node:path";

const tmp = useTmpHome("wktree-finish-hooks-test-");
const { initRepoWithOrigin } = useOriginFixture();
const EXECUTABLE_MODE = 0o755;

test.each([
	{ hook: "pre-commit", strategy: "squash", fresh: false, staged: "source.txt" },
	{ hook: "pre-merge-commit", strategy: "merge_commit", fresh: false, staged: "source.txt" },
	{ hook: "pre-rebase", strategy: "rebase_ff", fresh: true, staged: "" },
])(
	"$strategy preserves $hook rejection as a Git failure #test-99",
	async ({ hook, strategy, fresh, staged }) => {
		const fixture = await prepareHookFailure(hook, strategy, fresh);
		const before = await readFinishState(fixture);
		const sourceBefore = await readCheckoutState(fixture.worktreePath);
		const result = await dispatch("finish", finishArgs(fixture.worktreePath, strategy), deps);
		expect(result.failure).toBeInstanceOf(GitError);
		expect({ ...JSON.parse(result.stdout ?? "{}"), exitCode: result.exitCode }).toMatchObject({
			exitCode: EXIT_CODES.FAILURE,
			reason: "git_failed",
			integrated: false,
			cleanup_actions: [],
			message: expect.stringContaining("hook rejected"),
		});
		expect(await readFinishState(fixture)).toMatchObject({
			...before,
			canonical: { head: before.canonical.head },
		});
		expect(await readCheckoutState(fixture.worktreePath)).toEqual(sourceBefore);
		expect(await gitOut(fixture.root, "ls-files", "--unmerged")).toBe("");
		expect(await gitOut(fixture.root, "diff", "--name-only", "--cached")).toBe(staged);
	},
);

// --- Private functions ---

async function prepareHookFailure(hook: string, strategy: string, fresh: boolean) {
	const { remote, root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({
		command: "echo ready",
		root,
		tmp: tmp.dir,
		copyToml: finishPolicy(strategy, fresh, true),
	});
	const worktreePath = `${root}__feature--hook`;
	await createWorktree({ branch: "feature/hook", path: worktreePath, root });
	await commitFile({
		content: "source\n",
		message: "source work",
		path: "source.txt",
		repo: worktreePath,
	});
	if (fresh) {
		await commitOnRemoteDefault({
			content: "remote\n",
			message: "advance remote",
			path: "remote.txt",
			remote,
		});
	}
	await installRejectingHook(root, hook);
	return { branch: "feature/hook", remote, root, worktreePath };
}

async function installRejectingHook(root: string, name: string): Promise<void> {
	const hookPath = join(root, ".git", "hooks", name);
	await writeFile(hookPath, "#!/bin/sh\necho hook rejected >&2\nexit 1\n");
	await chmod(hookPath, EXECUTABLE_MODE);
}
