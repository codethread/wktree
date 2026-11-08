/* eslint-disable unicorn/no-null -- The consumed application contract models missing bases/defaults with null. */
import { TrunkDetectionError, UsageError } from "../../src/errors.ts";
import { expect, test } from "bun:test";
import {
	resolveDefaultBaseForNewBranch,
	resolveOfflineDefaultBase,
} from "../../src/application/branches.ts";
import type { GitRunner } from "../../src/services.ts";
import { createRefFixture } from "../contract/local-git-refs-fixture.ts";

const cached = "refs/remotes/origin/develop";
const local = "refs/heads/develop";
const git: GitRunner = { run: unexpectedGit, runRaw: unexpectedGit };
const options = {
	canonical: { cleanliness: unexpectedGit, checkout: unexpectedGit, headAncestry: unexpectedGit },
	base: null,
	branchState: "none",
	git,
	noNetwork: true,
	policy: "origin_default",
	root: "/unused",
} as const;

test.each([
	{ name: null, failure: TrunkDetectionError },
	{ name: "develop", failure: UsageError },
])(
	"offline default refusal precedes canonical Git calls: %j #test-181",
	async ({ name, failure }) => {
		const refs = createRefFixture({ defaultBranch: name, refs: [], commits: {} });
		const request = { ...options, policy: "fresh_canonical" as const, refs };
		await expect(resolveDefaultBaseForNewBranch(request)).rejects.toBeInstanceOf(failure);
		refs.reads.length = 0;
		expect(await resolveDefaultBaseForNewBranch({ ...request, base: "explicit-commit" })).toBe(
			"explicit-commit",
		);
		expect(refs.reads).toEqual([]);
	},
);

test("offline origin_default uses the local commit when the cached default ref is absent #test-176", async () => {
	const refs = createRefFixture({
		defaultBranch: "develop",
		refs: [local],
		commits: { [local]: { kind: "commit", oid: "local-tip" } },
	});
	expect(await resolveDefaultBaseForNewBranch({ ...options, refs })).toBe("local-tip");
});

test("offline origin_default selects the cached ref without querying the local branch #test-177", async () => {
	const refs = createRefFixture({ defaultBranch: "develop", refs: [cached], commits: {} });
	expect(await resolveDefaultBaseForNewBranch({ ...options, refs })).toBe("origin/develop");
	expect(refs.reads).not.toContain(`hasRef:${local}`);
});

test.each([
	{ refs: [cached, local], selected: cached, oid: "cached-tip" },
	{ refs: [local], selected: local, oid: "local-tip" },
])("offline default resolution reads only the selected $selected commit", async (row) => {
	const refs = createRefFixture({
		defaultBranch: "develop",
		refs: row.refs,
		commits: { [row.selected]: { kind: "commit", oid: row.oid } },
	});
	expect(await resolveOfflineDefaultBase(refs)).toBe(row.oid);
});

test("an unresolvable cached commit fails without querying the local fallback", async () => {
	const refs = createRefFixture({
		defaultBranch: "develop",
		refs: [cached, local],
		commits: { [cached]: { kind: "unresolvable" }, [local]: { kind: "commit", oid: "local-tip" } },
	});
	await expect(resolveOfflineDefaultBase(refs)).rejects.toBeInstanceOf(UsageError);
	expect(refs.reads).not.toContain(`hasRef:${local}`);
	expect(refs.reads).not.toContain(`commit:${local}`);
});

test.each(["local", "remote", "local-remote"] as const)(
	"existing %s branch bypasses default and canonical reads and ignores an explicit base",
	async (branchState) => {
		const refs = createRefFixture({ defaultBranch: null, refs: [], commits: {} });
		expect(
			await resolveDefaultBaseForNewBranch({ ...options, branchState, base: "ignored", refs }),
		).toBeNull();
		expect(refs.reads).toEqual([]);
	},
);

function unexpectedGit(): never {
	throw new Error("Default selection attempted a canonical Git operation");
}
