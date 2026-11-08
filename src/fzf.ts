// Single-selection fuzzy finder over lines using fzf, which draws its UI on /dev/tty itself
import { EXIT_CODES, PickerCancelled, WktreeError } from "./errors.ts";

/** Exit 1 means nothing matched and 130 means interrupted (Esc or Ctrl-C). */
const NO_MATCH_EXIT_CODE = 1;
const INTERRUPTED_EXIT_CODE = 130;
const CANCEL_EXIT_CODES = new Set([NO_MATCH_EXIT_CODE, INTERRUPTED_EXIT_CODE]);
const CAMEL_CASE_BOUNDARY = /[A-Z]/gu;

interface Options {
	/** Prompt displayed above the available rows. */
	header?: string;
	/** Shell command rendered beside the candidate list. */
	preview?: string | undefined;
	/** Placement and size of the preview pane. */
	previewWindow?: string;
	/** Separator used to split each row into fields. */
	delimiter?: string;
	/** One-based fields displayed in the candidate list. */
	withNth?: string;
	/** Popup placement inside tmux; fzf ignores it outside tmux and runs inline. */
	tmux?: string | undefined;
}

export async function fzf(lines: string[], opts: Options = {}): Promise<string> {
	const flags = Object.entries(opts).flatMap(([option, value]) => {
		if (value === undefined) {
			return [];
		}
		return optionFlag(option, value);
	});

	const proc = Bun.spawn(["fzf", ...flags], {
		stdio: ["pipe", "pipe", "inherit"],
	});

	proc.stdin.write(lines.join("\n"));
	proc.stdin.end();

	const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (CANCEL_EXIT_CODES.has(exitCode)) {
		throw new PickerCancelled();
	}
	if (exitCode !== EXIT_CODES.SUCCESS) {
		throw new WktreeError(`fzf failed (exit ${exitCode})`);
	}
	return output.trim();
}

// --- Private helpers ---

function optionFlag(option: string, value: string): string[] {
	return [`--${option.replaceAll(CAMEL_CASE_BOUNDARY, (char) => `-${char.toLowerCase()}`)}`, value];
}
