import { CanonicalRootError, EXIT_CODES, TrunkDetectionError } from "../../src/errors.ts";
import { expect, mock, test } from "bun:test";
import { GitError } from "../../src/git/error.ts";
import type { LocalGitRefs } from "../../src/application/branches.ts";
import { assertFeatureBranches } from "../../src/application/local-delivery.ts";
import { createRefFixture } from "../contract/local-git-refs-fixture.ts";

const checkouts = { source: { branch: "task/slice" }, target: { branch: "feature/base" } };

test("local delivery accepts feature branches without resolving the designated default tip", async () => {
	const refs = createRefFixture({ defaultBranch: "develop", refs: [], commits: {} });
	await assertFeatureBranches(refs, checkouts);
	expect(refs.reads).toEqual(["defaultBranch"]);
});

test.each(["source", "target"] as const)(
	"local delivery protects the designated default as %s",
	async (side) => {
		const refs = createRefFixture({ defaultBranch: "develop", refs: [], commits: {} });
		await expect(
			assertFeatureBranches(refs, { ...checkouts, [side]: { branch: "develop" } }),
		).rejects.toBeInstanceOf(CanonicalRootError);
		expect(refs.reads).toEqual(["defaultBranch"]);
	},
);

test("local delivery requires a designated default branch", async () => {
	// eslint-disable-next-line unicorn/no-null -- LocalGitRefs uses null for an absent default designation.
	const refs = createRefFixture({ defaultBranch: null, refs: [], commits: {} });
	await expect(assertFeatureBranches(refs, checkouts)).rejects.toBeInstanceOf(TrunkDetectionError);
	expect(refs.reads).toEqual(["defaultBranch"]);
});

test.each(["malformed", "git"] as const)(
	"local delivery propagates a %s default-ref read failure",
	async (kind) => {
		const failure = readFailure(kind);
		const defaultBranch = mock<LocalGitRefs["defaultBranch"]>(() => Promise.reject(failure));
		await expect(assertFeatureBranches({ defaultBranch }, checkouts)).rejects.toBe(failure);
		expect(defaultBranch.mock.calls).toEqual([[]]);
	},
);

function readFailure(kind: "malformed" | "git") {
	if (kind === "malformed") {
		return new TrunkDetectionError("malformed designation");
	}
	return new GitError(["symbolic-ref"], "read failed", EXIT_CODES.FAILURE);
}
