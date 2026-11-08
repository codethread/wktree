// eslint-disable-next-line import/no-nodejs-modules -- Canonical project names fall back to the root basename.
import { basename } from "node:path";
import { rootGlobMatches } from "./paths.ts";

export const BUILTIN_ADD_POLICY: AddPolicy = "origin_default";
export const BUILTIN_FINISH_POLICY: FinishPolicy = {
	deleteBranch: false,
	enabled: true,
	push: false,
	removeWorktree: false,
	strategy: "ff_only",
};

export type AddPolicy = "origin_default" | "fresh_canonical";
export type WorktreeLocation = "sibling" | "nested";
export type FinishStrategy = "ff_only" | "rebase_ff" | "squash" | "merge_commit";
export type CopyMode = "copy" | "symlink";

export interface FinishPolicy {
	/** Whether finishing is permitted. */
	enabled: boolean;
	/** How the branch is integrated into the canonical checkout. */
	strategy: FinishStrategy;
	/** Push the integrated branch before cleanup. */
	push: boolean;
	/** Remove the finished checkout after successful integration. */
	removeWorktree: boolean;
	/** Delete its branch after the checkout is removed. */
	deleteBranch: boolean;
}

export interface PolicyTables {
	/** Overrides the inherited add policy when present. */
	add?: {
		/** Add policy contributed by this configuration layer. */
		policy: AddPolicy;
	};
	/** Fields omitted from this patch inherit their previous values. */
	finish?: Partial<FinishPolicy>;
}

export interface CopyEntry {
	/** Source path, relative to the canonical root or absolute. */
	from: string;
	/** Normalized destinations relative to the created checkout. */
	to: string[];
	/** Materialization mode after project defaults are applied. */
	mode: CopyMode;
}

export interface ProjectConfig extends PolicyTables {
	/** Display name, defaulting to the configured root's basename. */
	name: string | null;
	/** Expanded configured path, retained for source attribution. */
	root: string;
	/** Exact-project bootstrap command, or null to inherit from rules. */
	command: string | null;
	/** Overrides inherited placement when specified. */
	worktreeLocation?: WorktreeLocation;
	/** Overrides the inherited pre-remote hook when specified. */
	preRemoteCheck?: string | null;
	/** Number of fixed slots, or null for ordinary worktrees. */
	poolSize: number | null;
	/** Default materialization mode for this project's copy entries. */
	copyModeDefault: CopyMode;
	/** Files to materialize before running the bootstrap command. */
	copy: CopyEntry[];
}

export interface PolicyRule extends PolicyTables {
	/** Expanded glob matched against canonical repository paths. */
	rootGlob: string;
	/** Bootstrap command contributed by this rule, if any. */
	command: string | null;
	/** Overrides placement from earlier matching layers. */
	worktreeLocation?: WorktreeLocation;
	/** Pre-remote hook contributed by this rule, if any. */
	preRemoteCheck?: string | null;
}

export interface TreesConfig {
	/** Final repository-local layer, when its canonical-root file exists. */
	local?: RepositoryConfig;
	/** Exact-root configuration entries. */
	projects: ProjectConfig[];
	/** Rules in precedence order, with later matches winning. */
	rules: PolicyRule[];
	/** Policy patches applied over the built-in defaults. */
	defaults: PolicyTables;
	/** Global preference for newly created worktrees. */
	worktreeLocation: WorktreeLocation;
}

export interface RepositoryOptions extends PolicyTables {
	/** Repository display name override. */
	name?: string;
	/** Bootstrap command override. */
	command?: string;
	/** Pre-remote hook override. */
	preRemoteCheck?: string;
	/** Placement override for new worktrees. */
	worktreeLocation?: WorktreeLocation;
	/** Fixed pool size override. */
	poolSize?: number;
	/** Default mode for copy entries supplied by this file. */
	copyModeDefault?: CopyMode;
	/** Replacement copy list; an empty list disables inherited copying. */
	copy?: CopyEntry[];
}

