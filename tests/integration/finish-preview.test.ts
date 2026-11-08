import { EXIT_CODES, dispatch } from "../../src/index";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { chmod, readFile, writeFile } from "node:fs/promises";
import {
	commitFile,
	createWorktree,
	deps,
	pathExists,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
import { expect, test } from "bun:test";
import { finishArgs, finishPolicy, readCheckoutState, readFinishState } from "./finish-helpers.ts";
import { gitOut, gitSucceeds, useTmpHome } from "./lifecycle-helpers.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Integration fixtures exercise real filesystem IO.
import { join } from "node:path";

const tmp = useTmpHome("wktree-finish-preview-test-");
const { initRepoWithOrigin } = useOriginFixture();
const EXECUTABLE_MODE = 0o755;

test.each([
	{ key: "branch.main.mergeOptions", value: "-s resolve", strategy: "squash" },
	{ key: "pull.twohead", value: "resolve", strategy: "merge_commit" },
])(
	"$strategy refuses unpreviewable $key before mutation #test-95",
	async ({ key, value, strategy }) => {
		const fixture = await prepareRenameConflict(key, value, strategy);
		const before = await readFinishState(fixture);
		const result = await dispatch("finish", finishArgs(fixture.worktreePath, strategy), deps);
		expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
			reason: "blocked",
			integrated: false,
			cleanup_actions: [],
			message: expect.stringContaining(key.toLowerCase()),
		});
		expect(await readFinishState(fixture)).toEqual(before);
	},
);

test.each([
	{ strategy: "squash", attribute: "absent.json" },
	{ strategy: "merge_commit", attribute: "absent.json" },
	{ strategy: "squash", attribute: "README.md" },
	{ strategy: "merge_commit", attribute: "README.md" },
])(
	"$strategy permits a configured driver unused by the merge ($attribute) #test-96",
	async ({ strategy, attribute }) => {
		const fixture = await prepareSource(strategy);
		await commitFile({
			content: "source content\n",
			message: "source edit",
			path: "README.md",
			repo: fixture.worktreePath,
		});
		const marker = await installStatefulDriver(fixture.root, attribute);
		const driver = await gitOut(fixture.root, "config", "merge.stateful.driver");
		const result = await dispatch("finish", finishArgs(fixture.worktreePath, strategy), deps);
		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({ ok: true, kind: "ready", strategy });
		expect(await readFile(join(fixture.root, "README.md"), "utf8")).toBe("source content\n");
		expect(await pathExists(marker)).toBe(false);
		expect(await gitOut(fixture.root, "config", "merge.stateful.driver")).toBe(driver);
	},
);

test("needed external merge drivers block preview without executing their commands #test-98", async () => {
	const fixture = await prepareDriverConflict();
	const before = await readFinishState(fixture);
	const sourceBefore = await readCheckoutState(fixture.worktreePath);
	const result = await dispatch("finish", finishArgs(fixture.worktreePath, "squash"), deps);
	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		reason: "blocked",
		integrated: false,
		cleanup_actions: [],
		message: expect.stringContaining("external merge driver"),
	});
	expect(await pathExists(fixture.marker)).toBe(false);
	expect(await readFinishState(fixture)).toEqual(before);
	expect(await readCheckoutState(fixture.worktreePath)).toEqual(sourceBefore);
});

