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
		.summary("Manage git worktrees deterministically")
		.description(
			"Deterministic git worktree lifecycle engine for humans, agents, shells, and tmux wrappers.",
		)
		.option(
			"--cwd <path>",
			"Path inside the worktree set to operate on; defaults to the current directory",
			process.cwd(),
		)
		.configureOutput({
			writeOut: (str) => process.stderr.write(str),
			writeErr: (str) => process.stderr.write(str),
		})
		.addHelpText(
			"after",
			`
Agent workflow:
  Pass --cwd <path> only when targeting a worktree set other than the current
  directory. Prefer --json when available and branch on payload kind rather than
  stderr text. If add returns post_create_script_path, run that script with bash
  before treating the worktree as ready.

Common flows:
  wktree add --branch <feature> --json
  wktree list --json
  wktree path --branch <feature>
  wktree remove --branch <feature> --json
  wktree finish --json
  wktree config explain --json

Pools:
  Pooled repositories reuse fixed slots instead of creating branch-named sibling
  directories. Run status and check hasPool to see whether remove/add use pooled
  slot semantics. Use remove for cleanup in both pooled and non-pooled repositories.

Safety:
  Unforced destructive operations refuse dirty, ahead, local-only, canonical-root,
  or otherwise ambiguous states. Use --force only when discarding local work is
  intentional.
`,
		)
		.exitOverride();

	program
		.command("root")
		.summary("Print canonical root")
		.description("Print the protected canonical/root worktree for the repository containing --cwd (or the current directory by default).")
		.addHelpText(
			"after",
			`
Use when:
  You need the repository anchor that wktree uses for config lookup, sibling path
  generation, default-branch policy, and root-protection checks.

Notes:
  The canonical root is never removed or recycled by wktree. Run this before
  reasoning about generated sibling paths or effective project configuration.
`,
		)
		.action(async (_opts, command) => {
			await runAction("root", optsToArgs(command.optsWithGlobals()), deps);
		});

	program
		.command("list")
		.summary("List worktrees")
		.description("List every git worktree known to the repository, including canonical and pooled slots.")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			`
Use when:
  You need to discover existing worktrees, identify the canonical root, inspect
  branch/path/session identity, or decide whether an agent should reuse an
  existing checkout instead of creating one.

Notes:
  In pooled repositories, list ensures configured slots exist before reporting
  them. With --json, stdout is an array of worktree items; diagnostics stay on
  stderr.

Related:
  status shows pool-focused slot state. path resolves one branch to its expected
  worktree path.
`,
		)
		.action(async (_opts, command) => {
			await runAction("list", optsToArgs(command.optsWithGlobals()), deps);
		});

	program
		.command("path")
		.summary("Resolve branch path")
		.description("Print the deterministic worktree path for a branch in the repository containing --cwd (or the current directory by default).")
		.requiredOption("--branch <branch>", "Branch name")
		.addHelpText(
			"after",
			`
Use when:
  A script or agent needs the expected checkout path for a branch without
  creating, switching, or removing anything.

Notes:
  Non-pooled repositories use sibling paths based on the canonical root and
  branch name. Pooled repositories may map active branches to reusable slot
  paths instead.
`,
		)
		.action(async (_opts, command) => {
			await runAction("path", optsToArgs(command.optsWithGlobals()), deps);
		});

	program
		.command("add")
		.summary("Create or allocate worktree")
		.description("Create a regular worktree or allocate a pooled slot for a branch, applying add policy and setup.")
		.requiredOption("--branch <branch>", "Branch name")
		.option("--json", "Machine-readable output")
		.option("--slot <path>", "Specific pool slot path")
		.option("--base <branch>", "Base branch for new branches")
		.option("--force", "Force operation")
		.addHelpText(
			"after",
			`
Use when:
  Starting work on a branch. This is the preferred entry point over raw git
  worktree add because it applies repository policy, deterministic paths, pool
  allocation, copy setup, and bootstrap script generation.

Notes:
  Without --base, new branches start from the configured policy target. Use
  --base only for intentional stacked/non-default work. If --json returns
  post_create_script_path, run that script with bash before opening the worktree.

Blocked outcomes:
  Existing branches, stale or dirty canonical roots, pool exhaustion, and unsafe
  slot states are reported explicitly. Machine consumers should branch on kind
  such as ready, blocked, or pool_full.
`,
		)
		.action(async (_opts, command) => {
			await runAction("add", optsToArgs(command.optsWithGlobals()), deps);
		});

	program
		.command("remove")
		.summary("Remove worktree")
		.description("Remove a regular worktree or free a pooled worktree slot, refusing unsafe states unless forced.")
		.option("--branch <branch>", "Branch to remove")
		.option("--self <path>", "Remove the worktree at this path")
		.option("--json", "Machine-readable output")
		.option("--force", "Force removal")
		.option("--keep-branch", "Remove/free worktree without deleting branch")
		.option("--skip-pre-remote-check", "Skip configured pre-remote check")
		.addHelpText(
			"after",
			`
Use when:
  Cleaning up branch worktrees after work is done or abandoned. Use --branch for
  a named branch, or --self with the current worktree path when a wrapper or
  agent wants to remove the checkout it is operating in.

Safety:
  The canonical root is protected. Without --force, removal refuses dirty,
  ahead, local-only, unmerged, or otherwise ambiguous work. --keep-branch removes
  only the checkout/slot occupancy and leaves the branch ref intact.

Related:
  finish can integrate a completed worktree and then clean it up as one
  conservative lifecycle operation.
`,
		)
		.action(async (_opts, command) => {
			await runAction("remove", optsToArgs(command.optsWithGlobals()), deps);
		});

	program
		.command("ensure")
		.summary("Materialise pool slots")
		.description("Create and initialize the configured fixed pool slots for a pooled repository.")
		.addHelpText(
			"after",
			`
Use when:
  Pre-warming an expensive repository's worktree pool before agents or humans
  request work. add and list also ensure pools as needed, so this is mainly for
  setup, repair, or making failures visible early.

Notes:
  Non-pooled repositories have no slots to materialize. Pool initialization runs
  configured copy/setup so slots are ready for later allocation.
`,
		)
		.action(async (_opts, command) => {
			await runAction("ensure", optsToArgs(command.optsWithGlobals()), deps);
		});

	program
		.command("status")
		.summary("Show pool status")
		.description("Print JSON describing configured pool size and each slot's branch, safety, and initialization state.")
		.addHelpText(
			"after",
			`
Use when:
  Deciding whether a repository is pooled and whether any slots can be removed
  for reuse. A size of 0 means regular non-pooled worktrees; size greater than 0
  means remove uses pool semantics.

Notes:
  Output is always JSON. Slot fields include branch, dirty state, placeholder
  status, last commit details, and initialization state.
`,
		)
		.action(async (_opts, command) => {
			await runAction("status", optsToArgs(command.optsWithGlobals()), deps);
		});

	program
		.command("copy")
		.summary("Re-run copy setup")
		.description("Re-apply configured local file/directory copy or symlink setup to the current non-canonical worktree.")
		.option("--json", "Machine-readable output")
		.addHelpText(
			"after",
			`
Use when:
  Project copy configuration changed, local tool assets were updated, or a
  worktree needs its untracked setup files materialized again without recreating
  the checkout.

Notes:
  copy targets the non-canonical worktree containing --cwd (or the current directory by default) and refuses the
  canonical root. Destinations are engine-managed untracked setup paths; reruns
  replace those paths from their configured sources.
`,
		)
		.action(async (_opts, command) => {
			await runAction("copy", optsToArgs(command.optsWithGlobals()), deps);
		});

	program
		.command("finish")
		.summary("Integrate completed work")
		.description("Integrate the current non-canonical worktree into the canonical root using effective finish policy.")
		.option("--json", "Machine-readable output")
		.addHelpText(
			"after",
			`
Use when:
  Work on a branch is complete and should be folded back into the canonical
  target branch with the same lifecycle rules used by creation and cleanup.

Notes:
  finish refuses the canonical root, requires a clean source worktree, fetches,
  requires a clean/fresh target, and stops on conflicts. Strategy, push, worktree
  cleanup, and branch deletion all come from finish policy in config; use config
  explain to inspect the effective values. Valid strategies are ff_only,
  rebase_ff, squash, and merge_commit.

Cleanup:
  Configured remove_worktree removes regular worktrees or frees pooled slots only
  after integration and configured push succeed. Configured delete_branch
  requires remove_worktree to be enabled in the same effective policy.
`,
		)
		.action(async (_opts, command) => {
			await runAction("finish", optsToArgs(command.optsWithGlobals()), deps);
		});

	program
		.command("config")
		.summary("Inspect configuration")
		.description("Inspect effective wktree configuration and policy.")
		.addHelpText(
			"after",
			`
Use subcommands to explain the configuration resolved for a repository.

Related:
  config explain --cwd <path> --json
`,
		)
		.command("explain")
		.summary("Explain effective config")
		.description("Show effective policy, bootstrap command source, and matching config layers for a repository.")
		.option("--json", "Machine-readable output")
		.addHelpText(
			"after",
			`
Use when:
  Debugging why add, finish, pools, copy setup, or bootstrap commands behave a
  certain way for a repository.

Notes:
  Resolution starts with built-in defaults, applies matching root_glob rules in
  file order, then exact project overrides. Use --json for the matched rules,
  exact project, command source, add policy, and finish policy.
`,
		)
		.action(async (_opts, command) => {
			await runAction("config", ["explain", ...optsToArgs(command.optsWithGlobals())], deps);
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
