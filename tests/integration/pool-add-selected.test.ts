import {
	ConfigError,
	DirtySlotError,
	EXIT_CODES,
	HookError,
	UnmergedBranchError,
	dispatch,
} from "../../src/index";
import {
	createPoolSlot,
	pathExists,
	run,
	testDeps,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
import { expect, test } from "bun:test";
import { gitOut, gitSucceeds, gitText, useTmpHome } from "./lifecycle-helpers.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { join, resolve } from "node:path";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { readFile, rm, writeFile } from "node:fs/promises";
import type { Slot } from "../../src/domain/worktree.ts";
import { createRemoteBranch } from "./remote-history.ts";
import { worktreePathForName } from "../../src/domain/worktree.ts";

const tmp = useTmpHome("wktree-pool-add-selected-test-");
const { initRepoWithOrigin } = useOriginFixture();
const SETUP_BRANCH = 'git branch --show-current >> "$(git rev-parse --git-path setup-branches)"';
const FAILURE_CONFIG = { copy: 'copy = ["missing.env"]\n', hook: "" };
const FAILURE_CLASS = { copy: ConfigError, hook: HookError };
const SAFETY_FAILURE = { dirty: DirtySlotError, clean: UnmergedBranchError };

interface FixtureSlot {
	index: number;
	branch: string;
	initialized: boolean;
	state: "clean" | "dirty" | "missing" | "unreadable";
}

async function metadataPath(slotPath: string, name: string) {
	return resolve(slotPath, await gitOut(slotPath, "rev-parse", "--git-path", name));
}

async function poolSlots(root: string): Promise<Slot[]> {
	const result = await dispatch("status", ["--cwd", root], testDeps());
	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	return JSON.parse(result.stdout ?? "{}").slots;
}

async function fixtureSlot(root: string, slot: FixtureSlot) {
	await createPoolSlot({
		branch: slot.branch,
		index: slot.index,
		initialized: slot.initialized,
		root,
	});
	const slotPath = `${root}__feat${slot.index}`;
	if (slot.state === "missing") {
		await rm(slotPath, { recursive: true });
		return;
	}
	if (slot.state === "dirty" || slot.state === "unreadable") {
		await writeFile(join(slotPath, "local.txt"), "preserve\n");
	}
	if (slot.state === "unreadable") {
		await writeFile(await metadataPath(slotPath, "index"), "broken index\n");
	}
}

async function fixtureSlots(root: string, slots: FixtureSlot[]) {
	for (const slot of slots) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- Real Git worktree mutations must run sequentially.
		await fixtureSlot(root, slot);
	}
}

async function coldPool(exists: boolean) {
	const { root } = await initRepoWithOrigin(tmp.dir);
	await writeFile(join(root, ".env"), "copied\n");
	writeConfig({
		command: `${SETUP_BRANCH}; test "$(cat .env)" = copied`,
		copyToml: 'copy = [".env"]\n',
		poolSize: 5,
		root,
		tmp: tmp.dir,
	});
	await fixtureSlots(root, [
		{ branch: "feature/occupied", index: 1, initialized: false, state: "clean" },
		{ branch: "wk-pool/feat2", index: 2, initialized: false, state: "dirty" },
		{ branch: "wk-pool/feat3", index: 3, initialized: false, state: "missing" },
	]);
	if (exists) {
		await fixtureSlot(root, {
			branch: "wk-pool/feat4",
			index: 4,
			initialized: false,
			state: "clean",
		});
	}
	return root;
}

async function rollbackPool(options: {
	exists: boolean;
	existingBranch: boolean;
	failure: "copy" | "hook";
}) {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	writeConfig({
		command: "touch partial-setup; exit 7",
		copyToml: FAILURE_CONFIG[options.failure],
		poolSize: 3,
		root,
		tmp: tmp.dir,
	});
	if (options.existingBranch) {
		await createRemoteBranch(remote, "feature/failure");
		await run(["git", "-C", root, "branch", "feature/failure"]);
	}
	const originalHead = await gitOut(root, "rev-parse", "HEAD");
	await fixtureSlot(root, {
		branch: "feature/untouched",
		index: 1,
		initialized: false,
		state: "dirty",
	});
	if (options.exists) {
		await fixtureSlot(root, {
			branch: "wk-pool/feat2",
			index: 2,
			initialized: false,
			state: "clean",
		});
	}
	return { originalHead, root };
}

