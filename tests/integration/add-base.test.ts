import { EXIT_CODES, UsageError, dispatch } from "../../src/index";
import {
	commitFile,
	createWorktree,
	deps,
	pathExists,
	run,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
import { expect, test } from "bun:test";
import { gitText, useTmpHome } from "./lifecycle-helpers.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { join } from "node:path";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { mkdir } from "node:fs/promises";

const tmp = useTmpHome("wktree-add-base-test-");
const { initRepoWithOrigin } = useOriginFixture();

test("--base-current stacks a new branch on the worktree containing cwd #test-121", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });
	const parentPath = `${root}__feature--parent`;
	await createWorktree({ root, branch: "feature/parent", path: parentPath });
	await commitFile({
		content: "parent\n",
		message: "parent work",
		path: "parent.txt",
		repo: parentPath,
	});
	const nestedCwd = join(parentPath, "nested");
	await mkdir(nestedCwd, { recursive: true });

	const result = await dispatch(
		"add",
		["--cwd", nestedCwd, "--branch", "feature/child", "--base-current", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(await gitText(`${root}__feature--child`, "show", "HEAD:parent.txt")).toBe("parent\n");
});
test("--base-current from canonical root stacks on the canonical branch #test-122", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });
	await commitFile({
		content: "canonical\n",
		message: "canonical work",
		path: "canonical.txt",
		repo: root,
	});

	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/from-canonical", "--base-current", "--json"],
		deps,
	);

	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(await gitText(`${root}__feature--from-canonical`, "show", "HEAD:canonical.txt")).toBe(
		"canonical\n",
	);
});
test("--base-current refuses a detached worktree #test-123", async () => {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", root, tmp: tmp.dir });
	const worktreePath = `${root}__feature--detached`;
	await createWorktree({ root, branch: "feature/detached", path: worktreePath });
	await run(["git", "-C", worktreePath, "checkout", "--detach"]);

	const { failure } = await dispatch(
		"add",
		["--cwd", worktreePath, "--branch", "feature/stacked", "--base-current", "--json"],
		deps,
	);
	expect(failure).toBeInstanceOf(UsageError);
	expect(await pathExists(`${root}__feature--stacked`)).toBe(false);
});
test("--base-current is refused together with --base #test-124", async () => {
	// Request parsing must refuse this combination before any repository or config IO.
	const root = "/unused";

	const { failure } = await dispatch(
		"add",
		[
			"--cwd",
			root,
			"--branch",
			"feature/conflicting-base",
			"--base-current",
			"--base",
			"main",
			"--json",
		],
		deps,
	);
	expect(failure).toBeInstanceOf(UsageError);
});
