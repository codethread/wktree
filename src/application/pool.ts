import type { Deps, GitRunner, WorkspaceFiles } from "../services.ts";
import { DirtySlotError, UsageError } from "../errors.ts";
import type { PoolState, Slot, Worktree } from "../domain/worktree.ts";
import type { ProjectConfig, TreesConfig, WorktreeLocation } from "../domain/config.ts";
import { assertBranchHasMergedUpstream, assertBranchIntegratedInto } from "./branches.ts";
import { buildPoolState, placeholderBranchFor } from "./pool-state.ts";
import { initializeSlots } from "./pool-init.ts";
import { listWorktrees } from "../git/worktrees.ts";

/** A pool without configured slots reports zero size. */
const NO_COUNT = 0;

export async function recycleSlot(options: {
	files: WorkspaceFiles;
	git: GitRunner;
	project: ProjectConfig;
	root: string;
	slotPath: string;
	force: boolean;
	keepBranch: boolean;
	integratedInto: string | null;
	worktreeLocation: WorktreeLocation;
	/** Add-local offline reset resolved before slot mutation. Other callers discover/fetch normally. */
	preparedReset?: { slot: Slot; commit: string } | undefined;
}): Promise<void> {
	const { git, root, keepBranch, integratedInto } = options;
	const { slot, resetCommit } = await resolveRecycleReset(options);
	if (options.force) {
		await forceResetSlot({ git, keepBranch, root, slot, resetCommit });
		return;
	}
	await recycleSlotSafely({ git, integratedInto, keepBranch, root, slot, resetCommit });
}

export async function ensurePool(options: {
	/** Pool to materialize. */
	project: ProjectConfig;
	/** Injected operation boundaries. */
	deps: Deps;
	/** Reuse an inventory already obtained by the command. */
	initialWorktrees?: Worktree[] | undefined;
	/** Loaded configuration used to resolve policy. */
	config: TreesConfig;
	/** Bootstrap command already resolved by the caller, when available. */
	resolvedCommand?: string | null;
}): Promise<PoolState> {
	const { project, deps, initialWorktrees, config, resolvedCommand } = options;
	if (!project.poolSize) {
		return unpooledState(project, deps.files);
	}
	const state = await ensurePoolSlots({ config, deps, initialWorktrees, project, resolvedCommand });
	return state;
}
// --- Private functions ---

async function resolveRecycleReset(options: Parameters<typeof recycleSlot>[number]) {
	if (options.preparedReset) {
		return { slot: options.preparedReset.slot, resetCommit: options.preparedReset.commit };
	}
	const { slot, trunk } = await locateSlot(options);
	await options.git.run(["-C", options.root, "fetch", "origin"]);
	return { slot, resetCommit: `origin/${trunk}` };
}

function unpooledState(project: ProjectConfig, files: WorkspaceFiles): PoolState {
	return {
		hasPool: false,
		root: files.normalizePath(project.root),
		size: NO_COUNT,
		slots: [],
		trunk: "",
	};
}

async function locateSlot(options: {
	files: WorkspaceFiles;
	git: GitRunner;
	project: ProjectConfig;
	root: string;
	slotPath: string;
	worktreeLocation: WorktreeLocation;
}): Promise<{ slot: Slot; trunk: string }> {
	const { files, git, project, root, slotPath, worktreeLocation } = options;
	const normalizedSlotPath = files.normalizePath(slotPath);
	const worktrees = await listWorktrees(git, root);
	const state = await buildPoolState({
		deps: { files, git },
		location: worktreeLocation,
		project,
		worktrees,
	});
	const slot = state.slots.find(
		(candidate) => files.normalizePath(candidate.path) === normalizedSlotPath,
	);
	if (!slot?.exists) {
		throw new UsageError(`pool slot not found: ${slotPath}`);
	}
	return { slot, trunk: state.trunk };
}

function recyclableOldBranch(slot: Slot): string | undefined {
	const { branch } = slot;
	if (!branch || branch === placeholderBranchFor(slot.index)) {
		return undefined;
	}
	return branch;
}

