import { createStaticProvider, validateSkillFrontmatter } from "skills-handler";
import type { SkillProvider } from "skills-handler";
import matter from "gray-matter";
import pooledSlots from "../skills/git-workflow/references/pooled-slots.md" with { type: "text" };
import workflow from "../skills/git-workflow/SKILL.md" with { type: "text" };

/** Embed the package's instructions and references in source and compiled CLIs. */
export function createBundledSkills(): SkillProvider {
	const parsed = matter(workflow);
	if (!validateSkillFrontmatter(parsed.data)) {
		throw new Error("Invalid frontmatter in Wktree's bundled git-workflow skill");
	}
	const { name, description } = parsed.data;
	return createStaticProvider(
		[
			{
				name,
				description,
				body: parsed.content.trim(),
				files: ["SKILL.md", "references/pooled-slots.md"],
			},
		],
		{ [name]: { "references/pooled-slots.md": pooledSlots } },
	);
}