async function expectRolledBackSlot(root: string, exists: boolean) {
	const [untouched, selected, missing] = await poolSlots(root);
	expect(untouched).toMatchObject({ branch: "feature/untouched", initialized: false, dirty: true });
	expect(missing).toMatchObject({ exists: false });
	if (exists) {
		expect(selected).toMatchObject({ branch: "wk-pool/feat2", initialized: false, dirty: false });
		return;
	}
	expect(selected).toMatchObject({ exists: false });
	expect(await pathExists(`${root}__feat2`)).toBe(false);
}

test("prefers an initialized free slot without preparing unrelated cold, dirty or broken slots #test-112", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: SETUP_BRANCH, poolSize: 5, root, tmp: tmp.dir });
	await fixtureSlots(root, [
		{ branch: "wk-pool/feat1", index: 1, initialized: false, state: "clean" },
		{ branch: "feature/broken", index: 2, initialized: false, state: "missing" },
		{ branch: "wk-pool/feat3", index: 3, initialized: true, state: "clean" },
		{ branch: "wk-pool/feat4", index: 4, initialized: false, state: "dirty" },
	]);
	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/selected", "--json"],
		testDeps(),
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(JSON.parse(result.stdout ?? "{}").worktree_path).toBe(`${root}__feat3`);
	expect(await poolSlots(root)).toMatchObject([
		{ branch: "wk-pool/feat1", initialized: false },
		{ branch: "feature/broken", initialized: false, dirty: true },
		{ branch: "feature/selected", initialized: true },
		{ branch: "wk-pool/feat4", initialized: false, dirty: true },
		{ exists: false },
	]);
	expect(await readFile(join(`${root}__feat4`, "local.txt"), "utf8")).toBe("preserve\n");
	expect(await pathExists(`${root}__feat2`)).toBe(false);
	expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/wk-pool/feat5")).toBe(false);
});

test.each([{ exists: false }, { exists: true }])(
	"prepares only one available cold slot (exists=$exists) and bootstraps once on the target branch #test-113",
	async ({ exists }) => {
		const root = await coldPool(exists);
		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/cold", "--json"],
			testDeps(),
		);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}").worktree_path).toBe(`${root}__feat4`);
		expect(await readFile(await metadataPath(`${root}__feat4`, "setup-branches"), "utf8")).toBe(
			"feature/cold\n",
		);
		expect(await poolSlots(root)).toMatchObject([
			{ branch: "feature/occupied", initialized: false },
			{ branch: "wk-pool/feat2", initialized: false, dirty: true },
			{ branch: "wk-pool/feat3", initialized: false, dirty: true },
			{ branch: "feature/cold", initialized: true },
			{ exists: false },
		]);
		expect(await readFile(join(`${root}__feat2`, "local.txt"), "utf8")).toBe("preserve\n");
		expect(await pathExists(`${root}__feat3`)).toBe(false);
	},
);

test.each([{ location: "sibling" }, { location: "nested" }] as const)(
	"explicit --slot creates only the selected missing configured $location slot #test-116",
	async ({ location }) => {
		const { root } = await initRepoWithOrigin(tmp.dir);
		writeConfig({
			command: SETUP_BRANCH,
			copyToml: `worktree_location = "${location}"\n`,
			poolSize: 3,
			root,
			tmp: tmp.dir,
		});
		const slotPath = worktreePathForName(root, "feat3", location);
		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/explicit", "--slot", slotPath, "--json"],
			testDeps(),
		);

		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}").worktree_path).toBe(slotPath);
		expect(await poolSlots(root)).toMatchObject([
			{ exists: false },
			{ exists: false },
			{ initialized: true },
		]);
		const invalid = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/invalid", "--slot", `${root}__feat99`, "--json"],
			testDeps(),
		);
		expect(invalid.exitCode).toBe(EXIT_CODES.USAGE);
		expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/invalid")).toBe(
			false,
		);
	},
);

