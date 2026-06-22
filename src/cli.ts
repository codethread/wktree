import {closeSync, openSync, readSync, writeFileSync} from "node:fs";
import {Command, CommanderError} from "commander";
import {EXIT_CODES, PickerCancelled, WktreeError} from "./errors.ts";
import {fzf} from "./fzf.ts";
import {LiveGitRunner} from "./git/executor.ts";
import {LiveHookRunner} from "./hooks.ts";
import {dispatch} from "./main.ts";
import type {Deps, PickerItem, PickerService, ProgressReporter} from "./types.ts";

export async function main(argv: string[] = Bun.argv, deps: Deps = createLiveDeps()): Promise<void> {
	const program = new Command();
	program
		.name("wktree")
		.description("Reusable git worktree pool manager")
		.configureOutput({
			writeOut: (str) => process.stderr.write(str),
			writeErr: (str) => process.stderr.write(str),
		})
		.exitOverride();

	program
		.command("root")
		.description("Print canonical worktree root")
		.requiredOption("--cwd <path>", "Path within git repository")
		.action(async (opts) => {
			await runAction("root", optsToArgs(opts), deps);
		});

	program
		.command("list")
		.description("List worktrees")
		.requiredOption("--cwd <path>", "Path within git repository")
		.option("--json", "Output as JSON")
		.action(async (opts) => {
			await runAction("list", optsToArgs(opts), deps);
		});

	program
		.command("path")
		.description("Print worktree path for branch")
		.requiredOption("--cwd <path>", "Path within git repository")
		.requiredOption("--branch <branch>", "Branch name")
		.action(async (opts) => {
			await runAction("path", optsToArgs(opts), deps);
		});

	program
		.command("add")
		.description("Add or allocate a worktree")
		.requiredOption("--cwd <path>", "Path within git repository")
		.requiredOption("--branch <branch>", "Branch name")
		.option("--json", "Machine-readable output")
		.option("--slot <path>", "Specific pool slot path")
		.option("--base <branch>", "Base branch for new branches")
		.option("--force", "Force operation")
		.action(async (opts) => {
			await runAction("add", optsToArgs(opts), deps);
		});

	program
		.command("remove")
		.description("Remove or recycle a worktree")
		.requiredOption("--cwd <path>", "Path within git repository")
		.option("--branch <branch>", "Branch to remove")
		.option("--self <path>", "Remove the worktree at this path")
		.option("--json", "Machine-readable output")
		.option("--force", "Force removal")
		.option("--keep-branch", "Remove/recycle worktree without deleting branch")
		.action(async (opts) => {
			await runAction("remove", optsToArgs(opts), deps);
		});

	program
		.command("ensure")
		.description("Materialise pooled worktree slots")
		.requiredOption("--cwd <path>", "Path within git repository")
		.action(async (opts) => {
			await runAction("ensure", optsToArgs(opts), deps);
		});

	program
		.command("status")
		.description("Print pool status JSON")
		.requiredOption("--cwd <path>", "Path within git repository")
		.action(async (opts) => {
			await runAction("status", optsToArgs(opts), deps);
		});

	program
		.command("recycle")
		.description("Recycle a pooled slot")
		.requiredOption("--cwd <path>", "Path within git repository")
		.requiredOption("--slot <path>", "Pool slot path")
		.option("--force", "Force recycle")
		.action(async (opts) => {
			await runAction("recycle", optsToArgs(opts), deps);
		});

	program
		.command("copy")
		.description("Re-run configured copy setup")
		.requiredOption("--cwd <path>", "Path within git repository")
		.option("--json", "Machine-readable output")
		.action(async (opts) => {
			await runAction("copy", optsToArgs(opts), deps);
		});

	program
		.command("config")
		.description("Inspect effective configuration")
		.command("explain")
		.description("Show effective policy for a repository")
		.requiredOption("--cwd <path>", "Path within git repository")
		.option("--json", "Machine-readable output")
		.action(async (opts) => {
			await runAction("config", ["explain", ...optsToArgs(opts)], deps);
		});

	try {
		await program.parseAsync(argv);
	} catch (error) {
		if (error instanceof CommanderError) {
			process.exit(error.exitCode === 0 ? 0 : EXIT_CODES.USAGE);
		}
		const exitCode = error instanceof WktreeError ? error.exitCode : EXIT_CODES.FAILURE;
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(exitCode);
	}
}

async function runAction(subcmd: string, args: string[], deps: Deps): Promise<void> {
	try {
		const result = await dispatch(subcmd, args, deps);
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exit(result.exitCode);
	} catch (error) {
		if (error instanceof WktreeError) {
			process.stderr.write(`${error.message}\n`);
			process.exit(error.exitCode);
		}
		throw error;
	}
}

function optsToArgs(opts: Record<string, unknown>): string[] {
	const args: string[] = [];
	for (const [key, value] of Object.entries(opts)) {
		const flag = key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
		if (value === true) args.push(`--${flag}`);
		else if (value !== false && value !== undefined && value !== null) args.push(`--${flag}`, String(value));
	}
	return args;
}

export function createLiveDeps(): Deps {
	return {
		git: new LiveGitRunner(),
		hooks: new LiveHookRunner(),
		picker: new LivePickerService(),
		progress: new ConsoleProgressReporter(),
	};
}

class LivePickerService implements PickerService {
	async pick(items: PickerItem[], header: string): Promise<PickerItem> {
		const byDisplay = new Map(items.map((item) => [item.display, item]));
		const selection = await fzf(
			items.map((item) => item.display),
			{header, preview: items[0]?.preview, withNth: "2..", tty: true},
		);
		const item = byDisplay.get(selection.trim());
		if (!item) throw new PickerCancelled();
		return item;
	}

	async confirm(prompt: string): Promise<boolean> {
		const tty = openSync("/dev/tty", "r+");
		try {
			writeFileSync(tty, prompt);
			const answer = Buffer.alloc(1);
			readSync(tty, answer, 0, 1, null);
			writeFileSync(tty, "\n");
			return answer.toString() === "y" || answer.toString() === "Y";
		} finally {
			closeSync(tty);
		}
	}
}

class ConsoleProgressReporter implements ProgressReporter {
	banner(line: string): void {
		process.stderr.write(`${line}\n`);
	}

	stream(stream: "stdout" | "stderr", line: string): void {
		const target = stream === "stdout" ? process.stdout : process.stderr;
		target.write(`${line}\n`);
	}

	error(msg: string): void {
		process.stderr.write(`${msg}\n`);
	}
}
