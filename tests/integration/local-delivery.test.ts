/* eslint-disable max-statements -- Native-Git scenarios keep setup, effects and receipts together. */
import { EXIT_CODES, dispatch } from "../../src/index.ts";
import { afterAll, expect, test } from "bun:test";
// oxlint-disable-next-line import/no-nodejs-modules -- Native Git fixtures use temporary files.
import { chmod, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { commitFile, createWorktree, initRepo, pathExists, testDeps } from "./support.ts";
import { gitOut, gitSucceeds, gitText, runCli, useTmpHome } from "./lifecycle-helpers.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Native Git fixtures copy real repositories on disk.
import { cpSync } from "node:fs";
// oxlint-disable-next-line import/no-nodejs-modules -- Temporary checkout paths.
import { join } from "node:path";
// oxlint-disable-next-line import/no-nodejs-modules -- Temporary checkout paths.
import { tmpdir } from "node:os";

const tmp = useTmpHome("wktree-local-delivery-");
const EXECUTABLE = 0o755;
const GIT_FAILURE = 128;

const fixtureState: { seed?: { dir: string; root: string; base: string; head: string } } = {};

afterAll(async () => {
	if (fixtureState.seed) {
		await rm(fixtureState.seed.dir, { force: true, recursive: true });
	}
});

async function fixture() {
	fixtureState.seed ??= await createSeed();
	const { seed } = fixtureState;
	// oxlint-disable-next-line node/no-sync -- This sequential fixture copy blocks its test worker.
	cpSync(seed.root, join(tmp.dir, "repo"), { recursive: true });
	const root = await realpath(join(tmp.dir, "repo"));
	const target = join(tmp.dir, "feature");
	const source = join(tmp.dir, "task");
	await createWorktree({ root, path: target, branch: "feature/base" });
	await gitOut(root, "worktree", "add", source, "task/slice");
	return {
		root,
		source: await realpath(source),
		target: await realpath(target),
		base: seed.base,
		head: seed.head,
	};
}

async function createSeed() {
	const dir = await mkdtemp(join(tmpdir(), "wktree-local-delivery-seed-"));
	await initRepo(join(dir, "repo"));
	const root = await realpath(join(dir, "repo"));
	// A dangling designation supplies the default name without any origin history or remote.
	await gitOut(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
	const source = join(dir, "task");
	await createWorktree({ root, path: source, branch: "task/slice" });
	const base = await gitOut(root, "rev-parse", "HEAD");
	await commitFile({
		repo: source,
		path: "slice.txt",
		content: "reviewed\n",
		message: "feat: slice",
	});
	const head = await gitOut(source, "rev-parse", "HEAD");
	await gitOut(root, "worktree", "remove", source);
	return { dir, root, base, head };
}

async function readCheckoutState(repo: string) {
	const [status, index] = await Promise.all([
		gitOut(repo, "status", "--porcelain=v2", "--branch", "--untracked-files=all"),
		gitText(repo, "ls-files", "--stage"),
	]);
	return { status, index };
}

function pins(checkout: Awaited<ReturnType<typeof fixture>>, target = checkout.base) {
	return ["--expected-source", checkout.head, "--expected-target", target];
}

test(
	"public CLI integrates a pinned local-only task and preserves source and " +
		"canonical checkouts #test-132",
	async () => {
		const checkout = await fixture();
		await writeFile(
			join(checkout.root, ".wktree.toml"),
			'[finish]\nstrategy = "squash"\npush = true\nremove_worktree = true\ndelete_branch = true\n',
		);
		const canonical = await readCheckoutState(checkout.root);
		expect(canonical.status).toContain(`# branch.oid ${checkout.base}\n`);
		expect(canonical.status).toContain("# branch.head main");
		const hook = join(checkout.root, ".git/hooks/post-merge");
		await writeFile(hook, "#!/bin/sh\necho invoked > hook-ran\n");
		await chmod(hook, EXECUTABLE);

		const result = await runCli([
			"--cwd",
			checkout.source,
			"integrate",
			"--into",
			"feature/base",
			...pins(checkout),
			"--json",
		]);
		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			kind: "ready",
			root: checkout.root,
			source_branch: "task/slice",
			target_branch: "feature/base",
			worktree_path: checkout.source,
			target_worktree_path: checkout.target,
			source_oid: checkout.head,
			target_before_oid: checkout.base,
			target_after_oid: checkout.head,
			integrated: true,
			cleanup_actions: [],
		});
		expect(await pathExists(join(checkout.target, "hook-ran"))).toBe(false);
		expect(await readCheckoutState(checkout.root)).toEqual(canonical);
		expect(await gitOut(checkout.source, "rev-parse", "HEAD")).toBe(checkout.head);
	},
);