test.each([
	{ state: "dirty", branch: "feature/occupied", initialized: false },
	{ state: "clean", branch: "feature/occupied", initialized: false },
	{ state: "dirty", branch: "wk-pool/feat1", initialized: true },
] as const)(
	"explicit $branch remains protected (state=$state, initialized=$initialized) #test-118",
	async ({ state, branch, initialized }) => {
		const { root } = await initRepoWithOrigin(tmp.dir);
		writeConfig({ command: "touch should-not-run", poolSize: 2, root, tmp: tmp.dir });
		await fixtureSlot(root, { branch, index: 1, initialized, state });
		const before = await gitText(`${root}__feat1`, "status", "--porcelain");
		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/unsafe", "--slot", `${root}__feat1`, "--json"],
			testDeps(),
		);

		expect(result.failure).toBeInstanceOf(SAFETY_FAILURE[state]);
		expect(await poolSlots(root)).toMatchObject([
			{
				branch,
				initialized,
				exists: true,
				placeholder: branch === "wk-pool/feat1",
				dirty: state === "dirty",
				path: `${root}__feat1`,
			},
			{ exists: false },
		]);
		expect(await gitText(`${root}__feat1`, "status", "--porcelain")).toBe(before);
	},
);

test.each([{ state: "dirty" }, { state: "unreadable" }] as const)(
	"automatic allocation skips unsafe initialized placeholders and preserves their work (state=$state) #test-117",
	async ({ state }) => {
		const { root } = await initRepoWithOrigin(tmp.dir);
		writeConfig({ command: "exit 7", poolSize: 2, root, tmp: tmp.dir });
		await fixtureSlot(root, { branch: "wk-pool/feat1", index: 1, initialized: true, state });
		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/failure", "--json"],
			testDeps(),
		);

		expect(result.failure).toBeInstanceOf(HookError);
		expect(await readFile(join(`${root}__feat1`, "local.txt"), "utf8")).toBe("preserve\n");
		expect(await poolSlots(root)).toMatchObject([
			{ branch: "wk-pool/feat1", initialized: true, dirty: true },
			{ exists: false },
		]);
		expect(await pathExists(`${root}__feat2`)).toBe(false);
		if (state === "unreadable") {
			expect(await readFile(await metadataPath(`${root}__feat1`, "index"), "utf8")).toBe(
				"broken index\n",
			);
		}
	},
);

test.each([
	{ exists: false, existingBranch: false, failure: "hook" },
	{ exists: false, existingBranch: true, failure: "copy" },
	{ exists: true, existingBranch: false, failure: "copy" },
	{ exists: true, existingBranch: true, failure: "hook" },
] as const)(
	"$failure failure rolls back only the selected cold slot (exists=$exists, existingBranch=$existingBranch) #test-114",
	async (options) => {
		const { originalHead, root } = await rollbackPool(options);
		const result = await dispatch(
			"add",
			["--cwd", root, "--branch", "feature/failure", "--slot", `${root}__feat2`, "--json"],
			testDeps(),
		);

		expect(result.failure).toBeInstanceOf(FAILURE_CLASS[options.failure]);
		await expectRolledBackSlot(root, options.exists);
		expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/failure")).toBe(
			options.existingBranch,
		);
		if (options.existingBranch) {
			expect(await gitOut(root, "rev-parse", "refs/heads/feature/failure")).toBe(originalHead);
		}
		expect(await readFile(join(`${root}__feat1`, "local.txt"), "utf8")).toBe("preserve\n");
	},
);

test("a fully occupied uninitialized pool reports pool_full without running setup #test-119", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "exit 7", poolSize: 1, root, tmp: tmp.dir });
	await fixtureSlot(root, {
		branch: "feature/occupied",
		index: 1,
		initialized: false,
		state: "clean",
	});
	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/full", "--force", "--json"],
		testDeps(),
	);

	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({ kind: "pool_full" });
	expect(await poolSlots(root)).toMatchObject([{ branch: "feature/occupied", initialized: false }]);
});

test("explicit force recycles only the selected cold occupied slot before target-branch setup #test-115", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({
		command: `test "$(git branch --show-current)" = feature/forced; ${SETUP_BRANCH}`,
		poolSize: 3,
		root,
		tmp: tmp.dir,
	});
	await fixtureSlot(root, { branch: "feature/old", index: 2, initialized: false, state: "dirty" });
	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/forced", "--slot", `${root}__feat2`, "--force", "--json"],
		testDeps(),
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(await poolSlots(root)).toMatchObject([
		{ exists: false },
		{ branch: "feature/forced", initialized: true, dirty: false },
		{ exists: false },
	]);
	expect(await pathExists(join(`${root}__feat2`, "local.txt"))).toBe(false);
	expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/old")).toBe(false);
	expect(await readFile(await metadataPath(`${root}__feat2`, "setup-branches"), "utf8")).toBe(
		"feature/forced\n",
	);
});
