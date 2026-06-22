import {existsSync, readFileSync, realpathSync} from "node:fs";
import {homedir} from "node:os";
import {basename, isAbsolute, normalize, resolve} from "node:path";
import {TOML} from "bun";
import {ConfigError} from "./errors.ts";
import {CopyModeSchema, PoolSizeSchema} from "./schemas.ts";
import type {
	AddPolicy,
	CopyEntry,
	CopyMode,
	FinishPolicy,
	FinishStrategy,
	PolicyRule,
	ProjectConfig,
	TreesConfig,
} from "./types.ts";

const ADD_POLICIES = ["origin_default", "fresh_canonical"] as const;
const FINISH_STRATEGIES = ["ff_only", "rebase_ff", "squash", "merge_commit"] as const;
export const BUILTIN_ADD_POLICY: AddPolicy = "origin_default";
export const BUILTIN_FINISH_POLICY: FinishPolicy = {
	enabled: true,
	strategy: "ff_only",
	push: false,
	removeWorktree: false,
	deleteBranch: false,
};

export function parseConfig(toml: string): TreesConfig {
	let raw: unknown;
	try {
		raw = TOML.parse(toml);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ConfigError(`Invalid TOML in trees.toml: ${message}`);
	}

	if (!isRecord(raw)) {
		throw new ConfigError("Invalid trees.toml: expected a top-level TOML table");
	}

	if ("post_create" in raw) {
		throw new ConfigError(
			"Legacy [[post_create]] entries are no longer supported; rename [[post_create]] to [[project]]",
		);
	}

	const rawProjects = raw.project ?? [];
	if (!Array.isArray(rawProjects)) {
		throw new ConfigError("Invalid trees.toml: [[project]] must be an array of tables");
	}
	const rawRules = raw.rule ?? [];
	if (!Array.isArray(rawRules)) throw new ConfigError("Invalid trees.toml: [[rule]] must be an array of tables");

	if (raw.defaults !== undefined && !isRecord(raw.defaults)) {
		throw new ConfigError("[defaults] must be a TOML table");
	}
	const defaults = parsePolicyTables(raw.defaults ?? {}, "[defaults]");
	const rules = rawRules.map((entry, index) => parseRuleConfig(entry, index));
	const seenRoots = new Set<string>();
	const projects = rawProjects.map((entry, index) => parseProjectConfig(entry, index, seenRoots));
	return {projects, rules, defaults};
}

function parseRuleConfig(entry: unknown, index: number): PolicyRule {
	const label = `[[rule]] entry ${index + 1}`;
	if (!isRecord(entry)) throw new ConfigError(`${label} must be a TOML table`);
	if (typeof entry.root_glob !== "string" || entry.root_glob.trim() === "") {
		throw new ConfigError(`${label}: required field \`root_glob\` is missing or empty`);
	}
	const rootGlob = expandRootGlob(entry.root_glob, `${label}: root_glob`);
	return {rootGlob, ...parsePolicyTables(entry, label)};
}

function parseProjectConfig(entry: unknown, index: number, seenRoots: Set<string>): ProjectConfig {
	const label = `[[project]] entry ${index + 1}`;
	if (!isRecord(entry)) {
		throw new ConfigError(`${label} must be a TOML table`);
	}

	if ("shell" in entry) {
		throw new ConfigError(`${label}: \`shell\` is no longer supported; command always runs under bash`);
	}

	const rootValue = entry.root;
	if (typeof rootValue !== "string" || rootValue.trim() === "") {
		throw new ConfigError(`${label}: required field \`root\` is missing or empty`);
	}

	const commandValue = entry.command;
	const hasCommand = typeof commandValue === "string" && commandValue.trim() !== "";
	const needsCommand = entry.pool_size !== undefined || entry.copy !== undefined || entry.copy_mode_default !== undefined;
	if (!hasCommand && needsCommand) {
		throw new ConfigError(`${label}: required field \`command\` is missing or empty`);
	}
	if (commandValue !== undefined && !hasCommand) {
		throw new ConfigError(`${label}: optional field \`command\` must be a non-empty string when present`);
	}

	const root = expandPath(rootValue);
	if (seenRoots.has(root)) {
		throw new ConfigError(`${label}: duplicate root \`${root}\``);
	}
	seenRoots.add(root);

	const nameValue = entry.name;
	if (nameValue !== undefined && typeof nameValue !== "string") {
		throw new ConfigError(`${label}: optional field \`name\` must be a string when present`);
	}

	const copyModeDefault = parseCopyMode(entry.copy_mode_default, `${label}: copy_mode_default`);
	const copy = parseCopyEntries(entry.copy, label, copyModeDefault);

	const poolSize = parsePoolSize(entry.pool_size, label);
	return {
		name: nameValue ?? basename(root),
		root,
		command: hasCommand ? commandValue : null,
		poolSize,
		copyModeDefault,
		copy,
		...parsePolicyTables(entry, label),
	};
}

