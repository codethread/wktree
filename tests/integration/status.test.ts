import { EXIT_CODES, buildPoolState, dispatch } from "../../src/index";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	createPoolSlot,
	deps,
	restoreTestEnv,
	run,
	setTestEnv,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { join } from "node:path";
import { parseWorktreeList } from "../../src/git/worktrees.ts";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { tmpdir } from "node:os";

const { initRepoWithOrigin } = useOriginFixture();

const SINGLE_SLOT = 1;
const TWO_SLOTS = 2;
const FOUR_SLOTS = 4;
const SLOT = { first: 1, fourth: 4, second: 2, third: 3 };

let tmp = "";

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "wktree-status-test-"));
	setTestEnv("HOME", tmp);
	setTestEnv("XDG_STATE_HOME", join(tmp, "state"));
	setTestEnv("GIT_CONFIG_NOSYSTEM", "1");
	setTestEnv("GIT_CONFIG_GLOBAL", join(tmp, "gitconfig"));
	setTestEnv("XDG_CONFIG_HOME", join(tmp, "config"));
});

afterEach(async () => {
	restoreTestEnv();
	await rm(tmp, { force: true, recursive: true });
});

test("reports absent slots for an empty pool #test-276", async () => {
	const { root } = await initRepoWithOrigin(tmp);
	writeConfig({ command: "echo ready", poolSize: TWO_SLOTS, root, tmp });
	const listed = await run(["git", "-C", root, "worktree", "list", "--porcelain"]);
	const worktrees = parseWorktreeList(listed.stdout);

	const state = await buildPoolState({
		deps,
		project: {
			command: "echo ready",
			copy: [],
			copyModeDefault: "copy",
			name: "repo",
			poolSize: 2,
			root,
		},
		worktrees,
	});

	expect(state).toMatchObject({ hasPool: true, root, size: 2, trunk: "main" });
	expect(
		state.slots.map((slot) => ({ exists: slot.exists, initialized: slot.initialized })),
	).toEqual([
		{ exists: false, initialized: false },
		{ exists: false, initialized: false },
	]);
});

async function initMixedPool() {
	const { root } = await initRepoWithOrigin(tmp);
	writeConfig({ command: "echo ready", poolSize: FOUR_SLOTS, root, tmp });
	await createPoolSlot({ branch: "wk-pool/feat1", index: SLOT.first, initialized: true, root });
	await createPoolSlot({ branch: "feature/taken", index: SLOT.second, initialized: true, root });
	await createPoolSlot({ branch: "feature/dirty", index: SLOT.third, initialized: true, root });
	await writeFile(join(`${root}__feat3`, "dirty.txt"), "dirty\n");
	await createPoolSlot({ branch: "wk-pool/feat4", index: SLOT.fourth, initialized: false, root });
	return root;
}

function assertPoolIdentity(
	state: { root: string; trunk: string; hasPool: boolean },
	root: string,
) {
	expect(state.root).toBe(root);
	expect(state.trunk).toBe("main");
	expect(state.hasPool).toBe(true);
}

function assertCommitMetadata(slot: { lastCommitIso: string; lastCommitSubject: string }) {
	expect(slot.lastCommitIso).toContain("T");
	expect(slot.lastCommitSubject).toBe("initial");
}

test("status JSON reports free, taken, dirty, and half-initialized slots #test-274", async () => {
	const root = await initMixedPool();

	const result = await dispatch("status", ["--cwd", root], deps);
	const state = JSON.parse(result.stdout ?? "{}");

	assertPoolIdentity(state, root);
	const [free, taken, dirty, halfInitialized] = state.slots;
	expect(free).toMatchObject({
		branch: "wk-pool/feat1",
		dirty: false,
		exists: true,
		index: 1,
		initialized: true,
		placeholder: true,
	});
	expect(taken).toMatchObject({
		branch: "feature/taken",
		dirty: false,
		exists: true,
		index: 2,
		initialized: true,
		placeholder: false,
	});
	expect(dirty).toMatchObject({
		branch: "feature/dirty",
		dirty: true,
		exists: true,
		index: 3,
		initialized: true,
	});
	expect(halfInitialized).toMatchObject({
		exists: true,
		index: 4,
		initialized: false,
		placeholder: true,
	});
	assertCommitMetadata(free);
});

test("blocks when sibling and legacy nested worktrees claim the same pool slot #test-277", async () => {
	const { root } = await initRepoWithOrigin(tmp);
	writeConfig({ command: "echo ready", poolSize: SINGLE_SLOT, root, tmp });
	await createPoolSlot({ branch: "wk-pool/feat1", index: SLOT.first, initialized: true, root });
	const nestedSlot = join(root, ".wktree", "feat1");
	await run(["git", "-C", root, "worktree", "add", "-b", "feature/colliding-slot", nestedSlot]);

	const result = await dispatch("status", ["--cwd", root], deps);

	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		message: expect.stringContaining("multiple worktrees claim pool slot feat1"),
		reason: "blocked",
	});
});

async function initIgnoredSlot() {
	const { root } = await initRepoWithOrigin(tmp);
	writeConfig({ command: "echo ready", poolSize: SINGLE_SLOT, root, tmp });
	await createPoolSlot({ branch: "wk-pool/feat1", index: SLOT.first, initialized: true, root });
	const exclude = await run(["git", "-C", root, "rev-parse", "--git-path", "info/exclude"]);
	await writeFile(join(root, exclude.stdout.trim()), "node_modules/\n");
	await mkdir(join(`${root}__feat1`, "node_modules"));
	await writeFile(join(`${root}__feat1`, "node_modules", "ignored.txt"), "ignored\n");
	return root;
}

test("gitignored files do not mark a slot dirty and non-pooled status is empty #test-275", async () => {
	const root = await initIgnoredSlot();

	const pooledResult = await dispatch("status", ["--cwd", root], deps);
	const pooled = JSON.parse(pooledResult.stdout ?? "{}");
	const [slot] = pooled.slots;
	expect(slot.dirty).toBe(false);

	writeConfig({ command: "echo ready", root, tmp });
	const nonPooledResult = await dispatch("status", ["--cwd", root], deps);
	const nonPooled = JSON.parse(nonPooledResult.stdout ?? "{}");
	expect(nonPooled).toEqual({
		diagnostics: [],
		hasPool: false,
		kind: "status",
		ok: true,
		root,
		setup_output: [],
		size: 0,
		slots: [],
		// oxlint-disable-next-line unicorn/no-null -- Non-pooled status has an explicit-null trunk in the JSON protocol.
		trunk: null,
	});
});
