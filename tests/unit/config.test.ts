import { ConfigError, EXIT_CODES } from "../../src/errors.ts";
import { expect, test } from "bun:test";
import { explainPolicy, resolveEffectiveCommand } from "../../src/domain/config.ts";
import type { ProjectConfig } from "../../src/domain/config.ts";
import { parseConfig as parseTomlConfig } from "../../src/config.ts";

function parseConfig(toml: string) {
	return parseTomlConfig(toml, {
		cwd: "/work",
		home: "/home/test",
		normalizePath: (path) => path,
	});
}

const locationConfig = `worktree_location = "sibling"
[[rule]]
root_glob = "/tmp/**"
worktree_location = "nested"
[[project]]
root = "/tmp/repo"
worktree_location = "sibling"`;
test.each([
	{ expected: "sibling", name: "built-in default", root: "/repo", toml: "" },
	{ expected: "sibling", name: "global default", root: "/elsewhere", toml: locationConfig },
	{ expected: "nested", name: "matching rule", root: "/tmp/other", toml: locationConfig },
	{ expected: "sibling", name: "project override", root: "/tmp/repo", toml: locationConfig },
])("resolves worktree location from $name #test-572", ({ toml, root, expected }) => {
	expect(explainPolicy(parseConfig(toml), root).worktreeLocation).toBe(expected);
});
test.each([
	'worktree_location = "elsewhere"',
	'[[rule]]\nroot_glob = "/tmp/**"\nworktree_location = "elsewhere"',
])("rejects invalid worktree location: %s #test-576", (toml) => {
	expect(() => parseConfig(toml)).toThrow("worktree_location");
});

test.each<{ name: string; toml: string; expected: ProjectConfig[] }>([
	{
		expected: [
			{
				command: "yarn install",
				copy: [],
				copyModeDefault: "copy",
				name: "app",
				poolSize: 5,
				root: "/home/test/work/app",
			},
		],
		name: "pooled home-relative project",
		toml: '[[project]]\nname = "app"\nroot = "~/work/app"\ncommand = "yarn install"\npool_size = 5',
	},
	{
		expected: [
			{
				command: "echo ready",
				copy: [],
				copyModeDefault: "copy",
				name: "repo",
				// eslint-disable-next-line unicorn/no-null -- Non-pooled projects have no fixed slot count.
				poolSize: null,
				root: "/work/relative/repo",
			},
		],
		name: "non-pooled cwd-relative project",
		toml: '[[project]]\nroot = "./relative/repo"\ncommand = "echo ready"',
	},
	{
		expected: [
			{
				command: "echo one",
				copy: [],
				copyModeDefault: "copy",
				name: "one",
				// eslint-disable-next-line unicorn/no-null -- Non-pooled projects have no fixed slot count.
				poolSize: null,
				root: "/tmp/one",
			},
			{
				command: "echo two",
				copy: [],
				copyModeDefault: "copy",
				name: "two",
				poolSize: 2,
				root: "/tmp/two",
			},
		],
		name: "mixed projects",
		toml:
			"[[project]]\n" +
			'root = "/tmp/one"\n' +
			'command = "echo one"\n' +
			"[[project]]\n" +
			'root = "/tmp/two"\n' +
			'command = "echo two"\n' +
			"pool_size = 2",
	},
])("parses $name #test-575", ({ toml, expected }) => {
	expect(parseConfig(toml).projects).toEqual(expected);
});

test.each([
	{
		expected: [{ from: ".env", mode: "copy", to: [".env"] }],
		extra: 'copy = [".env"]',
		mode: "copy",
		name: "string entry",
	},
	{
		expected: [{ from: "source.env", mode: "copy", to: ["local.env"] }],
		extra: 'copy = [{ from = "source.env", to = "local.env" }]',
		mode: "copy",
		name: "single destination",
	},
	{
		expected: [{ from: ".env", mode: "copy", to: [".env.local", ".env.test"] }],
		extra: 'copy = [{ from = ".env", to = [".env.local", ".env.test"] }]',
		mode: "copy",
		name: "multiple destinations",
	},
	{
		expected: [
			{ from: ".env", mode: "symlink", to: [".env"] },
			{ from: "local.env", mode: "copy", to: ["local.env"] },
		],
		extra:
			'copy_mode_default = "symlink"\ncopy = [".env", { from = "local.env", to = "local.env", mode = "copy" }]',
		mode: "symlink",
		name: "entry overrides project mode",
	},
	{
		expected: [
			{ from: ".env", mode: "copy", to: [".env"] },
			{ from: "~/shared/env", mode: "copy", to: ["local.env", "test.env"] },
		],
		extra:
			'copy = ["./.env", { from = "~/shared/env", to = ["nested/../local.env", "./test.env"] }]',
		mode: "copy",
		name: "normalized destinations",
	},
])("parses copy configuration: $name #test-598", ({ extra, mode, expected }) => {
	const [project] = parseConfig(
		`[[project]]\nroot = "/repo"\ncommand = "setup"\n${extra}`,
	).projects;
	expect(project).toMatchObject({ copy: expected, copyModeDefault: mode });
});