test("recursive merge-base drivers cannot escape the preview refusal #test-97", async () => {
	const fixture = await prepareRecursiveDriverConflict();
	const before = await readFinishState(fixture);
	const sourceBefore = await readCheckoutState(fixture.worktreePath);
	const result = await dispatch("finish", finishArgs(fixture.worktreePath, "squash"), deps);
	expect(result.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(await pathExists(fixture.marker)).toBe(false);
	expect(await readFinishState(fixture)).toEqual(before);
	expect(await readCheckoutState(fixture.worktreePath)).toEqual(sourceBefore);
});

// --- Private functions ---

async function prepareSource(strategy: string, fresh = false) {
	const { remote, root } = await initRepoWithOrigin(tmp.dir);
	const worktreePath = await addSource(root, strategy, fresh);
	return { branch: "feature/preview", remote, root, worktreePath };
}

async function addSource(root: string, strategy: string, fresh = false): Promise<string> {
	writeConfig({
		command: "echo ready",
		root,
		tmp: tmp.dir,
		copyToml: finishPolicy(strategy, fresh, true),
	});
	await createWorktree({ root, branch: "feature/preview", path: `${root}__feature--preview` });
	return `${root}__feature--preview`;
}

async function prepareRenameConflict(key: string, value: string, strategy: string) {
	const fixture = await prepareSource(strategy);
	await gitOut(fixture.worktreePath, "mv", "README.md", "renamed.md");
	await gitOut(fixture.worktreePath, "commit", "-m", "rename source file");
	await commitFile({
		content: "target edit\n",
		message: "edit target file",
		path: "README.md",
		repo: fixture.root,
	});
	await gitOut(fixture.root, "config", key, value);
	expect(
		await gitSucceeds(fixture.root, "merge-tree", "--write-tree", "main", fixture.branch),
	).toBe(true);
	return fixture;
}

async function prepareDriverConflict() {
	const fixture = await prepareSource("squash");
	await commitFile({
		content: "source\n",
		message: "source edit",
		path: "README.md",
		repo: fixture.worktreePath,
	});
	await commitFile({
		content: "target\n",
		message: "target edit",
		path: "README.md",
		repo: fixture.root,
	});
	const marker = await installStatefulDriver(fixture.root);
	return { ...fixture, marker };
}

// eslint-disable-next-line max-statements -- Build both virtual-base resolutions as one Git history fixture.
async function prepareRecursiveDriverConflict() {
	const fixture = await prepareSource("squash");
	await commitFile({ content: "left\n", message: "left", path: "README.md", repo: fixture.root });
	const left = await gitOut(fixture.root, "rev-parse", "HEAD");
	await commitFile({
		content: "right\n",
		message: "right",
		path: "README.md",
		repo: fixture.worktreePath,
	});
	const right = await gitOut(fixture.worktreePath, "rev-parse", "HEAD");
	const leftTree = await gitOut(fixture.root, "rev-parse", `${left}^{tree}`);
	const rightTree = await gitOut(fixture.root, "rev-parse", `${right}^{tree}`);
	// Opposite resolutions of the same two parents require a recursive virtual merge base.
	const target = await gitOut(
		fixture.root,
		"commit-tree",
		leftTree,
		"-p",
		left,
		"-p",
		right,
		"-m",
		"target",
	);
	const source = await gitOut(
		fixture.root,
		"commit-tree",
		rightTree,
		"-p",
		right,
		"-p",
		left,
		"-m",
		"source",
	);
	await gitOut(fixture.root, "reset", "--hard", target);
	await gitOut(fixture.worktreePath, "reset", "--hard", source);
	const marker = await installStatefulDriver(fixture.root);
	await gitOut(fixture.root, "config", "merge.stateful.recursive", "helper");
	const driver = await gitOut(fixture.root, "config", "merge.stateful.driver");
	await gitOut(fixture.root, "config", "merge.helper.driver", driver);
	return { ...fixture, marker };
}

async function installStatefulDriver(root: string, attribute = "README.md"): Promise<string> {
	const marker = join(tmp.dir, "driver-ran");
	const driver = join(tmp.dir, "merge-driver");
	await writeFile(
		driver,
		`#!/bin/sh\nif test -e "${marker}"; then exit 1; fi\ntouch "${marker}"\nprintf 'resolved\\n' > "$1"\n`,
	);
	await chmod(driver, EXECUTABLE_MODE);
	await writeFile(join(root, ".git", "info", "attributes"), `${attribute} merge=stateful\n`);
	await gitOut(root, "config", "merge.stateful.driver", `${driver} %A`);
	return marker;
}