async function assertSourceBranchRecyclable(options: {
	branch: string;
	git: GitRunner;
	integratedInto: string | null;
	root: string;
	slotPath: string;
}): Promise<void> {
	const { branch, git, integratedInto, root, slotPath } = options;
	if (integratedInto) {
		await assertBranchIntegratedInto({ branch, git, integratedInto, root, worktreePath: slotPath });
		return;
	}
	await assertBranchHasMergedUpstream(git, root, branch);
}

async function deleteSourceBranch(options: {
	git: GitRunner;
	integratedInto: string | null;
	oldBranch: string;
	root: string;
}): Promise<void> {
	const { git, integratedInto, oldBranch, root } = options;
	if (integratedInto) {
		await git.run(["-C", root, "branch", "-D", oldBranch]);
		return;
	}
	await git.run(["-C", root, "branch", "-d", oldBranch]);
}

async function checkoutPlaceholder(options: {
	git: GitRunner;
	placeholderBranch: string;
	slotPath: string;
	resetCommit: string;
}): Promise<void> {
	const { git, placeholderBranch, slotPath, resetCommit } = options;
	await git.run(["-C", slotPath, "checkout", "-B", placeholderBranch, resetCommit]);
}

async function forceResetSlot(options: {
	git: GitRunner;
	keepBranch: boolean;
	root: string;
	slot: Slot;
	resetCommit: string;
}): Promise<void> {
	const { git, keepBranch, root, slot, resetCommit } = options;
	const oldBranch = recyclableOldBranch(slot);
	await git.run([
		"-C",
		slot.path,
		"checkout",
		"-f",
		"-B",
		placeholderBranchFor(slot.index),
		resetCommit,
	]);
	await git.run(["-C", slot.path, "reset", "--hard", placeholderBranchFor(slot.index)]);
	await git.run(["-C", slot.path, "clean", "-fd"]);
	if (oldBranch && !keepBranch) {
		await git.run(["-C", root, "branch", "-D", oldBranch]);
	}
}

async function recycleSlotSafely(options: {
	git: GitRunner;
	integratedInto: string | null;
	keepBranch: boolean;
	root: string;
	slot: Slot;
	resetCommit: string;
}): Promise<void> {
	const { git, integratedInto, keepBranch, root, slot, resetCommit } = options;
	const status = await git.runRaw(["-C", slot.path, "status", "--porcelain=v1"]);
	if (status.stdout.trim() !== "") {
		throw new DirtySlotError(`slot ${slot.path} has uncommitted changes; pass --force to recycle`);
	}
	const oldBranch = recyclableOldBranch(slot);
	if (!keepBranch && oldBranch) {
		await assertSourceBranchRecyclable({
			branch: oldBranch,
			git,
			integratedInto,
			root,
			slotPath: slot.path,
		});
	}
	await checkoutPlaceholder({
		git,
		placeholderBranch: placeholderBranchFor(slot.index),
		slotPath: slot.path,
		resetCommit,
	});
	if (!keepBranch && oldBranch) {
		await deleteSourceBranch({ git, integratedInto, oldBranch, root });
	}
}

async function ensurePoolSlots(options: {
	config: TreesConfig;
	deps: Deps;
	initialWorktrees: Worktree[] | undefined;
	project: ProjectConfig;
	resolvedCommand: string | null | undefined;
}): Promise<PoolState> {
	const { config, deps, initialWorktrees, project, resolvedCommand } = options;
	const root = deps.files.normalizePath(project.root);
	const policy = deps.config.explain(config, root);
	const worktrees = initialWorktrees ?? (await listWorktrees(deps.git, root));
	const state = await buildPoolState({
		deps,
		location: policy.worktreeLocation,
		project,
		worktrees,
	});
	if (!state.slots.some((slot) => !slot.exists || !slot.initialized)) {
		return state;
	}
	await deps.git.run(["-C", root, "fetch", "origin"]);
	return initializeSlots({
		command: resolvedCommand ?? policy.command.command,
		deps,
		location: policy.worktreeLocation,
		project,
		root,
		state,
	});
}

export {
	buildPoolSlots,
	buildPoolState,
	describeSlotRisk,
	ensurePlaceholderBranch,
} from "./pool-state.ts";