test("public CLI removes a contained local-only task with exact cleanup receipts #test-134", async () => {
	const checkout = await fixture();
	await gitOut(checkout.target, "merge", "--ff-only", checkout.head);
	const canonical = await readCheckoutState(checkout.root);
	const cleanup = await runCli([
		"--cwd",
		checkout.source,
		"remove",
		"--self",
		"--integrated-into-local",
		"feature/base",
		...pins(checkout, checkout.head),
		"--json",
	]);
	expect(cleanup.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(cleanup.stderr).toBe("");
	expect(JSON.parse(cleanup.stdout)).toMatchObject({
		ok: true,
		removed: true,
		containment: "git_ancestry",
		source_oid: checkout.head,
		target_before_oid: checkout.head,
		target_after_oid: checkout.head,
		cleanup_actions: ["remove_worktree", "delete_branch"],
	});
	expect(await pathExists(checkout.source)).toBe(false);
	expect(await gitSucceeds(checkout.target, "show-ref", "--verify", "refs/heads/task/slice")).toBe(
		false,
	);
	expect(await gitOut(checkout.target, "rev-parse", "HEAD")).toBe(checkout.head);
	expect(await readCheckoutState(checkout.root)).toEqual(canonical);
});

test.each([
	{ state: "stale-source", reason: "source_not_fresh" },
	{ state: "stale-target", reason: "target_not_fresh" },
	{ state: "dirty-source", reason: "dirty_worktree" },
	{ state: "dirty-target", reason: "dirty_worktree" },
	{ state: "diverged", reason: "blocked" },
	{ state: "canonical", reason: "canonical_root" },
	{ state: "default", reason: "canonical_root" },
	{ state: "unregistered", reason: "blocked" },
	{ state: "locked", reason: "blocked" },
	{ state: "merge-options", reason: "usage" },
	{ state: "duplicate-source", reason: "blocked" },
])(
	"integration refuses $state before changing either checkout #test-133",
	async ({ state, reason }) => {
		const checkout = await fixture();
		let into = "feature/base";
		let targetPin = checkout.base;
		let sourcePin = checkout.head;
		switch (state) {
			case "stale-source": {
				sourcePin = checkout.base;
				break;
			}
			case "stale-target": {
				targetPin = checkout.head;
				break;
			}
			case "dirty-source": {
				await writeFile(join(checkout.source, "private.txt"), "private");
				break;
			}
			case "dirty-target": {
				await writeFile(join(checkout.target, "private.txt"), "private");
				break;
			}
			case "diverged": {
				await gitOut(checkout.target, "commit", "--allow-empty", "-m", "other slice");
				targetPin = await gitOut(checkout.target, "rev-parse", "HEAD");
				break;
			}
			case "canonical": {
				into = "main";
				break;
			}
			case "default": {
				await gitOut(
					checkout.root,
					"symbolic-ref",
					"refs/remotes/origin/HEAD",
					"refs/remotes/origin/feature/base",
				);
				break;
			}
			case "unregistered": {
				into = "missing";
				break;
			}
			case "locked": {
				await gitOut(checkout.root, "worktree", "lock", checkout.target);
				break;
			}
			case "merge-options": {
				await gitOut(checkout.target, "config", "branch.feature/base.mergeOptions", "--squash");
				break;
			}
			case "duplicate-source": {
				await gitOut(
					checkout.root,
					"worktree",
					"add",
					"--force",
					join(tmp.dir, "duplicate"),
					"task/slice",
				);
				break;
			}
		}
		const before = await readCheckoutState(checkout.target);
		const sourceBefore = await readCheckoutState(checkout.source);
		const result = await dispatch(
			"integrate",
			[
				"--cwd",
				checkout.source,
				"--into",
				into,
				"--expected-source",
				sourcePin,
				"--expected-target",
				targetPin,
				"--json",
			],
			testDeps(),
		);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			ok: false,
			reason,
			integrated: false,
			integration_attempted: false,
			cleanup_actions: [],
		});
		expect(await readCheckoutState(checkout.target)).toEqual(before);
		expect(await readCheckoutState(checkout.source)).toEqual(sourceBefore);
	},
);

