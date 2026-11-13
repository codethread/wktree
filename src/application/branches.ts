import type { BranchState, TreeDefaultBranch } from "../domain/worktree.ts";
import {
	DirtyCanonicalError,
	DirtyWorktreeError,
	EXIT_CODES,
	NonFastForwardCanonicalError,
	TrunkDetectionError,
	UnmergedBranchError,
	UsageError,
	WktreeError,
	WrongCanonicalBranchError,
} from "../errors.ts";
import { parseTrunkFromRemoteShow, parseTrunkFromSymbolicRef } from "../git/worktrees.ts";
import type { AddPolicy } from "../domain/config.ts";
import { GitError } from "../git/error.ts";
import type { GitRunner } from "../services.ts";

/** Git diff reports differing content with exit status one. */
const DIFF_FOUND = 1;
const NO_PATHS = 0;
const NOT_SYMBOLIC = 1;

export type CommitRead =
	| {
			/** Resolved commit object. */
			kind: "commit";
			/** Full object ID. */
			oid: string;
	  }
	| {
			/** Ref cannot be resolved to an existing commit. */
			kind: "unresolvable";
	  };

/** Read-only local observations; callers retain lifecycle and mutation authority. */
export interface LocalGitRefs {
	/** Read the local origin/HEAD branch name, independent of target ref presence; null if undesignated. */
	defaultBranch: () => Promise<string | null>;
	/** Check exact full-ref membership; failure is not absence. */
	hasRef: (fullRef: string) => Promise<boolean>;
	/** Peel a ref to a commit without substituting another ref. */
	commit: (ref: string) => Promise<CommitRead>;
}

export type CanonicalCheckout =
	| {
			/** HEAD is attached to a local branch. */
			kind: "branch";
			/** Short branch name, independent of the designated default. */
			name: string;
	  }
	| {
			/** HEAD is detached from any branch. */
			kind: "detached";
	  };

/** Whether HEAD ancestry was established; unproven does not imply divergence. */
export type AncestryProof = "proven" | "unproven";

/**
 * Read-only canonical worktree checks, separate from LocalGitRefs discovery.
 * Sequential reads are not an atomic snapshot; callers retain lifecycle and mutation authority.
 */
export interface CanonicalGitObservations {
	/** Empty porcelain status is clean; reported changes are dirty. Read failures reject. */
	cleanliness: () => Promise<"clean" | "dirty">;
	/** Read the current branch or detached state. Read failures reject. */
	checkout: () => Promise<CanonicalCheckout>;
	/** Prove HEAD is an ancestor of targetRef; any nonzero Git exit is unproven, launch failures reject. */
	headAncestry: (targetRef: string) => Promise<AncestryProof>;
}

interface ComparisonRequest {
	/** Branch whose integration is being verified. */
	branch: string;
	/** Injected Git process boundary. */
	git: GitRunner;
	/** Integration target named in refusal diagnostics. */
	integratedInto: string;
	/** Repository containing the compared refs. */
	root: string;
	/** Source commit or ref for the comparison. */
	source: string;
	/** Target commit or ref that must contain the source changes. */
	target: string;
}

/** Bind reads to root using the supplied GitRunner; offline callers supply a no-lazy-fetch runner. */
export function createLocalGitRefs(git: GitRunner, root: string): LocalGitRefs {
	return {
		defaultBranch: () => readLocalDefaultBranch(git, root),
		hasRef: (ref) => refExists(git, root, ref),
		commit: (ref) => readCommit(git, root, ref),
	};
}

/** Bind reads to the canonical root and supplied runner, preserving any no-lazy-fetch scope. */
export function createCanonicalGitObservations(
	git: GitRunner,
	root: string,
): CanonicalGitObservations {
	return {
		cleanliness: () => readCanonicalCleanliness(git, root),
		checkout: () => readCanonicalCheckout(git, root),
		headAncestry: (ref) => readHeadAncestry(git, root, ref),
	};
}

export async function detectBranchState(
	git: GitRunner,
	root: string,
	branch: string,
): Promise<BranchState> {
	const refs = await git.runRaw([
		"-C",
		root,
		"for-each-ref",
		"--format=%(refname)",
		"refs/heads",
		"refs/remotes/origin",
	]);
	return branchStateFromRefs(refs.stdout.split("\n"), branch);
}

export async function detectOriginDefaultBranch(git: GitRunner, root: string): Promise<string> {
	const symbolic = await git.runRaw(["-C", root, "symbolic-ref", "refs/remotes/origin/HEAD"]);
	const fromSymbolic =
		symbolic.exitCode === EXIT_CODES.SUCCESS && parseTrunkFromSymbolicRef(symbolic.stdout);
	if (fromSymbolic) {
		return fromSymbolic;
	}
	const remoteShow = await git.runRaw(["-C", root, "remote", "show", "origin"]);
	const fromRemoteShow =
		remoteShow.exitCode === EXIT_CODES.SUCCESS && parseTrunkFromRemoteShow(remoteShow.stdout);
	if (fromRemoteShow) {
		return fromRemoteShow;
	}
	throw new TrunkDetectionError("couldn't determine origin default branch");
}

