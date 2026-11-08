import { expect, test } from "bun:test";
import { runCli, useTmpHome } from "./lifecycle-helpers.ts";
import { EXIT_CODES } from "../../src/errors.ts";

const tmp = useTmpHome("wktree-skills-");

test("skills lists bundled metadata outside a repository #test-280", async () => {
	const result = await runCli(["skills", "list", "--json"], tmp.dir);
	expect(result).toMatchObject({ exitCode: EXIT_CODES.SUCCESS, stderr: "" });
	expect(JSON.parse(result.stdout)).toMatchObject({
		ok: true,
		kind: "skills_list",
		skills: [
			{
				name: "git-workflow",
				description: expect.any(String),
				files: ["SKILL.md", "references/pooled-slots.md"],
			},
		],
	});
	const defaultList = await runCli(["skills", "--json"], tmp.dir);
	expect(defaultList).toEqual(result);
});

test("skills reads bundled instructions and referenced resources #test-279", async () => {
	const instructions = await runCli(["skills", "get", "git-workflow"], tmp.dir);
	expect(instructions).toMatchObject({ exitCode: EXIT_CODES.SUCCESS, stderr: "" });
	expect(instructions.stdout).not.toStartWith("---");
	expect(instructions.stdout).toContain(
		"wktree skills file git-workflow references/pooled-slots.md",
	);
	const resource = await runCli(
		["skills", "file", "git-workflow", "references/pooled-slots.md", "--json"],
		tmp.dir,
	);
	expect(resource).toMatchObject({ exitCode: EXIT_CODES.SUCCESS, stderr: "" });
	expect(JSON.parse(resource.stdout)).toMatchObject({
		ok: true,
		kind: "skills_get",
		name: "git-workflow",
		path: "references/pooled-slots.md",
		content: expect.stringContaining("# Pooled slots"),
	});
});

test("skills emits one JSON error for a missing CLI argument #test-281", async () => {
	const result = await runCli(["skills", "get", "--json"], tmp.dir);
	expect(result).toMatchObject({ exitCode: EXIT_CODES.USAGE, stderr: "" });
	expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, kind: "error", reason: "usage" });
});
