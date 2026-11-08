import { EXIT_CODES, UsageError } from "../../src/errors.ts";
import { expect, mock, test } from "bun:test";
import type { Deps } from "../../src/services.ts";
import { dispatch } from "../../src/main.ts";
import { parseIntegrationPlan } from "../../src/commands/finish-integration.ts";

test("finish rejects --strategy before calling dependencies #test-748", async () => {
	const unexpected = mock((): never => {
		throw new Error("Unexpected dependency call");
	});
	const result = await dispatch(
		"finish",
		["--cwd", "/repo/worktree", "--json", "--strategy", "ff_only"],
		unusedDependencies(unexpected),
	);

	expect(result.failure).toBeInstanceOf(UsageError);
	expect(result.exitCode).toBe(EXIT_CODES.USAGE);
	expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
		ok: false,
		reason: "usage",
		diagnostics: [],
		setup_output: [],
	});
	expect(unexpected).not.toHaveBeenCalled();
});

test.each([
	{ strategy: "ff_only", flag: "--title", title: "title", body: undefined },
	{ strategy: "ff_only", flag: "--body", title: undefined, body: "body" },
	{ strategy: "rebase_ff", flag: "--title", title: "title", body: undefined },
	{ strategy: "rebase_ff", flag: "--body", title: undefined, body: "body" },
	{ strategy: "merge_commit", flag: "--title", title: "title", body: undefined },
	{ strategy: "merge_commit", flag: "--body", title: undefined, body: "body" },
] as const)("$strategy rejects $flag", (request) => {
	expect(() => parseIntegrationPlan(request.strategy, request.title, request.body)).toThrow(
		UsageError,
	);
});

test("finish accepts a trimmed squash message and an ff_only plan without a message", () => {
	expect(parseIntegrationPlan("squash", "  title  ", "  body  ")).toEqual({
		strategy: "squash",
		title: "title",
		body: "body",
	});
	const request = { title: undefined, body: undefined };
	expect(parseIntegrationPlan("ff_only", request.title, request.body)).toEqual({
		strategy: "ff_only",
	});
});

function unusedDependencies(unexpected: () => never): Deps {
	return {
		skills: { getSkills: unexpected, getSkillFile: unexpected },
		git: { run: unexpected, runRaw: unexpected },
		worktrees: { list: unexpected },
		config: { read: unexpected, explain: unexpected },
		files: {
			normalizePath: unexpected,
			exists: unexpected,
			prepareParent: unexpected,
			copy: unexpected,
			writePostCreateScript: unexpected,
		},
		hooks: { runInline: unexpected, runCommand: unexpected },
		picker: { pick: unexpected, confirm: unexpected },
		multiplexer: {
			attached: false,
			open: unexpected,
			closeUnder: unexpected,
			previewCommand: unexpected,
		},
		cdDirective: { write: unexpected },
		progress: { banner: unexpected, stream: unexpected, error: unexpected },
		clock: { now: unexpected },
	};
}
