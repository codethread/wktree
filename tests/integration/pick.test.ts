import { EXIT_CODES, dispatch } from "../../src/index";
import { afterEach, describe, expect, test } from "bun:test";
import {
	createTestCdDirective,
	createTestMultiplexer,
	createTestPicker,
	initRepo,
	restoreTestEnv,
	run,
	setTestEnv,
	testDeps,
} from "./support.ts";
/* oxlint-disable-next-line import/no-nodejs-modules -- pick fixtures create real repositories on disk */
import { mkdtemp, realpath, rm } from "node:fs/promises";
/* oxlint-disable-next-line import/no-nodejs-modules -- fixture paths are built with node:path */
import { join } from "node:path";
/* oxlint-disable-next-line import/no-nodejs-modules -- fixtures live in the host temporary directory */
import { tmpdir } from "node:os";

function pickDeps(choice: string | null, attached = true) {
	const picker = createTestPicker(choice, true);
	const multiplexer = createTestMultiplexer(attached);
	const cdDirective = createTestCdDirective();
	return {
		cdDirective,
		deps: testDeps({ cdDirective, multiplexer, picker }),
		multiplexer,
		picker,
	};
}

let tmp = "";
let root = "";
let featurePath = "";

async function initPickRepo() {
	tmp = await mkdtemp(join(tmpdir(), "wktree-pick-test-"));
	setTestEnv("HOME", tmp);
	setTestEnv("XDG_STATE_HOME", join(tmp, "state"));
	setTestEnv("GIT_CONFIG_NOSYSTEM", "1");
	setTestEnv("GIT_CONFIG_GLOBAL", join(tmp, "gitconfig"));
	setTestEnv("XDG_CONFIG_HOME", join(tmp, "config"));
	await initRepo(join(tmp, "repo"));
	root = await realpath(join(tmp, "repo"));
	featurePath = `${root}__feature`;
	await run(["git", "-C", root, "worktree", "add", "-b", "feature", featurePath]);
}

afterEach(async () => {
	restoreTestEnv();
	await rm(tmp, { force: true, recursive: true });
});

describe("wktree pick", () => {
	test("select writes the chosen path to the cd directive and prints it #test-286", async () => {
		await initPickRepo();
		const { deps, picker, multiplexer, cdDirective } = pickDeps(featurePath);

		const result = await dispatch("pick", ["--cwd", join(root, "."), "--interactive"], deps);

		expect(result).toEqual({ exitCode: EXIT_CODES.SUCCESS, stdout: `${featurePath}\n` });
		expect(cdDirective.paths).toEqual([featurePath]);
		expect(multiplexer.opened).toEqual([]);
		expect(picker.options).toEqual({ interactive: true });
		expect(picker.items).toEqual([
			{ display: `${root}\t* main`, key: root, preview: "test-preview" },
			{ display: `${featurePath}\t  feature`, key: featurePath, preview: "test-preview" },
		]);
	});
});
