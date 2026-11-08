import { EXIT_CODES, UsageError, toWktreeError } from "./errors.ts";
import type { FailureContext, FailureKind, WktreeError } from "./errors.ts";
import type { ProgressReporter } from "./services.ts";

const JSON_INDENT = 2;
const FLAG_PREFIX = "--";
const VALUE_ARGUMENTS = 1;
const BOOLEAN_OPTIONS = new Set([
	"--base-current",
	"--force",
	"--interactive",
	"--json",
	"--keep-branch",
	"--open",
	"--no-network",
	"--skip-command",
	"--self",
	"--schema",
]);

const NO_OUTPUT: JsonLog = { diagnostics: [], setup_output: [] };

export interface CommandResult {
	/** Output returned to the invoking shell, when present. */
	stdout?: string | undefined;
	/** Diagnostics returned to the invoking shell, when present. */
	stderr?: string;
	/** Structured result rendered as the single JSON document in --json mode. */
	payload?: object | undefined;
	/** Process status from the documented exit-code taxonomy. */
	exitCode: number;
	/** The failure this result was formatted from, for in-process callers. */
	failure?: WktreeError | undefined;
	/** Interactive follow-up run once output is written; it may end the process. */
	afterOutput?: (() => Promise<void>) | undefined;
}

export interface OutputMode {
	/** Whether the caller requests structured machine output. */
	json: boolean;
}

interface SetupOutputLine {
	/** Stream the setup command wrote the line to. */
	stream: "stdout" | "stderr";
	/** Line text without its terminator. */
	line: string;
}

/** Output captured during a --json invocation so stderr stays silent. */
export interface JsonLog {
	/** Wktree's own progress lines and warnings, in order. */
	diagnostics: string[];
	/** Setup command output, in order, tagged with its original stream. */
	setup_output: SetupOutputLine[];
}

interface FailurePayload extends FailureContext {
	/** Recoverable refusal or failure to run. */
	kind: FailureKind;
	/** Machine-readable failure token. */
	reason: string;
	/** Human-readable explanation of the failure. */
	message: string;
}

export function parseOutputMode(opts: Record<string, string | boolean>): OutputMode {
	return {
		json: opts.json === true,
	};
}

export function finalizeStructuredResult(
	payload: object,
	output: OutputMode,
	exitCode: number = EXIT_CODES.SUCCESS,
): CommandResult {
	if (output.json) {
		return { exitCode, payload };
	}
	return { exitCode };
}

export function finalizeReadyResult(options: {
	/** Structured successful command payload. */
	payload: object;
	/** Requested output rendering. */
	output: OutputMode;
	/** Human-readable successful operation summary. */
	summary: string;
	/** Interactive follow-up run after output has been emitted. */
	afterOutput?: (() => Promise<void>) | undefined;
}): CommandResult {
	const { payload, output, summary, afterOutput } = options;
	if (output.json) {
		return { ...finalizeStructuredResult(payload, output), afterOutput };
	}
	return { afterOutput, exitCode: EXIT_CODES.SUCCESS, stderr: `${summary}\n` };
}

/** The one formatter for anything a command throws: human text or a failure payload. */
export function formatFailure(error: unknown, output: OutputMode): CommandResult {
	const failure = toWktreeError(error);
	if (!output.json) {
		return { exitCode: failure.exitCode, failure, stderr: `${failure.message}\n` };
	}
	return { exitCode: failure.exitCode, failure, payload: toFailurePayload(failure) };
}

/**
 * Collect progress into the JSON document. Once rendered, later lines (interactive
 * follow-ups only) fall through to the terminal reporter.
 */
export function createJsonCollector(terminal: ProgressReporter) {
	const log: JsonLog = { diagnostics: [], setup_output: [] };
	let rendered = false;
	const progress: ProgressReporter = {
		banner: (line) => {
			if (rendered) {
				terminal.banner(line);
			} else {
				log.diagnostics.push(line);
			}
		},
		error: (msg) => {
			if (rendered) {
				terminal.error(msg);
			} else {
				log.diagnostics.push(msg);
			}
		},
		stream: (stream, line) => {
			if (rendered) {
				terminal.stream(stream, line);
			} else {
				log.setup_output.push({ line, stream });
			}
		},
	};
	const render = (result: CommandResult): CommandResult => {
		rendered = true;
		return renderJsonResult(result, log);
	};
	return { progress, render };
}

/** Render a result as the single stdout document: `ok`, then the payload, then captured output. */
export function renderJsonResult(result: CommandResult, log: JsonLog = NO_OUTPUT): CommandResult {
	return {
		afterOutput: result.afterOutput,
		exitCode: result.exitCode,
		failure: result.failure,
		stdout: `${JSON.stringify(
			{ ok: result.exitCode === EXIT_CODES.SUCCESS, ...result.payload, ...log },
			undefined,
			JSON_INDENT,
		)}\n`,
	};
}

export function parseOptions(args: string[]): Record<string, string | boolean> {
	const opts: Record<string, string | boolean> = {};
	for (let index = 0; index < args.length; index += VALUE_ARGUMENTS) {
		const arg = args[index] ?? "";
		if (BOOLEAN_OPTIONS.has(arg)) {
			opts[arg.slice(FLAG_PREFIX.length)] = true;
		} else if (arg.startsWith(FLAG_PREFIX)) {
			index = takeOptionValue(opts, args, index);
		}
	}
	return opts;
}

export function requireOption(opts: Record<string, string | boolean>, key: string): string {
	const value = opts[key];
	if (typeof value !== "string" || value === "") {
		throw new UsageError(`missing required --${key}`);
	}
	return value;
}
// --- Private functions ---

function toFailurePayload(failure: WktreeError): FailurePayload {
	return {
		kind: failure.kind,
		message: failure.message,
		reason: failure.reason,
		...failure.context,
	};
}

function takeOptionValue(
	opts: Record<string, string | boolean>,
	args: string[],
	index: number,
): number {
	const key = (args[index] ?? "").slice(FLAG_PREFIX.length);
	const value = args[index + VALUE_ARGUMENTS];
	if (value === undefined || value.startsWith(FLAG_PREFIX)) {
		throw new UsageError(`missing value for --${key}`);
	}
	opts[key] = value;
	return index + VALUE_ARGUMENTS;
}

export {
	formatCommandSource,
	formatConfigSummary,
	formatWorktreeList,
	formatWorktreeTree,
	toAddPayload,
	toConfigExplainPayload,
	toListJson,
	toRemovePayload,
	toTreePayload,
	type PoolFullPayload,
	type ReadyAddPayload,
} from "./protocol-payloads.ts";
