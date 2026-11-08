import type { CopyMode, TreesConfig } from "../../src/domain/config.ts";
import { applyRepositoryConfig, parseRepositoryConfig } from "../../src/config.ts";
import { expect, test } from "bun:test";
import { ConfigError } from "../../src/errors.ts";
import type { RawRepositoryConfig } from "../../src/schemas.ts";
import { RepositoryConfigSchema } from "../../src/schemas.ts";
import { explainPolicy } from "../../src/domain/config.ts";

const root = "/repo";
const context = { canonicalRoot: root, normalizePath: (path: string) => path };
const emptyConfig: TreesConfig = {
	defaults: {},
	projects: [],
	rules: [],
	worktreeLocation: "sibling",
};
const globalConfig: TreesConfig = {
	worktreeLocation: "nested",
	defaults: { finish: { strategy: "squash", push: true } },
	rules: [
		{
			rootGlob: "/**",
			command: "echo rule",
			preRemoteCheck: "echo check",
			add: { policy: "fresh_canonical" },
			finish: { removeWorktree: true },
		},
	],
	projects: [
		{
			root,
			name: "global-name",
			command: "echo project",
			poolSize: 2,
			copyModeDefault: "symlink",
			copy: [{ from: ".env", to: [".env"], mode: "symlink" }],
			finish: { deleteBranch: true },
		},
	],
};

function localConfig(raw: RawRepositoryConfig, global = globalConfig) {
	return applyRepositoryConfig(raw, global, context);
}

test.each([
	{ mode: "symlink", raw: { copy: ["./.env", { from: "source", to: "./target", mode: "copy" }] } },
	{
		mode: "copy",
		raw: {
			copy_mode_default: "copy",
			copy: [".env", { from: "source", to: "target", mode: "copy" }],
		},
	},
] satisfies { mode: CopyMode; raw: RawRepositoryConfig }[])(
	"local copy entries use effective $mode default and retain explicit modes #test-693",
	({ mode, raw }) => {
		const policy = explainPolicy(localConfig(raw), root);
		expect(policy.project?.copy).toEqual([
			{ from: ".env", mode, to: [".env"] },
			{ from: "source", mode: "copy", to: ["target"] },
		]);
	},
);

test("local pool and copy setup can inherit a global rule command without an exact project", () => {
	const global: TreesConfig = {
		...emptyConfig,
		rules: [{ rootGlob: "/repo", command: "echo rule" }],
	};
	const policy = explainPolicy(localConfig({ pool_size: 1, copy: [".env"] }, global), root);
	expect(policy.globalProject).toBeUndefined();
	expect(policy.project).toMatchObject({
		name: "repo",
		poolSize: 1,
		root,
		copy: [{ from: ".env", to: [".env"], mode: "copy" }],
	});
	expect(policy.command).toEqual({ command: "echo rule", source: "rule:/repo" });
});

test("changing only the local copy default preserves the resolved inherited copy entries", () => {
	const policy = explainPolicy(localConfig({ copy_mode_default: "copy" }), root);
	expect(policy.project).toMatchObject({
		copy: [{ from: ".env", mode: "symlink", to: [".env"] }],
		copyModeDefault: "copy",
	});
});

test("an empty local copy list and empty finish patch need no bootstrap command", () => {
	const policy = explainPolicy(localConfig({ copy: [], finish: {} }, emptyConfig), root);
	expect(policy.project?.copy).toEqual([]);
	expect(policy.command.command).toBeNull();
	expect(policy.finishPolicy.push).toBe(false);
});

test("repository-local settings apply only to their canonical root", () => {
	const config = localConfig({ command: "echo local", worktree_location: "sibling" });
	const policy = explainPolicy(config, "/other");
	expect(policy.local).toBeUndefined();
	expect(policy.project).toBeUndefined();
	expect(policy.command).toEqual({ command: "echo rule", source: "rule:/**" });
	expect(policy.worktreeLocation).toBe("nested");
});

test("local overrides preserve omitted finish fields and leave the global configuration unchanged", () => {
	const global = structuredClone(globalConfig);
	const config = localConfig(
		{
			name: "local-name",
			command: "echo local",
			pre_remote_check: "echo local check",
			worktree_location: "sibling",
			add: { policy: "origin_default" },
			finish: { push: false, delete_branch: false },
			copy: [],
		},
		global,
	);
	const policy = explainPolicy(config, root);
	expect(policy.command).toEqual({ command: "echo local", source: "local:/repo/.wktree.toml" });
	expect(policy.preRemoteCheck).toEqual({
		value: "echo local check",
		source: "local:/repo/.wktree.toml",
	});
	expect(policy).toMatchObject({
		worktreeLocation: "sibling",
		addPolicy: "origin_default",
		project: { name: "local-name", copy: [] },
		finishPolicy: {
			enabled: true,
			strategy: "squash",
			push: false,
			removeWorktree: true,
			deleteBranch: false,
		},
	});
	expect(config).not.toBe(global);
	expect(global).toEqual(globalConfig);
});

