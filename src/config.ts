import type {
	ConfigPathContext,
	CopyEntry,
	CopyMode,
	FinishPolicy,
	PolicyTables,
	RepositoryOptions,
	TreesConfig,
	WorktreeLocation,
} from "./domain/config.ts";
import type { RawConfig, RawRepositoryConfig } from "./schemas.ts";
import { RepositoryConfigSchema, createConfigSchema } from "./schemas.ts";
// eslint-disable-next-line import/no-nodejs-modules -- Configuration file and copy paths use platform path semantics.
import { basename, normalize, resolve } from "node:path";
import {
	expandConfigGlob,
	expandConfigPath,
	findProjectForRoot,
	resolveEffectiveCommand,
} from "./domain/config.ts";
import { ConfigError } from "./errors.ts";
import { TOML } from "bun";
import { z } from "zod";

const MINIMUM_COPY_ENTRIES = 1;

type RuleRaw = RawConfig["rule"][number];
type ProjectRaw = RawConfig["project"][number];
type FinishRaw = NonNullable<RawConfig["defaults"]["finish"]>;

interface RepositoryConfigContext {
	/** Canonical root to which the local configuration applies. */
	canonicalRoot: string;
	/** Injected path canonicalization used for matching inherited settings. */
	normalizePath: ConfigPathContext["normalizePath"];
}

interface ProjectSetup {
	/** Bootstrap command override, when configured. */
	command?: string;
	/** Pre-remote hook override, when configured. */
	preRemoteCheck?: string;
	/** Worktree placement override, when configured. */
	worktreeLocation?: WorktreeLocation;
}

export function parseConfig(toml: string, context: ConfigPathContext): TreesConfig {
	const raw = parseToml(toml);
	const result = createConfigSchema(context).safeParse(raw);
	if (!result.success) {
		throw new ConfigError(`Invalid wktree.toml:\n${z.prettifyError(result.error)}`);
	}
	return projectConfig(result.data, context);
}

/** Parse and schema-validate canonical-root TOML, then apply it over loaded global configuration. */
export function parseRepositoryConfig(
	toml: string,
	config: TreesConfig,
	context: RepositoryConfigContext,
): TreesConfig {
	const path = resolve(context.canonicalRoot, ".wktree.toml");
	const result = RepositoryConfigSchema.safeParse(parseToml(toml, path));
	if (!result.success) {
		throw new ConfigError(`Invalid ${path}:\n${z.prettifyError(result.error)}`);
	}
	return applyRepositoryConfig(result.data, config, context);
}

/**
 * Apply trusted RepositoryConfigSchema output as a new local layer, leaving config unchanged.
 * Use injected path matching for inheritance and effective-command validation after layering.
 */
export function applyRepositoryConfig(
	raw: RawRepositoryConfig,
	config: TreesConfig,
	context: RepositoryConfigContext,
): TreesConfig {
	const path = resolve(context.canonicalRoot, ".wktree.toml");
	const project = findProjectForRoot(config, context.canonicalRoot, context.normalizePath);
	const options = projectRepositoryOptions(raw, project?.copyModeDefault ?? "copy");
	const layered = { ...config, local: { options, path, root: context.canonicalRoot } };
	validateRepositorySetup(raw, layered, context);
	return layered;
}
// --- Private functions ---

function validateRepositorySetup(
	raw: RawRepositoryConfig,
	config: TreesConfig,
	context: RepositoryConfigContext,
): void {
	const requiresCommand =
		raw.copy_mode_default !== undefined ||
		(raw.copy !== undefined && raw.copy.length >= MINIMUM_COPY_ENTRIES);
	if (
		requiresCommand &&
		resolveEffectiveCommand(config, context.canonicalRoot, context.normalizePath).command === null
	) {
		throw new ConfigError(
			`${resolve(context.canonicalRoot, ".wktree.toml")} requires an effective command for copy setup`,
		);
	}
}

function errorMessage(cause: unknown): string {
	if (cause instanceof Error) {
		return cause.message;
	}
	return String(cause);
}

function parseToml(toml: string, path = "wktree.toml"): unknown {
	try {
		return TOML.parse(toml);
	} catch (error) {
		throw new ConfigError(`Invalid TOML in ${path}: ${errorMessage(error)}`);
	}
}

