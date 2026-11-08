import { DirtySlotError, UsageError } from "../errors.ts";
// eslint-disable-next-line import/no-nodejs-modules -- Worktree paths are real filesystem paths by contract.
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { WorktreeLocation } from "./config.ts";

const LEGACY_NESTED_WORKTREE_DIR = ".wktree";
const MIN_BRANCH_PARTS = 1;
const NO_COMMITS = 0;
export const NESTED_WORKTREE_DIR = ".worktrees";
const TILDE_PREFIX = "~/";

export interface Worktree {
	/** Checkout path reported by Git. */
	path: string;
	/** Checked-out commit, absent for a bare repository. */
	head: string | null;
	/** Local branch name, absent for detached or bare worktrees. */
	branch: string | null;
	/** Full branch ref reported by Git. */
	branchRef: string | null;
	/** Whether HEAD is detached from a branch. */
	detached: boolean;
	/** Whether the entry is a bare repository. */
	bare: boolean;
	/** Whether this is the protected first worktree in Git's listing. */
	canonical: boolean;
	/** Whether Git has locked this worktree. */
	locked: boolean;
	/** Git's lock explanation, when supplied. */
	lockReason: string | null;
	/** Whether Git considers this worktree prunable. */
	prunable: boolean;
	/** Git's prune explanation, when supplied. */
	prunableReason: string | null;
	/** Fixed slot identity inferred from its managed path. */
	pool: PoolSlotIdentity | null;
}

export interface PoolSlotIdentity {
	/** One-based slot number. */
	index: number;
	/** Whether the slot currently holds its reserved placeholder branch. */
	placeholder: boolean;
}

export interface Slot {
	/** One-based slot number. */
	index: number;
	/** Actual or planned path of the slot. */
	path: string;
	/** Whether Git currently lists the slot. */
	exists: boolean;
	/** Checked-out local branch, if any. */
	branch: string | null;
	/** Whether the slot holds its reserved placeholder branch. */
	placeholder: boolean;
	/** Whether Git reports uncommitted changes or cannot read the slot's status. */
	dirty: boolean;
	/** Commit timestamp reported by Git, when available. */
	lastCommitIso: string | null;
	/** Latest commit subject, when available. */
	lastCommitSubject: string | null;
	/** Whether the successful bootstrap marker exists. */
	initialized: boolean;
}

export interface PoolState {
	/** Canonical repository root. */
	root: string;
	/** Origin's default branch; empty when no pool is configured. */
	trunk: string;
	/** Whether this project uses fixed slots. */
	hasPool: boolean;
	/** Configured number of slots. */
	size: number;
	/** Latest observations for each configured slot. */
	slots: Slot[];
}

export interface AddPlan {
	/** Allocated checkout path. */
	worktreePath: string;
	/** Checked-out local branch. */
	branch: string;
	/** Canonical repository root. */
	root: string;
	/** Human-facing session title. */
	title: string;
	/** Whether allocation created a local branch ref. */
	createdNewBranch: boolean;
	/** Previous branch head available for rollback. */
	rollbackBranchHead: string | null;
}

export interface RemovePlan {
	/** Checkout path selected for cleanup. */
	worktreePath: string;
	/** Whether cleanup removed the directory rather than recycling a slot. */
	removed: boolean;
}

export interface PostCreateScriptSpec {
	/** Project name displayed during setup. */
	projectName: string;
	/** Canonical root exported to the hook. */
	root: string;
	/** New checkout exported to the hook and used as its working directory. */
	created: string;
	/** Configured Bash setup command. */
	command: string;
	/** Whether successful setup should write a pool initialization marker. */
	pooled: boolean;
}

export interface CopiedFile {
	/** Materialized source path. */
	from: string;
	/** Destination relative to the target checkout. */
	to: string;
	/** Kind of filesystem asset created. */
	type: "file" | "directory" | "symlink";
}

export type BranchState = "local" | "remote" | "local-remote" | "none";

export type WorktreeParentage =
	| {
			/** One nearest strict ancestor with feature commits outside the default branch. */
			kind: "inferred";
			/** Parent group's commit OID. */
			head: string;
	  }
	| {
			/** Multiple incomparable nearest ancestors; do not choose one. */
			kind: "ambiguous";
			/** Candidate parent groups' commit OIDs. */
			heads: string[];
	  }
	| {
			/** No parent can be established from this inventory. */
			kind: "unknown";
			/** Missing commit or no eligible feature ancestor of the commit. */
			reason: "no_head" | "no_ancestor";
	  };

export interface TreeDefaultBranch {
	/** Default branch name discovered from local origin/HEAD metadata. */
	branch: string;
	/** Local default ref, or cached origin ref when the local branch is absent. */
	ref: string;
	/** Snapshotted commit used for every baseline comparison. */
	head: string;
}

export interface TreeComparison {
	/** Whether local history contains a common ancestor with the default branch. */
	kind: "related" | "no_common_ancestor";
	/** Commits reachable only from this HEAD. */
	ahead: number;
	/** Commits reachable only from the default branch. */
	behind: number;
}

export interface WorktreeTree {
	/** Baseline designation and commit; absent for an inventory with no commits. */
	defaultBranch: TreeDefaultBranch | undefined;
	/** Every registered worktree, grouped by commit or missing-HEAD path. */
	nodes: WorktreeTreeNode[];
}

export interface WorktreeTreeNode {
	/** Commit OID for a HEAD group, or checkout path when there is no commit. */
	id: string;
	/** Worktrees at this commit; missing-HEAD worktrees remain separate. */
	worktrees: Worktree[];
	/** Current commit ancestry, not recorded branch creation history. */
	parentage: WorktreeParentage;
	/** Counts against the default branch; absent for a missing HEAD. */
	comparison: TreeComparison | undefined;
}

