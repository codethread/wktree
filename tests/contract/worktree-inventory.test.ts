/* eslint-disable unicorn/no-null -- Git's absent metadata uses explicit null. */
import { expect, test } from "bun:test";
// oxlint-disable-next-line import/no-nodejs-modules -- Native contracts create isolated real repositories.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
// oxlint-disable-next-line import/no-nodejs-modules -- Native contracts create isolated real repositories.
import { mkdtempSync, rmSync } from "node:fs";
import { GitError } from "../../src/git/error.ts";
import type { Worktree } from "../../src/domain/worktree.ts";
import type { WorktreeInventory } from "../../src/git/worktrees.ts";
import { createGitWorktreeInventory } from "../../src/git/worktrees.ts";
import { createLiveGitRunner } from "../../src/git/executor.ts";
import { createMemoryWorktreeInventory } from "./worktree-inventory-fixture.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Native fixtures live in the host temporary directory.
import { tmpdir } from "node:os";

const OID_LENGTH = 40;
const MUTATED_SLOT = 99;
const READ_FAILURE = 17;
const git = createLiveGitRunner();
const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"];

test(
	"worktree inventory shares ordered paths, flags, aliases and fresh observations " +
		"with native Git #test-679",
	// eslint-disable-next-line max-statements -- Keep native setup and freshness transitions visibly timed together.
	async () => {
		const tmp = await realpath(await mkdtemp(`${tmpdir()}/wktree-inventory-`));
		try {
			const root = `${tmp}/repo with spaces`;
			await git.run(["init", "--template=", "--initial-branch=main", root]);
			await git.run([
				"-C",
				root,
				...identity,
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--allow-empty",
				"-m",
				"initial",
			]);
			const resolved = await git.run(["-C", root, "rev-parse", "HEAD"]);
			const head = resolved.stdout.trim();
			const expected = await createLinkedInventory(root, tmp, head);
			const linked = `${root}__sibling`;
			const subdirectories = [`${root}/subdir`, `${linked}/subdir`];
			await Promise.all(subdirectories.map((path) => mkdir(path)));
			const aliases = [linked, ...subdirectories];
			const memory = createMemoryWorktreeInventory({
				repositories: [{ cwd: root, aliases, worktrees: expected }],
			});
			const live = createGitWorktreeInventory(git);
			await Promise.all(
				[live, memory].map((inventory) =>
					assertObservations(inventory, [root, ...aliases], expected),
				),
			);
			const earlier = await live.list(root);
			await git.run(["-C", root, "worktree", "unlock", `${tmp}/manual checkout`]);
			const changed = expected.map((worktree) => {
				if (worktree.path === `${tmp}/manual checkout`) {
					return { ...worktree, locked: false, lockReason: null };
				}
				return worktree;
			});
			memory.replace(linked, changed);
			await Promise.all(
				[live, memory].map((inventory) => assertObservations(inventory, [root], changed)),
			);
			expect(earlier).toEqual(expected);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	},
);

// eslint-disable-next-line max-statements -- Both native HEAD variants share setup-inclusive timing and assertions.
test("worktree inventory preserves bare and unborn HEAD representations #test-680", async () => {
	const tmp = await realpath(await mkdtemp(`${tmpdir()}/wktree-inventory-heads-`));
	try {
		const bare = `${tmp}/bare.git`;
		const unborn = `${tmp}/unborn`;
		await git.run(["init", "--template=", "--initial-branch=main", "--bare", bare]);
		await git.run(["init", "--template=", "--object-format=sha1", "--initial-branch=main", unborn]);
		const states = [
			{ cwd: bare, worktrees: [record(bare, null, null, { bare: true, canonical: true })] },
			{
				cwd: unborn,
				worktrees: [record(unborn, "0".repeat(OID_LENGTH), "main", { canonical: true })],
			},
		];
		const memory = createMemoryWorktreeInventory({ repositories: states });
		await Promise.all(
			[createGitWorktreeInventory(git), memory].flatMap((inventory) =>
				states.map((state) => assertObservations(inventory, [state.cwd], state.worktrees)),
			),
		);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});

test("worktree inventory rejects an actual non-repository and an unknown memory cwd #test-681", async () => {
	// oxlint-disable-next-line node/no-sync
	const tmp = mkdtempSync(`${tmpdir()}/wktree-inventory-invalid-`);
	try {
		await Promise.all(
			[createGitWorktreeInventory(git), createMemoryWorktreeInventory({ repositories: [] })].map(
				async (inventory) => {
					const failure: unknown = await inventory.list(tmp).catch((error: unknown) => error);
					expect(failure).toBeInstanceOf(GitError);
					expect(failure).toMatchObject({
						gitExitCode: 128,
						reason: "git_failed",
					});
				},
			),
		);
	} finally {
		// oxlint-disable-next-line node/no-sync
		rmSync(tmp, { recursive: true, force: true });
	}
});

// eslint-disable-next-line max-statements -- Follow seed, replacement, fault and recovery observations in order.
test("memory inventory isolates seeds, replacements, repositories and named failures", async () => {
	const seedSlot = record("/repo__feat1", "a".repeat(OID_LENGTH), "wk-pool/feat1", {
		pool: { index: 1, placeholder: true },
	});
	const seed = [seedSlot];
	const options = {
		repositories: [
			{ cwd: "/repo", aliases: ["/repo/subdir"], worktrees: seed },
			{ cwd: "/other", worktrees: seed },
		],
	};
	const inventory = createMemoryWorktreeInventory(options);
	const independent = createMemoryWorktreeInventory(options);
	const expected = structuredClone(seed);
	seedSlot.pool!.index = MUTATED_SLOT;
	seed.push(record("/injected", null, null));
	await assertObservations(inventory, ["/repo", "/repo/subdir", "/other"], expected);
	const replacementExpected = record("/changed__feat2", "b".repeat(OID_LENGTH), "topic", {
		pool: { index: 2, placeholder: false },
	});
	const replacementSlot = structuredClone(replacementExpected);
	const replacement = [replacementSlot];
	const earlier = await inventory.list("/repo");
	inventory.replace("/repo/subdir", replacement);
	replacementSlot.branch = "mutated";
	replacementSlot.pool!.index = MUTATED_SLOT;
	expect(await inventory.list("/repo")).toEqual([replacementExpected]);
	expect(earlier).toEqual(expected);
	await assertObservations(inventory, ["/other"], expected);
	await assertObservations(independent, ["/repo"], expected);
	const failure = new GitError(["worktree", "list"], "inventory read denied\n", READ_FAILURE);
	inventory.fail("/repo", failure);
	await expect(inventory.list("/repo/subdir")).rejects.toBe(failure);
	await expect(inventory.list("/repo")).rejects.toMatchObject({
		stderr: "inventory read denied\n",
		gitExitCode: 17,
	});
	await assertObservations(inventory, ["/other"], expected);
	inventory.recover("/repo/subdir");
	expect(await inventory.list("/repo")).toEqual([replacementExpected]);
});

// --- Native scenario setup and shared assertions ---

// eslint-disable-next-line max-statements -- Register path variants before applying native lock and prune states.
async function createLinkedInventory(root: string, tmp: string, head: string): Promise<Worktree[]> {
	const manual = `${tmp}/manual checkout`;
	const specifications = [
		{ path: manual, branch: null },
		{ path: `${root}/.wktree/feat3`, branch: "wk-pool/feat3" },
		{ path: `${root}/.worktrees/feat2`, branch: "feature/active" },
		{ path: `${root}__feat1`, branch: "wk-pool/feat1" },
		{ path: `${root}__prunable`, branch: "gone" },
		{ path: `${root}__sibling`, branch: "feature/sibling" },
	];
	for (const spec of specifications) {
		let checkout = ["--detach", spec.path];
		if (spec.branch !== null) {
			checkout = ["-b", spec.branch, spec.path];
		}
		// eslint-disable-next-line no-await-in-loop -- Native Git registry writes must be serialized.
		await git.run(["-C", root, "worktree", "add", "--no-checkout", ...checkout]);
	}
	await git.run([
		"-C",
		root,
		"worktree",
		"lock",
		"--reason",
		"held for review with spaces",
		manual,
	]);
	await git.run(["-C", root, "worktree", "lock", `${root}__sibling`]);
	await rm(`${root}__prunable`, { recursive: true });
	return [
		record(root, head, "main", { canonical: true }),
		record(`${tmp}/manual checkout`, head, null, {
			detached: true,
			locked: true,
			lockReason: "held for review with spaces",
		}),
		record(`${root}/.wktree/feat3`, head, "wk-pool/feat3", {
			pool: { index: 3, placeholder: true },
		}),
		record(`${root}/.worktrees/feat2`, head, "feature/active", {
			pool: { index: 2, placeholder: false },
		}),
		record(`${root}__feat1`, head, "wk-pool/feat1", { pool: { index: 1, placeholder: true } }),
		record(`${root}__prunable`, head, "gone", {
			prunable: true,
			prunableReason: "gitdir file points to non-existent location",
		}),
		record(`${root}__sibling`, head, "feature/sibling", { locked: true }),
	];
}

async function assertObservations(
	inventory: WorktreeInventory,
	aliases: readonly string[],
	expected: Worktree[],
): Promise<void> {
	await Promise.all(
		aliases.map(async (cwd) => {
			const observed = await inventory.list(cwd);
			expect(observed).toEqual(expected);
			observed.reverse();
			for (const worktree of observed) {
				worktree.path = "/caller-mutated";
				if (worktree.pool) {
					worktree.pool.index = MUTATED_SLOT;
					worktree.pool.placeholder = !worktree.pool.placeholder;
				}
			}
			expect(await inventory.list(cwd)).toEqual(expected);
		}),
	);
}

// eslint-disable-next-line max-params -- Keep record identity distinct from optional flag metadata.
function record(
	path: string,
	head: string | null,
	branch: string | null,
	overrides: Partial<Worktree> = {},
): Worktree {
	let branchRef = null;
	if (branch !== null) {
		branchRef = `refs/heads/${branch}`;
	}
	return {
		path,
		head,
		branch,
		branchRef,
		bare: false,
		canonical: false,
		detached: false,
		locked: false,
		lockReason: null,
		prunable: false,
		prunableReason: null,
		pool: null,
		...overrides,
	};
}
