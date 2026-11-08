import { sessionNameForWorktreePath } from "../domain/worktree.ts";

/** Field holding the worktree path in picker rows; read by fzf as `{1}`. */
export const WORKTREE_PATH_FIELD = "{1}";

/** Session a multiplexer should create and focus. */
export interface MultiplexerOpenRequest {
	/** Session identity; derive it with openRequestForWorktree so it matches the payload session. */
	name: string;
	/** Window title shown to the user, normally the branch name. */
	title: string;
	/** Worktree path the session is rooted at. */
	path: string;
}

/**
 * Terminal multiplexer boundary. The engine stores no session state: sessions
 * are observed through the multiplexer itself and reconstructed from worktree
 * paths, so a missing session is never an error.
 */
export interface Multiplexer {
	/** Whether wktree runs inside this multiplexer, so open can move the user's focus. */
	readonly attached: boolean;
	/** Create the session when it is missing, then focus it. */
	open: (request: MultiplexerOpenRequest) => Promise<void>;
	/** Close every session whose working directory is path or below it. */
	closeUnder: (path: string) => Promise<void>;
	/**
	 * Shell command for the picker's live preview of a worktree. The command
	 * reads the worktree path from fzf's first tab-delimited field, so picker
	 * rows must keep the path first and fzf must run with a tab delimiter.
	 */
	previewCommand: () => string;
}

/** Preview command for worktrees no session shows: recent history. */
export function gitLogPreviewCommand(): string {
	return `git -C ${WORKTREE_PATH_FIELD} log --oneline -20`;
}

/** Session operations for environments without a terminal multiplexer. */
export function createNoMultiplexer(): Multiplexer {
	return {
		attached: false,
		async closeUnder() {},
		async open() {},
		previewCommand: gitLogPreviewCommand,
	};
}

/** Build an open request whose session name matches the payload session identity. */
export function openRequestForWorktree(path: string, title: string): MultiplexerOpenRequest {
	return { name: sessionNameForWorktreePath(path), path, title };
}
