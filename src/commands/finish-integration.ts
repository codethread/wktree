import type { AddPolicy, FinishStrategy } from "../domain/config.ts";
import {
	BlockedError,
	DirtyWorktreeError,
	EXIT_CODES,
	FinishConflictError,
	TargetNotFreshError,
	UsageError,
} from "../errors.ts";
import {
	assertCanonicalCanFastForward,
	createCanonicalGitObservations,
} from "../application/branches.ts";
import { GitError } from "../git/error.ts";
import type { GitRunner } from "../services.ts";
import type { Worktree } from "../domain/worktree.ts";

const MERGE_CONFLICT = 1;
const PREVIEW_DRIVER_REQUIRED = "wktree-preview-needs-external-driver";
// Exit above 128 makes Git abort recursive virtual-base merges instead of absorbing a conflict.
const PREVIEW_DRIVER_COMMAND = `echo ${PREVIEW_DRIVER_REQUIRED} >&2; exit 129`;
const CONFIG_NOT_FOUND = 1;
const CONFIG_VALUE_OFFSET = 1;
const CONFIG_KEY_START = 0;

interface IntegrateOptions {
	/** Canonical checkout receiving integrated changes. */
	canonicalPath: string;
	/** Git process boundary. */
	git: GitRunner;
	/** Source branch being integrated. */
	sourceBranch: string;
	/** Source checkout used by the rebase strategy. */
	sourcePath: string;
	/** Immutable target commit checked before canonical advancement. */
	targetRef: string;
	/** Canonical branch whose merge options affect integration. */
	targetBranch: string;
}

/** Validated integration inputs: squash needs a caller title, other strategies none. */
export type IntegrationPlan =
	| {
			/** Configured non-squash strategy; carries no message inputs. */
			strategy: Exclude<FinishStrategy, "squash">;
	  }
	| {
			/** Squash integration strategy. */
			strategy: "squash";
			/** Caller-supplied squash commit subject. */
			title: string;
			/** Caller-supplied squash commit body; undefined when omitted. */
			body: string | undefined;
	  };

/** Narrowed squash inputs accepted by the squash integrator. */
type SquashIntegration = Extract<IntegrationPlan, { strategy: "squash" }>;

export async function assertCleanSource(git: GitRunner, source: Worktree): Promise<void> {
	const status = await git.run(["-C", source.path, "status", "--porcelain=v1"]);
	if (status.stdout.trim() !== "") {
		throw new DirtyWorktreeError("source worktree has uncommitted changes");
	}
}

/** Establish conflict safety before canonical advancement, rebasing only the source. */
export async function prepareSourceIntegration(
	options: IntegrateOptions,
	integration: IntegrationPlan,
): Promise<void> {
	switch (integration.strategy) {
		case "ff_only": {
			await assertSourceCanFastForwardTarget(options);
			return;
		}
		case "squash":
		case "merge_commit": {
			const overrides = await previewMergeConfig(options);
			await previewMerge(options, overrides);
			return;
		}
		case "rebase_ff": {
			await rebaseSource(options);
		}
	}
}

export async function integrateSource(
	options: IntegrateOptions,
	integration: IntegrationPlan,
): Promise<void> {
	switch (integration.strategy) {
		case "ff_only":
		case "rebase_ff": {
			await integrateFastForward(options);
			return;
		}
		case "squash": {
			await integrateSquash(options, integration);
			return;
		}
		case "merge_commit": {
			await integrateMergeCommit(options);
		}
	}
}

export async function assertFinishTargetReady(options: {
	git: GitRunner;
	policy: AddPolicy;
	root: string;
	targetBranch: string;
}): Promise<string> {
	const { git, policy, root, targetBranch } = options;
	if (policy === "fresh_canonical") {
		return assertCanonicalFresh(git, root, targetBranch);
	}
	const status = await git.run(["-C", root, "status", "--porcelain=v1"]);
	if (status.stdout.trim() !== "") {
		throw new TargetNotFreshError("target worktree has uncommitted changes");
	}
	const branch = await git.run(["-C", root, "branch", "--show-current"]);
	assertWorktreeOnTargetBranch(branch.stdout.trim(), targetBranch);
	await assertTargetContainsOrigin(git, root, targetBranch);
	return `refs/heads/${targetBranch}`;
}

