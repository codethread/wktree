import type { CopiedFile, PostCreateScriptSpec } from "./domain/worktree.ts";
import type {
	CopyEntry,
	PolicyExplanation,
	TreesConfig,
	WorktreeLocation,
} from "./domain/config.ts";
import type { Multiplexer } from "./integrations/multiplexer.ts";
import type { SkillProvider } from "skills-handler";
import type { WorktreeInventory } from "./git/worktrees.ts";

export interface GitResult {
	/** Captured standard output. */
	stdout: string;
	/** Captured diagnostics. */
	stderr: string;
	/** Git's process exit status. */
	exitCode: number;
}

export interface GitRunner {
	/** Run Git, throwing when it exits unsuccessfully. */
	run: (args: string[], opts?: GitRunOptions) => Promise<GitResult>;
	/** Run Git and let the caller interpret its exit status. */
	runRaw: (args: string[], opts?: GitRunOptions) => Promise<GitResult>;
}

export interface GitRunOptions {
	/** Working directory for the Git process; defaults to the process root. */
	cwd?: string;
}

export interface ConfigService {
	/** Load global and canonical-root local configuration at the command boundary. */
	read: (canonicalRoot: string) => TreesConfig;
	/** Resolve policy after canonicalizing filesystem paths. */
	explain: (config: TreesConfig, root: string) => PolicyExplanation;
}

export interface WorkspaceFiles {
	/** Resolve existing paths through symlinks; preserve missing paths. */
	normalizePath: (path: string) => string;
	/** Check whether a filesystem target exists. */
	exists: (path: string) => boolean;
	/** Prepare the directory and ignore entry for a nested worktree. */
	prepareParent: (options: {
		/** Operation-scoped Git boundary, including offline object policy. */
		git: GitRunner;
		/** Canonical root whose shared exclude is updated. */
		root: string;
		/** Target checkout path. */
		path: string;
		/** Placement policy for missing checkouts. */
		location: WorktreeLocation;
	}) => Promise<void>;
	/** Validate all destinations before replacing configured local assets. */
	copy: (options: {
		/** Operation-scoped Git boundary for tracked-path safety checks. */
		git: GitRunner;
		/** Canonical root supplying relative copy sources. */
		root: string;
		/** Checkout receiving assets. */
		target: string;
		/** Parsed copy/symlink requests. */
		entries: CopyEntry[];
	}) => Promise<CopiedFile[]>;
	/** Write an executable bootstrap script and return its path. */
	writePostCreateScript: (spec: PostCreateScriptSpec) => string;
}

export interface HookResult {
	/** Lines captured from standard output. */
	stdout: string[];
	/** Lines captured from standard error. */
	stderr: string[];
	/** Bash's process exit status. */
	exitCode: number;
}

export interface HookExecutionOptions {
	/** Working directory inherited by the hook. */
	cwd: string;
	/** Overrides merged into the invoking process's environment. */
	env: Record<string, string>;
	/** Receives output while the hook is running; omitted when only capture is needed. */
	onLine?: (stream: "stdout" | "stderr", line: string) => void;
}

export interface HookRunner {
	/** Execute a bootstrap file, raising a hook failure on nonzero exit. */
	runInline: (scriptPath: string, options: HookExecutionOptions) => Promise<void>;
	/** Execute a preflight command and capture its output. */
	runCommand: (script: string, cwd: string, env: Record<string, string>) => Promise<HookResult>;
}

export interface PickerItem {
	/** Stable identity returned by the picker. */
	key: string;
	/** Tab-delimited row: a hidden first field the preview reads as `{1}`, then the text shown. */
	display: string;
	/** Shell preview associated with the row. */
	preview: string;
}

export interface PickerOptions {
	/** Whether the invocation is human-interactive, so the picker may use multiplexer UI. */
	interactive?: boolean;
}

export interface PickerService {
	/** Select one of the supplied items. */
	pick: (items: PickerItem[], header: string, options?: PickerOptions) => Promise<PickerItem>;
	/** Ask whether the user accepts the described operation. */
	confirm: (prompt: string) => Promise<boolean>;
}

export interface ProgressReporter {
	/** Show the current operation. */
	banner: (line: string) => void;
	/** Forward a hook output line. */
	stream: (stream: "stdout" | "stderr", line: string) => void;
	/** Report a diagnostic. */
	error: (msg: string) => void;
}

export interface CdDirective {
	/** Ask the invoking wrapper to change its shell's directory to path. */
	write: (path: string) => void;
}

export interface Deps {
	/** Bundled instruction catalogue and supporting resource reads. */
	skills: SkillProvider;
	/** Git process boundary. */
	git: GitRunner;
	/**
	 * Required registered-worktree reads for root, list and pick.
	 * Custom live dependencies must bind this inventory to the same GitRunner instance as git.
	 */
	worktrees: WorktreeInventory;
	/** Configuration loading and canonical path matching. */
	config: ConfigService;
	/** Worktree setup and filesystem observations. */
	files: WorkspaceFiles;
	/** Bootstrap and preflight execution. */
	hooks: HookRunner;
	/** Interactive selection and confirmation. */
	picker: PickerService;
	/** Terminal multiplexer session control; the null implementation outside one. */
	multiplexer: Multiplexer;
	/** Shell directory change requested of an interactive wrapper. */
	cdDirective: CdDirective;
	/** Command diagnostics and hook output. */
	progress: ProgressReporter;
	/** Time source for human-readable commit ages. */
	clock: ClockService;
}

export interface ClockService {
	/** Current Unix time in milliseconds. */
	now: () => number;
}
