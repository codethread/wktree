export class TmuxError extends Error {
	args: string[];
	stderr: string;
	tmuxExitCode: number;
	constructor(args: string[], stderr: string, tmuxExitCode: number) {
		super(`tmux ${args.join(" ")} failed: ${stderr.trim()}`);
		this.args = args;
		this.stderr = stderr;
		this.tmuxExitCode = tmuxExitCode;
		this.name = "TmuxError";
	}
}