export interface RepositoryConfig {
	/** Canonical root to which this layer belongs. */
	root: string;
	/** Local TOML path for source attribution. */
	path: string;
	/** Explicit settings only; omitted fields inherit the global configuration. */
	options: RepositoryOptions;
}

export interface ConfigPathContext {
	/** Home directory used for leading tilde expansion. */
	home: string;
	/** Base directory for relative paths in the configuration. */
	cwd: string;
	/** Resolve an existing path for matching without replacing its configured spelling. */
	normalizePath: (path: string) => string;
}

export interface ResolvedConfigString {
	/** Selected value, or null when no layer supplies one. */
	value: string | null;
	/** Project or rule that supplied the value. */
	source: string | null;
}

export interface PolicyExplanation {
	/** Matching repository-local file and its explicit settings, when present. */
	local: RepositoryConfig | undefined;
	/** Canonicalized repository path used for rule matching. */
	canonicalRoot: string;
	/** Matching rules in precedence order. */
	matchedRules: PolicyRule[];
	/** Matching global exact project, retained for source attribution. */
	globalProject: ProjectConfig | undefined;
	/** Effective repository setup after the local overlay, if configured. */
	project: ProjectConfig | undefined;
	/** Effective add policy after every layer is applied. */
	addPolicy: AddPolicy;
	/** Effective finish policy after every layer is applied. */
	finishPolicy: FinishPolicy;
	/** Effective location for new worktrees. */
	worktreeLocation: WorktreeLocation;
	/** Effective bootstrap command and its source. */
	command: {
		/** Selected bootstrap command, or null when no layer supplies one. */
		command: string | null;
		/** Project or rule that supplied the command. */
		source: string | null;
	};
	/** Effective pre-remote hook and its source. */
	preRemoteCheck: ResolvedConfigString;
}

type FieldName = "command" | "preRemoteCheck";
type NormalizePath = (path: string) => string;

interface StringFieldRequest {
	/** Configuration layers to search in precedence order. */
	config: TreesConfig;
	/** Canonicalized repository path used for matching. */
	canonicalRoot: string;
	/** String-valued policy field to resolve. */
	field: FieldName;
	/** Injected path canonicalization used for matching. */
	normalizePath: NormalizePath;
}

interface PolicyLayers {
	/** Add policy accumulated from matching layers. */
	addPolicy: AddPolicy;
	/** Finish policy accumulated from matching layers. */
	finishPolicy: FinishPolicy;
	/** Worktree placement accumulated from matching layers. */
	worktreeLocation: WorktreeLocation;
}

export function findProjectForRoot(
	config: TreesConfig,
	root: string,
	normalizePath = identityPath,
): ProjectConfig | undefined {
	const comparableRoot = normalizePath(root);
	return config.projects.find((candidate) => normalizePath(candidate.root) === comparableRoot);
}

export function resolveEffectiveCommand(
	config: TreesConfig,
	canonicalRoot: string,
	normalizePath = identityPath,
): PolicyExplanation["command"] {
	const resolved = resolveEffectiveStringField({
		canonicalRoot,
		config,
		field: "command",
		normalizePath,
	});
	return { command: resolved.value, source: resolved.source };
}

export function resolvePreRemoteCheck(
	config: TreesConfig,
	canonicalRoot: string,
	normalizePath = identityPath,
): ResolvedConfigString {
	return resolveEffectiveStringField({
		canonicalRoot,
		config,
		field: "preRemoteCheck",
		normalizePath,
	});
}

export function explainPolicy(
	config: TreesConfig,
	canonicalRoot: string,
	normalizePath = identityPath,
): PolicyExplanation {
	const root = normalizePath(canonicalRoot);
	const matchedRules = config.rules.filter((rule) => rootGlobMatches(rule.rootGlob, root));
	const globalProject = findProjectForRoot(config, root, normalizePath);
	const local = localForRoot(config, root, normalizePath);
	const project = applyLocalToProject(globalProject, local);
	const { add: defaultAdd, finish: defaultFinish } = config.defaults;
	const layers = applyProjectToLayers(
		applyRulesToLayers(
			{
				addPolicy: defaultAdd?.policy ?? BUILTIN_ADD_POLICY,
				finishPolicy: { ...BUILTIN_FINISH_POLICY, ...defaultFinish },
				worktreeLocation: config.worktreeLocation,
			},
			matchedRules,
		),
		project,
	);
	return {
		addPolicy: layers.addPolicy,
		canonicalRoot: root,
		command: resolveEffectiveCommand(config, root, normalizePath),
		finishPolicy: layers.finishPolicy,
		globalProject,
		local,
		matchedRules,
		preRemoteCheck: resolvePreRemoteCheck(config, root, normalizePath),
		project,
		worktreeLocation: layers.worktreeLocation,
	};
}

