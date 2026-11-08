import {
	ConfigError,
	EXIT_CODES,
	HookError,
	UnmergedBranchError,
	UsageError,
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
import { gitOut, gitSucceeds, runCli, useTmpHome } from "./lifecycle-helpers.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Real Git fixtures exercise filesystem boundaries.
import { join, resolve } from "node:path";
import type { CommandResult } from "../../src/index";
import { commitOnRemoteDefault } from "./remote-history.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Real Git fixtures exercise filesystem boundaries.
import { writeFile } from "node:fs/promises";

const tmp = useTmpHome("wktree-pool-add-offline-");
const { initRepoWithOrigin } = useOriginFixture();
const FAILURE = { hook: HookError, copy: ConfigError };

async function markerExists(slot: string) {
	return pathExists(
		resolve(slot, await gitOut(slot, "rev-parse", "--git-path", "wk-pool-initialized")),
	);
}

function addFlags(options: { noNetwork: boolean; skipCommand: boolean }) {
	const flags: string[] = [];
	if (options.noNetwork) {
		flags.push("--no-network");
	}
	if (options.skipCommand) {
		flags.push("--skip-command");
	}
	return flags;
}

function poolCommand(skip: boolean) {
	if (skip) {
		return "exit 7";
	}
	return 'test "$(cat .env)" = copied; test "$(git branch --show-current)" = feature/new; echo bootstrap-ran';
}

async function poolFixture(options: {
	noNetwork: boolean;
	skipCommand: boolean;
	state: "missing" | "cold" | "warm";
}) {
	const { root } = await initRepoWithOrigin(tmp.dir);
	await writeFile(join(root, ".env"), "copied\n");
	let precheck = `pre_remote_check = 'touch "$(git rev-parse --git-path precheck-ran)"'\n`;
	if (options.noNetwork) {
		precheck = 'pre_remote_check = "exit 9"\n';
		await run(["git", "-C", root, "remote", "set-url", "origin", join(tmp.dir, "absent.git")]);
	}
	writeConfig({
		command: poolCommand(options.skipCommand),
		copyToml: `${precheck}copy = [".env"]\n`,
		poolSize: 2,
		root,
		tmp: tmp.dir,
	});
	if (options.state !== "missing") {
		await createPoolSlot({
			root,
			index: 2,
			branch: "wk-pool/feat2",
			initialized: options.state === "warm",
		});
	}
	return root;
}

function addPool(root: string, flags: string[] = [], launcher = false): Promise<CommandResult> {
	const args = [
		"--cwd",
		root,
		"--branch",
		"feature/new",
		"--slot",
		`${root}__feat2`,
		"--json",
		...flags,
	];
	if (launcher) {
		return runCli(["add", ...args]);
	}
	return dispatch("add", args, testDeps());
}

function failureConfig(failure: string) {
	let config = 'pre_remote_check = "exit 9"\n';
	if (failure === "copy") {
		config += 'copy = ["absent.env"]\n';
	}
	return config;
}

async function rollbackFixture(exists: boolean, failure: string) {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({
		command: "exit 7",
		copyToml: failureConfig(failure),
		poolSize: 2,
		root,
		tmp: tmp.dir,
	});
	const trunk = await gitOut(root, "rev-parse", "main");
	if (exists) {
		await createPoolSlot({ root, index: 2, branch: "wk-pool/feat2", initialized: false });
	}
	await run(["git", "-C", root, "remote", "set-url", "origin", join(tmp.dir, "absent.git")]);
	return { root, trunk };
}

async function occupiedFixture() {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({
		command: "exit 7",
		poolSize: 1,
		copyToml: 'pre_remote_check = "exit 9"\n',
		root,
		tmp: tmp.dir,
	});
	await createPoolSlot({ root, index: 1, branch: "feature/old", initialized: false });
	await run(["git", "-C", root, "remote", "set-url", "origin", join(tmp.dir, "absent.git")]);
	return root;
}

async function missingResetFixture() {
	const root = await poolFixture({ noNetwork: true, skipCommand: true, state: "cold" });
	const tip = await gitOut(root, "rev-parse", "HEAD");
	await run(["git", "-C", root, "branch", "feature/new"]);
	await run(["git", "-C", root, "checkout", "-b", "other"]);
	await run(["git", "-C", root, "branch", "-D", "main"]);
	await run(["git", "-C", root, "update-ref", "-d", "refs/remotes/origin/main"]);
	return { root, tip };
}

async function expectFlagEffects(
	root: string,
	stdout: string,
	options: { noNetwork: boolean; skipCommand: boolean },
) {
	const payload = JSON.parse(stdout);
	expect(payload.kind).toBe("ready");
	expect(await gitOut(`${root}__feat2`, "branch", "--show-current")).toBe("feature/new");
	const bootstrapOutput = payload.setup_output.filter(
		(entry: { line: string }) => entry.line === "bootstrap-ran",
	);
	if (options.skipCommand) {
		expect(payload.setup_output).toEqual([]);
	} else {
		expect(bootstrapOutput).toEqual([{ line: "bootstrap-ran", stream: "stdout" }]);
	}
	const precheckPath = await gitOut(root, "rev-parse", "--git-path", "precheck-ran");
	expect(await pathExists(resolve(root, precheckPath))).toBe(!options.noNetwork);
}

test.each([
	{ noNetwork: true, skipCommand: false, state: "missing" },
	{ noNetwork: true, skipCommand: false, state: "warm" },
	{ noNetwork: false, skipCommand: true, state: "missing" },
	{ noNetwork: true, skipCommand: true, state: "cold" },
	{ noNetwork: true, skipCommand: true, state: "warm" },
] as const)(
	"pooled flags preserve copies and truthful marker (noNetwork=$noNetwork, " +
		"skipCommand=$skipCommand, state=$state) #test-103",
	async (options) => {
		const root = await poolFixture(options);
		const flags = addFlags(options);
		// Keep one real CLI composition with both flags; slot-state permutations need no extra Bun process.
		const result = await addPool(
			root,
			flags,
			options.noNetwork && options.skipCommand && options.state === "cold",
		);
		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		await expectFlagEffects(root, result.stdout ?? "{}", options);
		expect(await Bun.file(`${root}__feat2/.env`).text()).toBe("copied\n");
		expect(await markerExists(`${root}__feat2`)).toBe(
			!options.skipCommand || options.state === "warm",
		);
		expect(await pathExists(`${root}__feat1`)).toBe(false);
	},
);

test.each([
	{ exists: false, failure: "copy" },
	{ exists: true, failure: "copy" },
	{ exists: false, failure: "hook" },
	{ exists: true, failure: "hook" },
] as const)(
	"offline $failure failure rolls back the selected slot with no origin access (exists=$exists) #test-105",
	async ({ exists, failure }) => {
		const { root, trunk } = await rollbackFixture(exists, failure);
		const result = await addPool(root, ["--no-network"]);
		expect(result.failure).toBeInstanceOf(FAILURE[failure]);
		expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/new")).toBe(false);
		expect(await pathExists(`${root}__feat2`)).toBe(exists);
		if (exists) {
			expect(await gitOut(`${root}__feat2`, "branch", "--show-current")).toBe("wk-pool/feat2");
			expect(await gitOut(`${root}__feat2`, "rev-parse", "HEAD")).toBe(trunk);
			expect(await markerExists(`${root}__feat2`)).toBe(false);
		}
	},
);

test(
	"offline unmarked occupied slot is a full-pool candidate and retains safety " +
		"before forced recycle #test-101",
	async () => {
		const root = await occupiedFixture();
		const flags = [
			"--cwd",
			root,
			"--branch",
			"feature/new",
			"--no-network",
			"--skip-command",
			"--json",
		];
		const full = await dispatch("add", flags, testDeps());
		expect(JSON.parse(full.stdout ?? "{}")).toMatchObject({
			kind: "pool_full",
			candidates: [{ branch: "feature/old", slot: 1 }],
		});
		const unsafe = await dispatch("add", [...flags, "--slot", `${root}__feat1`], testDeps());
		expect(unsafe.failure).toBeInstanceOf(UnmergedBranchError);
		const recycled = await dispatch(
			"add",
			[...flags, "--slot", `${root}__feat1`, "--force"],
			testDeps(),
		);
		expect(recycled.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/old")).toBe(false);
		expect(await markerExists(`${root}__feat1`)).toBe(false);
	},
);

test("pooled offline add preserves refs on missing-default refusal and accepts --base-current #test-104", async () => {
	const { root, tip } = await missingResetFixture();
	const slot = `${root}__feat2`;
	const slotHead = await gitOut(slot, "rev-parse", "HEAD");
	const failure = await addPool(root, ["--no-network", "--skip-command"]);
	await assertResetRefusal({ result: failure, root, tip, slotHead });
	const success = await addPool(root, ["--no-network", "--skip-command", "--base-current"]);
	expect(success.exitCode).toBe(EXIT_CODES.SUCCESS);
	expect(JSON.parse(success.stdout ?? "{}")).toMatchObject({ kind: "ready" });
	expect(await gitOut(slot, "branch", "--show-current")).toBe("feature/new");
	expect(await gitOut(slot, "rev-parse", "HEAD")).toBe(tip);
});

async function assertResetRefusal(options: {
	result: Awaited<ReturnType<typeof dispatch>>;
	root: string;
	tip: string;
	slotHead: string;
}) {
	const { result, root, tip, slotHead } = options;
	const slot = `${root}__feat2`;
	expect(result.failure).toBeInstanceOf(UsageError);
	expect(result.exitCode).toBe(EXIT_CODES.USAGE);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({ ok: false, reason: "usage" });
	expect(JSON.parse(result.stdout ?? "{}").message).toContain("--base");
	expect(await gitOut(slot, "branch", "--show-current")).toBe("wk-pool/feat2");
	expect(await gitOut(slot, "rev-parse", "HEAD")).toBe(slotHead);
	expect(await gitOut(root, "rev-parse", "feature/new")).toBe(tip);
}

async function aheadPoolFixture(policy: string) {
	const { root, remote } = await initRepoWithOrigin(tmp.dir);
	const trunk = await gitOut(root, "rev-parse", "main");
	await commitOnRemoteDefault({ content: "ahead\n", message: "ahead", path: "ahead.txt", remote });
	await run(["git", "-C", root, "fetch", "origin"]);
	const cached = await gitOut(root, "rev-parse", "origin/main");
	await createPoolSlot({ root, index: 2, branch: "wk-pool/feat2", initialized: true });
	await run(["git", "-C", root, "remote", "set-url", "origin", join(tmp.dir, "absent.git")]);
	writeConfig({
		command: "exit 7",
		copyToml: `pre_remote_check = "exit 9"\n[project.add]\npolicy = "${policy}"\n`,
		poolSize: 2,
		root,
		tmp: tmp.dir,
	});
	return { root, trunk, cached };
}

async function existingCachedPoolFixture() {
	const fixture = await aheadPoolFixture("fresh_canonical");
	await run(["git", "-C", fixture.root, "branch", "feature/new", fixture.trunk]);
	await run([
		"git",
		"-C",
		fixture.root,
		"update-ref",
		"refs/remotes/origin/feature/new",
		fixture.cached,
	]);
	return fixture;
}

test(
	"offline pooled existing branch fast-forwards from cache " +
		"and setup rollback restores its original tip #test-100",
	async () => {
		const { root, trunk, cached } = await existingCachedPoolFixture();
		const failed = await addPool(root, ["--no-network"]);
		expect(failed.failure).toBeInstanceOf(HookError);
		expect(await gitOut(root, "rev-parse", "feature/new")).toBe(trunk);
		expect(await gitOut(`${root}__feat2`, "rev-parse", "HEAD")).toBe(cached);
		const success = await addPool(root, ["--no-network", "--skip-command"]);
		expect(success.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(await gitOut(root, "rev-parse", "feature/new")).toBe(cached);
		expect(await gitOut(root, "rev-parse", "main")).toBe(trunk);
	},
);

test("offline forced recycle and rollback prefer cached reset over an explicit older base #test-102", async () => {
	const { root, cached } = await aheadPoolFixture("origin_default");
	await run(["git", "-C", `${root}__feat2`, "checkout", "-b", "feature/old"]);
	const failed = await addPool(root, ["--no-network", "--base", "main", "--force"]);
	expect(failed.failure).toBeInstanceOf(HookError);
	expect(await gitOut(`${root}__feat2`, "branch", "--show-current")).toBe("wk-pool/feat2");
	expect(await gitOut(`${root}__feat2`, "rev-parse", "HEAD")).toBe(cached);
	expect(await gitSucceeds(root, "show-ref", "--verify", "refs/heads/feature/new")).toBe(false);
});
