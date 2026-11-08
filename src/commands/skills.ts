import type { CommandResult, OutputMode } from "../protocol.ts";
import { EXIT_CODES, UsageError } from "../errors.ts";
import type { Skill, SkillProvider } from "skills-handler";
import { parseOptions, parseOutputMode } from "../protocol.ts";
import type { Deps } from "../services.ts";

/** Read bundled skills without consulting Git, repository configuration, or the network. */
export async function skillsCommand(
	args: string[],
	deps: Pick<Deps, "skills">,
): Promise<CommandResult> {
	const output = parseOutputMode(parseOptions(args));
	const [action = "list"] = args;
	if (action === "list") {
		return listSkills(await deps.skills.getSkills(), output);
	}
	if (action !== "get" && action !== "file") {
		throw new UsageError(`unknown skills subcommand: ${action}`);
	}
	return readSkill(args, deps.skills, output);
}

async function readSkill(
	args: string[],
	provider: SkillProvider,
	output: OutputMode,
): Promise<CommandResult> {
	const [action, name, resource] = args;
	const skill = findSkill(await provider.getSkills(), name);
	let path = "SKILL.md";
	if (action === "file") {
		path = requireResource(skill, resource);
	}
	const content = await readContent(provider, skill, path);
	return result({ kind: "skills_get", name: skill.name, path, content }, content, output);
}

function listSkills(skills: Skill[], output: OutputMode): CommandResult {
	const entries = skills.map(({ name, description, files }) => ({ name, description, files }));
	const text = entries.map((skill) => `${skill.name}\t${skill.description}`).join("\n");
	return result({ kind: "skills_list", skills: entries }, text, output);
}

function findSkill(skills: Skill[], name: string | undefined): Skill {
	const skill = skills.find((entry) => entry.name === name);
	if (!skill) {
		throw new UsageError(`skill not found: ${name ?? "(missing name)"}`);
	}
	return skill;
}

function requireResource(skill: Skill, path: string | undefined): string {
	if (!path || !skill.files.includes(path)) {
		throw new UsageError(`skill file not found: ${skill.name}/${path ?? "(missing path)"}`);
	}
	return path;
}

async function readContent(provider: SkillProvider, skill: Skill, path: string): Promise<string> {
	if (path === "SKILL.md") {
		return skill.body;
	}
	const content = await provider.getSkillFile(skill.name, path);
	if (content === null) {
		throw new Error(`Bundled skill file is unavailable: ${skill.name}/${path}`);
	}
	return content;
}

function result(payload: object, content: string, output: OutputMode): CommandResult {
	if (output.json) {
		return { exitCode: EXIT_CODES.SUCCESS, payload };
	}
	return { exitCode: EXIT_CODES.SUCCESS, stdout: `${content.trimEnd()}\n` };
}
