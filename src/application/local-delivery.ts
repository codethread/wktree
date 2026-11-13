import {
	BlockedError,
	CanonicalRootError,
	DirtyWorktreeError,
	EXIT_CODES,
	SourceNotFreshError,
	TargetNotFreshError,
	TrunkDetectionError,
	UsageError,
	WktreeError,
} from "../errors.ts";
import type { Deps, GitRunner } from "../services.ts";
import { GitError } from "../git/error.ts";
import type { LocalGitRefs } from "./branches.ts";
import type { Worktree } from "../domain/worktree.ts";
import { createLocalGitRefs } from "./branches.ts";
import { listWorktrees } from "../git/worktrees.ts";
import { resolveWorktreeContainingPath } from "./repository.ts";

const ONE_DESTINATION = 1;
const NOT_ANCESTOR = 1;
const NOT_CONFIGURED = 1;
const SNAPSHOT_FIELDS = 3;

export interface LocalDeliveryRequest {
	/** Directory inside the source checkout. */
	cwd: string;
	/** Explicit local destination branch. */
	into: string;
	/** Full reviewed source commit OID. */
	expectedSource: string;
	/** Full validated destination commit OID. */
	expectedTarget: string;
}

export interface LocalDelivery {
	/** Protected canonical root, used only for repository identity. */
	root: string;
	/** Shared Git directory validated against the canonical checkout. */
	commonDir: string;
	/** Registered checkout and local branch supplying the change. */
	source: Worktree & { branch: string };
	/** Registered checkout and local branch receiving the change. */
	target: Worktree & { branch: string };
	/** Exact validated source commit. */
	sourceOid: string;
	/** Exact validated destination commit. */
	targetOid: string;
}

/** Validate caller pins once at the command boundary. */
export function parseDeliveryOid(value: string, flag: string): string {
	if (!/^(?:[\da-f]{40}|[\da-f]{64})$/u.test(value)) {
		throw new UsageError(`--${flag} must be a full lowercase commit OID`);
	}
	return value;
}

/** Resolve explicit local authority and verify both live checkouts before a mutation. */
export async function prepareLocalDelivery(
	request: LocalDeliveryRequest,
	deps: Deps,
): Promise<LocalDelivery> {
	const { canonical, source, target } = await selectLocalCheckouts(request, deps);
	await assertFeatureBranches(createLocalGitRefs(deps.git, canonical.path), { source, target });
	const commonDir = await gitValue(deps.git, canonical.path, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	const delivery = {
		root: canonical.path,
		commonDir,
		source,
		target,
		sourceOid: request.expectedSource,
		targetOid: request.expectedTarget,
	};
	await verifyLocalDelivery(delivery, deps);
	return delivery;
}

/** Recheck live identity, exact pins and cleanliness against an operation's authority. */
export async function verifyLocalDelivery(delivery: LocalDelivery, deps: Deps): Promise<void> {
	const [source, target] = await Promise.all([
		inspectCheckout(deps.git, delivery.source.path),
		inspectCheckout(deps.git, delivery.target.path),
	]);
	assertCheckoutIdentity({
		deps,
		worktree: delivery.source,
		commonDir: delivery.commonDir,
		snapshot: source,
	});
	assertCheckoutIdentity({
		deps,
		worktree: delivery.target,
		commonDir: delivery.commonDir,
		snapshot: target,
	});
	if (source.head !== delivery.sourceOid) {
		throw new SourceNotFreshError(
			`source HEAD moved: expected ${delivery.sourceOid}, observed ${source.head}`,
		);
	}
	if (target.head !== delivery.targetOid) {
		throw new TargetNotFreshError(
			`destination HEAD moved: expected ${delivery.targetOid}, observed ${target.head}`,
		);
	}
	if (source.status !== "" || target.status !== "") {
		throw new DirtyWorktreeError("local delivery requires clean source and destination checkouts");
	}
}

/** Query immutable commit ancestry; distinguish noncontainment from Git failure. */
export async function isLocalAncestor(options: {
	git: GitRunner;
	cwd: string;
	ancestor: string;
	descendant: string;
}): Promise<boolean> {
	const { git, cwd, ancestor, descendant } = options;
	const args = ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant];
	const result = await git.runRaw(args);
	if (result.exitCode !== EXIT_CODES.SUCCESS && result.exitCode !== NOT_ANCESTOR) {
		throw new GitError(args, result.stderr, result.exitCode);
	}
	return result.exitCode === EXIT_CODES.SUCCESS;
}

/** Do not allow branch configuration to add unreviewed merge arguments. */
export async function assertLocalMergeOptions(options: {
	git: GitRunner;
	path: string;
	branch: string;
}): Promise<void> {
	const { git, path, branch } = options;
	const args = ["-C", path, "config", "--get-all", `branch.${branch}.mergeOptions`];
	const result = await git.runRaw(args);
	if (result.exitCode !== EXIT_CODES.SUCCESS && result.exitCode !== NOT_CONFIGURED) {
		throw new GitError(args, result.stderr, result.exitCode);
	}
	if (result.stdout.trim() !== "") {
		throw new UsageError("local integration requires empty destination branch mergeOptions");
	}
}

