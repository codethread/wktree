// :module: Reusable git worktree pool manager core
// Exit-code taxonomy:
//   0   success / ready
//   10  blocked / recoverable state (for example `pool_full`)
//   11  unsafe operation refused without explicit force
//   12  usage or config error
//   130 cancelled by picker / user
//   1   unexpected runtime or hook failure

import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {
	explainPolicy,
	findProjectForRoot,
	normalizeExistingPath,
	readConfig,
	resolveCopySource,
} from "./config.ts";
import {
	BlockedError,
	CanonicalRootError,
	ConfigError,
	DirtyCanonicalError,
	DirtySlotError,
	DuplicateBranchError,
	EXIT_CODES,
	NonFastForwardCanonicalError,
	PickerCancelled,
	ReservedPrefixError,
	TrunkDetectionError,
	UnmergedBranchError,
	UnsafeOperationError,
	UsageError,
	WktreeError,
	WrongCanonicalBranchError,
} from "./errors.ts";
import type {GitRunner} from "./git/executor.ts";
export {GitError} from "./git/executor.ts";
import {
	parseTrunkFromRemoteShow,
	parseTrunkFromSymbolicRef,
	parseWorktreeList,
} from "./git/worktrees.ts";
import type {
	AddPlan,
	BlockedPayload,
	CopiedFile,
	CopyEntry,
	Deps,
	PickerItem,
	PoolFullCandidate,
	PoolFullPayload,
	PoolState,
	PostCreateScriptSpec,
	ProgressReporter,
	ProjectConfig,
	ReadyAddPayload,
	ReadyRemovePayload,
	RemovePlan,
	SessionInfo,
	Slot,
	Worktree,
} from "./types.ts";

export {explainPolicy, parseConfig} from "./config.ts";
export {LiveHookRunner} from "./hooks.ts";
export {
	BlockedError,
	CanonicalRootError,
	ConfigError,
	DirtySlotError,
	DuplicateBranchError,
	EXIT_CODES,
	HookError,
	PickerCancelled,
	ReservedPrefixError,
	TrunkDetectionError,
	UnmergedBranchError,
	UnsafeOperationError,
	UsageError,
	WktreeError,
} from "./errors.ts";
export type {
	CopiedFile,
	CopyEntry,
	AddPolicy,
	CopyMode,
	Deps,
	FinishPolicy,
	FinishStrategy,
	HookRunner,
	PickerItem,
	PickerService,
	PoolState,
	PostCreateScriptSpec,
	ProgressReporter,
	ProjectConfig,
	Slot,
	TreesConfig,
	Worktree,
} from "./types.ts";
const USAGE = `wktree - reusable git worktree pool manager

Usage: wktree <subcommand> [options]

Subcommands:
  root      Print canonical worktree root
  list      List worktrees
  path      Print worktree path for branch
  add       Add or allocate a worktree
  remove    Remove or recycle a worktree
  ensure    Materialise pooled worktree slots
  status    Print pool status JSON
  recycle   Recycle a pooled slot
  copy      Re-run configured copy setup
  config    Inspect effective configuration

Options:
  -h, --help  Show this help message
`;

export interface CommandResult {
	stdout?: string;
	stderr?: string;
	exitCode: number;
}

interface OutputMode {
	json: boolean;
}

export async function dispatch(
	subcommand: string | undefined,
	args: string[],
	deps: Deps,
): Promise<CommandResult> {
	if (!subcommand || subcommand === "--help" || subcommand === "-h") {
		return {stdout: USAGE, exitCode: 0};
	}

	switch (subcommand) {
		case "root":
			return rootCommand(args, deps);
		case "list":
			return listCommand(args, deps);
		case "path":
			return pathCommand(args, deps);
		case "add":
			return addCommand(args, deps);
		case "remove":
			return removeCommand(args, deps);
		case "status":
			return statusCommand(args, deps);
		case "ensure":
			return ensureCommand(args, deps);
		case "recycle":
			return recycleCommand(args, deps);
		case "copy":
			return copyCommand(args, deps);
		case "config":
			return configCommand(args, deps);
		default:
			return {stderr: USAGE, exitCode: EXIT_CODES.USAGE};
	}
}


async function rootCommand(args: string[], deps: Deps) {
	const opts = parseOptions(args);
	const cwd = requireOption(opts, "cwd");
	const canonicalRoot = await resolveCanonicalRoot(deps.git, cwd);
	return {stdout: `${canonicalRoot}\n`, exitCode: 0};
}

async function listCommand(args: string[], deps: Deps) {
	const opts = parseOptions(args);
	const cwd = requireOption(opts, "cwd");
	const output = parseOutputMode(opts);
	const machineDeps = withMachineJsonProgress(deps, output);
	const config = readConfig();
	const canonicalRoot = await resolveCanonicalRoot(machineDeps.git, cwd);
	const project = findProjectForRoot(config, canonicalRoot);
	if (project?.poolSize) await ensurePool(project, machineDeps);
	const worktrees = await listWorktrees(machineDeps.git, cwd);
	if (output.json) return {stdout: `${JSON.stringify(worktrees.map(toListJson), null, 2)}\n`, exitCode: 0};
	return {stdout: formatWorktreeList(worktrees), exitCode: 0};
}

async function pathCommand(args: string[], deps: Deps) {
	const opts = parseOptions(args);
	const cwd = requireOption(opts, "cwd");
	const branch = requireOption(opts, "branch");
	const canonicalRoot = await resolveCanonicalRoot(deps.git, cwd);
	const project = findProjectForRoot(readConfig(), canonicalRoot);
	if (project?.poolSize) {
		const state = await buildPoolState(project, await listWorktrees(deps.git, canonicalRoot), deps.git);
		const slot = state.slots.find((candidate) => candidate.branch === branch);
		if (!slot) throw new BlockedError(`no pooled worktree found for branch ${branch}`);
		return {stdout: `${slot.path}\n`, exitCode: 0};
	}
	return {stdout: `${canonicalRoot}__${encodeBranch(branch)}\n`, exitCode: 0};
}

