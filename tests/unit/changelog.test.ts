import { expect, test } from "bun:test";
import { queryChangelog, renderChangelog } from "../../src/changelog.ts";
import type { ChangelogRelease } from "../../src/changelog.ts";

const LATEST_CHANGES = 2;
const DEFAULT_LIMIT = 20;
const tool = { tool: "busybee", version: "0.7.0" };
const change = {
	commit: "d7e55e9fb000d05b255240210a7df3694c0447df",
	summary: "Local workflow dependencies",
	body: "Use **local dependencies**.\n\n```sh\nbusybee discover RUN\n```",
	breaking: ["Explicit breaking note"],
	adoption: [{ requirement: "optional" as const, text: "Install in .workflows" }],
};
const history: ChangelogRelease[] = [
	{ version: "0.8.0", changes: [change] },
	{ version: "0.7.0", changes: [change, change] },
	{ version: "0.6.0", changes: [change] },
];

test("latest selection excludes releases beyond the installed version #test-416", () => {
	const page = queryChangelog(tool, history, { offset: 0 });
	expect(page.releases.map((release) => release.version)).toEqual(["0.7.0"]);
	expect(page.total).toBe(LATEST_CHANGES);
	expect(page.historyStartsAt).toBe("0.6.0");
});

test("exclusive since filters before paging entries within a release", () => {
	const page = queryChangelog(tool, history, { since: "0.6.0", limit: 1, offset: 0 });
	expect(page.releases).toEqual([{ version: "0.7.0", changes: [change] }]);
	expect(page).toMatchObject({ total: 2, nextOffset: 1 });
	const last = queryChangelog(tool, history, { since: "0.6.0", limit: 1, offset: 1 });
	expect(last.releases).toEqual(page.releases);
	expect(last.nextOffset).toBeUndefined();
});

test("exact selection and human rendering retain explicit breaking and adoption meaning #test-706", () => {
	const page = queryChangelog(tool, history, { release: "0.6.0", offset: 0 });
	expect(page.releases).toEqual([{ version: "0.6.0", changes: [change] }]);
	const text = renderChangelog(page);
	expect(text).toContain("(d7e55e9)");
	expect(text).toContain(change.body);
	expect(JSON.stringify(page)).toContain(JSON.stringify(change.body));
	expect(text).toContain("BREAKING: Explicit breaking note");
	expect(text).toContain("Adoption (optional): Install in .workflows");
	expect(() => queryChangelog(tool, history, { release: "0.5.0", offset: 0 })).toThrow(Error);
});

test("large histories of empty releases stay bounded and expose exhaustion #test-704", () => {
	const empty = Array.from({ length: 140 }, (_unused, patch) => ({
		version: `0.1.${patch}`,
		changes: [],
	}));
	const page = queryChangelog(tool, empty, { since: "0.0.0", offset: 0 });
	expect(page.releases).toHaveLength(DEFAULT_LIMIT);
	expect(page).toMatchObject({ total: 140, nextOffset: 20 });
	const exhausted = queryChangelog(tool, empty, { since: "0.0.0", offset: 140 });
	expect(exhausted.releases).toEqual([]);
	expect(exhausted.nextOffset).toBeUndefined();
});
