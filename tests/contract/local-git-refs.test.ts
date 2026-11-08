/* eslint-disable unicorn/no-null -- Missing local default metadata is explicitly represented by null. */
import { createLiveGitRunner, withoutLazyFetch } from "../../src/git/executor.ts";
import { expect, test } from "bun:test";
import { gitOut, useTmpHome } from "../integration/lifecycle-helpers.ts";
import { GitError } from "../../src/git/error.ts";
import type { LocalGitRefs } from "../../src/application/branches.ts";
import type { RefState } from "./local-git-refs-fixture.ts";
import { TrunkDetectionError } from "../../src/errors.ts";
import { createLocalGitRefs } from "../../src/application/branches.ts";
import { createRefFixture } from "./local-git-refs-fixture.ts";
import { run } from "../integration/support.ts";

const tmp = useTmpHome("wktree-ref-contract-");
const local = "refs/heads/develop";
const cached = "refs/remotes/origin/develop";
const missing = "refs/heads/absent";
const tag = "refs/tags/start";
const tree = "refs/tags/tree";
const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"];

test("local Git ref fixture matches native default, exact-ref and commit observations #test-181", async () => {
	const root = `${tmp.dir}/repo`;
	const state = await createRefRepository(root);
	const live = createLocalGitRefs(withoutLazyFetch(createLiveGitRunner()), root);
	await Promise.all(
		[live, createRefFixture(state)].map((refs) => assertRefObservations(refs, state)),
	);
	await run(["git", "-C", root, "symbolic-ref", "refs/remotes/origin/HEAD", cached]);
	const designated = createRefFixture({ ...state, defaultBranch: "develop" });
	expect(await live.defaultBranch()).toBe(await designated.defaultBranch());
	expect(await live.defaultBranch()).toBe("develop");
	await assertReadFailures(root, live);
});

async function createRefRepository(root: string): Promise<RefState> {
	await run(["git", "init", "--template=", "--initial-branch=develop", root]);
	await run([
		"git",
		"-C",
		root,
		...identity,
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--allow-empty",
		"-m",
		"fixture",
	]);
	const oid = await gitOut(root, "rev-parse", "HEAD");
	await createRefs(root, oid);
	return {
		defaultBranch: null,
		refs: [local, cached, `${missing}/child`, tag, tree],
		commits: {
			[local]: { kind: "commit", oid },
			[cached]: { kind: "commit", oid },
			[tag]: { kind: "commit", oid },
			[missing]: { kind: "unresolvable" },
			[tree]: { kind: "unresolvable" },
		},
	};
}

async function createRefs(root: string, oid: string): Promise<void> {
	await run([
		"git",
		"-C",
		root,
		...identity,
		"-c",
		"tag.gpgsign=false",
		"tag",
		"-a",
		"start",
		"-m",
		"start",
	]);
	const treeOid = await gitOut(root, "rev-parse", "HEAD^{tree}");
	await run(
		["git", "-C", root, "update-ref", "--stdin"],
		`update ${cached} ${oid}\nupdate ${missing}/child ${oid}\nupdate ${tree} ${treeOid}\n`,
	);
}

async function assertRefObservations(refs: LocalGitRefs, state: RefState): Promise<void> {
	expect(await refs.defaultBranch()).toBeNull();
	await Promise.all(
		Object.entries(state.commits).map(async ([ref, expected]) => {
			expect(await refs.hasRef(ref)).toBe(state.refs.includes(ref));
			expect(await refs.commit(ref)).toEqual(expected);
		}),
	);
}

async function assertReadFailures(root: string, live: LocalGitRefs): Promise<void> {
	await run(["git", "-C", root, "symbolic-ref", "refs/remotes/origin/HEAD", local]);
	await expect(live.defaultBranch()).rejects.toBeInstanceOf(TrunkDetectionError);
	const invalid = createLocalGitRefs(createLiveGitRunner(), `${tmp.dir}/missing`);
	await expect(invalid.defaultBranch()).rejects.toBeInstanceOf(GitError);
	await expect(invalid.hasRef(local)).rejects.toBeInstanceOf(GitError);
}