function parsePolicyTables(value: Record<string, unknown>, label: string) {
	return {
		add: parseAddPolicyPatch(value.add, `${label}.add`),
		finish: parseFinishPolicyPatch(value.finish, `${label}.finish`),
	};
}

function parseAddPolicyPatch(value: unknown, label: string): {policy: AddPolicy} | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new ConfigError(`${label} must be a TOML table`);
	const keys = Object.keys(value);
	for (const key of keys) {
		if (key !== "policy") throw new ConfigError(`${label}: unknown field \`${key}\``);
	}
	if (value.policy === undefined) throw new ConfigError(`${label}.policy is required when ${label} is present`);
	if (!isAddPolicy(value.policy)) throw new ConfigError(`${label}.policy must be origin_default or fresh_canonical`);
	return {policy: value.policy};
}

function parseFinishPolicyPatch(value: unknown, label: string): Partial<FinishPolicy> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new ConfigError(`${label} must be a TOML table`);
	const allowed = new Set(["enabled", "strategy", "push", "remove_worktree", "delete_branch"]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new ConfigError(`${label}: unknown field \`${key}\``);
	}
	const finish: Partial<FinishPolicy> = {};
	if (value.enabled !== undefined) finish.enabled = parseBoolean(value.enabled, `${label}.enabled`);
	if (value.strategy !== undefined) {
		if (!isFinishStrategy(value.strategy)) throw new ConfigError(`${label}.strategy must be ff_only, rebase_ff, squash, or merge_commit`);
		finish.strategy = value.strategy;
	}
	if (value.push !== undefined) finish.push = parseBoolean(value.push, `${label}.push`);
	if (value.remove_worktree !== undefined) finish.removeWorktree = parseBoolean(value.remove_worktree, `${label}.remove_worktree`);
	if (value.delete_branch !== undefined) finish.deleteBranch = parseBoolean(value.delete_branch, `${label}.delete_branch`);
	return finish;
}

function parseBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new ConfigError(`${label} must be a boolean`);
	return value;
}

function isAddPolicy(value: unknown): value is AddPolicy {
	return typeof value === "string" && ADD_POLICIES.includes(value as AddPolicy);
}
function isFinishStrategy(value: unknown): value is FinishStrategy {
	return typeof value === "string" && FINISH_STRATEGIES.includes(value as FinishStrategy);
}

export function readConfig(): TreesConfig {
	const configHome = process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config");
	const configPath = resolve(configHome, "ct-worktrees", "trees.toml");
	if (!existsSync(configPath)) return {projects: [], rules: [], defaults: {}};
	return parseConfig(readFileSync(configPath, "utf8"));
}

export function findProjectForRoot(config: TreesConfig, root: string): ProjectConfig | undefined {
	const comparableRoot = normalizeExistingPath(root);
	return config.projects.find((candidate) => normalizeExistingPath(candidate.root) === comparableRoot);
}

export function explainPolicy(config: TreesConfig, canonicalRoot: string) {
	const root = normalizeExistingPath(canonicalRoot);
	const matchedRules = config.rules.filter((rule) => rootGlobMatches(rule.rootGlob, root));
	const project = findProjectForRoot(config, root);
	let addPolicy = config.defaults.add?.policy ?? BUILTIN_ADD_POLICY;
	let finishPolicy = {...BUILTIN_FINISH_POLICY, ...config.defaults.finish};
	for (const rule of matchedRules) {
		if (rule.add?.policy) addPolicy = rule.add.policy;
		finishPolicy = {...finishPolicy, ...rule.finish};
	}
	if (project?.add?.policy) addPolicy = project.add.policy;
	if (project?.finish) finishPolicy = {...finishPolicy, ...project.finish};
	return {canonicalRoot: root, matchedRules, project, addPolicy, finishPolicy};
}