test("local cleanup preserves an unintegrated or newly advanced private source #test-136", async () => {
	const checkout = await fixture();
	const result = await dispatch(
		"remove",
		[
			"--cwd",
			checkout.source,
			"--self",
			"--integrated-into-local",
			"feature/base",
			...pins(checkout),
			"--json",
		],
		testDeps(),
	);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		ok: false,
		reason: "unmerged_branch",
		cleanup_actions: [],
	});
	expect(await pathExists(checkout.source)).toBe(true);
	await gitOut(checkout.target, "merge", "--ff-only", checkout.head);
	await gitOut(checkout.source, "commit", "--allow-empty", "-m", "private work");
	const stale = await dispatch(
		"remove",
		[
			"--cwd",
			checkout.source,
			"--self",
			"--integrated-into-local",
			"feature/base",
			...pins(checkout, checkout.head),
			"--json",
		],
		testDeps(),
	);
	expect(JSON.parse(stale.stdout ?? "{}")).toMatchObject({
		ok: false,
		reason: "source_not_fresh",
		cleanup_actions: [],
	});
	expect(await pathExists(checkout.source)).toBe(true);
	expect(await gitSucceeds(checkout.root, "show-ref", "--verify", "refs/heads/task/slice")).toBe(
		true,
	);
});

test(
	"failed Git mutation reports observed integration, and cleanup reports only " +
		"completed actions #test-135",
	async () => {
		const checkout = await fixture();
		const deps = testDeps();
		const integrated = await dispatch(
			"integrate",
			["--cwd", checkout.source, "--into", "feature/base", ...pins(checkout), "--json"],
			{
				...deps,
				git: {
					...deps.git,
					run: async (args, opts) => {
						const result = await deps.git.run(args, opts);
						if (args.includes("merge")) {
							throw new Error("interrupted after merge");
						}
						return result;
					},
				},
			},
		);
		expect(JSON.parse(integrated.stdout ?? "{}")).toMatchObject({
			ok: false,
			integration_attempted: true,
			integrated: true,
			target_after_oid: checkout.head,
			cleanup_actions: [],
		});
		const cleanup = await dispatch(
			"remove",
			[
				"--cwd",
				checkout.source,
				"--self",
				"--integrated-into-local",
				"feature/base",
				...pins(checkout, checkout.head),
				"--json",
			],
			{
				...deps,
				git: {
					...deps.git,
					run: (args, opts) => {
						if (args.includes("update-ref")) {
							throw new Error("branch deletion failed");
						}
						return deps.git.run(args, opts);
					},
				},
			},
		);
		expect(JSON.parse(cleanup.stdout ?? "{}")).toMatchObject({
			ok: false,
			cleanup_actions: ["remove_worktree"],
		});
		expect(await pathExists(checkout.source)).toBe(false);
		expect(await gitSucceeds(checkout.root, "show-ref", "--verify", "refs/heads/task/slice")).toBe(
			true,
		);
	},
);

test("Git ancestry failures stay failures and every Git operation disables lazy fetching #test-140", async () => {
	const checkout = await fixture();
	const deps = testDeps();
	const calls: string[][] = [];
	const result = await dispatch(
		"integrate",
		["--cwd", checkout.source, "--into", "feature/base", ...pins(checkout), "--json"],
		{
			...deps,
			config: {
				...deps.config,
				read: () => {
					throw new Error("must not load finish policy");
				},
			},
			git: {
				run: (args, opts) => {
					calls.push(args);
					return deps.git.run(args, opts);
				},
				runRaw: (args, opts) => {
					calls.push(args);
					if (args.includes("merge-base")) {
						return Promise.resolve({ exitCode: GIT_FAILURE, stdout: "", stderr: "missing object" });
					}
					return deps.git.runRaw(args, opts);
				},
			},
		},
	);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		ok: false,
		reason: "git_failed",
		integration_attempted: false,
	});
	expect(calls.every(([first]) => first === "--no-lazy-fetch")).toBe(true);
	expect(calls.flat()).not.toContain("fetch");
	expect(calls.flat()).not.toContain("push");
	expect(await gitOut(checkout.target, "rev-parse", "HEAD")).toBe(checkout.base);
});