async function addCommand(args: string[], deps: Deps) {
	const opts = parseOptions(args);
	const cwd = requireOption(opts, "cwd");
	const branch = requireOption(opts, "branch");
	const output = parseOutputMode(opts);
	const machineDeps = withMachineJsonProgress(deps, output);
	const slotPath = typeof opts.slot === "string" ? opts.slot : null;
	const base = typeof opts.base === "string" ? opts.base : null;
	if (branch.startsWith("wk-pool/")) {
		throw new ReservedPrefixError("branch names starting with wk-pool/ are reserved");
	}

	try {
		const canonicalRoot = await resolveCanonicalRoot(machineDeps.git, cwd);
		const config = readConfig();
		const project = findProjectForRoot(config, canonicalRoot);
		if (slotPath && !project?.poolSize) {
			throw new UsageError("--slot is only valid for pooled projects");
		}
		if (project?.poolSize) {
			return addPooledWorktree({
				deps: machineDeps,
				project,
				root: canonicalRoot,
				branch,
				slotPath,
				output,
				base,
				force: opts.force === true,
			});
		}

		const worktreePath = `${canonicalRoot}__${encodeBranch(branch)}`;
		if (normalizeExistingPath(worktreePath) === normalizeExistingPath(canonicalRoot)) {
			throw new CanonicalRootError("refusing to use canonical root as worktree target");
		}

		await machineDeps.git.run(["-C", canonicalRoot, "fetch", "origin"]);
		const branchState = await detectBranchState(machineDeps.git, canonicalRoot, branch);
		let defaultBase: string | null = null;
		if (branchState === "none") {
			if (base) {
				defaultBase = base;
			} else {
				const defaultBranch = await detectOriginDefaultBranch(machineDeps.git, canonicalRoot);
				if (explainPolicy(config, canonicalRoot).addPolicy === "fresh_canonical") {
					await fastForwardCanonicalDefault(machineDeps.git, canonicalRoot, defaultBranch);
					defaultBase = defaultBranch;
				} else {
					defaultBase = `origin/${defaultBranch}`;
				}
			}
		}
		const originalBranchHead = await captureExistingBranchHead({
			git: machineDeps.git,
			root: canonicalRoot,
			branch,
			branchState,
		});
		await addNonPoolWorktree({
			git: machineDeps.git,
			root: canonicalRoot,
			path: worktreePath,
			branch,
			state: branchState,
			base: base ?? defaultBase,
			progress: machineDeps.progress,
		});
		try {
			await mergeOriginIfPresent({
				git: machineDeps.git,
				worktreePath,
				branch,
				progress: machineDeps.progress,
			});
			if (project) {
				await runCopySetup({
					git: machineDeps.git,
					root: canonicalRoot,
					target: worktreePath,
					entries: project.copy,
				});
			}
		} catch (error) {
			await rollbackNonPoolAdd({
				git: machineDeps.git,
				root: canonicalRoot,
				worktreePath,
				branch,
				branchState,
				originalBranchHead,
			});
			throw error;
		}

		const postCreateScriptPath = project?.command
			? writePostCreateScript({project, root: canonicalRoot, created: worktreePath, branch, pooled: false})
			: null;
		const plan: AddPlan = {
			worktreePath,
			branch,
			root: canonicalRoot,
			title: branch,
			postCreateScriptPath,
			createdNewBranch: branchState === "none" || branchState === "remote",
			rollbackBranchHead: originalBranchHead,
		};
		return finalizeStructuredResult(toAddPayload(plan), output);
	} catch (error) {
		const blocked = toBlockedCommandResult(error, output, {branch, slot_path: slotPath ?? undefined});
		if (blocked) return blocked;
		throw error;
	}
}

async function addPooledWorktree(options: {
	deps: Deps;
	project: ProjectConfig;
	root: string;
	branch: string;
	slotPath: string | null;
	output: OutputMode;
	base: string | null;
	force: boolean;
}): Promise<CommandResult> {
	const {deps, project, root, branch, slotPath, output, base, force} = options;
	let worktrees = await listWorktrees(deps.git, root);
	for (const worktree of worktrees) {
		if (worktree.branch === branch) {
			throw new DuplicateBranchError(`branch ${branch} is already checked out at ${worktree.path}`);
		}
	}
	await ensurePool(project, deps, worktrees);
	worktrees = await listWorktrees(deps.git, root);
	for (const worktree of worktrees) {
		if (worktree.branch === branch) {
			throw new DuplicateBranchError(`branch ${branch} is already checked out at ${worktree.path}`);
		}
	}
	await deps.git.run(["-C", root, "fetch", "origin"]);
	let state = await buildPoolState(project, worktrees, deps.git);

	if (slotPath) {
		const selected = state.slots.find(
			(candidate) => normalizeExistingPath(candidate.path) === normalizeExistingPath(slotPath),
		);
		if (!selected?.exists) throw new UsageError(`pool slot not found: ${slotPath}`);
		if (!selected.initialized) throw new BlockedError(`pool slot is not initialized: ${selected.path}`);
		let targetSlot = selected;
		if (!targetSlot.placeholder) {
			await recycleSlot({git: deps.git, project, root, slotPath: targetSlot.path, force, keepBranch: false});
			state = await buildPoolState(project, await listWorktrees(deps.git, root), deps.git);
			targetSlot = state.slots.find((candidate) => candidate.index === selected.index) ?? targetSlot;
		}
		return finalizeStructuredResult(
			await allocatePooledSlot({deps, project, root, slot: targetSlot, branch, base}),
			output,
		);
	}

	const slot = state.slots.find(
		(candidate) => candidate.exists && candidate.initialized && candidate.placeholder,
	);
	if (slot) {
		return finalizeStructuredResult(
			await allocatePooledSlot({deps, project, root, slot, branch, base}),
			output,
		);
	}

	if (output.json) {
		return finalizeStructuredResult(
			await toPoolFullPayload(deps.git, state, branch),
			output,
			EXIT_CODES.BLOCKED,
		);
	}

	const selected = await pickFullPoolSlot({deps, state});
	if (!force) {
		const confirmed = await deps.picker.confirm(await buildRecycleConfirmPrompt(deps.git, selected));
		if (!confirmed) throw new PickerCancelled();
	}
	await recycleSlot({git: deps.git, project, root, slotPath: selected.path, force: true, keepBranch: false});
	state = await buildPoolState(project, await listWorktrees(deps.git, root), deps.git);
	const recycled = state.slots.find((candidate) => candidate.index === selected.index);
	if (!recycled) throw new WktreeError(`pool slot disappeared after recycle: ${selected.path}`);
	return finalizeStructuredResult(
		await allocatePooledSlot({deps, project, root, slot: recycled, branch, base}),
		output,
	);
}

async function allocatePooledSlot(options: {
	deps: Deps;
	project: ProjectConfig;
	root: string;
	slot: Slot;
	branch: string;
	base: string | null;
}): Promise<ReadyAddPayload> {
	const {deps, project, root, slot, branch, base} = options;
	const branchState = await detectBranchState(deps.git, root, branch);
	const originalBranchHead = await captureExistingBranchHead({git: deps.git, root, branch, branchState});
	const defaultBase =
		branchState === "none" && !base ? await detectOriginDefaultBranch(deps.git, root) : null;
	await checkoutBranchInSlot({
		git: deps.git,
		slotPath: slot.path,
		branch,
		state: branchState,
		base: base ?? defaultBase,
		progress: deps.progress,
	});
	try {
		await mergeOriginIfPresent({git: deps.git, worktreePath: slot.path, branch, progress: deps.progress});
		await runCopySetup({git: deps.git, root, target: slot.path, entries: project.copy});
	} catch (error) {
		await rollbackPooledAllocation({git: deps.git, root, slot, branch, branchState, originalBranchHead});
		throw error;
	}
	if (!project.command) throw new ConfigError(`project ${project.name ?? project.root} requires command for pooled setup`);
	const postCreateScriptPath = writePostCreateScript({
		project,
		root,
		created: slot.path,
		branch,
		pooled: true,
	});
	const plan: AddPlan = {
		worktreePath: slot.path,
		branch,
		root,
		title: branch,
		postCreateScriptPath,
		createdNewBranch: branchState === "none" || branchState === "remote",
		rollbackBranchHead: originalBranchHead,
	};
	return toAddPayload(plan);
}