export function normalizeExistingPath(path: string): string {
	return existsSync(path) ? realpathSync(path) : path;
}

function parseCopyEntries(value: unknown, label: string, defaultMode: CopyMode): CopyEntry[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new ConfigError(`${label}: optional field \`copy\` must be an array`);
	return value.map((entry, index) => {
		const entryLabel = `${label}: copy entry ${index + 1}`;
		if (isRecord(entry)) {
			if (typeof entry.from !== "string" || entry.from.trim() === "") {
				throw new ConfigError(`${entryLabel}: required field \`from\` is missing or empty`);
			}
			return {from: entry.from, to: parseCopyDestinations(entry.to, entryLabel), mode: parseCopyMode(entry.mode, `${entryLabel}: mode`, defaultMode)};
		}
		if (typeof entry !== "string") throw new ConfigError(`${entryLabel}: expected a string path`);
		const path = parseRelativeCopyPath(entry, entryLabel);
		return {from: path, to: [path], mode: defaultMode};
	});
}

function parseCopyMode(value: unknown, label: string, fallback: CopyMode = "copy"): CopyMode {
	if (value === undefined) return fallback;
	const result = CopyModeSchema.safeParse(value);
	if (result.success) return result.data;
	throw new ConfigError(`${label} must be "copy" or "symlink"`);
}

function parseCopyDestinations(value: unknown, label: string): string[] {
	if (typeof value === "string") return [parseRelativeCopyPath(value, `${label}: to`)];
	if (Array.isArray(value)) {
		if (value.length === 0) throw new ConfigError(`${label}: \`to\` array must not be empty`);
		return value.map((entry, index) => {
			if (typeof entry !== "string") throw new ConfigError(`${label}: to entry ${index + 1} must be a string`);
			return parseRelativeCopyPath(entry, `${label}: to entry ${index + 1}`);
		});
	}
	throw new ConfigError(`${label}: required field \`to\` is missing`);
}

function parseRelativeCopyPath(value: string, label: string): string {
	if (value.trim() === "") throw new ConfigError(`${label}: copy path must not be empty`);
	if (isAbsolute(value)) throw new ConfigError(`${label}: copy path must be relative, not absolute`);
	if (value.startsWith("~")) throw new ConfigError(`${label}: copy path must be relative, not start with ~`);
	const normalized = normalize(value);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
		throw new ConfigError(`${label}: copy path must stay within the worktree`);
	}
	return normalized;
}

export function resolveCopySource(root: string, from: string): string {
	return expandLeadingHome(from) ?? (isAbsolute(from) ? from : resolve(root, from));
}

function parsePoolSize(value: unknown, label: string): number | null {
	if (value === undefined) return null;
	const result = PoolSizeSchema.safeParse(value);
	if (!result.success) throw new ConfigError(`${label}: optional field \`pool_size\` must be an integer greater than or equal to 1`);
	return result.data;
}

function expandPath(path: string): string {
	return expandLeadingHome(path) ?? resolve(path);
}

function expandRootGlob(path: string, label: string): string {
	if (path.includes("\0") || path.trim() === "") throw new ConfigError(`${label} is malformed`);
	if (path.startsWith("~") && path !== "~" && !path.startsWith("~/")) throw new ConfigError(`${label} supports only leading ~/ expansion`);
	return expandLeadingHome(path) ?? (isAbsolute(path) ? path : resolve(path));
}

function expandLeadingHome(path: string): string | null {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return null;
}

function rootGlobMatches(glob: string, path: string): boolean {
	return matchGlobSegments(glob.split("/"), path.split("/"));
}

function matchGlobSegments(pattern: string[], path: string[]): boolean {
	if (pattern.length === 0) return path.length === 0;
	const [head, ...tail] = pattern;
	if (head === "**") {
		return matchGlobSegments(tail, path) || (path.length > 0 && matchGlobSegments(pattern, path.slice(1)));
	}
	if (path.length === 0) return false;
	return globSegmentMatches(head ?? "", path[0] ?? "") && matchGlobSegments(tail, path.slice(1));
}

function globSegmentMatches(pattern: string, value: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
	return new RegExp(`^${escaped}$`).test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
