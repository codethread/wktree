/* eslint-disable unicorn/no-null -- The existing ref contract represents missing defaults and bases with null. */
import { TrunkDetectionError, UsageError } from "../../src/errors.ts";
import { expect, test } from "bun:test";
import {
	resolveLocalBaseCommit,
	resolveOfflinePoolResetCommit,
} from "../../src/application/branches.ts";
import { createRefFixture } from "../contract/local-git-refs-fixture.ts";

const cached = "refs/remotes/origin/main";
const local = "refs/heads/main";
const explicit = "refs/heads/explicit";

test.each([
	{ name: "no default is designated", defaultBranch: null, failure: TrunkDetectionError },
	{ name: "both default refs are absent", defaultBranch: "main", failure: UsageError },
])("pooled reset requires an explicit base when $name", async (row) => {
	const refs = createRefFixture({
		defaultBranch: row.defaultBranch,
		refs: [explicit],
		commits: { [explicit]: { kind: "commit", oid: "explicit-tip" } },
	});
	await expect(resolveOfflinePoolResetCommit(refs, null)).rejects.toBeInstanceOf(row.failure);
	expect(await resolveOfflinePoolResetCommit(refs, "explicit")).toBe("explicit-tip");
});

test.each([
	{
		name: "prefers the cached default over local and explicit bases",
		refs: [cached, local, explicit],
		selected: cached,
	},
	{
		name: "uses the local default over an explicit base when the cached ref is absent",
		refs: [local, explicit],
		selected: local,
	},
])("pooled reset $name", async (row) => {
	const refs = createRefFixture({
		defaultBranch: "main",
		refs: row.refs,
		commits: { [row.selected]: { kind: "commit", oid: "default-tip" } },
	});
	expect(await resolveOfflinePoolResetCommit(refs, "explicit")).toBe("default-tip");
	expect(refs.reads).not.toContain(`hasRef:${explicit}`);
	expect(refs.reads).not.toContain(`commit:${explicit}`);
});

test.each([
	{ name: "cached", refs: [cached, local, explicit], selected: cached },
	{ name: "local", refs: [local, explicit], selected: local },
])("an unresolvable $name reset commit does not use another base", async (row) => {
	const refs = createRefFixture({
		defaultBranch: "main",
		refs: row.refs,
		commits: { [row.selected]: { kind: "unresolvable" } },
	});
	await expect(resolveOfflinePoolResetCommit(refs, "explicit")).rejects.toBeInstanceOf(UsageError);
	expect(refs.reads).not.toContain(`hasRef:${explicit}`);
	expect(refs.reads).not.toContain(`commit:${explicit}`);
});

test.each(["defaultBranch", "hasRef", "commit"] as const)(
	"pooled reset propagates a rejected %s read without using the explicit base",
	async (operation) => {
		const refs = createRefFixture({
			defaultBranch: "main",
			refs: [cached, explicit],
			commits: { [cached]: { kind: "commit", oid: "cached-tip" } },
		});
		const failure = new Error("Read failed");
		const reject = (): Promise<never> => Promise.reject(failure);
		await expect(
			resolveOfflinePoolResetCommit({ ...refs, [operation]: reject }, "explicit"),
		).rejects.toBe(failure);
		expect(refs.reads).not.toContain(`hasRef:${explicit}`);
		expect(refs.reads).not.toContain(`commit:${explicit}`);
	},
);

test.each([
	{
		name: "prefers a local branch over the same origin branch name",
		base: "topic",
		refs: ["refs/heads/topic", "refs/remotes/origin/topic"],
		selected: "refs/heads/topic",
	},
	{
		name: "prefers an explicit origin branch over a colliding local name",
		base: "origin/topic",
		refs: ["refs/heads/origin/topic", "refs/remotes/origin/topic"],
		selected: "refs/remotes/origin/topic",
	},
	{
		name: "uses the origin branch when no local branch matches",
		base: "topic",
		refs: ["refs/remotes/origin/topic"],
		selected: "refs/remotes/origin/topic",
	},
	{
		name: "falls back from origin/topic to refs/heads/origin/topic",
		base: "origin/topic",
		refs: ["refs/heads/origin/topic"],
		selected: "refs/heads/origin/topic",
	},
	{
		name: "falls back from origin/topic to refs/remotes/origin/origin/topic",
		base: "origin/topic",
		refs: ["refs/remotes/origin/origin/topic"],
		selected: "refs/remotes/origin/origin/topic",
	},
])("explicit base $name", async (row) => {
	const refs = createRefFixture({
		defaultBranch: null,
		refs: row.refs,
		commits: { [row.selected]: { kind: "commit", oid: "selected-tip" } },
	});
	expect(await resolveLocalBaseCommit(refs, row.base)).toBe("selected-tip");
});

test.each(["release-tag", "refs/heads/topic", "0123456789abcdef0123456789abcdef01234567"])(
	"explicit base peels the original spelling and resolved commit: %s",
	async (base) => {
		const refs = createRefFixture({
			defaultBranch: null,
			refs: [],
			commits: {
				[base]: { kind: "commit", oid: "peeled-tip" },
				"peeled-tip": { kind: "commit", oid: "peeled-tip" },
			},
		});
		expect(await resolveLocalBaseCommit(refs, base)).toBe("peeled-tip");
	},
);

test.each([
	{
		base: "topic",
		refs: ["refs/heads/topic", "refs/remotes/origin/topic"],
		selected: "refs/heads/topic",
	},
	{ base: "missing", refs: [], selected: "missing" },
])("explicit base refuses an unresolvable $selected commit", async (row) => {
	const refs = createRefFixture({
		defaultBranch: null,
		refs: row.refs,
		commits: { [row.selected]: { kind: "unresolvable" } },
	});
	await expect(resolveLocalBaseCommit(refs, row.base)).rejects.toBeInstanceOf(UsageError);
});