test("local setup inherits command and copy defaults through canonical aliases", () => {
	const normalizePath = (path: string) => {
		if (path === "/alias") {
			return root;
		}
		return path;
	};
	const config = applyRepositoryConfig({ pool_size: 1, copy: [".env"] }, globalConfig, {
		canonicalRoot: "/alias",
		normalizePath,
	});
	const policy = explainPolicy(config, root, normalizePath);
	expect(policy.command).toEqual({ command: "echo project", source: "project:/repo" });
	expect(policy.project).toMatchObject({
		poolSize: 1,
		copy: [{ from: ".env", to: [".env"], mode: "symlink" }],
	});
	expect(policy.local).toMatchObject({ root: "/alias", path: "/alias/.wktree.toml" });
});

test("local copy conversion preserves object sources and normalizes scalar and list destinations", () => {
	const config = localConfig({
		copy: [
			{ from: "./source", to: "dir/../target" },
			{ from: "~/source", to: ["./first", "nested/../second"] },
		],
	});
	expect(config.local?.options.copy).toEqual([
		{ from: "./source", to: ["target"], mode: "symlink" },
		{ from: "~/source", to: ["first", "second"], mode: "symlink" },
	]);
});

test.each([
	{ name: "pool", raw: { pool_size: 1 } },
	{ name: "copy default", raw: { copy_mode_default: "symlink" } },
	{ name: "nonempty copy", raw: { copy: [".env"] } },
] satisfies { name: string; raw: RawRepositoryConfig }[])(
	"requires an effective command for local $name setup",
	({ raw }) => {
		expect(() => localConfig(raw, emptyConfig)).toThrow(ConfigError);
	},
);

test.each([
	{ name: "root", raw: { root } },
	{ name: "root glob", raw: { root_glob: "/**" } },
	{ name: "defaults", raw: { defaults: { finish: { push: true } } } },
	{ name: "rule", raw: { rule: [{ root_glob: "/**" }] } },
	{ name: "project", raw: { project: [{ root }] } },
	{ name: "blank command", raw: { command: " " } },
	{ name: "invalid location", raw: { worktree_location: "invalid" } },
	{ name: "zero pool", raw: { pool_size: 0 } },
	{ name: "escaping copy", raw: { copy: ["../outside"] } },
	{ name: "empty destinations", raw: { copy: [{ from: ".env", to: [] }] } },
	{ name: "unknown finish key", raw: { finish: { removeWorktree: true } } },
	{ name: "invalid finish value", raw: { finish: { push: "yes" } } },
])("repository schema rejects $name #test-700", ({ raw }) => {
	expect(RepositoryConfigSchema.safeParse(raw).success).toBe(false);
});

test("local TOML parser attaches converted settings to the supplied global configuration", () => {
	const config = parseRepositoryConfig(
		'command = "echo parsed"\npool_size = 1\n[finish]\npush = false',
		globalConfig,
		context,
	);
	expect(config.local).toEqual({
		root,
		path: "/repo/.wktree.toml",
		options: { command: "echo parsed", poolSize: 1, finish: { push: false } },
	});
	expect(config.projects).toBe(globalConfig.projects);
});

test("malformed local TOML reports its configuration path", () => {
	const [diagnostic] = parseFailure("command =").message.split(":");
	expect(diagnostic).toMatchInlineSnapshot('"Invalid TOML in /repo/.wktree.toml"');
});

test("local parser wraps schema rejection with its configuration path", () => {
	const [diagnostic] = parseFailure('[[project]]\nroot = "/repo"').message.split(":");
	expect(diagnostic).toMatchInlineSnapshot('"Invalid /repo/.wktree.toml"');
});

test("local parser propagates the effective-command requirement", () => {
	expect(parseFailure("pool_size = 1", emptyConfig).message).toMatchInlineSnapshot(
		'"/repo/.wktree.toml requires an effective command for pooled or copy setup"',
	);
});

function parseFailure(toml: string, config = globalConfig): ConfigError {
	try {
		parseRepositoryConfig(toml, config, context);
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		if (error instanceof ConfigError) {
			return error;
		}
		throw error;
	}
	throw new Error("Expected repository configuration to fail");
}
