import { EXIT_CODES, UsageError } from "../../src/errors.ts";
import { expect, test } from "bun:test";
import type { Skill } from "skills-handler";
import { createStaticProvider } from "skills-handler";
import { skillsCommand } from "../../src/commands/skills.ts";

const name = "git-workflow";
const reference = "references/pooled-slots.md";
const skill: Skill = {
	name,
	description: "Work with Git trees",
	body: "# Workflow\n\nFollow the workflow.\n\n",
	files: ["SKILL.md", reference],
};
const resource = "# Pooled slots\n\nReuse a slot.\n\n";

test("skills discovery returns metadata only and defaults to text rows #test-280", async () => {
	expect(await skillsCommand(["list", "--json"], dependencies())).toEqual({
		exitCode: EXIT_CODES.SUCCESS,
		payload: {
			kind: "skills_list",
			skills: [{ name, description: skill.description, files: skill.files }],
		},
	});
	expect(await skillsCommand([], dependencies())).toEqual({
		exitCode: EXIT_CODES.SUCCESS,
		stdout: `${name}\t${skill.description}\n`,
	});
});

test.each([{ args: ["get", name] }, { args: ["file", name, "SKILL.md"] }])(
	"skills prints the instruction body with one final newline: $args #test-279",
	async ({ args }) => {
		expect(await skillsCommand([...args], dependencies())).toEqual({
			exitCode: EXIT_CODES.SUCCESS,
			stdout: "# Workflow\n\nFollow the workflow.\n",
		});
	},
);

test.each([{ args: ["get", name] }, { args: ["file", name, "SKILL.md"] }])(
	"skills preserves the instruction body in JSON: $args #test-279",
	async ({ args }) => {
		expect(await skillsCommand([...args, "--json"], dependencies())).toEqual({
			exitCode: EXIT_CODES.SUCCESS,
			payload: { kind: "skills_get", name, path: "SKILL.md", content: skill.body },
		});
	},
);

test("skills returns supporting content in JSON and trims only text output #test-279", async () => {
	expect(await skillsCommand(["file", name, reference, "--json"], dependencies())).toEqual({
		exitCode: EXIT_CODES.SUCCESS,
		payload: { kind: "skills_get", name, path: reference, content: resource },
	});
	expect(await skillsCommand(["file", name, reference], dependencies())).toEqual({
		exitCode: EXIT_CODES.SUCCESS,
		stdout: "# Pooled slots\n\nReuse a slot.\n",
	});
});

test.each([
	{ args: ["get", "missing"] },
	{ args: ["file", name, "missing.md"] },
	{ args: ["file", name, "../SKILL.md"] },
	{ args: ["get"] },
	{ args: ["file", name] },
	{ args: ["unknown"] },
])("skills rejects invalid requests: $args #test-281", async ({ args }) => {
	await expect(skillsCommand([...args], dependencies())).rejects.toBeInstanceOf(UsageError);
});

function dependencies() {
	return {
		skills: createStaticProvider([skill], { [name]: { [reference]: resource } }),
	};
}
