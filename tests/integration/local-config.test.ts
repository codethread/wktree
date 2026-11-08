import { expect, test } from "bun:test";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures use real filesystem boundaries.
import { readFile, writeFile } from "node:fs/promises";
import { runCli, useTmpHome } from "./lifecycle-helpers.ts";
import { EXIT_CODES } from "../../src/errors.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Fixture paths stay within temporary repositories.
import { join } from "node:path";
import { useOriginFixture } from "./support.ts";

const tmp = useTmpHome("wktree-local-config-");
const { initRepoWithOrigin } = useOriginFixture();
const CANONICAL_WORKTREE_COUNT = 1;

test("local-only configuration initializes a pool with real Bun bootstrap #test-69", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	await writeFile(
		join(root, ".wktree.toml"),
		'command = "bun --version > bun-version.txt"\npool_size = 1\nworktree_location = "nested"',
	);
	const ensured = await runCli(["ensure"], root);
	expect(ensured).toMatchObject({ exitCode: EXIT_CODES.SUCCESS });
	const slot = join(root, ".worktrees", "feat1");
	const version = await readFile(join(slot, "bun-version.txt"), "utf8");
	expect(version.trim()).toBe(Bun.version);
	await assertPoolState(root, slot);
});

async function assertPoolState(root: string, slot: string) {
	const status = await runCli(["status"], slot);
	expect(JSON.parse(status.stdout)).toMatchObject({
		hasPool: true,
		size: 1,
		slots: [{ initialized: true, path: slot }],
	});
	const explained = await runCli(["config", "explain", "--json"], slot);
	expect(JSON.parse(explained.stdout)).toMatchObject({
		command: { source: `local:${root}/.wktree.toml` },
		// oxlint-disable-next-line unicorn/no-null -- Local-only settings must not invent a global exact-project source.
		project: null,
		setup: { pool_size: 1 },
	});
}

test("malformed local TOML is rejected before registering a worktree #test-283", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	await writeFile(join(root, ".wktree.toml"), "command =");
	const result = await runCli(["add", "--branch", "feature/invalid", "--json"], root);
	expect(result).toMatchObject({ exitCode: EXIT_CODES.USAGE, stderr: "" });
	expect(JSON.parse(result.stdout)).toMatchObject({
		message: expect.stringContaining(`${root}/.wktree.toml`),
		ok: false,
		reason: "config",
	});
	const listed = await runCli(["list", "--json"], root);
	expect(JSON.parse(listed.stdout).worktrees).toHaveLength(CANONICAL_WORKTREE_COUNT);
});
