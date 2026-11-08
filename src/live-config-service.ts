// oxlint-disable-next-line import/no-nodejs-modules -- Config discovery is a filesystem IO boundary.
import { existsSync, readFileSync } from "node:fs";
import { parseConfig, parseRepositoryConfig } from "./config.ts";
import type { ConfigPathContext } from "./domain/config.ts";
import type { ConfigService } from "./services.ts";
import { explainPolicy } from "./domain/config.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Home resolution is a process boundary.
import { homedir } from "node:os";
// oxlint-disable-next-line import/no-nodejs-modules -- Path resolution is a filesystem boundary.
import { resolve } from "node:path";

export function createLiveConfigService(
	normalizePath: ConfigPathContext["normalizePath"],
): ConfigService {
	return {
		explain: (config, root) => {
			const canonicalRoot = normalizePath(root);
			const canonicalPaths = new Map(
				config.projects.map((project) => [project.root, normalizePath(project.root)]),
			);
			return explainPolicy(config, canonicalRoot, (path) => canonicalPaths.get(path) ?? path);
		},
		read: (root) => {
			const home = process.env.HOME || homedir();
			const configPath = resolve(
				process.env.XDG_CONFIG_HOME || resolve(home, ".config"),
				"wktree.toml",
			);
			const context = { cwd: process.cwd(), home, normalizePath };
			const config = parseConfig(readOptionalConfig(configPath) ?? "", context);
			const canonicalRoot = normalizePath(root);
			const local = readOptionalConfig(resolve(canonicalRoot, ".wktree.toml"));
			if (local === undefined) {
				return config;
			}
			return parseRepositoryConfig(local, config, { canonicalRoot, normalizePath });
		},
	};
}

// --- Private functions ---

function readOptionalConfig(path: string): string | undefined {
	// oxlint-disable-next-line node/no-sync -- ConfigService.read is a synchronous command-boundary contract.
	if (!existsSync(path)) {
		return undefined;
	}
	// oxlint-disable-next-line node/no-sync -- ConfigService.read is a synchronous command-boundary contract.
	return readFileSync(path, "utf8");
}
