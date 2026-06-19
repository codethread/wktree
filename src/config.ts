import {existsSync, readFileSync, realpathSync} from "node:fs";
import {homedir} from "node:os";
import {basename, isAbsolute, normalize, resolve} from "node:path";
import {TOML} from "bun";
import {ConfigError} from "./errors.ts";
import {CopyModeSchema, PoolSizeSchema, ProjectTableSchema, TreesTomlSchema} from "./schemas.ts";
import type {CopyEntry, CopyMode, ProjectConfig, TreesConfig} from "./types.ts";

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

	const topLevel = TreesTomlSchema.safeParse(raw);
	if (!topLevel.success) {
		throw new ConfigError("Invalid trees.toml: expected a top-level TOML table");
	}

	const seenRoots = new Set<string>();
	const projects = rawProjects.map((entry, index) => parseProjectConfig(entry, index, seenRoots));
	return {projects};
}

function parseProjectConfig(entry: unknown, index: number, seenRoots: Set<string>): ProjectConfig {
	const label = `[[project]] entry ${index + 1}`;
	if (!isRecord(entry)) {
		throw new ConfigError(`${label} must be a TOML table`);
	}

	if ("shell" in entry) {
		throw new ConfigError(`${label}: \`shell\` is no longer supported; command always runs under bash`);
	}

	const schemaResult = ProjectTableSchema.safeParse(entry);
	if (!schemaResult.success) {
		const rootValue = entry.root;
		if (typeof rootValue !== "string" || rootValue.trim() === "") {
			throw new ConfigError(`${label}: required field \`root\` is missing or empty`);
		}
		const commandValue = entry.command;
		if (typeof commandValue !== "string" || commandValue.trim() === "") {
			throw new ConfigError(`${label}: required field \`command\` is missing or empty`);
		}
	}

	const rootValue = entry.root;
	if (typeof rootValue !== "string" || rootValue.trim() === "") {
		throw new ConfigError(`${label}: required field \`root\` is missing or empty`);
	}

	const commandValue = entry.command;
	if (typeof commandValue !== "string" || commandValue.trim() === "") {
		throw new ConfigError(`${label}: required field \`command\` is missing or empty`);
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
		command: commandValue,
		poolSize,
		copyModeDefault,
		copy,
	};
}

export function readConfig(): TreesConfig {
	const configHome = process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config");
	const configPath = resolve(configHome, "ct-worktrees", "trees.toml");
	if (!existsSync(configPath)) return {projects: []};
	return parseConfig(readFileSync(configPath, "utf8"));
}

export function findProjectForRoot(config: TreesConfig, root: string): ProjectConfig | undefined {
	const comparableRoot = normalizeExistingPath(root);
	return config.projects.find((candidate) => normalizeExistingPath(candidate.root) === comparableRoot);
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
			return {
				from: entry.from,
				to: parseCopyDestinations(entry.to, entryLabel),
				mode: parseCopyMode(entry.mode, `${entryLabel}: mode`, defaultMode),
			};
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
			if (typeof entry !== "string")
				throw new ConfigError(`${label}: to entry ${index + 1} must be a string`);
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
	if (!result.success) {
		throw new ConfigError(
			`${label}: optional field \`pool_size\` must be an integer greater than or equal to 1`,
		);
	}
	return result.data;
}

function expandPath(path: string): string {
	return expandLeadingHome(path) ?? resolve(path);
}

function expandLeadingHome(path: string): string | null {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
