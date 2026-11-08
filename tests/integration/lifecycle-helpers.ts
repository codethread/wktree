import { afterEach, beforeEach } from "bun:test";
/* oxlint-disable-next-line import/no-nodejs-modules -- Integration tests drive real filesystem and git IO under Bun. */
import { join, resolve } from "node:path";
/* oxlint-disable-next-line import/no-nodejs-modules -- Integration tests drive real filesystem and git IO under Bun. */
import { mkdtemp, rm } from "node:fs/promises";
import { restoreTestEnv, run, runRaw, setTestEnv } from "./support.ts";
import { EXIT_CODES } from "../../src/index";
/* oxlint-disable-next-line import/no-nodejs-modules -- Integration tests drive real filesystem and git IO under Bun. */
import { tmpdir } from "node:os";

/** Registers the shared temp-home environment for a test file; `dir` is set before each test. */
export function useTmpHome(prefix: string) {
	const state = { dir: "" };
	beforeEach(async () => {
		state.dir = await mkdtemp(join(tmpdir(), prefix));
		setTestEnv("HOME", state.dir);
		setTestEnv("XDG_STATE_HOME", join(state.dir, "state"));
		setTestEnv("GIT_CONFIG_NOSYSTEM", "1");
		setTestEnv("GIT_CONFIG_GLOBAL", join(state.dir, "gitconfig"));
		setTestEnv("XDG_CONFIG_HOME", join(state.dir, "config"));
	});
	afterEach(async () => {
		restoreTestEnv();
		await rm(state.dir, { force: true, recursive: true });
	});
	return state;
}

export async function gitOut(repo: string, ...args: string[]): Promise<string> {
	const result = await run(["git", "-C", repo, ...args]);
	return result.stdout.trim();
}

export async function gitSucceeds(repo: string, ...args: string[]): Promise<boolean> {
	const result = await runRaw(["git", "-C", repo, ...args]);
	return result.exitCode === EXIT_CODES.SUCCESS;
}

export async function runCli(args: string[], cwd = process.cwd()) {
	const proc = Bun.spawn(["bun", resolve(import.meta.dirname, "../../bin/wktree.ts"), ...args], {
		cwd,
		env: process.env,
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stderr, stdout };
}

export async function gitText(repo: string, ...args: string[]): Promise<string> {
	const result = await run(["git", "-C", repo, ...args]);
	return result.stdout;
}
