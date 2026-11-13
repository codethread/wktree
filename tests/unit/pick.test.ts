/* eslint-disable unicorn/no-null -- Fixtures preserve explicit-null Worktree and picker cancellation contracts. */
import { EXIT_CODES, UsageError, dispatch } from "../../src/index";
import { createPolicyDeps, worktreeFixture } from "./policy-fixture.ts";
import { describe, expect, mock, test } from "bun:test";
import { GitError } from "../../src/git/error.ts";
import { createMemoryWorktreeInventory } from "../contract/worktree-inventory-fixture.ts";
import { createTestCdDirective } from "../integration/fakes/test-cd-directive.ts";
import { createTestMultiplexer } from "../integration/fakes/test-multiplexer.ts";
import { createTestPicker } from "../integration/fakes/test-picker.ts";
import { gitLogPreviewCommand } from "../../src/integrations/multiplexer.ts";

const GIT_FAILURE = 128;
const NO_PREVIEW_CALLS = 0;
const ONE_PREVIEW_CALL = 1;

function pickDeps(choice: string | null, attached = true) {
	const picker = createTestPicker(choice);
	const multiplexer = createTestMultiplexer(attached);
	const cdDirective = createTestCdDirective();
	return {
		cdDirective,
		deps: createPolicyDeps({
			cdDirective,
			multiplexer,
			picker,
			worktrees: createMemoryWorktreeInventory({
				repositories: [
					{
						cwd: root,
						aliases: [featurePath],
						worktrees: [
							worktreeFixture(root, { canonical: true }),
							worktreeFixture(featurePath, { branch: "feature", branchRef: "refs/heads/feature" }),
						],
					},
				],
			}),
			files: { ...createPolicyDeps().files, normalizePath: (path) => path },
		}),
		multiplexer,
		picker,
	};
}

const root = "/repo";
const featurePath = `${root}__feature`;

describe("wktree pick", () => {
	test("select writes the chosen path to the cd directive and prints it #test-286", async () => {
		const { deps, picker, multiplexer, cdDirective } = pickDeps(featurePath);

		const result = await dispatch("pick", ["--cwd", root, "--interactive"], deps);

		expect(result).toEqual({ exitCode: EXIT_CODES.SUCCESS, stdout: `${featurePath}\n` });
		expect(cdDirective.paths).toEqual([featurePath]);
		expect(multiplexer.opened).toEqual([]);
		expect(picker.options).toEqual({ interactive: true });
		expect(picker.items).toEqual([
			{ display: `${root}\t* main`, key: root, preview: "test-preview" },
			{ display: `${featurePath}\t  feature`, key: featurePath, preview: "test-preview" },
		]);
	});

	test("interactive without a multiplexer still previews history and hands back the path #test-287", async () => {
		const { deps, picker, multiplexer, cdDirective } = pickDeps(featurePath, false);

		const result = await dispatch("pick", ["--cwd", root, "--interactive"], deps);

		expect(result).toEqual({ exitCode: EXIT_CODES.SUCCESS, stdout: `${featurePath}\n` });
		expect(cdDirective.paths).toEqual([featurePath]);
		expect(picker.options).toEqual({ interactive: true });
		expect(multiplexer.previewCalls).toBe(ONE_PREVIEW_CALL);
		expect(picker.items.map((item) => item.preview)).toEqual([
			gitLogPreviewCommand(),
			gitLogPreviewCommand(),
		]);
	});

	test("without --interactive, select only prints the path and never touches the multiplexer #test-285", async () => {
		const { deps, picker, multiplexer, cdDirective } = pickDeps(featurePath);

		const result = await dispatch("pick", ["--cwd", root], deps);

		expect(result).toEqual({ exitCode: EXIT_CODES.SUCCESS, stdout: `${featurePath}\n` });
		expect(cdDirective.paths).toEqual([]);
		expect(picker.options).toEqual({ interactive: false });
		expect(multiplexer.previewCalls).toBe(NO_PREVIEW_CALLS);
		expect(picker.items.map((item) => item.preview)).toEqual([
			gitLogPreviewCommand(),
			gitLogPreviewCommand(),
		]);
	});
});