/** Validated integration inputs: squash requires a caller title, other strategies none. */
export function parseIntegrationPlan(
	strategy: FinishStrategy,
	title: string | boolean | undefined,
	body: string | boolean | undefined,
): IntegrationPlan {
	const normalizedTitle = normalizedText(title);
	const normalizedBody = normalizedText(body);
	if (strategy !== "squash") {
		if (normalizedTitle !== undefined || normalizedBody !== undefined) {
			throw new UsageError("--title and --body require finish strategy squash");
		}
		return { strategy };
	}
	if (normalizedTitle === undefined) {
		throw new UsageError("missing required --title");
	}
	return { body: normalizedBody, strategy, title: normalizedTitle };
}
// --- Private functions ---

async function assertSourceCanFastForwardTarget(options: IntegrateOptions): Promise<void> {
	const args = [
		"-C",
		options.canonicalPath,
		"merge-base",
		"--is-ancestor",
		options.targetRef,
		`refs/heads/${options.sourceBranch}`,
	];
	const canFastForward = await options.git.runRaw(args);
	if (canFastForward.exitCode === MERGE_CONFLICT) {
		throw new FinishConflictError("source branch cannot fast-forward target branch");
	}
	if (canFastForward.exitCode !== EXIT_CODES.SUCCESS) {
		throw new GitError(args, canFastForward.stderr, canFastForward.exitCode);
	}
}

async function previewMerge(options: IntegrateOptions, overrides: string[]): Promise<void> {
	const args = [
		"-C",
		options.canonicalPath,
		...overrides,
		`--attr-source=${options.targetRef}`,
		"merge-tree",
		"--write-tree",
		"--name-only",
		options.targetRef,
		`refs/heads/${options.sourceBranch}`,
	];
	const preview = await options.git.runRaw(args);
	if (preview.stderr.includes(PREVIEW_DRIVER_REQUIRED)) {
		throw new BlockedError("merge preview requires an external merge driver; integrate manually");
	}
	if (preview.exitCode === MERGE_CONFLICT) {
		throw new FinishConflictError(`merge preview found conflicts:\n${preview.stdout.trim()}`);
	}
	if (preview.exitCode !== EXIT_CODES.SUCCESS) {
		throw new GitError(args, preview.stderr, preview.exitCode);
	}
}

async function previewMergeConfig(options: IntegrateOptions): Promise<string[]> {
	const args = [
		"-C",
		options.canonicalPath,
		"config",
		"--null",
		"--get-regexp",
		String.raw`^(branch\..*\.mergeoptions|pull\.twohead|merge\..*\.driver)$`,
	];
	const config = await options.git.runRaw(args);
	if (config.exitCode === CONFIG_NOT_FOUND) {
		return [];
	}
	if (config.exitCode !== EXIT_CODES.SUCCESS) {
		throw new GitError(args, config.stderr, config.exitCode);
	}
	return mergePreviewOverrides(config.stdout, options.targetBranch);
}

function mergePreviewOverrides(records: string, targetBranch: string): string[] {
	const settings = new Map(
		records
			.split("\0")
			.filter((record) => record !== "")
			.map((setting) => {
				const separator = setting.indexOf("\n");
				return [
					setting.slice(CONFIG_KEY_START, separator),
					setting.slice(separator + CONFIG_VALUE_OFFSET).trim(),
				] as const;
			}),
	);
	const overrides: string[] = [];
	for (const [key, value] of settings) {
		if (
			(key === `branch.${targetBranch}.mergeoptions` && value !== "") ||
			(key === "pull.twohead" && value !== "ort")
		) {
			throw new BlockedError(
				`cannot safely preview finish with Git setting ${key}; remove it or integrate manually`,
			);
		}
		if (key.startsWith("merge.") && key.endsWith(".driver")) {
			// Unused drivers are harmless. A needed driver must fail preview without running its command.
			overrides.push("-c", `${key}=${PREVIEW_DRIVER_COMMAND}`);
		}
	}
	return overrides;
}

