/* eslint-disable import/max-dependencies -- Compose local commands and shared changelog contract. */
import { Command, CommanderError } from "commander";
import { EXIT_CODES, UsageError } from "./errors.ts";
import {
	changelogHistorySchema,
	changelogQuerySchema,
	changelogSchema,
	queryChangelog,
	renderChangelog,
} from "./changelog.ts";
import { formatFailure, renderJsonResult } from "./protocol.ts";
import type { CommandResult } from "./protocol.ts";
import type { Deps } from "./services.ts";
import { HELP } from "./cli-help.ts";
import changelog from "../changelog.json";
import { createLiveDeps } from "./live-deps.ts";
import { dispatch } from "./main.ts";
import tab from "@bomb.sh/tab/commander";
import { version } from "../package.json";

const registrations = [
	registerRoot,
	registerList,
	registerTree,
	registerPath,
	registerAdd,
	registerRemove,
	registerEnsure,
	registerStatus,
	registerCopy,
	registerFinish,
	registerIntegrate,
	registerPick,
	registerShellInit,
	registerConfig,
	registerSkills,
];

export async function main(
	argv: string[] = Bun.argv,
	deps: Deps = createLiveDeps(),
): Promise<void> {
	// Commander may reject arguments before dispatch can format them.
	const json = argv.includes("--json");
	const program = createProgram(json);
	for (const register of registrations) {
		register(program, deps);
	}
	configureCompletion(program);
	await parseProgram(program, argv, json);
}
// --- Private functions ---

function createProgram(json: boolean): Command {
	const program = new Command();
	program
		.name("wktree")
		.version(version)
		.summary("Manage git worktrees deterministically")
		.description(
			"Deterministic git worktree lifecycle engine for humans, agents, shells, and tmux wrappers.",
		)
		.option(
			"--cwd <path>",
			"Path inside the worktree set to operate on; defaults to the current directory",
			process.cwd(),
		)
		.option(
			"--interactive",
			"Human wrapper mode: add opens the worktree's multiplexer session; remove and finish leave and close it",
		)
		.configureOutput({
			writeErr: (str) => {
				if (!json) {
					process.stderr.write(str);
				}
			},
			writeOut: (str) => process.stdout.write(str),
		})
		.addHelpText("after", HELP.overview)
		.exitOverride();

	program
		.command("changelog")
		.description(
			"Read embedded history offline; defaults to the latest recorded release at or below this executable version",
		)
		.summary("Read offline release history")
		.option("--since <version>", "Releases newer than this stable version (exclusive)")
		.option("--release <version>", "Read one exact recorded release; cannot combine with --since")
		.option("--limit <count>", "Changes per page (1–100, default 20)")
		.option("--offset <count>", "Skip matching changes (default 0)")
		.option("--schema", "Print the successful JSON response schema")
		.option("--json", "Emit one JSON document with silent stderr")
		// eslint-disable-next-line max-statements -- Own schema discovery, query output and argument errors together.
		.action(function changelogCommand(this: Command) {
			const options = this.optsWithGlobals();
			if (options["schema"] === true) {
				process.stdout.write(
					`${JSON.stringify({ ok: true, kind: "changelog_schema", schema: changelogSchema() })}\n`,
				);
				return;
			}
			try {
				const page = queryChangelog(
					{ tool: "wktree", version },
					changelogHistorySchema.parse(changelog),
					changelogQuerySchema.parse(options),
				);
				let output = renderChangelog(page);
				if (options["json"] === true) {
					output = `${JSON.stringify(page)}\n`;
				}
				process.stdout.write(output);
			} catch (error) {
				program.error(String(error), {
					code: "commander.invalidArgument",
					exitCode: EXIT_CODES.USAGE,
				});
			}
		});
	return program;
}

function registerRoot(program: Command, deps: Deps): void {
	program
		.command("root")
		.summary("Print canonical root")
		.description(
			"Print the protected canonical/root worktree for the repository containing --cwd (or the " +
				"current directory by default).",
		)
		.addHelpText("after", HELP.root)
		.action((_opts, command) => runAction("root", optsToArgs(command.optsWithGlobals()), deps));
}

function registerList(program: Command, deps: Deps): void {
	program
		.command("list")
		.summary("List worktrees")
		.description(
			"List every git worktree known to the repository, including canonical and pooled slots.",
		)
		.option("--json", "Output as JSON")
		.addHelpText("after", HELP.list)
		.action((_opts, command) => runAction("list", optsToArgs(command.optsWithGlobals()), deps));
}

function registerTree(program: Command, deps: Deps): void {
	program
		.command("tree")
		.summary("Show worktree ancestry")
		.description("Render registered worktrees as a tree inferred from current Git commit ancestry.")
		.option("--json", "Output as JSON")
		.addHelpText("after", HELP.tree)
		.action((_opts, command) => runAction("tree", optsToArgs(command.optsWithGlobals()), deps));
}