test.each(["branch", "repository"])(
	"stale registry cannot authorize a foreign %s identity #test-138",
	async (identity) => {
		const checkout = await fixture();
		const deps = testDeps();
		const inventory = await gitOut(checkout.root, "worktree", "list", "--porcelain");
		if (identity === "branch") {
			await gitOut(checkout.target, "branch", "-m", "feature/renamed");
		} else {
			await rename(checkout.target, `${checkout.target}-moved`);
			await initRepo(checkout.target);
		}
		const before = await readCheckoutState(checkout.target);
		const result = await dispatch(
			"integrate",
			["--cwd", checkout.source, "--into", "feature/base", ...pins(checkout), "--json"],
			{
				...deps,
				git: {
					...deps.git,
					run: (args, opts) => {
						if (args.includes("worktree") && args.includes("list")) {
							return Promise.resolve({
								stdout: inventory,
								stderr: "",
								exitCode: EXIT_CODES.SUCCESS,
							});
						}
						return deps.git.run(args, opts);
					},
				},
			},
		);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			ok: false,
			reason: "blocked",
			integration_attempted: false,
		});
		expect(await readCheckoutState(checkout.target)).toEqual(before);
	},
);

test("public CLI exposes schemas without a repository and refuses abbreviated review pins #test-141", async () => {
	const schema = await runCli(["--cwd", tmp.dir, "integrate", "--schema", "--json"]);
	expect(schema.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(schema.stderr).toBe("");
	expect(JSON.parse(schema.stdout)).toMatchObject({
		ok: true,
		kind: "local_delivery_schema",
		schemas: {
			integrate: { type: "object" },
			remove_local: { type: "object" },
			failure: { type: "object" },
		},
	});
	const invalid = await runCli([
		"--cwd",
		tmp.dir,
		"integrate",
		"--into",
		"feature/base",
		"--expected-source",
		"HEAD",
		"--expected-target",
		"abc",
		"--json",
	]);
	expect(invalid.exitCode).toBe(EXIT_CODES.USAGE);
	expect(invalid.stderr).toBe("");
	expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false, kind: "error", reason: "usage" });
});

test(
	"cleanup's native expected-OID deletion preserves a source ref advanced after " +
		"checkout removal #test-137",
	async () => {
		const checkout = await fixture();
		await gitOut(checkout.target, "merge", "--ff-only", checkout.head);
		const tree = await gitOut(checkout.source, "rev-parse", "HEAD^{tree}");
		const privateHead = await gitOut(
			checkout.source,
			"commit-tree",
			tree,
			"-p",
			checkout.head,
			"-m",
			"private commit",
		);
		const deps = testDeps();
		const result = await dispatch(
			"remove",
			[
				"--cwd",
				checkout.source,
				"--self",
				"--integrated-into-local",
				"feature/base",
				...pins(checkout, checkout.head),
				"--json",
			],
			{
				...deps,
				git: {
					...deps.git,
					run: async (args, opts) => {
						if (args.includes("update-ref")) {
							await gitOut(
								checkout.target,
								"update-ref",
								"refs/heads/task/slice",
								privateHead,
								checkout.head,
							);
						}
						return deps.git.run(args, opts);
					},
				},
			},
		);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			ok: false,
			reason: "git_failed",
			cleanup_actions: ["remove_worktree"],
		});
		expect(await pathExists(checkout.source)).toBe(false);
		expect(await gitOut(checkout.target, "rev-parse", "refs/heads/task/slice")).toBe(privateHead);
	},
);

test("unreadable post-mutation HEAD leaves integration unknown for caller inspection #test-139", async () => {
	const checkout = await fixture();
	const deps = testDeps();
	let merged = false;
	const result = await dispatch(
		"integrate",
		["--cwd", checkout.source, "--into", "feature/base", ...pins(checkout), "--json"],
		{
			...deps,
			git: {
				...deps.git,
				run: async (args, opts) => {
					if (merged && args.includes("rev-parse")) {
						throw new Error("post-mutation HEAD unreadable");
					}
					const effect = await deps.git.run(args, opts);
					if (args.includes("merge")) {
						merged = true;
					}
					return effect;
				},
			},
		},
	);
	const payload = JSON.parse(result.stdout ?? "{}");
	expect(payload).toMatchObject({ ok: false, integration_attempted: true, cleanup_actions: [] });
	expect(payload).not.toHaveProperty("integrated");
	expect(payload).not.toHaveProperty("target_after_oid");
	expect(await gitOut(checkout.target, "rev-parse", "HEAD")).toBe(checkout.head);
});