test.each([
	{ message: "root", name: "missing root", toml: '[[project]]\ncommand = "echo ok"' },
	{
		message: "pool_size",
		name: "pool_size zero",
		toml: '[[project]]\nroot = "/tmp/repo"\ncommand = "x"\npool_size = 0',
	},
	{
		message: "pool_size",
		name: "pool_size negative",
		toml: '[[project]]\nroot = "/tmp/repo"\ncommand = "x"\npool_size = -1',
	},
	{
		message: "pool_size",
		name: "pool_size non-integer",
		toml: '[[project]]\nroot = "/tmp/repo"\ncommand = "x"\npool_size = 1.5',
	},
])("throws ConfigError for $name", ({ toml, message }) => {
	expect(() => parseConfig(toml)).toThrow(
		expect.objectContaining({
			message: expect.stringContaining(message),
			name: ConfigError.name,
		}),
	);
});

test("rejects duplicate expanded roots", () => {
	expect(() =>
		parseConfig(`
[[project]]
root = "~/same"
command = "echo one"

[[project]]
root = "/home/test/same"
command = "echo two"
`),
	).toThrow(ConfigError);
});

test.each([
	{ extra: "pool_size = 1", name: "pool_size" },
	{ extra: 'copy = [".env"]', name: "copy" },
	{ extra: 'copy_mode_default = "symlink"', name: "copy_mode_default" },
])("requires command when project uses $name", ({ extra }) => {
	expect(() =>
		parseConfig(`
[[project]]
root = "/tmp/repo"
${extra}
`),
	).toThrow(ConfigError);
});

test.each([
	{ config: '[defaults.add]\npolicy = "bad"', message: "policy" },
	{ config: '[defaults.finish]\nstrategy = "bad"', message: "strategy" },
	{ config: '[defaults.finish]\npush = "yes"', message: "boolean" },
	{ config: '[[rule]]\nroot_glob = "~repo/*"', message: "root_glob" },
	{ config: 'defaults = "bad"', message: "defaults" },
	{ config: '[defaults.add]\npolciy = "fresh_canonical"', message: "Unrecognized key" },
	{ config: "[defaults.finish]\nremoveWorktree = true", message: "Unrecognized key" },
])("invalid policy config fails loudly: $config #test-646", ({ config, message }) => {
	expect(() => parseConfig(config)).toThrow(
		expect.objectContaining({
			message: expect.stringContaining(message),
			name: ConfigError.name,
		}),
	);
});

test.each([
	{ field: "worktree_locaton", toml: 'worktree_locaton = "nested"' },
	{ field: "defaults", toml: 'defaults = "invalid"' },
	{ field: "command", toml: '[defaults]\ncommand = "x"' },
	{ field: "rule", toml: '[rule]\nroot_glob = "/repo"' },
	{ field: "commmand", toml: '[[rule]]\nroot_glob = "/repo"\ncommmand = "x"' },
	{ field: "project", toml: 'project = ["/repo"]' },
	{ field: "pool_siz", toml: '[[project]]\nroot = "/repo"\npool_siz = 2' },
	{ field: "command", toml: '[[project]]\nroot = "/repo"\ncommand = "   "' },
	{ field: "copy", toml: '[[project]]\nroot = "/repo"\ncopy = [{ from = "a", to = [] }]' },
	{
		field: "copy",
		toml: '[[project]]\nroot = "/repo"\ncopy = [{ from = "a", to = "b", modes = "copy" }]',
	},
	{ field: "copy", toml: '[[project]]\nroot = "/repo"\ncopy = ["a/../../outside"]' },
])("reports invalid TOML shape at $field as a usage error #test-585", ({ toml, field }) => {
	expect(() => parseConfig(toml)).toThrow(
		expect.objectContaining({
			exitCode: EXIT_CODES.USAGE,
			message: expect.stringContaining(field),
			name: ConfigError.name,
		}),
	);
});

test("inherited rule command satisfies pooled and copy setup requirement", () => {
	const config = parseConfig(`
[[rule]]
root_glob = "/tmp/**"
command = "echo inherited"

[[project]]
root = "/tmp/repo"
pool_size = 1
copy = [".env"]
`);
	const [project] = config.projects;
	expect(project?.command).toBeNull();
	expect(resolveEffectiveCommand(config, "/tmp/repo").command).toBe("echo inherited");
});

test("matches canonical roots while retaining configured project source paths", () => {
	const canonicalPaths = new Map([["/home/link", "/real/repo"]]);
	const normalizePath = (path: string) => canonicalPaths.get(path) ?? path;
	const config = parseTomlConfig(
		`
[[rule]]
root_glob = "/real/**"
command = "echo inherited"

[[project]]
root = "~/link"
pool_size = 1
pre_remote_check = "echo check"
`,
		{ cwd: "/work", home: "/home", normalizePath },
	);
	const explanation = explainPolicy(config, "/real/repo", normalizePath);
	expect(explanation.project?.root).toBe("/home/link");
	expect(explanation.command).toEqual({ command: "echo inherited", source: "rule:/real/**" });
	expect(explanation.preRemoteCheck).toEqual({
		source: "project:/home/link",
		value: "echo check",
	});
});
