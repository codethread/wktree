/** Result of one external command. */
export interface CommandResult {
	/** Captured standard output. */
	stdout: string;
	/** Captured diagnostics. */
	stderr: string;
	/** Process exit status. */
	exitCode: number;
}

/** Process boundary for multiplexer commands. */
export interface CommandRunner {
	/** Run a command and return its exit status and captured output. */
	run: (command: string, args: string[]) => Promise<CommandResult>;
}

export function createLiveCommandRunner(): CommandRunner {
	return { run };

	async function run(command: string, args: string[]): Promise<CommandResult> {
		// A stable neutral cwd keeps cleanup commands working after a worktree removes the process's original directory.
		const proc = Bun.spawn([command, ...args], {
			cwd: "/",
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
