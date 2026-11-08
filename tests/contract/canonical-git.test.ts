import { EXIT_CODES, NonFastForwardCanonicalError } from "../../src/errors.ts";
import {
	assertCanonicalCanFastForward,
	createCanonicalGitObservations,
	fastForwardCanonicalDefault,
} from "../../src/application/branches.ts";
import { commitFile, run } from "../integration/support.ts";
import { createLiveGitRunner, withoutLazyFetch } from "../../src/git/executor.ts";
import { expect, test } from "bun:test";
import { gitOut, useTmpHome } from "../integration/lifecycle-helpers.ts";
import type { CanonicalGitObservations } from "../../src/application/branches.ts";
import type { CanonicalState } from "./canonical-git-fixture.ts";
import { GitError } from "../../src/git/error.ts";
import type { GitRunner } from "../../src/services.ts";
import { createCanonicalFixture } from "./canonical-git-fixture.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Native Git contracts alter real fixture files.
import { writeFile } from "node:fs/promises";

const tmp = useTmpHome("wktree-canonical-contract-");
const git = withoutLazyFetch(createLiveGitRunner());
const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"];
const cached = "refs/remotes/origin/develop";
const target = "origin/develop";

interface History {
	/** Repository acting as the canonical worktree. */
	root: string;
	/** Common ancestor of the canonical and diverged tips. */
	base: string;
	/** Initial canonical develop tip. */
	head: string;
	/** Child of head, initially the cached origin/develop tip. */
	descendant: string;
	/** Child of base on a history diverging from head. */
	diverged: string;
}

test("canonical fixture matches native status, checkout and ancestry observations #test-179", async () => {
	const history = await createHistory(`${tmp.dir}/observations`);
	const live = createCanonicalGitObservations(git, history.root);
	const state: CanonicalState = {
		cleanliness: "clean",
		checkout: { kind: "branch", name: "develop" },
		ancestry: {
			[history.head]: "proven",
			[history.descendant]: "proven",
			[history.base]: "unproven",
			[history.diverged]: "unproven",
		},
	};
	await assertObservations(live, state);
	await assertDirtyStates(history.root, live, state);
	await run(["git", "-C", history.root, "checkout", "-b", "other"]);
	await assertObservations(live, { ...state, checkout: { kind: "branch", name: "other" } });
	await run(["git", "-C", history.root, "checkout", "--detach"]);
	await assertObservations(live, { ...state, checkout: { kind: "detached" } });
});

test("canonical status/checkout failures reject; fatal ancestry exits remain unproven #test-179", async () => {
	const invalid = createCanonicalGitObservations(git, `${tmp.dir}/absent`);
	await expect(invalid.cleanliness()).rejects.toBeInstanceOf(GitError);
	await expect(invalid.checkout()).rejects.toBeInstanceOf(GitError);
	const root = `${tmp.dir}/errors`;
	await createRepository(root);
	const live = createCanonicalGitObservations(git, root);
	expect(await live.headAncestry(target)).toBe("unproven");
	await expect(assertCanonicalCanFastForward(live, "develop")).rejects.toBeInstanceOf(
		NonFastForwardCanonicalError,
	);
});

test("native fast-forward succeeds and refuses a target that diverges after its ancestry check #test-179", async () => {
	const history = await createHistory(`${tmp.dir}/merge`);
	await advance(history, git);
	expect(await gitOut(history.root, "rev-parse", "HEAD")).toBe(history.descendant);
	await run(["git", "-C", history.root, "reset", "--hard", history.head]);
	const before = await worktreeState(history.root);
	const changing = changeTargetAfterProof(history);
	await expect(advance(history, changing.runner)).rejects.toBeInstanceOf(GitError);
	expect(await worktreeState(history.root)).toEqual(before);
	expect(await gitOut(history.root, "rev-parse", target)).toBe(history.diverged);
	expect(changing.commands).toEqual([
		["-C", history.root, "status", "--porcelain=v1"],
		["-C", history.root, "branch", "--show-current"],
		["-C", history.root, "merge", "--ff-only", target],
	]);
});

async function createHistory(root: string): Promise<History> {
	await createRepository(root);
	const base = await gitOut(root, "rev-parse", "HEAD");
	const tree = await gitOut(root, "rev-parse", "HEAD^{tree}");
	const head = await createCommit(root, tree, { parent: base, message: "head" });
	const descendant = await createCommit(root, tree, { parent: head, message: "descendant" });
	const diverged = await createCommit(root, tree, { parent: base, message: "diverged" });
	await run(
		["git", "-C", root, "update-ref", "--stdin"],
		`update refs/heads/develop ${head}\nupdate ${cached} ${descendant}\n`,
	);
	return { root, base, head, descendant, diverged };
}

async function createRepository(root: string): Promise<void> {
	await run(["git", "init", "--template=", "--initial-branch=develop", root]);
	await commitFile({ repo: root, path: "tracked.txt", content: "original\n", message: "base" });
}

function createCommit(
	root: string,
	tree: string,
	commit: { parent: string; message: string },
): Promise<string> {
	return gitOut(root, ...identity, "commit-tree", tree, "-p", commit.parent, "-m", commit.message);
}

async function assertObservations(
	live: CanonicalGitObservations,
	state: CanonicalState,
): Promise<void> {
	const memory = createCanonicalFixture(state);
	await Promise.all(
		[live, memory].map(async (observations) => {
			expect(await observations.cleanliness()).toBe(state.cleanliness);
			expect(await observations.checkout()).toEqual(state.checkout);
			await Promise.all(
				Object.entries(state.ancestry).map(async ([ref, proof]) => {
					expect(await observations.headAncestry(ref)).toBe(proof);
				}),
			);
		}),
	);
}

async function assertDirtyStates(
	root: string,
	live: CanonicalGitObservations,
	state: CanonicalState,
): Promise<void> {
	const dirty = { ...state, cleanliness: "dirty" as const };
	await writeFile(`${root}/untracked.txt`, "untracked\n");
	await assertDirty(live, dirty);
	await run(["git", "-C", root, "clean", "-f"]);
	await writeFile(`${root}/tracked.txt`, "changed\n");
	await assertDirty(live, dirty);
	await run(["git", "-C", root, "add", "tracked.txt"]);
	await assertDirty(live, dirty);
	await run(["git", "-C", root, "reset", "--hard", "HEAD"]);
}

async function assertDirty(live: CanonicalGitObservations, state: CanonicalState): Promise<void> {
	expect(await live.cleanliness()).toBe("dirty");
	expect(await createCanonicalFixture(state).cleanliness()).toBe("dirty");
}

function advance(history: History, runner: GitRunner): Promise<void> {
	return fastForwardCanonicalDefault({
		canonical: createCanonicalGitObservations(runner, history.root),
		git: runner,
		root: history.root,
		defaultBranch: "develop",
	});
}

function changeTargetAfterProof(history: History) {
	const commands: string[][] = [];
	const runner: GitRunner = {
		run(args) {
			commands.push([...args]);
			return git.run(args);
		},
		async runRaw(args) {
			const result = await git.runRaw(args);
			if (args.includes("merge-base")) {
				expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
				await run(["git", "-C", history.root, "update-ref", cached, history.diverged]);
			}
			return result;
		},
	};
	return { runner, commands };
}

function worktreeState(root: string): Promise<string[]> {
	return Promise.all([
		gitOut(root, "rev-parse", "HEAD"),
		gitOut(root, "status", "--porcelain=v1"),
		gitOut(root, "ls-files", "--stage"),
	]);
}
