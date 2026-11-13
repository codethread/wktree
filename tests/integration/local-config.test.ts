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

test("repository-local command config bootstraps an ordinary worktree", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	const command = "bun --version > bun-version.txt";
	await writeFile(join(root, ".wktree.toml"), `command = "${command}"`);

	const added = await runCli(["add", "--branch", "feature/local-config", "--json"], root);
	expect(added).toMatchObject({ exitCode: EXIT_CODES.SUCCESS });
	const worktreePath = JSON.parse(added.stdout).worktree_path;
	expect(await readFile(join(worktreePath, "bun-version.txt"), "utf8")).toBe(`${Bun.version}\n`);

	const explained = await runCli(["config", "explain", "--json"], worktreePath);
	expect(JSON.parse(explained.stdout)).toMatchObject({
		command: { source: `local:${root}/.wktree.toml`, value: command },
	});
});

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
