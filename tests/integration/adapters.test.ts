import { EXIT_CODES, HookError } from "../../src/errors.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { closeSync, openSync, writeSync } from "node:fs";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createLiveGitRunner } from "../../src/git/executor.ts";
import { createLiveHookRunner } from "../../src/hooks.ts";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { join } from "node:path";
import { testDeps } from "./support.ts";
// Integration fixtures exercise real filesystem and process boundaries.
// oxlint-disable-next-line import/no-nodejs-modules
import { tmpdir } from "node:os";

const HOOK_FAILURE_CODE = 7;
const EXECUTABLE_MODE = 0o755;

async function createHandshake(tmp: string) {
	const fifo = join(tmp, "response");
	const mkfifo = Bun.spawn(["mkfifo", fifo], { stderr: "pipe", stdout: "pipe" });
	expect(await mkfifo.exited).toBe(EXIT_CODES.SUCCESS);
	const script = join(tmp, "hook.sh");
	// A response from the first-line callback is required for the hook to finish.
	// Opening both ends avoids blocking on FIFO open; read's deadline bounds a regression.
	await writeFile(
		script,
		'exec 3<> "$RESPONSE_FIFO"\necho first\nIFS= read -r -t 2 -u 3 response || exit 8\necho "$response"\n',
	);
	return { fifo, script };
}

describe("LiveHookRunner", () => {
	let tmp = "";

	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "wktree-hook-test-"));
	});

	afterEach(async () => {
		await rm(tmp, { force: true, recursive: true });
	});

	test("streams output while the hook waits for a response #test-305", async () => {
		const { fifo, script } = await createHandshake(tmp);
		// The synchronous streaming callback must answer the waiting FIFO immediately.
		// oxlint-disable-next-line node/no-sync
		const response = openSync(fifo, "r+");
		try {
			const seen: string[] = [];
			await createLiveHookRunner().runInline(script, {
				cwd: tmp,
				env: { RESPONSE_FIFO: fifo },
				onLine: (stream, line) => {
					seen.push(`${stream}:${line}`);
					if (line === "first") {
						// oxlint-disable-next-line node/no-sync -- Reply inside the synchronous line callback to unblock the child.
						writeSync(response, "second\n");
					}
				},
			});
			expect(seen).toEqual(["stdout:first", "stdout:second"]);
		} finally {
			// oxlint-disable-next-line node/no-sync -- Close the descriptor acquired for the synchronous FIFO handshake.
			closeSync(response);
		}
	});

	test("throws HookError with exit code and slot path on failure #test-306", async () => {
		const script = join(tmp, "hook.sh");
		await writeFile(script, "echo bad >&2\nexit 7\n", { mode: EXECUTABLE_MODE });
		const runner = createLiveHookRunner();

		try {
			await runner.runInline(script, { cwd: tmp, env: {}, onLine: () => {} });
			throw new Error("expected hook to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(HookError);
			expect((error as HookError).hookExitCode).toBe(HOOK_FAILURE_CODE);
			expect((error as HookError).slotPath).toBe(tmp);
		}
	});
});

test("dependency helper pairs an overridden Git runner with its inventory", async () => {
	const calls: string[][] = [];
	const run = (args: string[]) => {
		calls.push(args);
		return Promise.resolve({
			exitCode: EXIT_CODES.SUCCESS,
			stdout: "worktree /fixture\nbare\n",
			stderr: "",
		});
	};
	const git = { run, runRaw: run };
	const deps = testDeps({ git });
	expect(deps.git).toBe(git);
	expect(await deps.worktrees.list("/fixture")).toMatchObject([
		{ path: "/fixture", canonical: true, bare: true },
	]);
	expect(calls).toEqual([["-C", "/fixture", "worktree", "list", "--porcelain"]]);
});

describe("createLiveGitRunner", () => {
	test("runs git --version #test-307", async () => {
		const git = createLiveGitRunner();
		const result = await git.run(["--version"]);
		expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(result.stdout).toContain("git version");
	});

	test("runs git even when the process cwd was removed #test-304", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wktree-git-cwd-test-"));
		const executor = new URL("../../src/git/executor.ts", import.meta.url).href;
		try {
			const child = Bun.spawn(
				[
					"bun",
					"-e",
					`
    import { mkdirSync, rmSync } from "node:fs";
    import { createLiveGitRunner } from ${JSON.stringify(executor)};
    const doomed = ${JSON.stringify(join(directory, "deleted-worktree"))};
    mkdirSync(doomed);
    process.chdir(doomed);
    rmSync(doomed, { recursive: true });
    const result = await createLiveGitRunner().run(["--version"]);
    process.stdout.write(result.stdout);
   `,
				],
				{ stderr: "pipe", stdout: "pipe" },
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exitCode, stderr, stdout }).toEqual({
				exitCode: 0,
				stderr: "",
				stdout: expect.stringContaining("git version"),
			});
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});

describe("LiveCommandRunner", () => {
	test("runs a command from a neutral cwd when the process cwd was removed #test-303", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wktree-multiplexer-cwd-test-"));
		const runner = new URL("../../src/integrations/tmux.ts", import.meta.url).href;
		try {
			const child = Bun.spawn(
				[
					"bun",
					"-e",
					`
    import { mkdirSync, rmSync } from "node:fs";
    import { createLiveCommandRunner } from ${JSON.stringify(runner)};
    const doomed = ${JSON.stringify(join(directory, "deleted-worktree"))};
    mkdirSync(doomed);
    process.chdir(doomed);
    rmSync(doomed, { recursive: true });
    const result = await createLiveCommandRunner().run("pwd", []);
    process.stdout.write(result.stdout);
   `,
				],
				{ stderr: "pipe", stdout: "pipe" },
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exitCode, stderr, stdout }).toEqual({
				exitCode: 0,
				stderr: "",
				stdout: "/\n",
			});
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
