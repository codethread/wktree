import type { BranchState, PoolState, Slot, Worktree } from "../domain/worktree.ts";
import {
	ConfigError,
	DuplicateBranchError,
	PickerCancelled,
	UsageError,
	WktreeError,
} from "../errors.ts";
import type { PoolFullPayload, ReadyAddPayload } from "../protocol.ts";
import type { ProjectConfig, TreesConfig, WorktreeLocation } from "../domain/config.ts";
import {
	addNonPoolWorktree,
	captureExistingBranchHead,
	checkoutBranchInSlot,
	mergeOriginIfPresent,
	prepareAddBranch,
	resolvePoolResetCommit,
	rollbackNonPoolAdd,
	rollbackPooledAllocation,
} from "./add-worktree.ts";
import { buildPoolSlots, recycleSlot } from "../application/pool.ts";
import {
	buildRecycleConfirmPrompt,
	pickFullPoolSlot,
	toPoolFullPayload,
} from "./add-pool-picker.ts";
import type { Deps } from "../services.ts";
import { explicitSlotAction } from "../domain/worktree.ts";
import { listWorktrees } from "../git/worktrees.ts";
import { projectNameFor } from "../domain/config.ts";
import { setupPooledCheckout } from "../application/pooled-setup.ts";
import { toAddPayload } from "../protocol.ts";

interface PooledAddOptions {
	/** Branch base requested by the caller. */
	base: string | null;
	/** Branch being allocated. */
	branch: string;
	/** Resolved bootstrap command. */
	command: string | null;
	/** Loaded configuration. */
	config: TreesConfig;
	/** Injected command services. */
	deps: Deps;
	/** Whether to force recycling. */
	force: boolean;
	/** Whether picker UI is interactive. */
	interactive: boolean;
	/** Whether full pools produce JSON rather than a picker. */
	json: boolean;
	/** Use only local refs and objects throughout allocation. */
	noNetwork: boolean;
	/** Skip bootstrap without changing copy/safety behavior. */
	skipCommand: boolean;
	/** Configured pooled project. */
	project: ProjectConfig;
	/** Canonical repository root. */
	root: string;
	/** Explicit slot override, if requested. */
	slotPath: string | null;
	/** Placement of new pool worktrees. */
	worktreeLocation: WorktreeLocation;
}
interface PreparedPool extends PooledAddOptions {
	/** Branch state observed from available refs. */
	branchState: BranchState;
	/** Pool observations before allocation. */
	state: Pick<PoolState, "root" | "slots">;
	/** Validated local commit used to return an existing slot to its placeholder. */
	resetCommit: string;
}
interface Allocation extends PreparedPool {
	/** Selected slot to prepare and allocate. */
	slot: Slot;
}

export async function addPooledWorktree(
	options: PooledAddOptions,
): Promise<ReadyAddPayload | PoolFullPayload> {
	const prepared = await preparePooledAdd(options);
	if (options.slotPath) {
		const slot = await selectExplicitSlot(prepared, options.slotPath);
		return allocatePooledSlot({ ...prepared, slot });
	}
	return allocateAvailableSlot(prepared);
}
// --- Private functions ---

function assertBranchAvailable(worktrees: Worktree[], branch: string): void {
	const existing = worktrees.find((worktree) => worktree.branch === branch);
	if (existing) {
		throw new DuplicateBranchError(`branch ${branch} is already checked out at ${existing.path}`);
	}
}

async function inspectPool(options: PooledAddOptions): Promise<Pick<PoolState, "root" | "slots">> {
	const { deps, project, root, worktreeLocation } = options;
	const worktrees = await listWorktrees(deps.git, root);
	assertBranchAvailable(worktrees, options.branch);
	return {
		root,
		slots: await buildPoolSlots({ deps, location: worktreeLocation, project, worktrees }),
	};
}

async function preparePooledAdd(options: PooledAddOptions): Promise<PreparedPool> {
	const { base, branch, config, deps, root } = options;
	const worktrees = await listWorktrees(deps.git, root);
	assertBranchAvailable(worktrees, branch);
	const preparedBranch = await prepareAddBranch({
		base,
		branch,
		config,
		deps,
		root,
		noNetwork: options.noNetwork,
	});
	const state = await inspectPool(options);
	const resetCommit = await resolvePoolResetCommit(options);
	return { ...options, ...preparedBranch, resetCommit, state };
}

async function populatePooledSlot(options: Allocation): Promise<void> {
	const { branch, command, deps, project, root, slot } = options;
	await mergeOriginIfPresent({
		branch,
		git: deps.git,
		progress: deps.progress,
		worktreePath: slot.path,
	});
	await setupPooledCheckout(deps, {
		root,
		target: slot.path,
		entries: project.copy,
		projectName: projectNameFor(project, root),
		command,
		skipCommand: options.skipCommand,
	});
}

