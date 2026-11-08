import { WktreeError } from "../errors.ts";

/** A Git invocation that exited unsuccessfully. */
export class GitError extends WktreeError {
	override readonly reason = "git_failed";
	override name = "GitError";
	args: string[];
	stderr: string;
	gitExitCode: number;
	constructor(args: string[], stderr: string, gitExitCode: number) {
		super(`git ${args.join(" ")} failed: ${stderr.trim()}`);
		this.args = args;
		this.stderr = stderr;
		this.gitExitCode = gitExitCode;
	}
}
