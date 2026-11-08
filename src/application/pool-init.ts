import type { PoolState, Slot } from "../domain/worktree.ts";
import type { ProjectConfig, WorktreeLocation } from "../domain/config.ts";
import { buildPoolState, ensurePlaceholderBranch, placeholderBranchFor } from "./pool-state.ts";
import { ConfigError } from "../errors.ts";
import type { Deps } from "../services.ts";
import { listWorktrees } from "../git/worktrees.ts";
import { projectNameFor } from "../domain/config.ts";
import { runBootstrap } from "./hooks.ts";

export async function initializeSlots(options: {
	command: string | null;
	deps: Deps;
	location: WorktreeLocation;
	project: ProjectConfig;
	root: string;
	state: PoolState;
}): Promise<PoolState> {
	const { command, deps, location, project, root, state: initialState } = options;
	let state = initialState;
	for (const slot of initialState.slots) {
		const pending = !slot.exists || !slot.initialized;
		if (pending) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- Git worktree mutations must run in order
			state = await initializeSlot({ command, deps, location, project, root, slot, state });
		}
	}
	return state;
}
// --- Private functions ---

function requireCommand(project: ProjectConfig, command: string | null): string {
	if (!command) {
		throw new ConfigError(
			`project ${project.name ?? project.root} requires command for pooled setup`,
		);
	}
	return command;
}

async function addSlotWorktree(options: {
	branch: string;
	deps: Deps;
	location: WorktreeLocation;
	root: string;
	slot: Slot;
}): Promise<void> {
	const { branch, deps, location, root, slot } = options;
	await deps.files.prepareParent({ root, path: slot.path, location, git: deps.git });
	await deps.git.run(["-C", root, "worktree", "add", slot.path, branch]);
}

async function bootstrapSlot(options: {
	command: string;
	deps: Deps;
	project: ProjectConfig;
	root: string;
	slot: Slot;
}): Promise<void> {
	const { command, deps, project, root, slot } = options;
	await deps.files.copy({ root, target: slot.path, entries: project.copy, git: deps.git });
	await runBootstrap(deps, {
		command,
		created: slot.path,
		pooled: true,
		projectName: projectNameFor(project, root),
		root,
	});
}

async function prepareSlot(options: {
	branch: string;
	command: string | null;
	deps: Deps;
	location: WorktreeLocation;
	project: ProjectConfig;
	root: string;
	slot: Slot;
}): Promise<void> {
	const { branch, command, deps, location, project, root, slot } = options;
	const createdWorktree = !slot.exists;
	if (createdWorktree) {
		await addSlotWorktree({ branch, deps, location, root, slot });
	}
	const bootstrapCommand = requireCommand(project, command);
	try {
		await bootstrapSlot({ command: bootstrapCommand, deps, project, root, slot });
	} catch (error) {
		if (createdWorktree) {
			await deps.git.runRaw(["-C", root, "worktree", "remove", "--force", slot.path]);
		}
		throw error;
	}
}

async function initializeSlot(options: {
	command: string | null;
	deps: Deps;
	location: WorktreeLocation;
	project: ProjectConfig;
	root: string;
	slot: Slot;
	state: PoolState;
}): Promise<PoolState> {
	const { command, deps, location, project, root, slot, state } = options;
	const branch = placeholderBranchFor(slot.index);
	deps.progress.banner(`[wk-pool] initializing feat${slot.index}…`);
	await ensurePlaceholderBranch({ branch, git: deps.git, root, trunk: state.trunk });
	await prepareSlot({ branch, command, deps, location, project, root, slot });
	const worktrees = await listWorktrees(deps.git, root);
	return buildPoolState({ deps, location, project, worktrees });
}
