import { ConfigError, HookError, ReservedPrefixError, dispatch } from "../../src/index";
import {
	createPoolSlot,
	pathExists,
	run,
	setTestEnv,
	testDeps,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
import { expect, test } from "bun:test";
import { gitOut, gitSucceeds, gitText, useTmpHome } from "./lifecycle-helpers.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { join, resolve } from "node:path";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRemoteBranch } from "./remote-history.ts";

const SINGLE_SLOT = 1;

const tmp = useTmpHome("wktree-pool-add-test-");
const { initRepoWithOrigin } = useOriginFixture();

async function prepareLegacyPool() {
	const { root } = await initRepoWithOrigin(tmp.dir);
	const configHome = join(tmp.dir, "config-mixed-pool");
	await mkdir(configHome, { recursive: true });
	setTestEnv("XDG_CONFIG_HOME", configHome);
	await writeFile(
		join(configHome, "wktree.toml"),
		`[[project]]\nroot = "${root}"\ncommand = "echo ready"\npool_size = 1\n`,
	);
	await createPoolSlot({
		branch: "feature/legacy-pool",
		index: SINGLE_SLOT,
		initialized: true,
		root,
	});

	return { configHome, root };
}

async function prepareMixedPool() {
	const { root, configHome } = await prepareLegacyPool();

	await writeFile(
		join(configHome, "wktree.toml"),
		`worktree_location = "sibling"\n` +
			`\n` +
			`[[project]]\n` +
			`root = "${root}"\n` +
			`command = "echo ready"\n` +
			`pool_size = 2\n` +
			`worktree_location = "nested"\n`,
	);
	const nestedSlot = join(root, ".worktrees", "feat2");
	await dispatch("ensure", ["--cwd", root], testDeps());

	return { legacySlot: `${root}__feat1`, nestedSlot, root };
}

test("keeps legacy pool slots and creates only missing slots in the preferred location #test-107", async () => {
	const { root, legacySlot, nestedSlot } = await prepareMixedPool();
	const status = await dispatch("status", ["--cwd", root], testDeps());

	expect(
		JSON.parse(status.stdout ?? "{}").slots.map((slot: { path: string }) => slot.path),
	).toEqual([legacySlot, nestedSlot]);
	const path = await dispatch(
		"path",
		["--cwd", root, "--branch", "feature/legacy-pool"],
		testDeps(),
	);
	expect(path.stdout).toBe(`${legacySlot}\n`);
	expect(await pathExists(nestedSlot)).toBe(true);
	expect(await gitText(root, "status", "--porcelain")).toBe("");

	const removed = await dispatch(
		"remove",
		["--cwd", root, "--branch", "feature/legacy-pool", "--keep-branch", "--json"],
		testDeps(),
	);
	expect(JSON.parse(removed.stdout ?? "{}")).toMatchObject({
		removed: false,
		worktree_path: legacySlot,
	});
	expect(await gitOut(legacySlot, "branch", "--show-current")).toBe("wk-pool/feat1");
});
test("copies into allocated slot after checkout and before setup #test-108", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	await writeFile(join(root, ".env"), "pooled\n");
	writeConfig({
		command: 'cat .env > "$(git rev-parse --git-path allocated-read)"',
		copyToml: 'copy = [".env"]\n',
		poolSize: SINGLE_SLOT,
		root,
		tmp: tmp.dir,
	});
	await createPoolSlot({ branch: "wk-pool/feat1", index: SINGLE_SLOT, initialized: true, root });

	await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/allocated-copy", "--json"],
		testDeps(),
	);

	expect(await readFile(join(`${root}__feat1`, ".env"), "utf8")).toBe("pooled\n");
	expect(await gitOut(`${root}__feat1`, "branch", "--show-current")).toBe("feature/allocated-copy");
	const allocatedReadPath = await gitOut(
		`${root}__feat1`,
		"rev-parse",
		"--git-path",
		"allocated-read",
	);
	expect(await readFile(resolve(`${root}__feat1`, allocatedReadPath), "utf8")).toBe("pooled\n");
});
test("setup failure during allocation restores an existing branch tip #test-110", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	await run(["git", "-C", root, "branch", "feature/pool-setup-restore"]);
	const originalHead = await gitOut(root, "rev-parse", "refs/heads/feature/pool-setup-restore");
	writeConfig({ command: "exit 7", poolSize: SINGLE_SLOT, root, tmp: tmp.dir });
	await createPoolSlot({ branch: "wk-pool/feat1", index: SINGLE_SLOT, initialized: true, root });

	const { failure } = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/pool-setup-restore", "--json"],
		testDeps(),
	);
	expect(failure).toBeInstanceOf(HookError);

	expect(await gitOut(`${root}__feat1`, "branch", "--show-current")).toBe("wk-pool/feat1");
	expect(await gitOut(root, "rev-parse", "refs/heads/feature/pool-setup-restore")).toBe(
		originalHead,
	);
});
test("copy setup failure during allocation restores the slot placeholder #test-109", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	await createPoolSlot({ branch: "wk-pool/feat1", index: SINGLE_SLOT, initialized: true, root });
	writeConfig({
		command: "echo should-not-run",
		copyToml: 'copy = [".env.missing"]\n',
		poolSize: SINGLE_SLOT,
		root,
		tmp: tmp.dir,
	});

	const { failure } = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/allocated-copy-fail", "--json"],
		testDeps(),
	);
	expect(failure).toBeInstanceOf(ConfigError);

	expect(await gitOut(`${root}__feat1`, "branch", "--show-current")).toBe("wk-pool/feat1");
	expect(
		await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/allocated-copy-fail"),
	).toBe(false);
});
test.each([
	{ branch: "feature/remote-pool", name: "existing remote-only", source: "remote" },
	{ branch: "feature/local-pool", name: "existing local", source: "local" },
])("allocates $name branch #test-106", async ({ branch, source }) => {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	if (source === "remote") {
		await createRemoteBranch(remote, branch);
	}
	if (source === "local") {
		await run(["git", "-C", root, "branch", branch]);
	}
	writeConfig({ command: "echo ready", poolSize: SINGLE_SLOT, root, tmp: tmp.dir });

	await dispatch("add", ["--cwd", root, "--branch", branch, "--json"], testDeps());

	expect(await gitOut(`${root}__feat1`, "branch", "--show-current")).toBe(branch);
});
test("rejects duplicate canonical branch and reserved branch before allocation #test-111", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", poolSize: SINGLE_SLOT, root, tmp: tmp.dir });

	const duplicate = await dispatch(
		"add",
		["--cwd", root, "--branch", "main", "--json"],
		testDeps(),
	);
	expect(JSON.parse(duplicate.stdout ?? "{}")).toMatchObject({
		kind: "blocked",
		message: expect.stringContaining(root),
		reason: "duplicate_branch",
	});
	const { failure } = await dispatch(
		"add",
		["--cwd", root, "--branch", "wk-pool/feat9", "--json"],
		testDeps(),
	);
	expect(failure).toBeInstanceOf(ReservedPrefixError);
	expect(await pathExists(`${root}__feat1`)).toBe(false);
});
