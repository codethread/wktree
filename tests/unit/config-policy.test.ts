/* eslint-disable unicorn/no-null -- Null models command inheritance, no pool, and no hook value or source. */
import { expect, test } from "bun:test";
import {
	explainPolicy,
	resolveEffectiveCommand,
	resolvePreRemoteCheck,
} from "../../src/domain/config.ts";
import type { TreesConfig } from "../../src/domain/config.ts";

const emptyConfig: TreesConfig = {
	defaults: {},
	projects: [],
	rules: [],
	worktreeLocation: "sibling",
};

test("resolves built-in policy defaults #test-363", () => {
	const policy = explainPolicy(emptyConfig, "/tmp/repo");
	expect(policy.addPolicy).toBe("origin_default");
	expect(policy.finishPolicy).toEqual({
		deleteBranch: false,
		enabled: true,
		push: false,
		removeWorktree: false,
		strategy: "ff_only",
	});
});

test("matching rules apply in configuration order with later fields winning #test-418", () => {
	const config: TreesConfig = {
		...emptyConfig,
		rules: [
			{
				rootGlob: "/tmp/**",
				command: "echo first",
				add: { policy: "fresh_canonical" },
				finish: { strategy: "squash", push: true },
			},
			{
				rootGlob: "/tmp/repo",
				command: "echo second",
				finish: { push: false, removeWorktree: true },
			},
		],
	};
	const policy = explainPolicy(config, "/tmp/repo");
	expect(policy.matchedRules.map((rule) => rule.rootGlob)).toEqual(["/tmp/**", "/tmp/repo"]);
	expect(policy.addPolicy).toBe("fresh_canonical");
	expect(policy.finishPolicy).toMatchObject({
		push: false,
		removeWorktree: true,
		strategy: "squash",
	});
	expect(resolveEffectiveCommand(config, "/tmp/repo")).toEqual({
		command: "echo second",
		source: "rule:/tmp/repo",
	});
});

test("exact project command overrides inherited rule command #test-483", () => {
	const config: TreesConfig = {
		...emptyConfig,
		rules: [{ rootGlob: "/tmp/**", command: "echo rule" }],
		projects: [
			{
				root: "/tmp/repo",
				name: "repo",
				command: "echo project",
				copy: [],
				copyModeDefault: "copy",
				poolSize: 1,
			},
		],
	};
	expect(resolveEffectiveCommand(config, "/tmp/repo")).toEqual({
		command: "echo project",
		source: "project:/tmp/repo",
	});
});

const preRemoteConfig: TreesConfig = {
	...emptyConfig,
	rules: [
		{ rootGlob: "/tmp/**", command: "setup", preRemoteCheck: "echo first >&2" },
		{ rootGlob: "/tmp/repo/**", command: "setup", preRemoteCheck: "echo second >&2" },
	],
	projects: [
		{
			root: "/tmp/repo",
			name: "repo",
			command: "setup",
			copy: [],
			copyModeDefault: "copy",
			poolSize: 1,
			preRemoteCheck: "echo project >&2",
		},
	],
};
test.each([
	{
		expected: { source: null, value: null },
		name: "default",
		root: "/tmp/repo",
		config: emptyConfig,
	},
	{
		expected: { source: "rule:/tmp/**", value: "echo first >&2" },
		name: "rule",
		root: "/tmp/other",
		config: preRemoteConfig,
	},
	{
		expected: { source: "rule:/tmp/repo/**", value: "echo second >&2" },
		name: "later rule",
		root: "/tmp/repo/nested",
		config: preRemoteConfig,
	},
	{
		expected: { source: "project:/tmp/repo", value: "echo project >&2" },
		name: "project",
		root: "/tmp/repo",
		config: preRemoteConfig,
	},
])("resolves pre_remote_check from $name #test-667", ({ config, root, expected }) => {
	expect(resolvePreRemoteCheck(config, root)).toEqual(expected);
});

test("exact project policy overrides matching rules without a project command", () => {
	const config: TreesConfig = {
		...emptyConfig,
		rules: [
			{
				rootGlob: "/tmp/**",
				command: "setup",
				add: { policy: "fresh_canonical" },
				finish: { strategy: "squash" },
			},
		],
		projects: [
			{
				root: "/tmp/repo",
				name: "repo",
				command: null,
				copy: [],
				copyModeDefault: "copy",
				poolSize: null,
				add: { policy: "origin_default" },
				finish: { enabled: false },
			},
		],
	};
	const [project] = config.projects;
	expect(project?.command).toBeNull();
	const policy = explainPolicy(config, "/tmp/repo");
	expect(policy.project?.name).toBe("repo");
	expect(policy.addPolicy).toBe("origin_default");
	expect(policy.finishPolicy).toMatchObject({ enabled: false, strategy: "squash" });
});

test("finish policy merges field-by-field across defaults rules and project", () => {
	const policy = explainPolicy(
		{
			...emptyConfig,
			defaults: { finish: { strategy: "rebase_ff", push: true } },
			rules: [{ rootGlob: "/tmp/**", command: "setup", finish: { removeWorktree: true } }],
			projects: [
				{
					root: "/tmp/repo",
					name: "repo",
					command: "setup",
					copy: [],
					copyModeDefault: "copy",
					poolSize: 1,
					finish: { deleteBranch: true },
				},
			],
		},
		"/tmp/repo",
	);
	expect(policy.finishPolicy).toEqual({
		deleteBranch: true,
		enabled: true,
		push: true,
		removeWorktree: true,
		strategy: "rebase_ff",
	});
});