function projectPolicies(raw: RawConfig["defaults"]): PolicyTables {
	const policies: PolicyTables = {};
	if (raw.add !== undefined) {
		policies.add = raw.add;
	}
	if (raw.finish !== undefined) {
		policies.finish = finishPolicy(raw.finish);
	}
	return policies;
}

function finishFlags(raw: FinishRaw): Partial<FinishPolicy> {
	const policy: Partial<FinishPolicy> = {};
	if (raw.enabled !== undefined) {
		policy.enabled = raw.enabled;
	}
	if (raw.push !== undefined) {
		policy.push = raw.push;
	}
	if (raw.remove_worktree !== undefined) {
		policy.removeWorktree = raw.remove_worktree;
	}
	if (raw.delete_branch !== undefined) {
		policy.deleteBranch = raw.delete_branch;
	}
	return policy;
}

function finishPolicy(raw: FinishRaw): Partial<FinishPolicy> {
	const policy = finishFlags(raw);
	if (raw.strategy !== undefined) {
		policy.strategy = raw.strategy;
	}
	return policy;
}

function projectSetup(raw: RawRepositoryConfig): ProjectSetup {
	const setup: ProjectSetup = {};
	if (raw.command !== undefined) {
		setup.command = raw.command;
	}
	if (raw.pre_remote_check !== undefined) {
		setup.preRemoteCheck = raw.pre_remote_check;
	}
	if (raw.worktree_location !== undefined) {
		setup.worktreeLocation = raw.worktree_location;
	}
	return setup;
}

function toDestinations(to: string | string[]): string[] {
	if (typeof to === "string") {
		return [to];
	}
	return to;
}

function projectCopy(
	copy: NonNullable<RawRepositoryConfig["copy"]>,
	defaultMode: CopyMode,
): CopyEntry[] {
	return copy.map((entry) => {
		if (typeof entry === "string") {
			const path = normalize(entry);
			return { from: path, mode: defaultMode, to: [path] };
		}
		return {
			from: entry.from,
			mode: entry.mode ?? defaultMode,
			to: toDestinations(entry.to).map((path) => normalize(path)),
		};
	});
}

function projectRepositoryOptions(
	raw: RawRepositoryConfig,
	inheritedMode: CopyMode,
): RepositoryOptions {
	const options: RepositoryOptions = { ...projectSetup(raw), ...projectPolicies(raw) };
	if (raw.name !== undefined) {
		options.name = raw.name;
	}
	if (raw.copy_mode_default !== undefined) {
		options.copyModeDefault = raw.copy_mode_default;
	}
	if (raw.copy !== undefined) {
		options.copy = projectCopy(raw.copy, raw.copy_mode_default ?? inheritedMode);
	}
	return options;
}

function buildProject(
	project: ProjectRaw,
	context: ConfigPathContext,
): TreesConfig["projects"][number] {
	const root = expandConfigPath(project.root, context);
	return {
		// oxlint-disable-next-line unicorn/no-null -- An omitted exact-project command inherits from rules.
		command: null,
		copy: projectCopy(project.copy, project.copy_mode_default ?? "copy"),
		copyModeDefault: project.copy_mode_default ?? "copy",
		name: project.name ?? basename(root),
		root,
		...projectSetup(project),
		...projectPolicies(project),
	};
}

function buildRule(rule: RuleRaw, context: ConfigPathContext): TreesConfig["rules"][number] {
	return {
		// oxlint-disable-next-line unicorn/no-null -- An omitted rule command contributes no override.
		command: null,
		rootGlob: expandConfigGlob(rule.root_glob, context),
		...projectSetup(rule),
		...projectPolicies(rule),
	};
}

function projectConfig(raw: RawConfig, context: ConfigPathContext): TreesConfig {
	return {
		defaults: projectPolicies(raw.defaults),
		projects: raw.project.map((project) => buildProject(project, context)),
		rules: raw.rule.map((rule) => buildRule(rule, context)),
		worktreeLocation: raw.worktree_location,
	};
}

export {
	BUILTIN_ADD_POLICY,
	BUILTIN_FINISH_POLICY,
	explainPolicy,
	findProjectForRoot,
	resolveEffectiveCommand,
	resolvePreRemoteCheck,
} from "./domain/config.ts";