/**
 * Route explicit selection independently of initialization.
 * "recycle" delegates safety checks and force handling to the recycler.
 */
export function explicitSlotAction(
	slot: Readonly<Pick<Slot, "path" | "exists" | "placeholder" | "dirty">>,
	force: boolean,
): "allocate" | "recycle" {
	if (!slot.exists || (slot.placeholder && !slot.dirty)) {
		return "allocate";
	}
	if (slot.placeholder && !force) {
		throw new DirtySlotError(`slot ${slot.path} has uncommitted changes; pass --force to recycle`);
	}
	return "recycle";
}

/** Git reports an all-zero HEAD for an unborn branch and no HEAD for a bare entry. */
export function worktreeCommit(worktree: Worktree): string | undefined {
	if (worktree.head && !/^0+$/u.test(worktree.head)) {
		return worktree.head;
	}
	return undefined;
}

/** Infer feature stacks without turning baseline history or free slots into parents. */
export function buildWorktreeTree(options: {
	/** Inventory observed once at the application boundary. */
	worktrees: Worktree[];
	/** Strict ancestor observations between active worktree HEADs. */
	ancestors: ReadonlyMap<string, ReadonlySet<string>>;
	/** Repository default designation and immutable comparison tip. */
	defaultBranch: TreeDefaultBranch | undefined;
	/** Default-relative observations for each committed HEAD. */
	comparisons: ReadonlyMap<string, TreeComparison>;
}): WorktreeTree {
	const activeHeads = options.worktrees
		.filter((worktree) => !worktree.pool?.placeholder)
		.map((worktree) => worktreeCommit(worktree))
		.filter((head) => head !== undefined);
	const featureHeads = new Set(
		activeHeads.filter((head) => {
			const comparison = options.comparisons.get(head);
			return comparison?.kind === "related" && comparison.ahead > NO_COMMITS;
		}),
	);
	return { defaultBranch: options.defaultBranch, nodes: groupWorktreeNodes(options, featureHeads) };
}

export function sessionNameForWorktreePath(worktreePath: string): string {
	const parent = dirname(worktreePath);
	const parentName = basename(parent);
	let name = basename(worktreePath);
	if (parentName === NESTED_WORKTREE_DIR || parentName === LEGACY_NESTED_WORKTREE_DIR) {
		name = `${basename(dirname(parent))}__${name}`;
	}
	return name.replaceAll(".", "_");
}

export function encodeBranch(branch: string): string {
	const parts = branch.split("/").filter((part) => part !== "");
	if (parts.length < MIN_BRANCH_PARTS) {
		throw new UsageError(`invalid branch name: ${branch}`);
	}
	return parts.join("--");
}

export function worktreePathForName(
	root: string,
	name: string,
	location: WorktreeLocation,
): string {
	if (location === "nested") {
		return resolve(root, NESTED_WORKTREE_DIR, name);
	}
	return `${root}__${name}`;
}

export function generatePostCreateScript(spec: PostCreateScriptSpec): string {
	const lines = [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		`export WK_ROOT=${shellQuote(spec.root)}`,
		`export WK_CREATED=${shellQuote(spec.created)}`,
		`echo ${shellQuote(`project: ${spec.projectName}`)}`,
		'cd "$WK_CREATED"',
		spec.command.trimEnd(),
	];
	if (spec.pooled) {
		lines.push(': > "$(git -C "$WK_CREATED" rev-parse --git-path wk-pool-initialized)"');
	}
	return `${lines.join("\n")}\n`;
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

export function resolveCopySource(root: string, from: string, home: string): string {
	if (from === "~") {
		return home;
	}
	if (from.startsWith(TILDE_PREFIX)) {
		return resolve(home, from.slice(TILDE_PREFIX.length));
	}
	if (isAbsolute(from)) {
		return from;
	}
	return resolve(root, from);
}

// --- Private functions ---

function groupWorktreeNodes(
	options: Parameters<typeof buildWorktreeTree>[number],
	featureHeads: ReadonlySet<string>,
): WorktreeTreeNode[] {
	const { worktrees, ancestors, comparisons } = options;
	const groups = new Map<string, WorktreeTreeNode>();
	for (const worktree of worktrees) {
		const head = worktreeCommit(worktree);
		const id = head ?? worktree.path;
		const existing = groups.get(id);
		if (existing) {
			existing.worktrees.push(worktree);
		} else {
			groups.set(id, {
				comparison: comparisons.get(id),
				id,
				parentage: inferWorktreeParentage(head, ancestors, featureHeads),
				worktrees: [worktree],
			});
		}
	}
	return [...groups.values()];
}

function inferWorktreeParentage(
	head: string | undefined,
	ancestors: ReadonlyMap<string, ReadonlySet<string>>,
	featureHeads: ReadonlySet<string>,
): WorktreeParentage {
	if (head === undefined) {
		return { kind: "unknown", reason: "no_head" };
	}
	const candidates = [...(ancestors.get(head) ?? [])].filter(
		(candidate) => featureHeads.has(head) && featureHeads.has(candidate),
	);
	const nearest = candidates.filter(
		(candidate) => !candidates.some((other) => ancestors.get(other)?.has(candidate)),
	);
	const [parent, second] = nearest;
	if (parent === undefined) {
		return { kind: "unknown", reason: "no_ancestor" };
	}
	if (second !== undefined) {
		return { heads: nearest, kind: "ambiguous" };
	}
	return { head: parent, kind: "inferred" };
}
