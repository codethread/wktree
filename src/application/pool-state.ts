import { BlockedError, ConfigError, EXIT_CODES } from "../errors.ts";
import type { GitResult, GitRunner, WorkspaceFiles } from "../services.ts";
import type { PoolState, Slot, Worktree } from "../domain/worktree.ts";
import type { ProjectConfig, WorktreeLocation } from "../domain/config.ts";
import { detectOriginDefaultBranch, refExists } from "./branches.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- resolve git-path locations at the filesystem boundary
import { resolve } from "node:path";
import { worktreePathForName } from "../domain/worktree.ts";

/** Pool slot indices are one-based; zero-based offsets add this. */
const FIRST_SLOT_INDEX = 1;
/** A pool slot is claimed by at most one worktree. */
const MAX_SLOT_MATCHES = 1;
/** A missing commit count is reported as zero. */
const NO_COUNT = 0;
const LOG_SEPARATOR = "\u001F";

export function placeholderBranchFor(index: number): string {
	return `wk-pool/feat${index}`;
}

export async function buildPoolState(options: {
	/** Pool configuration anchoring slot paths. */
	project: ProjectConfig;
	/** Git's current worktree inventory. */
	worktrees: Worktree[];
	/** Injected repository and filesystem observations. */
	deps: { git: GitRunner; files: Pick<WorkspaceFiles, "normalizePath" | "exists"> };
	/** Effective placement policy; defaults to the project's preference. */
	location?: WorktreeLocation;
}): Promise<PoolState> {
	const { project: cfg, deps } = options;
	const slotCount = requirePoolSize(cfg);
	const { git, files } = deps;
	const root = files.normalizePath(cfg.root);
	const trunk = await detectOriginDefaultBranch(git, root);
	const slots = await buildPoolSlots(options);
	return { hasPool: true, root, size: slotCount, slots, trunk };
}

/** Observe slot occupancy and readiness independently of origin/default discovery. */
export function buildPoolSlots(options: {
	project: ProjectConfig;
	worktrees: Worktree[];
	deps: { git: GitRunner; files: Pick<WorkspaceFiles, "normalizePath" | "exists"> };
	location?: WorktreeLocation;
}): Promise<Slot[]> {
	const { project, worktrees, deps, location = project.worktreeLocation ?? "sibling" } = options;
	const root = deps.files.normalizePath(project.root);
	return Promise.all(
		Array.from({ length: requirePoolSize(project) }, (_slotNumber, zeroBased) =>
			buildPoolSlotState({
				files: deps.files,
				git: deps.git,
				index: zeroBased + FIRST_SLOT_INDEX,
				location,
				root,
				worktrees,
			}),
		),
	);
}

export async function describeSlotRisk(
	git: GitRunner,
	slot: Slot,
): Promise<{ ahead: number; behind: number; localOnly: boolean }> {
	const upstream = await git.runRaw(["-C", slot.path, "rev-parse", "--abbrev-ref", "@{upstream}"]);
	if (upstream.exitCode !== EXIT_CODES.SUCCESS || upstream.stdout.trim() === "") {
		return { ahead: NO_COUNT, behind: NO_COUNT, localOnly: true };
	}
	const counts = await git.runRaw([
		"-C",
		slot.path,
		"rev-list",
		"--left-right",
		"--count",
		`${upstream.stdout.trim()}...HEAD`,
	]);
	const [behind, ahead] = counts.stdout.trim().split(/\s+/u).map(Number);
	return { ahead: ahead || NO_COUNT, behind: behind || NO_COUNT, localOnly: false };
}

export async function ensurePlaceholderBranch(options: {
	git: GitRunner;
	root: string;
	branch: string;
	trunk: string;
}): Promise<void> {
	const { git, root, branch, trunk } = options;
	const exists = await refExists(git, root, `refs/heads/${branch}`);
	if (!exists) {
		await git.run(["-C", root, "branch", branch, `origin/${trunk}`]);
	}
}
// --- Private functions ---

function requirePoolSize(cfg: ProjectConfig): number {
	if (!cfg.poolSize) {
		throw new ConfigError(`project ${cfg.name ?? cfg.root} is not pooled`);
	}
	return cfg.poolSize;
}

function emptySlot(index: number, path: string): Slot {
	return {
		// oxlint-disable-next-line unicorn/no-null -- Absent Git observations are explicit nulls in pool status JSON.
		branch: null,
		dirty: false,
		exists: false,
		index,
		initialized: false,
		// oxlint-disable-next-line unicorn/no-null -- Absent Git observations are explicit nulls in pool status JSON.
		lastCommitIso: null,
		// oxlint-disable-next-line unicorn/no-null -- Absent Git observations are explicit nulls in pool status JSON.
		lastCommitSubject: null,
		path,
		placeholder: false,
	};
}

function readLastCommit(log: GitResult): { iso: string | null; subject: string | null } {
	if (log.exitCode !== EXIT_CODES.SUCCESS || log.stdout.trim() === "") {
		// oxlint-disable-next-line unicorn/no-null -- Absent Git observations are explicit nulls in pool status JSON.
		return { iso: null, subject: null };
	}
	const [iso, subject] = log.stdout.trimEnd().split(LOG_SEPARATOR);
	// oxlint-disable-next-line unicorn/no-null -- Absent Git observations are explicit nulls in pool status JSON.
	return { iso: iso ?? null, subject: subject ?? null };
}

function findSlotWorktree(worktrees: Worktree[], index: number): Worktree | undefined {
	const matches = worktrees.filter(
		(candidate) => !candidate.canonical && candidate.pool?.index === index,
	);
	if (matches.length > MAX_SLOT_MATCHES) {
		throw new BlockedError(
			`multiple worktrees claim pool slot feat${index}: ${matches.map((candidate) => candidate.path).join(", ")}`,
		);
	}
	const [match] = matches;
	return match;
}

async function readSlotState(options: {
	files: Pick<WorkspaceFiles, "exists">;
	git: GitRunner;
	index: number;
	slotPath: string;
	worktree: Worktree;
}): Promise<Slot> {
	const { files, git, index, slotPath, worktree } = options;
	const [status, log, marker] = await Promise.all([
		git.runRaw(["-C", slotPath, "status", "--porcelain=v1"]),
		git.runRaw(["-C", slotPath, "log", "-1", "--format=%cI%x1f%s"]),
		git.runRaw(["-C", slotPath, "rev-parse", "--git-path", "wk-pool-initialized"]),
	]);
	const lastCommit = readLastCommit(log);
	const initialized =
		marker.exitCode === EXIT_CODES.SUCCESS && files.exists(resolve(slotPath, marker.stdout.trim()));
	return {
		branch: worktree.branch,
		dirty: status.exitCode !== EXIT_CODES.SUCCESS || status.stdout.trim() !== "",
		exists: true,
		index,
		initialized,
		lastCommitIso: lastCommit.iso,
		lastCommitSubject: lastCommit.subject,
		path: slotPath,
		placeholder: worktree.branch === placeholderBranchFor(index),
	};
}

async function buildPoolSlotState(options: {
	files: Pick<WorkspaceFiles, "exists">;
	git: GitRunner;
	index: number;
	location: WorktreeLocation;
	root: string;
	worktrees: Worktree[];
}): Promise<Slot> {
	const { files, git, index, location, root, worktrees } = options;
	const worktree = findSlotWorktree(worktrees, index);
	const slotPath = worktree?.path ?? worktreePathForName(root, `feat${index}`, location);
	if (!worktree) {
		return emptySlot(index, slotPath);
	}
	const state = await readSlotState({ files, git, index, slotPath, worktree });
	return state;
}