export async function resolveDefaultBaseForNewBranch(options: {
	refs: LocalGitRefs;
	/** Canonical checks used only by fresh_canonical default-base selection. */
	canonical: CanonicalGitObservations;
	git: GitRunner;
	root: string;
	policy: AddPolicy;
	branchState: BranchState;
	base: string | null;
	noNetwork: boolean;
}): Promise<string | null> {
	const { branchState, base } = options;
	if (branchState !== "none") {
		// oxlint-disable-next-line unicorn/no-null -- public result type signals "no base needed" with null
		return null;
	}
	if (base) {
		return base;
	}
	return await resolvePolicyDefaultBase(options);
}

export async function readLocalDefaultBranch(git: GitRunner, root: string): Promise<string | null> {
	const args = ["-C", root, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"];
	const symbolic = await git.runRaw(args);
	if (symbolic.exitCode === EXIT_CODES.SUCCESS) {
		if (!symbolic.stdout.trim().startsWith("refs/remotes/origin/")) {
			throw new TrunkDetectionError(
				"origin/HEAD must designate an origin remote-tracking branch name",
			);
		}
		return parseTrunkFromSymbolicRef(symbolic.stdout);
	}
	if (symbolic.exitCode !== NOT_SYMBOLIC) {
		throw new GitError(args, symbolic.stderr, symbolic.exitCode);
	}
	// oxlint-disable-next-line unicorn/no-null -- Local default discovery explicitly models missing metadata.
	return null;
}

/** A worktree view prefers the local default tip, unlike add's cached-origin policy. */
export async function resolveTreeDefaultBranch(
	git: GitRunner,
	root: string,
): Promise<TreeDefaultBranch> {
	const branch = await readLocalDefaultBranch(git, root);
	if (!branch) {
		throw new TrunkDetectionError(
			"origin/HEAD is unknown locally; set it with git remote set-head origin <default-branch>, then retry tree",
		);
	}
	let ref = `refs/heads/${branch}`;
	if (!(await refExists(git, root, ref))) {
		ref = `refs/remotes/origin/${branch}`;
		if (!(await refExists(git, root, ref))) {
			throw new TrunkDetectionError(
				`neither local nor cached origin default branch ${branch} exists; fetch it before retrying tree`,
			);
		}
	}
	const resolved = await git.run([
		"-C",
		root,
		"rev-parse",
		"--verify",
		"--end-of-options",
		`${ref}^{commit}`,
	]);
	return { branch, head: resolved.stdout.trim(), ref };
}

/** Resolve the cached default commit, using the local default only when the cached ref is absent. */
export async function resolveOfflineDefaultBase(refs: LocalGitRefs): Promise<string> {
	const trunk = await requireLocalDefaultBranch(refs);
	const cached = `refs/remotes/origin/${trunk}`;
	if (await refs.hasRef(cached)) {
		return requireCommit(await refs.commit(cached), "cached origin default branch", cached);
	}
	const ref = `refs/heads/${trunk}`;
	if (!(await refs.hasRef(ref))) {
		throw new UsageError(
			`cached origin and local default branch ${trunk} are missing; pass --base <local-ref> with --no-network`,
		);
	}
	return requireCommit(await refs.commit(ref), "local default branch", ref);
}

export async function resolveLocalBaseCommit(refs: LocalGitRefs, base: string): Promise<string> {
	const ref = await resolveBaseRef(refs, base);
	return requireCommit(await refs.commit(ref), "--base", ref);
}

/** Reject dirty or wrong/detached checkouts before checking ancestry. */
export async function assertCanonicalCanFastForward(
	canonical: CanonicalGitObservations,
	defaultBranch: string,
): Promise<void> {
	await assertCanonicalOnDefault(canonical, defaultBranch);
	const ref = `origin/${defaultBranch}`;
	if ((await canonical.headAncestry(ref)) === "unproven") {
		throw new NonFastForwardCanonicalError(`canonical root cannot fast-forward to ${ref}`);
	}
}

/**
 * Apply the guards, then let native --ff-only enforce the merge against current refs.
 * No lock or retry bridges observation and mutation; merge failures propagate.
 */
export async function fastForwardCanonicalDefault(options: {
	/** Observations bound to the same canonical root and scoped runner as the merge. */
	canonical: CanonicalGitObservations;
	/** Git runner that performs the mutation after the read-only guards. */
	git: GitRunner;
	/** Canonical root receiving the fast-forward. */
	root: string;
	/** Default branch required in the canonical worktree; origin/<defaultBranch> is the target. */
	defaultBranch: string;
}): Promise<void> {
	const { canonical, git, root, defaultBranch } = options;
	await assertCanonicalCanFastForward(canonical, defaultBranch);
	await git.run(["-C", root, "merge", "--ff-only", `origin/${defaultBranch}`]);
}

export async function resolveBaseRef(refs: LocalGitRefs, base: string): Promise<string> {
	if (base.startsWith("origin/")) {
		const remoteName = base.slice("origin/".length);
		if (await refs.hasRef(`refs/remotes/origin/${remoteName}`)) {
			return `refs/remotes/origin/${remoteName}`;
		}
	}
	if (await refs.hasRef(`refs/heads/${base}`)) {
		return `refs/heads/${base}`;
	}
	if (await refs.hasRef(`refs/remotes/origin/${base}`)) {
		return `refs/remotes/origin/${base}`;
	}
	return requireCommit(await refs.commit(base), "--base", base);
}

export async function assertBranchIntegratedInto(options: {
	git: GitRunner;
	root: string;
	worktreePath: string;
	branch: string;
	integratedInto: string;
}): Promise<void> {
	const { git, root, worktreePath, branch, integratedInto } = options;
	const dirty = await git.runRaw(["-C", worktreePath, "status", "--porcelain=v1"]);
	if (dirty.stdout.trim() !== "") {
		throw new DirtyWorktreeError(`worktree ${worktreePath} has uncommitted changes`);
	}
	const source = await resolveCommitRef({
		git,
		label: "source branch",
		ref: `refs/heads/${branch}`,
		root,
	});
	const target = await resolveCommitRef({
		git,
		label: "--integrated-into",
		ref: integratedInto,
		root,
	});
	const paths = await changedPathsBetween({ branch, git, integratedInto, root, source, target });
	await assertContentEquivalent({ branch, git, integratedInto, paths, root, source, target });
}

export async function assertBranchSafelyDeletable(
	git: GitRunner,
	root: string,
	branch: string,
): Promise<void> {
	const upstream = await readBranchUpstream(git, root, branch);
	let mergeTarget = "HEAD";
	if (upstream.exitCode === EXIT_CODES.SUCCESS) {
		mergeTarget = upstream.stdout.trim();
	}
	const merged = await git.runRaw(["-C", root, "merge-base", "--is-ancestor", branch, mergeTarget]);
	if (merged.exitCode !== EXIT_CODES.SUCCESS) {
		throw new UnmergedBranchError(`branch ${branch} is not merged; pass --force to remove it`);
	}
}

export async function refExists(git: GitRunner, root: string, ref: string): Promise<boolean> {
	const result = await git.run(["-C", root, "for-each-ref", "--format=%(refname)", ref]);
	return result.stdout.split("\n").includes(ref);
}
// --- Private functions ---

async function resolvePolicyDefaultBase({
	canonical,
	git,
	root,
	policy,
	noNetwork,
	refs,
}: Parameters<typeof resolveDefaultBaseForNewBranch>[number]): Promise<string> {
	const defaultBranch = await resolveDefaultBranchName({ git, root, noNetwork, refs });
	if (noNetwork && !(await refs.hasRef(`refs/remotes/origin/${defaultBranch}`))) {
		const localBase = await resolveOfflineDefaultBase(refs);
		if (policy === "fresh_canonical") {
			await assertCanonicalOnDefault(canonical, defaultBranch);
		}
		return localBase;
	}
	if (policy !== "fresh_canonical") {
		return `origin/${defaultBranch}`;
	}
	await fastForwardCanonicalDefault({ canonical, git, root, defaultBranch });
	return defaultBranch;
}

function resolveDefaultBranchName({
	git,
	root,
	noNetwork,
	refs,
}: Pick<
	Parameters<typeof resolveDefaultBaseForNewBranch>[number],
	"git" | "root" | "noNetwork" | "refs"
>): Promise<string> {
	if (!noNetwork) {
		return detectOriginDefaultBranch(git, root);
	}
	return requireLocalDefaultBranch(refs);
}

async function requireLocalDefaultBranch(refs: LocalGitRefs): Promise<string> {
	const trunk = await refs.defaultBranch();
	if (!trunk) {
		throw new TrunkDetectionError(
			"origin/HEAD is unknown locally; pass --base <local-ref> with --no-network",
		);
	}
	return trunk;
}

async function assertCanonicalOnDefault(
	canonical: CanonicalGitObservations,
	defaultBranch: string,
): Promise<void> {
	if ((await canonical.cleanliness()) === "dirty") {
		throw new DirtyCanonicalError("canonical root has uncommitted changes");
	}
	const current = await canonical.checkout();
	let name = "detached HEAD";
	if (current.kind === "branch") {
		({ name } = current);
	}
	if (current.kind === "detached" || current.name !== defaultBranch) {
		throw new WrongCanonicalBranchError(
			`canonical root must be checked out on ${defaultBranch}; currently on ${name}`,
		);
	}
}

function branchStateFromRefs(lines: string[], branch: string): BranchState {
	const local = lines.includes(`refs/heads/${branch}`);
	const remote = lines.includes(`refs/remotes/origin/${branch}`);
	if (local && remote) {
		return "local-remote";
	}
	if (local) {
		return "local";
	}
	if (remote) {
		return "remote";
	}
	return "none";
}

async function resolveCommitRef(options: {
	git: GitRunner;
	label: string;
	ref: string;
	root: string;
}): Promise<string> {
	const { git, label, ref, root } = options;
	return requireCommit(await readCommit(git, root, ref), label, ref);
}

async function readCommit(git: GitRunner, root: string, ref: string): Promise<CommitRead> {
	const resolved = await git.runRaw([
		"-C",
		root,
		"rev-parse",
		"--verify",
		"--end-of-options",
		`${ref}^{commit}`,
	]);
	if (resolved.exitCode !== EXIT_CODES.SUCCESS || resolved.stdout.trim() === "") {
		return { kind: "unresolvable" };
	}
	return { kind: "commit", oid: resolved.stdout.trim() };
}

function requireCommit(result: CommitRead, label: string, ref: string): string {
	if (result.kind === "unresolvable") {
		throw new UsageError(`${label} must name an existing commit: ${ref}`);
	}
	return result.oid;
}

async function readCanonicalCleanliness(git: GitRunner, root: string): Promise<"clean" | "dirty"> {
	const status = await git.run(["-C", root, "status", "--porcelain=v1"]);
	if (status.stdout.trim() === "") {
		return "clean";
	}
	return "dirty";
}

async function readCanonicalCheckout(git: GitRunner, root: string): Promise<CanonicalCheckout> {
	const current = await git.run(["-C", root, "branch", "--show-current"]);
	const name = current.stdout.trim();
	if (name === "") {
		return { kind: "detached" };
	}
	return { kind: "branch", name };
}

async function readHeadAncestry(git: GitRunner, root: string, ref: string): Promise<AncestryProof> {
	const ancestor = await git.runRaw(["-C", root, "merge-base", "--is-ancestor", "HEAD", ref]);
	if (ancestor.exitCode === EXIT_CODES.SUCCESS) {
		return "proven";
	}
	return "unproven";
}

async function resolveIntegrationBase(options: ComparisonRequest): Promise<string> {
	const { branch, git, integratedInto, root, source, target } = options;
	if (source === target) {
		throw new UnmergedBranchError(`branch ${branch} cannot be proven integrated into itself`);
	}
	const mergeBase = await git.runRaw(["-C", root, "merge-base", source, target]);
	if (mergeBase.exitCode !== EXIT_CODES.SUCCESS || mergeBase.stdout.trim() === "") {
		throw new UnmergedBranchError(`branch ${branch} and ${integratedInto} have no common ancestor`);
	}
	return mergeBase.stdout.trim();
}

async function changedPathsBetween(options: ComparisonRequest): Promise<string[]> {
	const { branch, git, integratedInto, root, source, target } = options;
	const base = await resolveIntegrationBase({ branch, git, integratedInto, root, source, target });
	const changedPaths = await git.runRaw(["-C", root, "diff", "--name-only", "-z", base, source]);
	const paths = changedPaths.stdout.split("\0").filter((path) => path !== "");
	if (paths.length === NO_PATHS) {
		throw new UnmergedBranchError(`branch ${branch} has no changes to prove integrated`);
	}
	return paths;
}

async function assertContentEquivalent(
	options: ComparisonRequest & { paths: string[] },
): Promise<void> {
	const { branch, git, integratedInto, paths, root, source, target } = options;
	const equivalent = await git.runRaw([
		"-C",
		root,
		"diff",
		"--quiet",
		source,
		target,
		"--",
		...paths,
	]);
	if (equivalent.exitCode === EXIT_CODES.SUCCESS) {
		return;
	}
	if (equivalent.exitCode === DIFF_FOUND) {
		throw new UnmergedBranchError(
			`branch ${branch} is not content-equivalent to ${integratedInto}; refusing to remove it`,
		);
	}
	throw new WktreeError(
		`could not compare branch ${branch} with ${integratedInto}: ${equivalent.stderr.trim()}`,
	);
}

function readBranchUpstream(git: GitRunner, root: string, branch: string) {
	return git.runRaw(["-C", root, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
}