function registerPath(program: Command, deps: Deps): void {
	program
		.command("path")
		.summary("Resolve branch path")
		.description(
			"Print the deterministic worktree path for a branch in the repository containing --cwd (or the " +
				"current directory by default).",
		)
		.requiredOption("--branch <branch>", "Branch name")
		.addHelpText("after", HELP.path)
		.action((_opts, command) => runAction("path", optsToArgs(command.optsWithGlobals()), deps));
}

function registerAdd(program: Command, deps: Deps): void {
	program
		.command("add")
		.summary("Create or allocate worktree")
		.description(
			"Create a regular worktree or allocate a pooled slot for a branch, applying add policy and setup.",
		)
		.requiredOption("--branch <branch>", "Branch name")
		.option("--json", "Machine-readable output")
		.option("--slot <path>", "Specific configured pool slot path, including a missing slot")
		.option("--base <ref>", "Base ref for new branches")
		.option("--base-current", "Use the branch checked out in the worktree containing --cwd")
		.option(
			"--no-network",
			"Use cached/local refs with normal policy; skip remote checks and fetch",
		)
		.option("--skip-command", "Skip configured bootstrap; retain copy setup and safety checks")
		.option("--force", "Force operation")
		.addHelpText("after", HELP.add)
		.action((_opts, command) => runAction("add", optsToArgs(command.optsWithGlobals()), deps));
}

function registerRemove(program: Command, deps: Deps): void {
	program
		.command("remove")
		.summary("Remove worktree")
		.description(
			"Remove a regular worktree or free a pooled worktree slot, refusing unsafe states unless forced.",
		)
		.option("--branch <branch>", "Branch to remove")
		.option("--self", "Remove the worktree containing --cwd")
		.option("--json", "Machine-readable output")
		.option("--force", "Force removal")
		.option("--keep-branch", "Remove/free worktree without deleting branch")
		.option(
			"--integrated-into-local <branch>",
			"Prove pinned local ancestry and remove a regular --self checkout",
		)
		.option(
			"--expected-source <oid>",
			"Full reviewed source OID; required by --integrated-into-local",
		)
		.option(
			"--expected-target <oid>",
			"Full local destination OID; required by --integrated-into-local",
		)
		.option(
			"--integrated-into <origin/ref>",
			"Delete a clean branch only after proving its content is in this fetched ref",
		)
		.addHelpText("after", HELP.remove)
		.action((_opts, command) => runAction("remove", optsToArgs(command.optsWithGlobals()), deps));
}

function registerEnsure(program: Command, deps: Deps): void {
	program
		.command("ensure")
		.summary("Materialise pool slots")
		.description("Create and initialize the configured fixed pool slots for a pooled repository.")
		.addHelpText("after", HELP.ensure)
		.action((_opts, command) => runAction("ensure", optsToArgs(command.optsWithGlobals()), deps));
}

function registerStatus(program: Command, deps: Deps): void {
	program
		.command("status")
		.summary("Show pool status")
		.description(
			"Print JSON describing configured pool size and each slot's branch, safety, and initialization state.",
		)
		.addHelpText("after", HELP.status)
		.action((_opts, command) => runAction("status", optsToArgs(command.optsWithGlobals()), deps));
}

function registerCopy(program: Command, deps: Deps): void {
	program
		.command("copy")
		.summary("Re-run copy setup")
		.description(
			"Re-apply configured local file/directory copy or symlink setup to the current non-canonical worktree.",
		)
		.option("--json", "Machine-readable output")
		.addHelpText("after", HELP.copy)
		.action((_opts, command) => runAction("copy", optsToArgs(command.optsWithGlobals()), deps));
}

function registerFinish(program: Command, deps: Deps): void {
	program
		.command("finish")
		.summary("Integrate completed work")
		.description(
			"Integrate the current non-canonical worktree into the canonical root using effective finish policy.",
		)
		.option("--json", "Machine-readable output")
		.option("--title <text>", "Squash integration commit title; required by the squash strategy")
		.option(
			"--body <text>",
			"Squash integration commit body; the source branch and its commit messages are appended",
		)
		.addHelpText("after", HELP.finish)
		.action((_opts, command) => runAction("finish", optsToArgs(command.optsWithGlobals()), deps));
}

function registerIntegrate(program: Command, deps: Deps): void {
	program
		.command("integrate")
		.summary("Fast-forward an explicit local feature worktree")
		.description(
			"Integrate the current task checkout into a pinned registered noncanonical feature checkout.",
		)
		.option(
			"--into <branch>",
			"Explicit local feature destination branch; required for integration",
		)
		.option("--expected-source <oid>", "Full reviewed source commit OID; required for integration")
		.option(
			"--expected-target <oid>",
			"Full validated destination commit OID; required for integration",
		)
		.option(
			"--schema",
			"Print integration, local cleanup and failure JSON schemas without repository access",
		)
		.option("--json", "Machine-readable output")
		.addHelpText("after", HELP.integrate)
		.action((_opts, command) =>
			runAction("integrate", optsToArgs(command.optsWithGlobals()), deps),
		);
}