/** Project name for bootstrap scripts: the configured name, else the canonical root's basename. */
export function projectNameFor(project: ProjectConfig | undefined, root: string): string {
	return project?.name ?? basename(root);
}
// --- Private functions ---

function identityPath(path: string): string {
	return path;
}

function resolveRuleField(
	rules: PolicyRule[],
	field: FieldName,
	root: string,
): ResolvedConfigString {
	// oxlint-disable-next-line unicorn/no-null -- A rule value is explicitly absent until a match supplies one.
	let value: string | null = null;
	// oxlint-disable-next-line unicorn/no-null -- A rule source is explicitly absent until a match supplies one.
	let source: string | null = null;
	for (const rule of rules) {
		if (rule[field] && rootGlobMatches(rule.rootGlob, root)) {
			value = rule[field];
			source = `rule:${rule.rootGlob}`;
		}
	}
	return { source, value };
}

function resolveEffectiveStringField(request: StringFieldRequest): ResolvedConfigString {
	const { canonicalRoot, config, field, normalizePath } = request;
	const root = normalizePath(canonicalRoot);
	const local = localForRoot(config, root, normalizePath);
	if (local?.options[field] !== undefined) {
		return { source: `local:${local.path}`, value: local.options[field] };
	}
	const project = findProjectForRoot(config, root, normalizePath);
	if (project?.[field]) {
		return { source: `project:${project.root}`, value: project[field] };
	}
	return resolveRuleField(config.rules, field, root);
}

function localForRoot(
	config: TreesConfig,
	root: string,
	normalizePath: NormalizePath,
): RepositoryConfig | undefined {
	if (config.local && normalizePath(config.local.root) === root) {
		return config.local;
	}
	return undefined;
}

function applyLocalToProject(
	project: ProjectConfig | undefined,
	local: RepositoryConfig | undefined,
): ProjectConfig | undefined {
	if (local === undefined) {
		return project;
	}
	return {
		// oxlint-disable-next-line unicorn/no-null -- Unconfigured bootstrap and pools retain their explicit absent values.
		command: null,
		copy: [],
		copyModeDefault: "copy",
		name: basename(local.root),
		// oxlint-disable-next-line unicorn/no-null -- A repository without a pool has no fixed slot count.
		poolSize: null,
		...project,
		...local.options,
		finish: { ...project?.finish, ...local.options.finish },
		root: local.root,
	};
}

function applyRulesToLayers(layers: PolicyLayers, rules: PolicyRule[]): PolicyLayers {
	let { addPolicy, worktreeLocation } = layers;
	const finishPolicy = { ...layers.finishPolicy };
	for (const rule of rules) {
		addPolicy = rule.add?.policy ?? addPolicy;
		Object.assign(finishPolicy, rule.finish);
		worktreeLocation = rule.worktreeLocation ?? worktreeLocation;
	}
	return { addPolicy, finishPolicy, worktreeLocation };
}

function applyProjectToLayers(
	layers: PolicyLayers,
	project: ProjectConfig | undefined,
): PolicyLayers {
	if (project === undefined) {
		return layers;
	}
	return {
		addPolicy: project.add?.policy ?? layers.addPolicy,
		finishPolicy: { ...layers.finishPolicy, ...project.finish },
		worktreeLocation: project.worktreeLocation ?? layers.worktreeLocation,
	};
}
export { expandConfigGlob, expandConfigPath, rootGlobMatches } from "./paths.ts";
