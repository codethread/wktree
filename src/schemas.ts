import { expandConfigGlob, expandConfigPath, rootGlobMatches } from "./domain/config.ts";
// eslint-disable-next-line import/no-nodejs-modules -- Config copy paths normalize against the real filesystem.
import { isAbsolute, normalize } from "node:path";
import type { ConfigPathContext } from "./domain/config.ts";
import { z } from "zod";

const MINIMUM_LIST_LENGTH = 1;

export const CopyModeSchema = z.enum(["copy", "symlink"]);
export const PoolSizeSchema = z.number().int().min(MINIMUM_LIST_LENGTH);

const NonEmptyStringSchema = z.string().regex(/\S/u, "must be a non-empty string");
// Filesystem paths cannot contain a null byte; also emit this constraint for editors.
// oxlint-disable-next-line no-control-regex
const PathSchema = NonEmptyStringSchema.regex(/^[^\u0000]*$/u, "path must not contain a null byte");
const WorktreeLocationSchema = z.enum(["sibling", "nested"]);
const AddPolicySchema = z.strictObject({
	policy: z
		.enum(["origin_default", "fresh_canonical"])
		.describe("Start from origin's default branch or first fast-forward the canonical checkout."),
});
const FinishPolicySchema = z.strictObject({
	delete_branch: z
		.boolean()
		.optional()
		.describe(
			"Delete its branch; requires remove_worktree in the effective policy. Default: false.",
		),
	enabled: z.boolean().optional().describe("Allow finishing; built-in default: true."),
	push: z.boolean().optional().describe("Push before cleanup; built-in default: false."),
	remove_worktree: z
		.boolean()
		.optional()
		.describe("Remove the checkout after integration; built-in default: false."),
	strategy: z
		.enum(["ff_only", "rebase_ff", "squash", "merge_commit"])
		.optional()
		.describe("Integration strategy; built-in default: ff_only."),
});
const PolicyShape = {
	add: AddPolicySchema.optional().describe("Override the inherited add policy."),
	finish: FinishPolicySchema.optional().describe("Override individual inherited finish fields."),
};

const RelativeCopyPathSchema = PathSchema.regex(
	/^[^/~]/u,
	"copy path must be relative, not absolute or start with ~",
)
	.refine((value) => {
		const path = normalize(value);
		return path !== "." && path !== ".." && !path.startsWith("../") && !isAbsolute(path);
	}, "copy path must stay within the worktree")
	.describe("A worktree-relative destination that stays inside the worktree after normalization.");

const CopyDestinationsSchema = z.union([
	RelativeCopyPathSchema,
	z.array(RelativeCopyPathSchema).min(MINIMUM_LIST_LENGTH),
]);

const CopyEntrySchema = z.union([
	RelativeCopyPathSchema.describe("Copy this relative path to the same destination."),
	z.strictObject({
		from: PathSchema.describe(
			"Source relative to the canonical root, absolute, or beginning with ~/.",
		),
		mode: CopyModeSchema.optional().describe("Override the effective copy_mode_default."),
		to: CopyDestinationsSchema,
	}),
]);

const SetupShape = {
	command: NonEmptyStringSchema.optional().describe(
		"Bootstrap command run under bash; omitted values inherit from earlier layers.",
	),
	pre_remote_check: NonEmptyStringSchema.optional().describe(
		"Bash command run before remote operations.",
	),
	worktree_location: WorktreeLocationSchema.optional().describe(
		"Override the inherited placement for new worktrees.",
	),
};

const RepositoryOptionsShape = {
	copy: z
		.array(CopyEntrySchema)
		.optional()
		.describe(
			"Files to materialize before bootstrap; non-empty lists require an effective command.",
		),
	copy_mode_default: CopyModeSchema.optional().describe(
		"Default copy mode; falls back to copy. Explicitly setting it requires an effective command.",
	),
	name: z.string().optional().describe("Display name; defaults to the expanded root's basename."),
	pool_size: PoolSizeSchema.optional().describe(
		"Fixed pool size; requires an effective bootstrap command.",
	),
	...SetupShape,
	...PolicyShape,
};

export const RepositoryConfigSchema = z
	.strictObject(RepositoryOptionsShape)
	.describe(
		"Repository-local .wktree.toml at the canonical root. Explicit fields override global " +
			"settings; omitted fields inherit them.",
	);

