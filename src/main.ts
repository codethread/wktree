/* eslint-disable import/max-dependencies -- Compose public command handlers at the dispatch boundary. */
import type { CommandResult, OutputMode } from "./protocol.ts";
import {
	configCommand,
	copyCommand,
	ensureCommand,
	listCommand,
	pathCommand,
	rootCommand,
	statusCommand,
	treeCommand,
} from "./commands/query.ts";
import { createJsonCollector, formatFailure } from "./protocol.ts";
import type { Deps } from "./services.ts";
import { UsageError } from "./errors.ts";
import { addCommand } from "./commands/add.ts";
import { finishCommand } from "./commands/finish.ts";
import { integrateCommand } from "./commands/integrate.ts";
import { pickCommand } from "./commands/pick.ts";
import { removeCommand } from "./commands/remove.ts";
import { shellInitCommand } from "./commands/shell-init.ts";
import { skillsCommand } from "./commands/skills.ts";

const handlers: Partial<
	Record<string, (args: string[], deps: Deps) => Promise<CommandResult> | CommandResult>
> = {
	add: addCommand,
	config: configCommand,
	copy: copyCommand,
	ensure: ensureCommand,
	finish: finishCommand,
	integrate: integrateCommand,
	list: listCommand,
	path: pathCommand,
	pick: pickCommand,
	remove: removeCommand,
	root: rootCommand,
	"shell-init": shellInitCommand,
	skills: skillsCommand,
	status: statusCommand,
	tree: treeCommand,
};

interface Invocation {
	/** Command selected by the caller. */
	subcommand: string | undefined;
	/** Raw command arguments. */
	args: string[];
	/** Requested output format. */
	output: OutputMode;
}

/** Format every command failure and capture progress for machine-readable invocations. */
export async function dispatch(
	subcommand: string | undefined,
	args: string[],
	deps: Deps,
): Promise<CommandResult> {
	const output: OutputMode = { json: subcommand === "status" || args.includes("--json") };
	const request = { args, output, subcommand };
	if (!output.json) {
		return routeFormatted(request, deps);
	}
	const collector = createJsonCollector(deps.progress);
	const result = await routeFormatted(request, { ...deps, progress: collector.progress });
	return collector.render(result);
}

// --- Private helpers ---

function route(request: Invocation, deps: Deps): CommandResult | Promise<CommandResult> {
	const { args, subcommand } = request;
	if (subcommand && Object.hasOwn(handlers, subcommand)) {
		const handler = handlers[subcommand];
		if (handler) {
			return handler(args, deps);
		}
	}
	if (subcommand) {
		throw new UsageError(`unknown subcommand: ${subcommand}`);
	}
	throw new UsageError("missing subcommand");
}

async function routeFormatted(request: Invocation, deps: Deps): Promise<CommandResult> {
	try {
		return await route(request, deps);
	} catch (error) {
		return formatFailure(error, request.output);
	}
}