async function pickFullPoolSlot(options: {deps: Deps; state: PoolState}): Promise<Slot> {
	const {deps, state} = options;
	const candidates = state.slots.filter((slot) => slot.exists && slot.initialized && !slot.placeholder);
	if (candidates.length === 0) throw new WktreeError("pool full; no recyclable slots found");
	const items: PickerItem[] = [];
	for (const slot of candidates) {
		const risk = await describeSlotRisk(deps.git, slot);
		items.push({
			key: String(slot.index),
			display: `${shellQuote(slot.path)}\tfeat${slot.index}  ${slot.branch ?? "(detached)"}  ${formatRelativeAge(slot.lastCommitIso)}${slot.dirty ? "  [dirty]" : ""}${risk.ahead > 0 ? `  [${risk.ahead} ahead]` : ""}${risk.localOnly ? "  [local-only]" : ""}`,
			preview: buildPickerPreview(),
		});
	}
	const selected = await deps.picker.pick(items, "Select a worktree slot to recycle");
	return candidates.find((slot) => String(slot.index) === selected.key) ?? candidates[0];
}

async function describeSlotRisk(
	git: GitRunner,
	slot: Slot,
): Promise<{ahead: number; behind: number; localOnly: boolean}> {
	const upstream = await git.runRaw(["-C", slot.path, "rev-parse", "--abbrev-ref", "@{upstream}"]);
	if (upstream.exitCode !== 0 || upstream.stdout.trim() === "") return {ahead: 0, behind: 0, localOnly: true};
	const counts = await git.runRaw([
		"-C",
		slot.path,
		"rev-list",
		"--left-right",
		"--count",
		`${upstream.stdout.trim()}...HEAD`,
	]);
	const [behind, ahead] = counts.stdout
		.trim()
		.split(/\s+/)
		.map((value) => Number(value));
	return {ahead: ahead || 0, behind: behind || 0, localOnly: false};
}

function buildPickerPreview(): string {
	return `slot={1}; counts=$(git -C "$slot" rev-list --left-right --count @{upstream}...HEAD 2>/dev/null); if [ $? -ne 0 ] || [ -z "$counts" ]; then echo '⚠ local-only branch'; else ahead=$(echo "$counts" | awk '{print $2}'); [ "$ahead" -gt 0 ] 2>/dev/null && echo "⚠ $ahead unpushed commits will be lost"; echo "upstream: $(echo "$counts" | awk '{print $1}') behind, $ahead ahead"; fi; git -C "$slot" log -5 --format='%h %s'; git -C "$slot" status --porcelain | head`;
}

async function buildRecycleConfirmPrompt(git: GitRunner, slot: Slot): Promise<string> {
	const risk = await describeSlotRisk(git, slot);
	const warnings = [
		slot.dirty ? "dirty changes will be lost" : null,
		risk.localOnly ? "local-only branch" : null,
		risk.ahead > 0 ? `⚠ ${risk.ahead} unpushed commits will be lost` : null,
	]
		.filter(Boolean)
		.join("; ");
	return `Recycle feat${slot.index} (${slot.branch ?? "detached"})${warnings ? `: ${warnings}` : ""}? [y/N] `;
}

function formatRelativeAge(iso: string | null): string {
	if (!iso) return "unknown";
	const ageMs = Date.now() - Date.parse(iso);
	const days = Math.floor(ageMs / 86_400_000);
	if (days > 0) return `${days}d ago`;
	const hours = Math.floor(ageMs / 3_600_000);
	return hours > 0 ? `${hours}h ago` : "now";
}

async function ensureCommand(args: string[], deps: Deps) {
	const opts = parseOptions(args);
	const cwd = requireOption(opts, "cwd");
	const worktrees = await listWorktrees(deps.git, cwd);
	const canonical = worktrees.find((worktree) => worktree.canonical);
	if (!canonical) throw new WktreeError("couldn't determine canonical worktree");
	const project = findProjectForRoot(readConfig(), canonical.path);
	if (project?.poolSize) await ensurePool(project, deps, worktrees);
	return {exitCode: 0};
}

async function statusCommand(args: string[], deps: Deps) {
	const opts = parseOptions(args);
	const cwd = requireOption(opts, "cwd");
	const worktrees = await listWorktrees(deps.git, cwd);
	const canonical = worktrees.find((worktree) => worktree.canonical);
	if (!canonical) throw new WktreeError("couldn't determine canonical worktree");
	const project = findProjectForRoot(readConfig(), canonical.path);
	if (!project?.poolSize) {
		return {
			stdout: `${JSON.stringify({root: canonical.path, trunk: null, size: 0, slots: []}, null, 2)}\n`,
			exitCode: 0,
		};
	}
	const state = await buildPoolState(project, worktrees, deps.git);
	return {stdout: `${JSON.stringify(state, null, 2)}\n`, exitCode: 0};
}

export async function buildPoolState(
	cfg: ProjectConfig,
	worktrees: Worktree[],
	git: GitRunner,
): Promise<PoolState> {
	if (!cfg.poolSize) throw new ConfigError(`project ${cfg.name ?? cfg.root} is not pooled`);
	const root = normalizeExistingPath(cfg.root);
	const trunk = await detectOriginDefaultBranch(git, root);
	const slots = await Promise.all(
		Array.from({length: cfg.poolSize}, (_, offset) =>
			buildPoolSlotState({
				index: offset + 1,
				root,
				worktrees,
				git,
			}),
		),
	);
	return {root, trunk, size: cfg.poolSize, slots};
}

async function buildPoolSlotState(options: {
	index: number;
	root: string;
	worktrees: Worktree[];
	git: GitRunner;
}): Promise<Slot> {
	const {index, root, worktrees, git} = options;
	const slotPath = `${root}__feat${index}`;
	const worktree = worktrees.find((candidate) => normalizeExistingPath(candidate.path) === slotPath);
	if (!worktree) {
		return {
			index,
			path: slotPath,
			exists: false,
			branch: null,
			placeholder: false,
			dirty: false,
			lastCommitIso: null,
			lastCommitSubject: null,
			initialized: false,
		};
	}

	const branch = worktree.branch;
	const [status, log, marker] = await Promise.all([
		git.runRaw(["-C", slotPath, "status", "--porcelain=v1"]),
		git.runRaw(["-C", slotPath, "log", "-1", "--format=%cI%x1f%s"]),
		git.runRaw(["-C", slotPath, "rev-parse", "--git-path", "wk-pool-initialized"]),
	]);
	const [lastCommitIso, lastCommitSubject] =
		log.exitCode === 0 && log.stdout.trim() !== "" ? log.stdout.trimEnd().split("\x1f", 2) : [null, null];
	return {
		index,
		path: slotPath,
		exists: true,
		branch,
		placeholder: branch === `wk-pool/feat${index}`,
		dirty: status.stdout.trim() !== "",
		lastCommitIso,
		lastCommitSubject,
		initialized: marker.exitCode === 0 && existsSync(resolve(slotPath, marker.stdout.trim())),
	};
}

