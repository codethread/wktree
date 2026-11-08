import { ConfigError, EXIT_CODES, HookError, dispatch } from "../../src/index";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	createPoolSlot,
	pathExists,
	restoreTestEnv,
	run,
	setTestEnv,
	testDeps,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { join, resolve } from "node:path";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { tmpdir } from "node:os";

const { initRepoWithOrigin } = useOriginFixture();

const SINGLE_SLOT = 1;
const TWO_SLOTS = 2;
const THREE_SLOTS = 3;
const SLOT = { first: 1, second: 2 };

let tmp = "";

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "wktree-ensure-test-"));
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

async function poolMarker(slotPath: string) {
	const result = await run([
		"git",
		"-C",
		slotPath,
		"rev-parse",
		"--git-path",
		"wk-pool-initialized",
	]);
	return resolve(slotPath, result.stdout.trim());
}

function assertHookOrder(events: string[]) {
	const [firstEvent] = events;
	expect(firstEvent).toBe("[wk-pool] initializing feat1…");
	expect(events.some((event) => event.includes("__feat1"))).toBe(true);
	expect(events.indexOf("[wk-pool] initializing feat1…")).toBeLessThan(
		events.indexOf("[wk-pool] initializing feat2…"),
	);
}

test("materialises slots sequentially and streams hook output #test-159", async () => {
	const { root } = await initRepoWithOrigin(tmp);
	writeConfig({ command: "echo hook-$WK_CREATED; touch sentinel", poolSize: TWO_SLOTS, root, tmp });
	const events: string[] = [];
	const liveDeps = testDeps({
		progress: {
			banner: (line: string) => {
				events.push(line);
			},
			error: () => {},
			stream: (_stream: "stdout" | "stderr", line: string) => {
				events.push(line);
			},
		},
	});

	await dispatch("ensure", ["--cwd", root], liveDeps);

	assertHookOrder(events);
	expect(await pathExists(join(`${root}__feat1`, "sentinel"))).toBe(true);
	expect(await pathExists(join(`${root}__feat2`, "sentinel"))).toBe(true);
});

test("copies files before pooled ensure hooks run #test-161", async () => {
	const { root } = await initRepoWithOrigin(tmp);
	await writeFile(join(root, ".env"), "ensure-copy\n");
	writeConfig({
		command: 'cat .env > "$WK_CREATED/hook-read-env"',
		copyToml: 'copy = [".env"]\n',
		poolSize: TWO_SLOTS,
		root,
		tmp,
	});

	await dispatch("ensure", ["--cwd", root], testDeps());

	expect(await readFile(join(`${root}__feat1`, "hook-read-env"), "utf8")).toBe("ensure-copy\n");
	expect(await readFile(join(`${root}__feat2`, "hook-read-env"), "utf8")).toBe("ensure-copy\n");
	const status = await run(["git", "-C", `${root}__feat1`, "status", "--porcelain", "--", ".env"]);
	expect(status.stdout).toBe("");
});

test("hook failure rolls back only in-flight slot and rerun recovers #test-157", async () => {
	const { root } = await initRepoWithOrigin(tmp);
	writeConfig({
		command:
			'case "$WK_CREATED" in *__feat2) if [ ! -f "$WK_ROOT/recover" ]; then exit 7; fi;; esac; touch sentinel',
		poolSize: THREE_SLOTS,
		root,
		tmp,
	});

	const { failure } = await dispatch("ensure", ["--cwd", root], testDeps());
	expect(failure).toBeInstanceOf(HookError);
	expect(await pathExists(`${root}__feat1`)).toBe(true);
	expect(await pathExists(`${root}__feat2`)).toBe(false);
	expect(await pathExists(`${root}__feat3`)).toBe(false);

	await writeFile(join(root, "recover"), "ok\n");
	await dispatch("ensure", ["--cwd", root], testDeps());
	expect(await pathExists(join(`${root}__feat3`, "sentinel"))).toBe(true);
});

async function initHalfSlot() {
	const { root } = await initRepoWithOrigin(tmp);
	writeConfig({ command: "echo rerun >> hook.log", poolSize: SINGLE_SLOT, root, tmp });
	await createPoolSlot({ branch: "wk-pool/feat1", index: SLOT.first, initialized: false, root });
	return root;
}

test("half-init reruns hook and preserves existing slot on failure #test-158", async () => {
	const root = await initHalfSlot();

	await dispatch("ensure", ["--cwd", root], testDeps());

	expect(await readFile(join(`${root}__feat1`, "hook.log"), "utf8")).toContain("rerun");
	expect(await pathExists(await poolMarker(`${root}__feat1`))).toBe(true);

	writeConfig({ command: "exit 9", poolSize: TWO_SLOTS, root, tmp });
	await createPoolSlot({ branch: "wk-pool/feat2", index: SLOT.second, initialized: false, root });
	const { failure } = await dispatch("ensure", ["--cwd", root], testDeps());
	expect(failure).toBeInstanceOf(HookError);
	expect(await pathExists(`${root}__feat2`)).toBe(true);
});

test("copy failure rolls back newly-created pooled slots #test-162", async () => {
	const { root } = await initRepoWithOrigin(tmp);
	writeConfig({
		command: "touch should-not-run",
		copyToml: 'copy = [".env.missing"]\n',
		poolSize: SINGLE_SLOT,
		root,
		tmp,
	});

	const { failure } = await dispatch("ensure", ["--cwd", root], testDeps());
	expect(failure).toBeInstanceOf(ConfigError);

	expect(await pathExists(`${root}__feat1`)).toBe(false);
});

test("copy failure preserves existing half-initialized pooled slots #test-160", async () => {
	const { root } = await initRepoWithOrigin(tmp);
	writeConfig({
		command: "touch should-not-run",
		copyToml: 'copy = [".env.missing"]\n',
		poolSize: TWO_SLOTS,
		root,
		tmp,
	});
	await createPoolSlot({ branch: "wk-pool/feat1", index: SLOT.first, initialized: true, root });
	await createPoolSlot({ branch: "wk-pool/feat2", index: SLOT.second, initialized: false, root });

	const { failure } = await dispatch("ensure", ["--cwd", root], testDeps());
	expect(failure).toBeInstanceOf(ConfigError);

	expect(await pathExists(`${root}__feat2`)).toBe(true);
	expect(await pathExists(join(`${root}__feat2`, "should-not-run"))).toBe(false);
	expect(await pathExists(await poolMarker(`${root}__feat2`))).toBe(false);
});

test("add initializes an absent pool and captures setup output in JSON #test-163", async () => {
	const { root } = await initRepoWithOrigin(tmp);
	writeConfig({ command: "echo setup-output", poolSize: SINGLE_SLOT, root, tmp });

	const result = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/first", "--json"],
		testDeps(),
	);

	expect(result.stderr).toBeUndefined();
	const payload = JSON.parse(result.stdout ?? "{}");
	expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(payload).toMatchObject({
		branch: "feature/first",
		kind: "ready",
		ok: true,
		worktree_path: `${root}__feat1`,
	});
	expect(await pathExists(await poolMarker(`${root}__feat1`))).toBe(true);
	expect(payload.diagnostics).toMatchInlineSnapshot(`
	  [
	    "[wk-pool] initializing feat1…",
	  ]
	`);
	expect(payload.setup_output).toContainEqual({ line: "setup-output", stream: "stdout" });
});