const ProjectSchema = z.strictObject({
	...RepositoryOptionsShape,
	copy: RepositoryOptionsShape.copy.default([]),
	root: PathSchema.describe("Canonical checkout path; leading ~/ and relative paths are expanded."),
});

const RuleSchema = z.strictObject({
	root_glob: PathSchema.regex(
		/^(?:~(?:\/|$)|[^~])/u,
		"root_glob supports only leading ~/ expansion",
	).describe("Canonical-root glob: * matches within a segment, ** matches zero or more segments."),
	...SetupShape,
	...PolicyShape,
});

const ConfigSchema = z.strictObject({
	defaults: z
		.strictObject(PolicyShape)
		.default({})
		.describe("Policy patches applied over built-in defaults."),
	project: z
		.array(ProjectSchema)
		.default([])
		.describe("Exact-root overrides; expanded roots must be unique."),
	rule: z
		.array(RuleSchema)
		.default([])
		.describe("Matching rules apply in file order; later values win."),
	worktree_location: WorktreeLocationSchema.default("sibling").describe(
		"Global placement for new worktrees.",
	),
});

type ConfigOutput = z.output<typeof ConfigSchema>;
type ProjectOutput = z.output<typeof ProjectSchema>;

interface ProjectState {
	/** Index in the source project's array. */
	index: number;
	/** Project values after the TOML schema has supplied defaults. */
	project: ProjectOutput;
	/** Expanded canonical root used for matching and duplicate checks. */
	root: string;
}

interface ProjectIssue {
	/** Human-readable configuration error. */
	message: string;
	/** TOML path to the invalid value. */
	path: (number | string)[];
}

export type RawConfig = z.output<ReturnType<typeof createConfigSchema>>;
export type RawRepositoryConfig = z.output<typeof RepositoryConfigSchema>;

/** One TOML schema; path context supplies environment-dependent cross-entry validation. */
export function createConfigSchema(context: ConfigPathContext) {
	return ConfigSchema.superRefine((config, refinement) => {
		for (const issue of collectProjectIssues(config, context)) {
			refinement.addIssue({ code: "custom", message: issue.message, path: issue.path });
		}
	}).describe(
		"WKTREE configuration. Policy inheritance, canonical path matching and normalized path safety " +
			"are also checked at runtime.",
	);
}
// --- Private functions ---

function expandProjects(config: ConfigOutput, context: ConfigPathContext): ProjectState[] {
	return config.project.map((project, index) => ({
		index,
		project,
		root: expandConfigPath(project.root, context),
	}));
}

function requiresCommand(project: ProjectOutput): boolean {
	return (
		project.pool_size !== undefined ||
		project.copy.length >= MINIMUM_LIST_LENGTH ||
		project.copy_mode_default !== undefined
	);
}

function validateProject(
	state: ProjectState,
	config: ConfigOutput,
	context: ConfigPathContext,
): ProjectIssue[] {
	if (!requiresCommand(state.project)) {
		return [];
	}
	const canonicalRoot = context.normalizePath(state.root);
	const effectiveProject = config.project.find(
		(candidate) =>
			context.normalizePath(expandConfigPath(candidate.root, context)) === canonicalRoot,
	);
	if (effectiveProject?.command !== undefined) {
		return [];
	}
	const inheritedCommand = config.rule.some(
		(rule) =>
			rule.command !== undefined &&
			rootGlobMatches(expandConfigGlob(rule.root_glob, context), canonicalRoot),
	);
	if (inheritedCommand) {
		return [];
	}
	return [
		{
			message: `root \`${state.root}\` requires an effective command for pooled or copy setup`,
			path: ["project", state.index, "command"],
		},
	];
}

function collectProjectIssues(config: ConfigOutput, context: ConfigPathContext): ProjectIssue[] {
	const issues: ProjectIssue[] = [];
	const roots = new Set<string>();
	for (const state of expandProjects(config, context)) {
		if (roots.has(state.root)) {
			issues.push({
				message: `duplicate root \`${state.root}\``,
				path: ["project", state.index, "root"],
			});
		}
		roots.add(state.root);
		issues.push(...validateProject(state, config, context));
	}
	return issues;
}