async function removeCommand(args: string[], deps: Deps) {
	const opts = parseOptions(args);
	const cwd = requireOption(opts, "cwd");
	const output = parseOutputMode(opts);
	const machineDeps = withMachineJsonProgress(deps, output);
	const branch = typeof opts.branch === "string" ? opts.branch : null;
	const self = typeof opts.self === "string" ? opts.self : null;
	const force = opts.force === true;
	const keepBranch = opts["keep-branch"] === true;
	if ((branch && self) || (!branch && !self)) {
		throw new UsageError("provide exactly one of --branch or --self");
	}

	let targetPath: string | undefined;
	try {
		let worktrees = await listWorktrees(machineDeps.git, cwd);
		const canonical = worktrees.find((worktree) => worktree.canonical);
		if (!canonical) throw new WktreeError("couldn't determine canonical worktree");
		const project = findProjectForRoot(readConfig(), canonical.path);
		if (project?.poolSize) {
			await ensurePool(project, machineDeps, worktrees);
			worktrees = await listWorktrees(machineDeps.git, cwd);
		}
		const target = resolveRemoveTarget(worktrees, canonical.path, {branch, self});
		targetPath = target.path;
		if (normalizeExistingPath(target.path) === normalizeExistingPath(canonical.path)) {
			throw new CanonicalRootError("refusing to remove canonical root");
		}
		if (project?.poolSize && target.pool) {
			await recycleSlot({
				git: machineDeps.git,
				project,
				root: canonical.path,
				slotPath: target.path,
				force,
				keepBranch,
			});
			return finalizeStructuredResult(toRemovePayload({worktreePath: target.path, removed: false}), output);
		}

		if (target.branch && !force)
			await assertBranchSafelyDeletable(machineDeps.git, canonical.path, target.branch);
		await machineDeps.git.run([
			"-C",
			canonical.path,
			"worktree",
			"remove",
			...(force ? ["--force"] : []),
			target.path,
		]);
		if (target.branch && !keepBranch) {
			await machineDeps.git.run(["-C", canonical.path, "branch", force ? "-D" : "-d", target.branch]);
		}

		return finalizeStructuredResult(
			toRemovePayload({worktreePath: target.path, removed: !existsSync(target.path)}),
			output,
		);
	} catch (error) {
		const blocked = toBlockedCommandResult(error, output, {
			branch: branch ?? undefined,
			worktree_path: targetPath,
		});
		if (blocked) return blocked;
		throw error;
	}
}

async function recycleCommand(args: string[], deps: Deps) {
	const opts = parseOptions(args);
	const cwd = requireOption(opts, "cwd");
	const slotPath = requireOption(opts, "slot");
	const force = opts.force === true;
	const root = await resolveCanonicalRoot(deps.git, cwd);
	const project = findProjectForRoot(readConfig(), root);
	if (!project?.poolSize) throw new UsageError("recycle requires a pooled project");
	await recycleSlot({git: deps.git, project, root, slotPath, force, keepBranch: false});
	return {exitCode: 0};
}

async function copyCommand(args: string[], deps: Deps) {
	const opts = parseOptions(args);
	const cwd = requireOption(opts, "cwd");
	const output = parseOutputMode(opts);
	try {
		const config = readConfig();
		const worktrees = await listWorktrees(deps.git, cwd);
		const canonical = worktrees.find((worktree) => worktree.canonical);
		if (!canonical) throw new WktreeError("couldn't determine canonical worktree");
		const target = resolveWorktreeContainingPath(worktrees, cwd);
		if (!target) throw new UsageError(`no worktree contains cwd: ${cwd}`);
		if (normalizeExistingPath(target.path) === normalizeExistingPath(canonical.path)) {
			throw new CanonicalRootError("refusing to copy setup into canonical root");
		}
		const project = findProjectForRoot(config, canonical.path);
		const copied = await runCopySetup({
			git: deps.git,
			root: canonical.path,
			target: target.path,
			entries: project?.copy ?? [],
		});
		return finalizeStructuredResult(
			{
				kind: "ready",
				root: canonical.path,
				worktree_path: target.path,
				copied,
				exclude_paths: [...new Set(copied.map((entry) => entry.to))].sort(),
			},
			output,
		);
	} catch (error) {
		const blocked = toBlockedCommandResult(error, output, {});
		if (blocked) return blocked;
		throw error;
	}
}

async function configCommand(args: string[], deps: Deps) {
	const [topic, ...rest] = args;
	if (topic !== "explain") throw new UsageError("expected config explain");
	const opts = parseOptions(rest);
	const cwd = requireOption(opts, "cwd");
	const output = parseOutputMode(opts);
	const canonicalRoot = await resolveCanonicalRoot(deps.git, cwd);
	const explanation = explainPolicy(readConfig(), canonicalRoot);
	const payload = toConfigExplainPayload(explanation);
	if (output.json) return {stdout: `${JSON.stringify(payload, null, 2)}\n`, exitCode: EXIT_CODES.SUCCESS};
	const matchedRules = payload.matched_rules.map((rule) => rule.root_glob).join(", ") || "(none)";
	const project = payload.project ? `${payload.project.name ?? "(unnamed)"} ${payload.project.root}` : "(none)";
	return {
		stdout: `root: ${payload.root}\nmatched_rules: ${matchedRules}\nproject: ${project}\nadd.policy: ${payload.add.policy}\nfinish.enabled: ${payload.finish.enabled}\nfinish.strategy: ${payload.finish.strategy}\nfinish.push: ${payload.finish.push}\nfinish.remove_worktree: ${payload.finish.remove_worktree}\nfinish.delete_branch: ${payload.finish.delete_branch}\n`,
		exitCode: EXIT_CODES.SUCCESS,
	};
}

function toConfigExplainPayload(explanation: ReturnType<typeof explainPolicy>) {
	return {
		kind: "config_explain",
		root: explanation.canonicalRoot,
		matched_rules: explanation.matchedRules.map((rule) => ({root_glob: rule.rootGlob})),
		project: explanation.project
			? {name: explanation.project.name, root: explanation.project.root}
			: null,
		add: {policy: explanation.addPolicy},
		finish: {
			enabled: explanation.finishPolicy.enabled,
			strategy: explanation.finishPolicy.strategy,
			push: explanation.finishPolicy.push,
			remove_worktree: explanation.finishPolicy.removeWorktree,
			delete_branch: explanation.finishPolicy.deleteBranch,
		},
	};
}