function registerPick(program: Command, deps: Deps): void {
	program
		.command("pick")
		.summary("Fuzzy-pick worktree")
		.description(
			"Fuzzy-pick a worktree with fzf and print its path, or with --interactive hand it to the " +
				"invoking shell or open its multiplexer session.",
		)
		.option("--open", "Open the selection's multiplexer session instead of printing its path")
		.addHelpText("after", HELP.pick)
		.action((_opts, command) => runAction("pick", optsToArgs(command.optsWithGlobals()), deps));
}

function registerShellInit(program: Command, deps: Deps): void {
	program
		.command("shell-init <shell>")
		.summary("Print shell integration")
		.description("Print a wk picker function for zsh or nu; does not require a repository.")
		.addHelpText("after", HELP.shellInit)
		.action((shell: string) => runAction("shell-init", [shell], deps));
}

function registerConfig(program: Command, deps: Deps): void {
	program
		.command("config")
		.summary("Inspect configuration")
		.description("Inspect effective wktree configuration and policy.")
		.addHelpText("after", HELP.config)
		.command("explain")
		.summary("Explain effective config")
		.description(
			"Show effective policy, bootstrap command source, and matching config layers for a repository.",
		)
		.option("--json", "Machine-readable output")
		.addHelpText("after", HELP.explain)
		.action((_opts, command) =>
			runAction("config", ["explain", ...optsToArgs(command.optsWithGlobals())], deps),
		);
}

function registerSkills(program: Command, deps: Deps): void {
	const skills = program
		.command("skills")
		.summary("Read bundled agent skills")
		.description(
			"List or read instructions bundled with this Wktree version; works outside a repository.",
		)
		.option("--json", "Machine-readable output")
		.action((_opts, command) =>
			runAction("skills", ["list", ...optsToArgs(command.optsWithGlobals())], deps),
		);
	skills
		.command("list")
		.description("List names and descriptions; --json also includes resource paths")
		.option("--json", "Machine-readable output")
		.action((_opts, command) =>
			runAction("skills", ["list", ...optsToArgs(command.optsWithGlobals())], deps),
		);
	skills
		.command("get <name>")
		.description("Print a skill's Markdown body without frontmatter")
		.option("--json", "Machine-readable output")
		.action((name: string, _opts, command) =>
			runAction("skills", ["get", name, ...optsToArgs(command.optsWithGlobals())], deps),
		);
	const file = skills
		.command("file <name> <path>")
		.description("Print a resource using its path relative to the skill directory")
		.option("--json", "Machine-readable output")
		.action((name: string, path: string) =>
			runAction("skills", ["file", name, path, ...optsToArgs(file.optsWithGlobals())], deps),
		);
}

function configureCompletion(program: Command): void {
	const completion = tab(program, { completionCommandName: "completions" });
	// The adapter collects local options only; Commander also accepts root options on subcommands.
	for (const command of completion.commands.values()) {
		for (const [name, option] of completion.options) {
			if (!command.options.has(name)) {
				command.options.set(name, option);
			}
		}
	}
}

async function handleParseError(error: unknown, json: boolean): Promise<void> {
	if (!(error instanceof CommanderError)) {
		throw error;
	}
	if (error.exitCode === EXIT_CODES.SUCCESS) {
		process.exit(EXIT_CODES.SUCCESS);
	}
	if (!json) {
		process.exit(EXIT_CODES.USAGE);
	}
	const usage = new UsageError(error.message.replace(/^error: /u, ""));
	await writeResult(renderJsonResult(formatFailure(usage, { json })));
	process.exit(EXIT_CODES.USAGE);
}

async function parseProgram(program: Command, argv: string[], json: boolean): Promise<void> {
	try {
		await program.parseAsync(argv);
	} catch (error) {
		await handleParseError(error, json);
	}
}

async function runAction(subcmd: string, args: string[], deps: Deps): Promise<void> {
	const result = await dispatch(subcmd, args, deps);
	await writeResult(result);
	await result.afterOutput?.();
	process.exit(result.exitCode);
}

// Await the writes: afterOutput may close the invoking session and end this process.
async function writeResult(result: CommandResult): Promise<void> {
	if (result.stdout) {
		await Bun.write(Bun.stdout, result.stdout);
	}
	if (result.stderr) {
		await Bun.write(Bun.stderr, result.stderr);
	}
}

function optsToArgs(opts: Record<string, unknown>): string[] {
	const args: string[] = [];
	for (const [key, value] of Object.entries(opts)) {
		const flag = key.replaceAll(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`);
		if (key === "network" && value === false) {
			args.push("--no-network");
		} else if (value === true && key !== "network") {
			args.push(`--${flag}`);
		} else if (key !== "network" && value !== false && value !== undefined && value !== null) {
			args.push(`--${flag}`, String(value));
		}
	}
	return args;
}