async function integrateFastForward(options: IntegrateOptions): Promise<void> {
	await options.git.run(["-C", options.canonicalPath, "merge", "--ff-only", options.sourceBranch]);
}

async function integrateSquash(
	options: IntegrateOptions,
	integration: SquashIntegration,
): Promise<void> {
	const message = composeSquashCommitMessage({
		body: integration.body,
		messages: await readSourceCommitMessages(options),
		sourceBranch: options.sourceBranch,
		title: integration.title,
	});
	await options.git.run(["-C", options.canonicalPath, "merge", "--squash", options.sourceBranch]);
	await options.git.run(["-C", options.canonicalPath, "commit", "-m", message]);
}

async function integrateMergeCommit(options: IntegrateOptions): Promise<void> {
	await options.git.run([
		"-C",
		options.canonicalPath,
		"merge",
		"--no-ff",
		"-m",
		mergeCommitMessage(options.sourceBranch),
		options.sourceBranch,
	]);
}

async function rebaseSource(options: IntegrateOptions): Promise<void> {
	const args = ["-C", options.sourcePath, "rebase", options.targetRef];
	const rebase = await options.git.runRaw(args);
	if (rebase.exitCode !== EXIT_CODES.SUCCESS) {
		const unmerged = await options.git.run(["-C", options.sourcePath, "ls-files", "--unmerged"]);
		if (unmerged.stdout !== "") {
			throw new FinishConflictError(
				`source rebase stopped with conflicts:\n${rebase.stderr.trim()}`,
			);
		}
		throw new GitError(args, rebase.stderr, rebase.exitCode);
	}
}

async function assertCanonicalFresh(
	git: GitRunner,
	root: string,
	targetBranch: string,
): Promise<string> {
	await assertCanonicalCanFastForward(createCanonicalGitObservations(git, root), targetBranch);
	return `origin/${targetBranch}`;
}

function assertWorktreeOnTargetBranch(current: string, targetBranch: string): void {
	if (current !== targetBranch) {
		throw new TargetNotFreshError(
			`target branch must be checked out on ${targetBranch}; currently on ${current || "detached HEAD"}`,
		);
	}
}

async function assertTargetContainsOrigin(
	git: GitRunner,
	root: string,
	targetBranch: string,
): Promise<void> {
	const targetIsCurrent = await git.runRaw([
		"-C",
		root,
		"merge-base",
		"--is-ancestor",
		`origin/${targetBranch}`,
		"HEAD",
	]);
	if (targetIsCurrent.exitCode !== EXIT_CODES.SUCCESS) {
		throw new TargetNotFreshError(`target branch is behind origin/${targetBranch}`);
	}
}

function normalizedText(value: string | boolean | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		return undefined;
	}
	return trimmed;
}

function mergeCommitMessage(sourceBranch: string): string {
	return `chore: merge worktree\n\nSource branch:\n${sourceBranch.match(/.{1,40}/gu)?.join("\n") ?? sourceBranch}`;
}

/** Squash message sections: caller text, branch provenance, then the squashed history. */
function composeSquashCommitMessage(options: {
	title: string;
	body: string | undefined;
	sourceBranch: string;
	messages: readonly string[];
}): string {
	const { title, body, sourceBranch, messages } = options;
	const sections = [title];
	if (body) {
		sections.push(body);
	}
	sections.push(
		`Source branch: ${sourceBranch}`,
		...messages.map((message) =>
			message
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n"),
		),
	);
	return sections.join("\n\n");
}

/** Source commit messages in the range being squashed, oldest first. */
async function readSourceCommitMessages(options: {
	git: GitRunner;
	canonicalPath: string;
	targetRef: string;
	sourceBranch: string;
}): Promise<string[]> {
	const log = await options.git.run([
		"-C",
		options.canonicalPath,
		"log",
		"--reverse",
		"--format=%B%x00",
		`${options.targetRef}..${options.sourceBranch}`,
	]);
	return log.stdout
		.split("\0")
		.map((message) => message.trim())
		.filter((message) => message !== "");
}
