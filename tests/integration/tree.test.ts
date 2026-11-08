import { EXIT_CODES, dispatch } from "../../src/index.ts";
import { expect, test } from "bun:test";
import { gitOut, useTmpHome } from "./lifecycle-helpers.ts";
import { initRepo, testDeps } from "./support.ts";
import { GitError } from "../../src/git/error.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures use real checkout paths.
import { join } from "node:path";
// Resolve macOS temporary-directory symlinks to Git's inventory paths.
// oxlint-disable-next-line import/no-nodejs-modules
import { realpath } from "node:fs/promises";

const GIT_FAILURE = 128;
const home = useTmpHome("wktree-tree-");

async function initTreeRepo(defaultBranch = "main") {
	const root = join(home.dir, "repo");
	await initRepo(root);
	if (defaultBranch !== "main") {
		await gitOut(root, "branch", "-m", defaultBranch);
	}
	await gitOut(root, "update-ref", `refs/remotes/origin/${defaultBranch}`, "HEAD");
	await gitOut(
		root,
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
		`refs/remotes/origin/${defaultBranch}`,
	);
	return realpath(root);
}

async function addBranch(root: string, branch: string, base: string) {
	const path = join(home.dir, branch);
	await gitOut(root, "worktree", "add", "-b", branch, path, base);
	return realpath(path);
}

async function commit(repo: string, message: string) {
	await gitOut(repo, "commit", "--allow-empty", "-m", message);
}

async function treeJson(root: string) {
	const result = await dispatch("tree", ["--cwd", root, "--json"], testDeps());
	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(result.stderr).toBeUndefined();
	return JSON.parse(result.stdout ?? "{}");
}

async function initOlderAndUnrelatedTree() {
	const root = await initTreeRepo();
	const old = await addBranch(root, "old", "main");
	const oldHead = await gitOut(old, "rev-parse", "HEAD");
	await commit(root, "advance main");
	const mainHead = await gitOut(root, "rev-parse", "HEAD");
	const separate = await addBranch(root, "separate", "main");
	await gitOut(separate, "checkout", "--orphan", "independent");
	await commit(separate, "independent root");
	return { mainHead, oldHead, root };
}

test("contained worktrees stay beneath the local default; unrelated history stays separate #test-142", async () => {
	const { mainHead, oldHead, root } = await initOlderAndUnrelatedTree();
	const payload = await treeJson(root);
	expect(payload.nodes).toContainEqual(
		expect.objectContaining({
			id: mainHead,
			parentage: { kind: "unknown", reason: "no_ancestor" },
		}),
	);
	expect(payload.default_branch).toMatchObject({ head: mainHead });
	expect(payload.nodes).toContainEqual(
		expect.objectContaining({ id: oldHead, comparison: { kind: "related", ahead: 0, behind: 1 } }),
	);
	const result = await dispatch("tree", ["--cwd", root], testDeps());
	expect(result.stdout).toMatchInlineSnapshot(`
"Worktrees (default-branch groups; inferred feature stacks, not creation history)
├── main [canonical] [default]
│   └── old [0 ahead, 1 behind]
└── independent [? no common ancestor in local history]
"
`);
});

test.each([
	{ args: ["init", "--bare"], kind: "bare" },
	{ args: ["init", "-b", "main"], kind: "unborn" },
])("$kind repositories have no comparable HEAD #test-147", async ({ args }) => {
	const root = join(home.dir, "empty");
	await gitOut(home.dir, ...args, root);
	const payload = await treeJson(root);
	expect(payload.nodes).toMatchObject([
		{ id: await realpath(root), parentage: { kind: "unknown", reason: "no_head" } },
	]);
	const text = await dispatch("tree", ["--cwd", root], testDeps());
	expect(text.stdout).toContain("[? no HEAD]");
});

test("detached worktrees are labelled by path and group with matching branch HEADs #test-144", async () => {
	const root = await initTreeRepo();
	const detached = join(home.dir, "detached");
	await gitOut(root, "worktree", "add", "--detach", detached, "HEAD");
	const path = await realpath(detached);
	const payload = await treeJson(root);
	expect(payload.nodes).toMatchObject([
		{ worktrees: [{ branch: "main" }, { detached: true, path }] },
	]);
	const text = await dispatch("tree", ["--cwd", root], testDeps());
	expect(text.stdout).toContain(`main [canonical] [default] = ${path} [detached] [same HEAD]`);
});

test.each(["symbolic-ref", "rev-parse", "rev-list", "merge-base"])(
	"%s errors fail as git_failed instead of appearing as uncertain parents #test-145",
	async (operation) => {
		const root = await initTreeRepo();
		const deps = testDeps();
		const result = await dispatch("tree", ["--cwd", root, "--json"], {
			...deps,
			git: {
				run: (args) => {
					expect(args).toContain("--no-lazy-fetch");
					if (args.includes(operation)) {
						throw new GitError(args, "missing commit object", GIT_FAILURE);
					}
					return deps.git.run(args);
				},
				runRaw: (args) => {
					expect(args).toContain("--no-lazy-fetch");
					if (args.includes(operation)) {
						return Promise.resolve({ exitCode: 128, stderr: "missing commit object", stdout: "" });
					}
					return deps.git.runRaw(args);
				},
			},
		});
		expect(result.exitCode).toBe(EXIT_CODES.FAILURE);
		expect(result.failure).toBeInstanceOf(GitError);
		expect(result.failure).toMatchObject({
			args: expect.arrayContaining([operation]),
			gitExitCode: GIT_FAILURE,
			stderr: "missing commit object",
		});
		expect(result.stderr).toBeUndefined();
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			kind: "error",
			ok: false,
			reason: "git_failed",
		});
	},
);

async function initDefaultAwayFromCanonical(removeLocal: boolean) {
	const root = await initTreeRepo("release/trunk");
	const baseline = await gitOut(root, "rev-parse", "HEAD");
	await gitOut(root, "checkout", "-b", "canonical-feature");
	await commit(root, "canonical feature work");
	if (removeLocal) {
		await gitOut(root, "branch", "-D", "release/trunk");
	}
	return { root, baseline };
}

test.each([
	{ removeLocal: false, ref: "refs/heads/release/trunk" },
	{ removeLocal: true, ref: "refs/remotes/origin/release/trunk" },
])("discovers $ref independently of canonical HEAD #test-143", async ({ removeLocal, ref }) => {
	const { root, baseline } = await initDefaultAwayFromCanonical(removeLocal);
	const result = await treeJson(root);
	expect(result.default_branch).toEqual({
		branch: "release/trunk",
		head: baseline,
		ref,
	});
	expect(result.nodes).toMatchObject([
		{
			comparison: { kind: "related", ahead: 1, behind: 0 },
			worktrees: [{ branch: "canonical-feature", canonical: true }],
		},
	]);
	const text = await dispatch("tree", ["--cwd", root], testDeps());
	expect(text.stdout).toContain("release/trunk [default; not checked out]");
	expect(text.stdout).toContain("    └── canonical-feature [canonical] [1 ahead, 0 behind]");
});

test.each([
	{ missing: "designation", args: ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"] },
	{
		missing: "tips",
		args: ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing"],
	},
])(
	"missing default $missing fails instead of guessing main or canonical HEAD #test-146",
	async ({ args }) => {
		const root = await initTreeRepo();
		await gitOut(root, ...args);
		const result = await dispatch("tree", ["--cwd", root, "--json"], testDeps());
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			ok: false,
			reason: "trunk_detection_failed",
		});
		expect(result.exitCode).not.toBe(EXIT_CODES.SUCCESS);
	},
);