export function localDeliveryReceipt(delivery: LocalDelivery) {
	return {
		root: delivery.root,
		worktree_path: delivery.source.path,
		source_branch: delivery.source.branch,
		target_branch: delivery.target.branch,
		target_worktree_path: delivery.target.path,
		source_oid: delivery.sourceOid,
		target_before_oid: delivery.targetOid,
	};
}

/**
 * Require a local default designation and exclude that branch from both delivery checkouts.
 * Read only the default name, not its tip; read failures propagate.
 */
export async function assertFeatureBranches(
	refs: Pick<LocalGitRefs, "defaultBranch">,
	checkouts: {
		/** Local branch supplying the change. */
		source: { branch: string };
		/** Local branch receiving the change. */
		target: { branch: string };
	},
): Promise<void> {
	const { source, target } = checkouts;
	const defaultBranch = await refs.defaultBranch();
	if (!defaultBranch) {
		throw new TrunkDetectionError(
			"local delivery requires the local origin/HEAD default-branch designation",
		);
	}
	if (source.branch === defaultBranch || target.branch === defaultBranch) {
		throw new CanonicalRootError("local delivery cannot use the default branch");
	}
}

// --- Private functions ---

// eslint-disable-next-line max-statements -- Keep selection and its refusal conditions together.
async function selectLocalCheckouts(request: LocalDeliveryRequest, deps: Deps) {
	const worktrees = await listWorktrees(deps.git, request.cwd);
	const canonical = worktrees.find((worktree) => worktree.canonical);
	if (!canonical) {
		throw new WktreeError("couldn't determine canonical worktree");
	}
	const source = resolveWorktreeContainingPath(worktrees, request.cwd, deps.files);
	const targets = worktrees.filter(
		(worktree) => worktree.branchRef === `refs/heads/${request.into}`,
	);
	const [target] = targets;
	if (!source || !target || targets.length !== ONE_DESTINATION) {
		throw new BlockedError(
			"local delivery requires one registered source and destination checkout",
		);
	}
	if (source.canonical || target.canonical) {
		throw new CanonicalRootError(
			"local delivery requires noncanonical source and destination worktrees",
		);
	}
	if (deps.files.normalizePath(source.path) === deps.files.normalizePath(target.path)) {
		throw new UsageError("source and destination worktrees must be distinct");
	}
	if (
		worktrees.filter((worktree) => worktree.branchRef === source.branchRef).length !==
		ONE_DESTINATION
	) {
		throw new BlockedError("source branch must be checked out in exactly one worktree");
	}
	const sourceBranch = requireActiveBranch(source);
	const targetBranch = requireActiveBranch(target);
	return {
		canonical,
		source: { ...source, branch: sourceBranch },
		target: { ...target, branch: targetBranch },
	};
}

function requireActiveBranch(worktree: Worktree): string {
	if (
		!worktree.branch ||
		worktree.bare ||
		worktree.detached ||
		worktree.locked ||
		worktree.prunable
	) {
		throw new BlockedError(`worktree must have an active unlocked local branch: ${worktree.path}`);
	}
	return worktree.branch;
}

async function gitValue(git: GitRunner, cwd: string, args: string[]): Promise<string> {
	const result = await git.run(["-C", cwd, ...args]);
	return result.stdout.trim();
}

async function inspectCheckout(git: GitRunner, path: string) {
	const [identity, ref, status] = await Promise.all([
		gitValue(git, path, [
			"rev-parse",
			"--path-format=absolute",
			"--show-toplevel",
			"--git-common-dir",
			"--verify",
			"HEAD^{commit}",
		]),
		gitValue(git, path, ["symbolic-ref", "--quiet", "HEAD"]),
		gitValue(git, path, [
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
			"--ignore-submodules=none",
		]),
	]);
	const fields = identity.split("\n");
	const [top, common, head] = fields;
	if (fields.length !== SNAPSHOT_FIELDS || !top || !common || !head) {
		throw new WktreeError(`invalid Git checkout identity: ${path}`);
	}
	return { top, common, head, ref, status };
}

function assertCheckoutIdentity(options: {
	deps: Deps;
	worktree: LocalDelivery["source"];
	commonDir: string;
	snapshot: Awaited<ReturnType<typeof inspectCheckout>>;
}): void {
	const { deps, worktree, commonDir, snapshot } = options;
	if (
		deps.files.normalizePath(snapshot.top) !== deps.files.normalizePath(worktree.path) ||
		deps.files.normalizePath(snapshot.common) !== deps.files.normalizePath(commonDir) ||
		snapshot.ref !== `refs/heads/${worktree.branch}`
	) {
		throw new BlockedError(`registered worktree identity changed: ${worktree.path}`);
	}
}