async function captureExistingBranchHead(options: {
	git: GitRunner;
	root: string;
	branch: string;
	branchState: BranchState;
}): Promise<string | null> {
	const {git, root, branch, branchState} = options;
	if (branchState !== "local" && branchState !== "local-remote") return null;
	const result = await git.run(["-C", root, "rev-parse", `refs/heads/${branch}`]);
	return result.stdout.trim();
}

async function restoreBranchRef(options: {
	git: GitRunner;
	root: string;
	branch: string;
	branchState: BranchState;
	originalBranchHead: string | null;
}): Promise<void> {
	const {git, root, branch, branchState, originalBranchHead} = options;
	if (branchState === "none" || branchState === "remote") {
		await git.runRaw(["-C", root, "branch", "-D", branch]);
		return;
	}
	if (originalBranchHead) await git.runRaw(["-C", root, "branch", "-f", branch, originalBranchHead]);
}

async function rollbackNonPoolAdd(options: {
	git: GitRunner;
	root: string;
	worktreePath: string;
	branch: string;
	branchState: BranchState;
	originalBranchHead: string | null;
}): Promise<void> {
	const {git, root, worktreePath, branch, branchState, originalBranchHead} = options;
	await git.runRaw(["-C", root, "worktree", "remove", "--force", worktreePath]);
	await restoreBranchRef({git, root, branch, branchState, originalBranchHead});
}

async function rollbackPooledAllocation(options: {
	git: GitRunner;
	root: string;
	slot: Slot;
	branch: string;
	branchState: BranchState;
	originalBranchHead: string | null;
}): Promise<void> {
	const {git, root, slot, branch, branchState, originalBranchHead} = options;
	const trunk = await detectOriginDefaultBranch(git, root);
	const placeholderBranch = `wk-pool/feat${slot.index}`;
	await ensurePlaceholderBranch({git, root, branch: placeholderBranch, trunk});
	await git.runRaw(["-C", slot.path, "checkout", "-f", "-B", placeholderBranch, `origin/${trunk}`]);
	await git.runRaw(["-C", slot.path, "reset", "--hard", placeholderBranch]);
	await git.runRaw(["-C", slot.path, "clean", "-fd"]);
	await restoreBranchRef({git, root, branch, branchState, originalBranchHead});
}

async function recycleSlot(options: {
	git: GitRunner;
	project: ProjectConfig;
	root: string;
	slotPath: string;
	force: boolean;
	keepBranch: boolean;
}): Promise<void> {
	const {git, project, root, slotPath, force, keepBranch} = options;
	const normalizedSlotPath = normalizeExistingPath(slotPath);
	const worktrees = await listWorktrees(git, root);
	const state = await buildPoolState(project, worktrees, git);
	const slot = state.slots.find((candidate) => normalizeExistingPath(candidate.path) === normalizedSlotPath);
	if (!slot?.exists) throw new UsageError(`pool slot not found: ${slotPath}`);
	const placeholderBranch = `wk-pool/feat${slot.index}`;
	const oldBranch = slot.branch;
	await git.run(["-C", root, "fetch", "origin"]);
	if (force) {
		await git.run(["-C", slot.path, "checkout", "-f", "-B", placeholderBranch, `origin/${state.trunk}`]);
		await git.run(["-C", slot.path, "reset", "--hard", placeholderBranch]);
		await git.run(["-C", slot.path, "clean", "-fd"]);
		if (oldBranch && oldBranch !== placeholderBranch) {
			if (!keepBranch) await git.run(["-C", root, "branch", "-D", oldBranch]);
			await killTmuxSessionForPath(slot.path);
		}
		return;
	}

	const dirty = (await git.runRaw(["-C", slot.path, "status", "--porcelain=v1"])).stdout.trim() !== "";
	if (dirty) throw new DirtySlotError(`slot ${slot.path} has uncommitted changes; pass --force to recycle`);
	if (oldBranch && oldBranch !== placeholderBranch) await assertBranchHasMergedUpstream(git, root, oldBranch);
	await git.run(["-C", slot.path, "checkout", "-B", placeholderBranch, `origin/${state.trunk}`]);
	if (oldBranch && oldBranch !== placeholderBranch) {
		if (!keepBranch) await git.run(["-C", root, "branch", "-d", oldBranch]);
		await killTmuxSessionForPath(slot.path);
	}
}

