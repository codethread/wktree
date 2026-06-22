import type {GitRunner} from "./git/executor.ts";
import type {Worktree} from "./git/worktrees.ts";

export type {Worktree} from "./git/worktrees.ts";

export type AddPolicy = "origin_default" | "fresh_canonical";
export type FinishStrategy = "ff_only" | "rebase_ff" | "squash" | "merge_commit";
export interface FinishPolicy {
	enabled: boolean;
	strategy: FinishStrategy;
	push: boolean;
	removeWorktree: boolean;
	deleteBranch: boolean;
}
export interface PolicyTables {
	add?: {policy: AddPolicy};
	finish?: Partial<FinishPolicy>;
}

export interface ProjectConfig extends PolicyTables {
	name: string | null;
	root: string;
	command: string | null;
	poolSize: number | null;
	copyModeDefault: CopyMode;
	copy: CopyEntry[];
}

export interface PolicyRule extends PolicyTables {
	rootGlob: string;
}

export type CopyMode = "copy" | "symlink";
export type CopyEntry = {from: string; to: string[]; mode: CopyMode};
export type CopiedFile = {from: string; to: string; type: "file" | "directory" | "symlink"};

export type TreesConfig = {projects: ProjectConfig[]; rules: PolicyRule[]; defaults: PolicyTables};

export interface Slot {
	index: number;
	path: string;
	exists: boolean;
	branch: string | null;
	placeholder: boolean;
	dirty: boolean;
	lastCommitIso: string | null;
	lastCommitSubject: string | null;
	initialized: boolean;
}

export interface PoolState {
	root: string;
	trunk: string;
	size: number;
	slots: Slot[];
}

export type Allocation =
	| {kind: "free-slot"; slotIndex: number; branchExists: "local" | "remote" | "none"}
	| {kind: "pool-full"; candidateSlots: Slot[]}
	| {kind: "duplicate"; slotIndex: number; branch: string};

export interface AddPlan {
	worktreePath: string;
	branch: string;
	root: string;
	title: string;
	postCreateScriptPath: string | null;
	createdNewBranch: boolean;
	rollbackBranchHead: string | null;
}

export interface RemovePlan {
	worktreePath: string;
	removed: boolean;
}

export interface SessionInfo {
	name: string;
	path: string;
}

export interface ReadyAddPayload {
	kind: "ready";
	worktree_path: string;
	branch: string;
	root: string;
	title: string;
	session: SessionInfo;
	post_create_script_path: string | null;
	created_new_branch: boolean;
	rollback_branch_head: string | null;
}

export interface ReadyRemovePayload {
	kind: "ready";
	worktree_path: string;
	removed: boolean;
	session: SessionInfo;
}

export interface PoolFullCandidate {
	slot: number;
	path: string;
	branch: string | null;
	dirty: boolean;
	ahead: number;
	local_only: boolean;
	last_commit_iso: string | null;
	last_commit_subject: string | null;
}

export interface PoolFullPayload {
	kind: "pool_full";
	root: string;
	branch: string;
	candidates: PoolFullCandidate[];
}

export interface BlockedPayload {
	kind: "blocked";
	reason: string;
	message: string;
	branch?: string;
	worktree_path?: string;
	slot_path?: string;
}

export interface PostCreateScriptSpec {
	projectName: string;
	root: string;
	created: string;
	command: string;
	pooled: boolean;
}

export interface HookRunner {
	runInline(
		scriptPath: string,
		cwd: string,
		env: Record<string, string>,
		onLine: (stream: "stdout" | "stderr", line: string) => void,
	): Promise<void>;
}

export interface PickerItem {
	key: string;
	display: string;
	preview: string;
}

export interface PickerService {
	pick(items: PickerItem[], header: string): Promise<PickerItem>;
	confirm(prompt: string): Promise<boolean>;
}

export interface ProgressReporter {
	banner(line: string): void;
	stream(stream: "stdout" | "stderr", line: string): void;
	error(msg: string): void;
}

export interface Deps {
	git: GitRunner;
	hooks: HookRunner;
	picker: PickerService;
	progress: ProgressReporter;
}