async function allocatePooledSlot(options: Allocation): Promise<ReadyAddPayload> {
	const { branch, branchState, command, deps, project, root, slot } = options;
	if (!command && !options.skipCommand) {
		throw new ConfigError(
			`project ${project.name ?? project.root} requires command for pooled setup`,
		);
	}
	const originalBranchHead = await captureExistingBranchHead({
		branch,
		branchState,
		git: deps.git,
		root,
	});
	await checkoutPooledSlot(options);
	try {
		await populatePooledSlot(options);
	} catch (error) {
		await rollbackSelectedSlot({ ...options, originalBranchHead });
		throw error;
	}
	return toAddPayload({
		branch,
		createdNewBranch: branchState === "none" || branchState === "remote",
		rollbackBranchHead: originalBranchHead,
		root,
		title: branch,
		worktreePath: slot.path,
	});
}

async function checkoutPooledSlot(options: Allocation): Promise<void> {
	const { base, branch, branchState, deps, root, slot } = options;
	if (!slot.exists || !slot.initialized) {
		deps.progress.banner(`[wk-pool] initializing feat${slot.index}…`);
	}
	if (slot.exists) {
		await checkoutBranchInSlot({
			base,
			branch,
			git: deps.git,
			progress: deps.progress,
			slotPath: slot.path,
			state: branchState,
		});
		return;
	}
	await deps.files.prepareParent({
		root,
		path: slot.path,
		location: options.worktreeLocation,
		git: deps.git,
	});
	await addNonPoolWorktree({
		base,
		branch,
		git: deps.git,
		path: slot.path,
		progress: deps.progress,
		root,
		state: branchState,
	});
}

async function rollbackSelectedSlot(
	options: Allocation & { originalBranchHead: string | null },
): Promise<void> {
	const { branch, branchState, deps, originalBranchHead, root, slot } = options;
	const rollback = { branch, branchState, git: deps.git, originalBranchHead, root };
	if (slot.exists) {
		await rollbackPooledAllocation({ ...rollback, slot, resetCommit: options.resetCommit });
		return;
	}
	await rollbackNonPoolAdd({ ...rollback, worktreePath: slot.path });
}

async function recycleAndReadSlot(
	options: PreparedPool,
	selected: Slot,
	force: boolean,
): Promise<Slot | undefined> {
	const { deps, project, root, worktreeLocation } = options;
	let preparedReset: { slot: Slot; commit: string } | undefined = undefined;
	if (options.noNetwork) {
		preparedReset = { slot: selected, commit: options.resetCommit };
	}
	await recycleSlot({
		preparedReset,
		files: deps.files,
		force,
		git: deps.git,
		// eslint-disable-next-line unicorn/no-null -- recycleSlot's API uses null when no integration ref is requested.
		integratedInto: null,
		keepBranch: false,
		project,
		root,
		slotPath: selected.path,
		worktreeLocation,
	});
	const slots = await buildPoolSlots({
		deps,
		location: worktreeLocation,
		project,
		worktrees: await listWorktrees(deps.git, root),
	});
	return slots.find((candidate) => candidate.index === selected.index);
}

async function selectExplicitSlot(options: PreparedPool, slotPath: string): Promise<Slot> {
	const { deps, state } = options;
	const selected = state.slots.find(
		(candidate) => deps.files.normalizePath(candidate.path) === deps.files.normalizePath(slotPath),
	);
	if (!selected) {
		throw new UsageError(`pool slot not found: ${slotPath}`);
	}
	if (explicitSlotAction(selected, options.force) === "allocate") {
		return selected;
	}
	return (await recycleAndReadSlot(options, selected, options.force)) ?? selected;
}

async function confirmRecycle(options: PreparedPool, selected: Slot): Promise<void> {
	if (options.force) {
		return;
	}
	const confirmed = await options.deps.picker.confirm(
		await buildRecycleConfirmPrompt(options.deps.git, selected),
	);
	if (!confirmed) {
		throw new PickerCancelled();
	}
}

async function recycleFullPoolSlot(options: PreparedPool): Promise<Slot> {
	const selected = await pickFullPoolSlot({
		deps: options.deps,
		interactive: options.interactive,
		noNetwork: options.noNetwork,
		state: options.state,
	});
	await confirmRecycle(options, selected);
	const recycled = await recycleAndReadSlot(options, selected, true);
	if (!recycled) {
		throw new WktreeError(`pool slot disappeared after recycle: ${selected.path}`);
	}
	return recycled;
}

async function allocateAvailableSlot(
	options: PreparedPool,
): Promise<ReadyAddPayload | PoolFullPayload> {
	const slot =
		options.state.slots.find(
			(candidate) =>
				candidate.exists && candidate.initialized && candidate.placeholder && !candidate.dirty,
		) ??
		options.state.slots.find(
			(candidate) => !candidate.exists || (candidate.placeholder && !candidate.dirty),
		);
	if (slot) {
		return allocatePooledSlot({ ...options, slot });
	}
	if (options.json) {
		return toPoolFullPayload(options.deps.git, options.state, options.branch);
	}
	const recycled = await recycleFullPoolSlot(options);
	return allocatePooledSlot({ ...options, slot: recycled });
}