async function assertBranchHasMergedUpstream(git: GitRunner, root: string, branch: string): Promise<void> {
	const upstream = await git.runRaw(["-C", root, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
	if (upstream.exitCode !== 0 || upstream.stdout.trim() === "") {
		throw new UnmergedBranchError(`branch ${branch} has no upstream; pass --force to recycle`);
	}
	const upstreamRef = upstream.stdout.trim();
	const merged = await git.runRaw(["-C", root, "merge-base", "--is-ancestor", branch, upstreamRef]);
	if (merged.exitCode !== 0) {
		throw new UnmergedBranchError(
			`branch ${branch} is not merged to ${upstreamRef}; pass --force to recycle`,
		);
	}
}

async function ensurePool(
	project: ProjectConfig,
	deps: Deps,
	initialWorktrees?: Worktree[],
): Promise<PoolState> {
	if (!project.poolSize) {
		return {root: normalizeExistingPath(project.root), trunk: "", size: 0, slots: []};
	}
	const root = normalizeExistingPath(project.root);
	let worktrees = initialWorktrees ?? (await listWorktrees(deps.git, root));
	let state = await buildPoolState(project, worktrees, deps.git);
	const needsWork = state.slots.some((slot) => !slot.exists || !slot.initialized);
	if (!needsWork) return state;

	await deps.git.run(["-C", root, "fetch", "origin"]);
	for (const slot of state.slots) {
		if (slot.exists && slot.initialized) continue;
		const branch = `wk-pool/feat${slot.index}`;
		deps.progress.banner(`[wk-pool] initializing feat${slot.index}…`);
		await ensurePlaceholderBranch({git: deps.git, root, branch, trunk: state.trunk});
		const createdWorktree = !slot.exists;
		if (createdWorktree) await deps.git.run(["-C", root, "worktree", "add", slot.path, branch]);
		if (!project.command) throw new ConfigError(`project ${project.name ?? project.root} requires command for pooled setup`);
		const postCreateScriptPath = writePostCreateScript({
			project,
			root,
			created: slot.path,
			branch,
			pooled: true,
		});
		try {
			await runCopySetup({git: deps.git, root, target: slot.path, entries: project.copy});
			await deps.hooks.runInline(postCreateScriptPath, slot.path, {}, (stream, line) =>
				deps.progress.stream(stream, line),
			);
		} catch (error) {
			if (createdWorktree) await deps.git.runRaw(["-C", root, "worktree", "remove", "--force", slot.path]);
			throw error;
		}
		worktrees = await listWorktrees(deps.git, root);
		state = await buildPoolState(project, worktrees, deps.git);
	}
	return state;
}

async function ensurePlaceholderBranch(options: {
	git: GitRunner;
	root: string;
	branch: string;
	trunk: string;
}): Promise<void> {
	const {git, root, branch, trunk} = options;
	const exists =
		(await git.runRaw(["-C", root, "show-ref", "--verify", `refs/heads/${branch}`])).exitCode === 0;
	if (!exists) await git.run(["-C", root, "branch", branch, `origin/${trunk}`]);
}

function resolveRemoveTarget(
	worktrees: Worktree[],
	canonicalRoot: string,
	selector: {branch: string | null; self: string | null},
): Worktree {
	const target = selector.branch
		? worktrees.find((worktree) => worktree.branch === selector.branch)
		: worktrees.find(
				(worktree) => normalizeExistingPath(worktree.path) === normalizeExistingPath(selector.self ?? ""),
			);
	if (!target) {
		if (selector.branch) throw new BlockedError(`no worktree found for branch ${selector.branch}`);
		throw new UsageError("target is not a git worktree");
	}
	if (normalizeExistingPath(target.path) === normalizeExistingPath(canonicalRoot))
		throw new CanonicalRootError("refusing to remove canonical root");
	return target;
}

async function assertBranchSafelyDeletable(git: GitRunner, root: string, branch: string): Promise<void> {
	const upstream = await git.runRaw(["-C", root, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
	const mergeTarget = upstream.exitCode === 0 ? upstream.stdout.trim() : "HEAD";
	const merged = await git.runRaw(["-C", root, "merge-base", "--is-ancestor", branch, mergeTarget]);
	if (merged.exitCode !== 0)
		throw new UnmergedBranchError(`branch ${branch} is not merged; pass --force to remove it`);
}

function parseOptions(args: string[]) {
	const opts: Record<string, string | boolean> = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--json" || arg === "--force" || arg === "--keep-branch") {
			opts[arg.slice(2)] = true;
			continue;
		}
		if (arg?.startsWith("--")) {
			const key = arg.slice(2);
			const value = args[index + 1];
			if (value === undefined || value.startsWith("--")) throw new UsageError(`missing value for --${key}`);
			opts[key] = value;
			index++;
		}
	}
	return opts;
}

function requireOption(opts: Record<string, string | boolean>, key: string): string {
	const value = opts[key];
	if (typeof value !== "string" || value === "") throw new UsageError(`missing required --${key}`);
	return value;
}

type BranchState = "local" | "remote" | "local-remote" | "none";

async function detectBranchState(git: GitRunner, root: string, branch: string): Promise<BranchState> {
	const refs = await git.runRaw([
		"-C",
		root,
		"for-each-ref",
		"--format=%(refname)",
		"refs/heads",
		"refs/remotes/origin",
	]);
	const lines = refs.stdout.split("\n");
	const local = lines.includes(`refs/heads/${branch}`);
	const remote = lines.includes(`refs/remotes/origin/${branch}`);
	if (local && remote) return "local-remote";
	if (local) return "local";
	if (remote) return "remote";
	return "none";
}

async function detectOriginDefaultBranch(git: GitRunner, root: string): Promise<string> {
	const symbolic = await git.runRaw(["-C", root, "symbolic-ref", "refs/remotes/origin/HEAD"]);
	const fromSymbolic = symbolic.exitCode === 0 ? parseTrunkFromSymbolicRef(symbolic.stdout) : null;
	if (fromSymbolic) return fromSymbolic;
	const remoteShow = await git.runRaw(["-C", root, "remote", "show", "origin"]);
	const fromRemoteShow = remoteShow.exitCode === 0 ? parseTrunkFromRemoteShow(remoteShow.stdout) : null;
	if (fromRemoteShow) return fromRemoteShow;
	throw new TrunkDetectionError("couldn't determine origin default branch");
}

async function fastForwardCanonicalDefault(
	git: GitRunner,
	root: string,
	defaultBranch: string,
): Promise<void> {
	const status = await git.run(["-C", root, "status", "--porcelain=v1"]);
	if (status.stdout.trim() !== "") {
		throw new DirtyCanonicalError("canonical root has uncommitted changes");
	}
	const current = (await git.run(["-C", root, "branch", "--show-current"])).stdout.trim();
	if (current !== defaultBranch) {
		throw new WrongCanonicalBranchError(
			`canonical root must be checked out on ${defaultBranch}; currently on ${current || "detached HEAD"}`,
		);
	}
	const ancestor = await git.runRaw(["-C", root, "merge-base", "--is-ancestor", "HEAD", `origin/${defaultBranch}`]);
	if (ancestor.exitCode !== 0) {
		throw new NonFastForwardCanonicalError(
			`canonical root cannot fast-forward to origin/${defaultBranch}`,
		);
	}
	await git.run(["-C", root, "merge", "--ff-only", `origin/${defaultBranch}`]);
}

async function addNonPoolWorktree(options: {
	git: GitRunner;
	root: string;
	path: string;
	branch: string;
	state: BranchState;
	base: string | null;
	progress: ProgressReporter;
}): Promise<void> {
	const {git, root, path, branch, state, base, progress} = options;
	if (state !== "none" && base) progress.error("--base ignored: branch already exists");
	if (state === "local" || state === "local-remote") {
		await git.run(["-C", root, "worktree", "add", path, branch]);
		return;
	}
	if (state === "remote") {
		await git.run(["-C", root, "worktree", "add", "--no-track", "-b", branch, path, `origin/${branch}`]);
		return;
	}
	const startPoint = base ? await resolveBaseRef(git, root, base) : "HEAD";
	await git.run(["-C", root, "worktree", "add", "--no-track", "-b", branch, path, startPoint]);
}

async function resolveBaseRef(git: GitRunner, root: string, base: string): Promise<string> {
	if (base.startsWith("origin/")) {
		const remoteName = base.slice("origin/".length);
		const remoteRef =
			(await git.runRaw(["-C", root, "show-ref", "--verify", `refs/remotes/origin/${remoteName}`])).exitCode === 0;
		if (remoteRef) return base;
	}
	const local = (await git.runRaw(["-C", root, "show-ref", "--verify", `refs/heads/${base}`])).exitCode === 0;
	if (local) return base;
	const remote =
		(await git.runRaw(["-C", root, "show-ref", "--verify", `refs/remotes/origin/${base}`])).exitCode === 0;
	if (remote) return `origin/${base}`;
	throw new UsageError(`base branch not found locally or on origin: ${base}`);
}

async function checkoutBranchInSlot(options: {
	git: GitRunner;
	slotPath: string;
	branch: string;
	state: BranchState;
	base: string | null;
	progress: ProgressReporter;
}): Promise<void> {
	const {git, slotPath, branch, state, base, progress} = options;
	if (state !== "none" && base) progress.error("--base ignored: branch already exists");
	if (state === "local" || state === "local-remote") {
		await git.run(["-C", slotPath, "checkout", branch]);
		return;
	}
	if (state === "remote") {
		await git.run(["-C", slotPath, "checkout", "--no-track", "-B", branch, `origin/${branch}`]);
		return;
	}
	const startPoint = base ? await resolveBaseRef(git, slotPath, base) : "HEAD";
	await git.run(["-C", slotPath, "checkout", "--no-track", "-B", branch, startPoint]);
}

async function mergeOriginIfPresent(options: {
	git: GitRunner;
	worktreePath: string;
	branch: string;
	progress: ProgressReporter;
}): Promise<void> {
	const {git, worktreePath, branch, progress} = options;
	const remoteExists =
		(await git.runRaw(["-C", worktreePath, "show-ref", "--verify", `refs/remotes/origin/${branch}`]))
			.exitCode === 0;
	if (!remoteExists) return;
	const merge = await git.runRaw(["-C", worktreePath, "merge", "--ff-only", `origin/${branch}`]);
	if (merge.exitCode !== 0)
		progress.error(`warning: couldn't fast-forward from origin/${branch}; preserving local work`);
}

function writePostCreateScript(options: {
	project: ProjectConfig;
	root: string;
	created: string;
	branch: string;
	pooled: boolean;
}): string {
	const {project, root, created, pooled} = options;
	if (!project.command) throw new ConfigError(`project ${project.name ?? project.root} requires command for post-create script`);
	const session = sessionNameForWorktreePath(created);
	const sessionDir = mkdtempSync(join(tmpdir(), `${session}.wktree.`));
	const postCreateScriptPath = resolve(sessionDir, "post-create.sh");
	writeFileSync(
		postCreateScriptPath,
		generatePostCreateScript({
			projectName: project.name ?? basename(root),
			root,
			created,
			command: project.command,
			pooled,
		}),
		{mode: 0o755},
	);
	return postCreateScriptPath;
}

function parseOutputMode(opts: Record<string, string | boolean>): OutputMode {
	return {
		json: opts.json === true,
	};
}

function finalizeStructuredResult(
	payload: object,
	output: OutputMode,
	exitCode: number = EXIT_CODES.SUCCESS,
): CommandResult {
	return {
		stdout: output.json ? `${JSON.stringify(payload, null, 2)}\n` : undefined,
		exitCode,
	};
}

function toBlockedCommandResult(
	error: unknown,
	output: OutputMode,
	context: Omit<BlockedPayload, "kind" | "reason" | "message">,
): CommandResult | null {
	if (!output.json || !(error instanceof WktreeError)) return null;
	const payload = toBlockedPayload(error, context);
	return payload ? finalizeStructuredResult(payload, output, error.exitCode) : null;
}

function toBlockedPayload(
	error: WktreeError,
	context: Omit<BlockedPayload, "kind" | "reason" | "message">,
): BlockedPayload | null {
	if (!(error instanceof BlockedError) && !(error instanceof UnsafeOperationError)) return null;
	let reason = "blocked";
	if (error instanceof DuplicateBranchError) reason = "duplicate_branch";
	else if (error instanceof DirtySlotError) reason = "dirty_slot";
	else if (error instanceof DirtyCanonicalError) reason = "dirty_canonical";
	else if (error instanceof WrongCanonicalBranchError) reason = "wrong_canonical_branch";
	else if (error instanceof NonFastForwardCanonicalError) reason = "non_ff_canonical";
	else if (error instanceof UnmergedBranchError) reason = "unmerged_branch";
	else if (error instanceof CanonicalRootError) reason = "canonical_root";
	else if (error.exitCode === EXIT_CODES.UNSAFE) reason = "unsafe";
	return {kind: "blocked", reason, message: error.message, ...context};
}

function withMachineJsonProgress(deps: Deps, output: OutputMode): Deps {
	if (!output.json) return deps;
	return {
		...deps,
		progress: {
			banner: (line: string) => deps.progress.banner(line),
			stream: (_stream: "stdout" | "stderr", line: string) => deps.progress.error(line),
			error: (msg: string) => deps.progress.error(msg),
		},
	};
}

function toAddPayload(plan: AddPlan): ReadyAddPayload {
	return {
		kind: "ready",
		worktree_path: plan.worktreePath,
		branch: plan.branch,
		root: plan.root,
		title: plan.title,
		session: toSessionInfo(plan.worktreePath),
		post_create_script_path: plan.postCreateScriptPath,
		created_new_branch: plan.createdNewBranch,
		rollback_branch_head: plan.rollbackBranchHead,
	};
}

function toRemovePayload(plan: RemovePlan): ReadyRemovePayload {
	return {
		kind: "ready",
		worktree_path: plan.worktreePath,
		removed: plan.removed,
		session: toSessionInfo(plan.worktreePath),
	};
}

async function toPoolFullPayload(git: GitRunner, state: PoolState, branch: string): Promise<PoolFullPayload> {
	const candidates = state.slots.filter((slot) => slot.exists && slot.initialized && !slot.placeholder);
	return {
		kind: "pool_full",
		root: state.root,
		branch,
		candidates: await Promise.all(
			candidates.map(async (slot) => {
				const risk = await describeSlotRisk(git, slot);
				return {
					slot: slot.index,
					path: slot.path,
					branch: slot.branch,
					dirty: slot.dirty,
					ahead: risk.ahead,
					local_only: risk.localOnly,
					last_commit_iso: slot.lastCommitIso,
					last_commit_subject: slot.lastCommitSubject,
				};
			}),
		),
	};
}

function sessionNameForWorktreePath(worktreePath: string): string {
	return basename(worktreePath).replaceAll(".", "_");
}

function toSessionInfo(worktreePath: string): SessionInfo {
	return {
		name: sessionNameForWorktreePath(worktreePath),
		path: worktreePath,
	};
}

async function killTmuxSessionForPath(worktreePath: string): Promise<void> {
	const proc = Bun.spawn(["tmux", "kill-session", "-t", `=${sessionNameForWorktreePath(worktreePath)}`], {
		stdout: "ignore",
		stderr: "ignore",
	});
	await proc.exited.catch(() => undefined);
}

async function listWorktrees(git: GitRunner, cwd: string): Promise<Worktree[]> {
	const result = await git.run(["-C", cwd, "worktree", "list", "--porcelain"]);
	return applyWorktreeMetadata(parseWorktreeList(result.stdout), result.stdout);
}

async function resolveCanonicalRoot(git: GitRunner, cwd: string): Promise<string> {
	const worktrees = await listWorktrees(git, cwd);
	const canonical = worktrees.find((worktree) => worktree.canonical);
	if (!canonical) throw new WktreeError("couldn't determine canonical worktree");
	return canonical.path;
}

function resolveWorktreeContainingPath(worktrees: Worktree[], cwd: string): Worktree | undefined {
	const normalizedCwd = normalizeExistingPath(resolve(cwd));
	return worktrees
		.filter((worktree) => pathContains(normalizeExistingPath(worktree.path), normalizedCwd))
		.sort((left, right) => right.path.length - left.path.length)[0];
}

function pathContains(parent: string, child: string): boolean {
	return child === parent || child.startsWith(`${parent}/`);
}

type WorktreeMetadata = {
	locked: boolean;
	lockReason: string | null;
	prunable: boolean;
	prunableReason: string | null;
};

const worktreeMetadata = new WeakMap<Worktree, WorktreeMetadata>();

function applyWorktreeMetadata(worktrees: Worktree[], porcelainOutput: string): Worktree[] {
	const records = porcelainOutput
		.trim()
		.split(/\n{2,}/)
		.map((record) => record.trim())
		.filter(Boolean);

	for (const [index, record] of records.entries()) {
		const worktree = worktrees[index];
		if (!worktree) continue;
		const metadata: WorktreeMetadata = {
			locked: false,
			lockReason: null,
			prunable: false,
			prunableReason: null,
		};
		for (const line of record.split("\n")) {
			if (line === "locked") metadata.locked = true;
			else if (line.startsWith("locked ")) {
				metadata.locked = true;
				metadata.lockReason = line.slice("locked ".length);
			} else if (line === "prunable") metadata.prunable = true;
			else if (line.startsWith("prunable ")) {
				metadata.prunable = true;
				metadata.prunableReason = line.slice("prunable ".length);
			}
		}
		worktreeMetadata.set(worktree, metadata);
	}

	return worktrees;
}

function getWorktreeMetadata(worktree: Worktree): WorktreeMetadata {
	return (
		worktreeMetadata.get(worktree) ?? {locked: false, lockReason: null, prunable: false, prunableReason: null}
	);
}

function toListJson(worktree: Worktree) {
	const metadata = getWorktreeMetadata(worktree);
	return {
		path: worktree.path,
		head: worktree.head,
		branch: worktree.branch,
		branch_ref: worktree.branchRef,
		detached: worktree.detached,
		bare: worktree.bare,
		locked: metadata.locked,
		lock_reason: metadata.lockReason,
		prunable: metadata.prunable,
		prunable_reason: metadata.prunableReason,
		canonical: worktree.canonical,
		pool: worktree.pool,
		session: toSessionInfo(worktree.path),
	};
}

function formatWorktreeList(worktrees: Worktree[]): string {
	return worktrees
		.map((worktree) => {
			const head = worktree.head ? worktree.head.slice(0, 7) : "-";
			const branch = worktree.branch ? `[${worktree.branch}]` : worktree.detached ? "(detached)" : "";
			const flags = [branch, worktree.canonical ? "[canonical]" : null, formatPool(worktree.pool)]
				.filter(Boolean)
				.join(" ");
			return `${worktree.path}  ${head}${flags ? ` ${flags}` : ""}`;
		})
		.join("\n")
		.concat(worktrees.length > 0 ? "\n" : "");
}

function formatPool(pool: Worktree["pool"]): string | null {
	if (!pool) return null;
	return pool.placeholder ? "[pool:free]" : `[pool:feat${pool.index}]`;
}

function encodeBranch(branch: string): string {
	const parts = branch.split("/").filter((part) => part !== "");
	if (parts.length === 0) throw new UsageError(`invalid branch name: ${branch}`);
	return parts.join("--");
}

function lstatExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

async function runCopySetup(options: {
	git: GitRunner;
	root: string;
	target: string;
	entries: CopyEntry[];
}): Promise<CopiedFile[]> {
	const {git, root, target, entries} = options;
	const plans: Array<{
		source: string;
		to: string;
		destination: string;
		type: "file" | "directory" | "symlink";
	}> = [];
	for (const entry of entries) {
		const source = resolveCopySource(root, entry.from);
		if (!existsSync(source)) throw new ConfigError(`copy source does not exist: ${entry.from}`);
		const stat = lstatSync(source);
		const type = entry.mode === "symlink" ? "symlink" : stat.isDirectory() ? "directory" : "file";
		if (entry.mode === "copy" && !stat.isFile() && !stat.isDirectory()) {
			throw new ConfigError(`copy source is not a regular file or directory: ${entry.from}`);
		}
		const materializedSource = entry.mode === "symlink" ? realpathSync(source) : source;
		for (const to of entry.to) {
			await assertDestinationUntracked(git, target, to);
			plans.push({source: materializedSource, to, destination: resolve(target, to), type});
		}
	}
	for (const plan of plans) {
		mkdirSync(dirname(plan.destination), {recursive: true});
		if (existsSync(plan.destination) || lstatExists(plan.destination))
			rmSync(plan.destination, {recursive: true, force: true});
		if (plan.type === "symlink") symlinkSync(plan.source, plan.destination);
		else cpSync(plan.source, plan.destination, {recursive: plan.type === "directory"});
	}
	await writeCopyExcludeBlock(
		git,
		root,
		plans.map((plan) => plan.to),
	);
	return plans.map((plan) => ({from: plan.source, to: plan.to, type: plan.type}));
}

async function assertDestinationUntracked(git: GitRunner, target: string, path: string): Promise<void> {
	const tracked = await git.runRaw(["-C", target, "ls-files", "--", path]);
	const trackedPaths = tracked.stdout.trim().split("\n").filter(Boolean);
	if (trackedPaths.length > 0) throw new UnsafeOperationError(`copy destination is tracked by git: ${path}`);
	const parts = path.split("/");
	for (let length = 1; length < parts.length; length++) {
		const ancestor = parts.slice(0, length).join("/");
		const trackedDirectory = await git.runRaw(["-C", target, "ls-tree", "-d", "HEAD", "--", ancestor]);
		if (trackedDirectory.stdout.trim() !== "") continue;
		const trackedFileAncestor = await git.runRaw([
			"-C",
			target,
			"ls-files",
			"--error-unmatch",
			"--",
			ancestor,
		]);
		if (trackedFileAncestor.exitCode === 0) {
			throw new UnsafeOperationError(`copy destination has tracked git ancestor: ${ancestor}`);
		}
	}
}

async function writeCopyExcludeBlock(git: GitRunner, root: string, paths: string[]): Promise<void> {
	const excludePathResult = await git.run(["-C", root, "rev-parse", "--git-path", "info/exclude"]);
	const gitPath = resolve(root, excludePathResult.stdout.trim());
	const excludePath = existsSync(gitPath) ? realpathSync(gitPath) : gitPath;
	mkdirSync(dirname(excludePath), {recursive: true});
	const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
	const withoutFence = current.replace(/(?:^|\n)# wktree-start\n[\s\S]*?\n# wktree-end\n?/g, (match) =>
		match.startsWith("\n") ? "\n" : "",
	);
	const uniquePaths = [...new Set(paths)].sort();
	const nextBlock = uniquePaths.length > 0 ? `# wktree-start\n${uniquePaths.join("\n")}\n# wktree-end\n` : "";
	const separator = withoutFence !== "" && !withoutFence.endsWith("\n") && nextBlock !== "" ? "\n" : "";
	writeFileSync(excludePath, `${withoutFence}${separator}${nextBlock}`);
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

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
