/* eslint-disable unicorn/no-null -- The application uses null for an omitted explicit base. */
import {
	DirtyCanonicalError,
	NonFastForwardCanonicalError,
	WrongCanonicalBranchError,
} from "../../src/errors.ts";
import {
	assertCanonicalCanFastForward,
	resolveDefaultBaseForNewBranch,
} from "../../src/application/branches.ts";
import { expect, test } from "bun:test";
import type { CanonicalState } from "../contract/canonical-git-fixture.ts";
import type { GitRunner } from "../../src/services.ts";
import { createCanonicalFixture } from "../contract/canonical-git-fixture.ts";
import { createRefFixture } from "../contract/local-git-refs-fixture.ts";

const git: GitRunner = { run: unexpectedGit, runRaw: unexpectedGit };
const cached = "refs/remotes/origin/develop";
const local = "refs/heads/develop";
const clean: CanonicalState = {
	cleanliness: "clean",
	checkout: { kind: "branch", name: "develop" },
	ancestry: { "origin/develop": "proven" },
};
const options = {
	base: null,
	branchState: "none",
	git,
	noNetwork: true,
	policy: "fresh_canonical",
	root: "/unused",
} as const;

test.each([
	{
		state: "dirty",
		refs: [cached, local],
		observation: { ...clean, cleanliness: "dirty" },
		failure: DirtyCanonicalError,
		reads: ["cleanliness"],
	},
	{
		state: "wrong",
		refs: [cached, local],
		observation: { ...clean, checkout: { kind: "branch", name: "other" } },
		failure: WrongCanonicalBranchError,
		reads: ["cleanliness", "checkout"],
	},
	{
		state: "unproven ancestry",
		refs: [cached, local],
		observation: { ...clean, ancestry: { "origin/develop": "unproven" } },
		failure: NonFastForwardCanonicalError,
		reads: ["cleanliness", "checkout", "headAncestry:origin/develop"],
	},
	{
		state: "uncached-dirty",
		refs: [local],
		observation: { ...clean, cleanliness: "dirty" },
		failure: DirtyCanonicalError,
		reads: ["cleanliness"],
	},
	{
		state: "uncached-wrong",
		refs: [local],
		observation: { ...clean, checkout: { kind: "branch", name: "other" } },
		failure: WrongCanonicalBranchError,
		reads: ["cleanliness", "checkout"],
	},
] as const)("fresh_canonical refuses $state before any Git mutation #test-179", async (row) => {
	const canonical = createCanonicalFixture(row.observation);
	const refs = createRefFixture({
		defaultBranch: "develop",
		refs: row.refs,
		commits: { [local]: { kind: "commit", oid: "local-tip" } },
	});
	await expect(
		resolveDefaultBaseForNewBranch({ ...options, refs, canonical }),
	).rejects.toBeInstanceOf(row.failure);
	expect(canonical.reads).toEqual([...row.reads]);
});

test("dirty canonical refusal takes precedence over the wrong checkout", async () => {
	const canonical = createCanonicalFixture({
		...clean,
		cleanliness: "dirty",
		checkout: { kind: "branch", name: "other" },
	});
	await expect(assertCanonicalCanFastForward(canonical, "develop")).rejects.toBeInstanceOf(
		DirtyCanonicalError,
	);
	expect(canonical.reads).toEqual(["cleanliness"]);
});

test("detached canonical checkout refuses before checking ancestry", async () => {
	const canonical = createCanonicalFixture({ ...clean, checkout: { kind: "detached" } });
	await expect(assertCanonicalCanFastForward(canonical, "develop")).rejects.toBeInstanceOf(
		WrongCanonicalBranchError,
	);
	expect(canonical.reads).toEqual(["cleanliness", "checkout"]);
});

test("uncached clean default returns its commit without ancestry or merge", async () => {
	const canonical = createCanonicalFixture(clean);
	const refs = createRefFixture({
		defaultBranch: "develop",
		refs: [local],
		commits: { [local]: { kind: "commit", oid: "local-tip" } },
	});
	expect(await resolveDefaultBaseForNewBranch({ ...options, refs, canonical })).toBe("local-tip");
	expect(canonical.reads).toEqual(["cleanliness", "checkout"]);
});

test.each(["cleanliness", "checkout", "headAncestry"] as const)(
	"canonical %s rejections propagate",
	async (operation) => {
		const failure = new Error("observation failed");
		const canonical = {
			...createCanonicalFixture(clean),
			[operation]: () => Promise.reject(failure),
		};
		await expect(assertCanonicalCanFastForward(canonical, "develop")).rejects.toBe(failure);
	},
);

function unexpectedGit(): never {
	throw new Error("Canonical policy attempted a Git mutation or raw read");
}
