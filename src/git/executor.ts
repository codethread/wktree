import type { GitResult, GitRunner } from "../services.ts";
import { EXIT_CODES } from "../errors.ts";
import { GitError } from "./error.ts";
// :module: Git command execution utilities for wktree

export function createLiveGitRunner(): GitRunner {
	return { run, runRaw };

	async function run(args: string[], opts: { cwd?: string } = {}): Promise<GitResult> {
		const result = await runRaw(args, opts);
		if (result.exitCode !== EXIT_CODES.SUCCESS) {
			throw new GitError(args, result.stderr, result.exitCode);
		}
		return result;
	}

	async function runRaw(args: string[], opts: { cwd?: string } = {}): Promise<GitResult> {
		// A neutral cwd keeps Git's -C flag meaningful after the original directory is deleted.
		// It also avoids accidental writes into $HOME.
		const proc = Bun.spawn(["git", ...args], {
			cwd: opts.cwd ?? "/",
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
}

/** Scope all Git reads and mutations in an offline operation to local objects. */
export function withoutLazyFetch(git: GitRunner): GitRunner {
	return {
		run: (args, opts) => git.run(["--no-lazy-fetch", ...args], opts),
		runRaw: (args, opts) => git.runRaw(["--no-lazy-fetch", ...args], opts),
	};
}

export { GitError } from "./error.ts";
