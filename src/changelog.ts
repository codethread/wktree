import { z } from "zod";

const FIRST = 0;
const ONE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SHORT_HASH_LENGTH = 7;
export const changelogVersionSchema = z
	.string()
	.regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
const adoptionSchema = z.strictObject({
	requirement: z.enum(["optional", "required"]),
	text: z.string().min(ONE),
});
export const changelogChangeSchema = z.strictObject({
	commit: z.string().min(ONE),
	summary: z.string().min(ONE),
	body: z.string(),
	breaking: z.array(z.string().min(ONE)),
	adoption: z.array(adoptionSchema),
});
export const changelogReleaseSchema = z.strictObject({
	version: changelogVersionSchema,
	changes: z.array(changelogChangeSchema),
});
export const changelogHistorySchema = z.array(changelogReleaseSchema);
export const changelogQuerySchema = z
	.object({
		since: changelogVersionSchema.optional(),
		release: changelogVersionSchema.optional(),
		limit: z.coerce.number().int().min(ONE).max(MAX_LIMIT).optional(),
		offset: z.coerce.number().int().min(FIRST).default(FIRST),
	})
	.refine((query) => query.since === undefined || query.release === undefined, {
		message: "Select --since or --release, not both.",
	});
const pageSchema = z.strictObject({
	ok: z.literal(true),
	kind: z.literal("changelog"),
	tool: z.string(),
	installedVersion: changelogVersionSchema,
	historyStartsAt: changelogVersionSchema
		.optional()
		.describe("Oldest recorded release; earlier history is unavailable."),
	since: changelogVersionSchema.optional(),
	release: changelogVersionSchema.optional(),
	releases: changelogHistorySchema,
	total: z.number().int().nonnegative(),
	offset: z.number().int().nonnegative(),
	limit: z.number().int().min(ONE).max(MAX_LIMIT),
	nextOffset: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Continue with --offset when present; absent means exhausted."),
});
export type ChangelogChange = z.infer<typeof changelogChangeSchema>;
export type ChangelogRelease = z.infer<typeof changelogReleaseSchema>;
export type ChangelogQuery = z.infer<typeof changelogQuerySchema>;
export interface ChangelogPage {
	/** Command document discriminator. */
	kind: "changelog";
	/** Successful finite query. */
	ok: true;
	/** Public executable requesting this package history. */
	tool: string;
	/** Version embedded in the executable. */
	installedVersion: string;
	/** Oldest recorded release; earlier history is unavailable. */
	historyStartsAt: string | undefined;
	/** Exclusive lower version bound, when requested. */
	since: string | undefined;
	/** Exact release selection, mutually exclusive with since. */
	release: string | undefined;
	/** Newest-first release page. */
	releases: ChangelogRelease[];
	/** Number of entries (including empty-release notices) matching the query before pagination. */
	total: number;
	/** Starting position in matching entries. */
	offset: number;
	/** Maximum changes in this page. */
	limit: number;
	/** Continue with --offset when present; absent means exhausted. */
	nextOffset: number | undefined;
}

/** On-demand successful response schema, without accessing any package or repository. */
export function changelogSchema(): z.core.JSONSchema.JSONSchema {
	return z.toJSONSchema(pageSchema);
}

/** Query only recorded package history; no repository, configuration or network dependencies. */
// eslint-disable-next-line max-statements -- Keep selection, pagination and its completeness metadata together.
export function queryChangelog(
	{ tool, version: installedVersion }: { tool: string; version: string },
	history: ChangelogRelease[],
	query: ChangelogQuery,
): ChangelogPage {
	const ordered = history
		.filter((release) => Bun.semver.order(release.version, installedVersion) <= FIRST)
		.toSorted((left, right) => Bun.semver.order(right.version, left.version));
	let selected = ordered.slice(FIRST, ONE);
	if (query.since !== undefined) {
		const { since } = query;
		selected = ordered.filter((release) => Bun.semver.order(release.version, since) > FIRST);
	}
	if (query.release !== undefined) {
		selected = ordered.filter((release) => release.version === query.release);
		if (selected.length === FIRST) {
			throw new Error(`No recorded release ${query.release} for ${tool}.`);
		}
	}
	const limit = query.limit ?? DEFAULT_LIMIT;
	const entries = selected.flatMap((release) => {
		if (release.changes.length === FIRST) {
			return [release];
		}
		return release.changes.map((change) => ({ version: release.version, changes: [change] }));
	});
	const page = entries.slice(query.offset, query.offset + limit);
	const releases = [...new Set(page.map((entry) => entry.version))].map((version) => ({
		version,
		changes: page.filter((entry) => entry.version === version).flatMap((entry) => entry.changes),
	}));
	const end = query.offset + page.length;
	let nextOffset: number | undefined = undefined;
	if (end < entries.length) {
		nextOffset = end;
	}
	return {
		ok: true,
		kind: "changelog",
		tool,
		installedVersion,
		historyStartsAt: ordered.at(-ONE)?.version,
		since: query.since,
		release: query.release,
		releases,
		total: entries.length,
		offset: query.offset,
		limit,
		nextOffset,
	};
}

/** Same recorded facts for each CLI's human presentation; Commander and output stay local. */
// eslint-disable-next-line max-statements -- Render one bounded page in release order.
export function renderChangelog(page: ChangelogPage): string {
	const lines = [`${page.tool} changelog (installed ${page.installedVersion})`];
	if (page.historyStartsAt !== undefined) {
		lines.push(
			`Recorded history starts at ${page.historyStartsAt}; earlier history is unavailable.`,
		);
	}
	if (page.releases.length === FIRST) {
		lines.push("No recorded releases match this page.");
	}
	for (const release of page.releases) {
		lines.push("", release.version);
		if (release.changes.length === FIRST) {
			lines.push("No recorded changes.");
		}
		for (const change of release.changes) {
			lines.push(
				`- ${change.summary} (${change.commit.slice(FIRST, SHORT_HASH_LENGTH)})`,
				...change.breaking.map((note) => `  BREAKING: ${note}`),
				...change.adoption.map((note) => `  Adoption (${note.requirement}): ${note.text}`),
			);
			if (change.body !== "") {
				lines.push("", change.body);
			}
		}
	}
	if (page.nextOffset !== undefined) {
		let selection = "";
		if (page.since !== undefined) {
			selection = ` --since ${page.since}`;
		}
		if (page.release !== undefined) {
			selection = ` --release ${page.release}`;
		}
		lines.push(
			"",
			`More: ${page.tool} changelog${selection} --offset ${page.nextOffset} --limit ${page.limit}`,
		);
	}
	return `${lines.join("\n")}\n`;
}