describe("wktree pick --open", () => {
	test("--open opens the selection's session without a cd directive #test-289", async () => {
		const { deps, multiplexer, cdDirective } = pickDeps(featurePath);

		const result = await dispatch("pick", ["--cwd", root, "--open", "--interactive"], deps);

		expect(result).toEqual({ exitCode: EXIT_CODES.SUCCESS });
		expect(multiplexer.opened).toEqual([
			{ name: "repo__feature", path: featurePath, title: "feature" },
		]);
		expect(cdDirective.paths).toEqual([]);
	});

	test.each([
		["interactive open", ["--open", "--interactive"], EXIT_CODES.SUCCESS],
		["interactive cd", ["--interactive"], EXIT_CODES.SUCCESS],
		["noninteractive", [], EXIT_CODES.CANCELLED],
	])("cancel %s exits quietly without switching #test-288", async (_case, flags, exitCode) => {
		// oxlint-disable-next-line unicorn/no-null -- TestPicker models cancellation as an explicit null choice
		const { deps, multiplexer, cdDirective } = pickDeps(null);

		const result = await dispatch("pick", ["--cwd", root, ...flags], deps);

		expect(result).toEqual({ exitCode });
		expect(multiplexer.opened).toEqual([]);
		expect(cdDirective.paths).toEqual([]);
	});

	test.each([
		["without --interactive", ["--open"], true],
		["outside a multiplexer", ["--open", "--interactive"], false],
	])("--open %s is a usage error before picking #test-284", async (_case, flags, attached) => {
		const { deps, picker, multiplexer, cdDirective } = pickDeps(featurePath, attached);
		const list = mock(createPolicyDeps().worktrees.list);
		const { failure } = await dispatch("pick", ["--cwd", root, ...flags], {
			...deps,
			worktrees: { list },
			files: createPolicyDeps().files,
		});
		expect(failure).toBeInstanceOf(UsageError);
		expect(list).not.toHaveBeenCalled();
		expect(picker.items).toEqual([]);
		expect(multiplexer.previewCalls).toBe(NO_PREVIEW_CALLS);
		expect(multiplexer.opened).toEqual([]);
		expect(cdDirective.paths).toEqual([]);
	});
});

test("pick excludes bare entries and marks the most specific current worktree", async () => {
	const picker = createTestPicker(featurePath);
	const deps = createPolicyDeps({
		picker,
		files: { ...createPolicyDeps().files, normalizePath: (path) => path },
		worktrees: createMemoryWorktreeInventory({
			repositories: [
				{
					cwd: root,
					aliases: [`${root}/nested/src`],
					worktrees: [
						worktreeFixture(`${root}/bare.git`, {
							bare: true,
							canonical: true,
							head: null,
							branch: null,
							branchRef: null,
						}),
						worktreeFixture(root),
						worktreeFixture(`${root}/nested`, { branch: "nested", branchRef: "refs/heads/nested" }),
						worktreeFixture(featurePath, { branch: null, branchRef: null, detached: true }),
					],
				},
			],
		}),
	});
	const result = await dispatch("pick", ["--cwd", `${root}/nested/src`], deps);
	expect(result).toEqual({ exitCode: EXIT_CODES.SUCCESS, stdout: `${featurePath}\n` });
	expect(picker.items.map((item) => item.display)).toEqual([
		`${root}\t  main`,
		`${root}/nested\t* nested`,
		`${featurePath}\t  (detached)`,
	]);
});

test("pick preserves inventory failure without reaching picker or UI", async () => {
	const error = new GitError(["worktree", "list"], "inventory unavailable", GIT_FAILURE);
	const result = await dispatch(
		"pick",
		["--cwd", root, "--json"],
		createPolicyDeps({
			worktrees: { list: () => Promise.reject(error) },
		}),
	);
	expect(result.failure).toBe(error);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({ ok: false, reason: "git_failed" });
});
