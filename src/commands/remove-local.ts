import { UnmergedBranchError, UsageError, withFailureContext } from "../errors.ts";
import { finalizeReadyResult, parseOptions, parseOutputMode, requireOption } from "../protocol.ts";
import {
	isLocalAncestor,
	localDeliveryReceipt,
	parseDeliveryOid,
	prepareLocalDelivery,
} from "../application/local-delivery.ts";
import type { CommandResult } from "../protocol.ts";
import type { Deps } from "../services.ts";
import type { FailureContext } from "../errors.ts";
import { withoutLazyFetch } from "../git/executor.ts";

/** Remove a regular task checkout only after exact local containment proof. */
// eslint-disable-next-line max-statements -- Keep cleanup and its confirmed effects together.
export async function removeLocalCommand(args: string[], deps: Deps): Promise<CommandResult> {
	const opts = parseOptions(args);
	if (
		!opts.self ||
		opts.branch ||
		opts.force ||
		opts["keep-branch"] ||
		opts["integrated-into"] ||
		opts.interactive
	) {
		throw new UsageError(
			"--integrated-into-local requires --self and cannot combine with " +
				"--branch, --force, --keep-branch, --integrated-into or --interactive",
		);
	}
	const request = {
		cwd: requireOption(opts, "cwd"),
		into: requireOption(opts, "integrated-into-local"),
		expectedSource: parseDeliveryOid(requireOption(opts, "expected-source"), "expected-source"),
		expectedTarget: parseDeliveryOid(requireOption(opts, "expected-target"), "expected-target"),
	};
	const git = withoutLazyFetch(deps.git);
	const cleanupActions: string[] = [];
	const context: FailureContext = { cleanup_actions: cleanupActions };
	try {
		const delivery = await prepareLocalDelivery(request, { ...deps, git });
		Object.assign(context, localDeliveryReceipt(delivery), {
			target_after_oid: delivery.targetOid,
		});
		if (
			!(await isLocalAncestor({
				git,
				cwd: delivery.target.path,
				ancestor: delivery.sourceOid,
				descendant: delivery.targetOid,
			}))
		) {
			throw new UnmergedBranchError("reviewed source is not contained in the local destination");
		}
		await git.run([
			"-C",
			delivery.target.path,
			"-c",
			"core.hooksPath=/dev/null",
			"worktree",
			"remove",
			delivery.source.path,
		]);
		cleanupActions.push("remove_worktree");
		await git.run([
			"-C",
			delivery.target.path,
			"-c",
			"core.hooksPath=/dev/null",
			"update-ref",
			"--no-deref",
			"-d",
			`refs/heads/${delivery.source.branch}`,
			delivery.sourceOid,
		]);
		cleanupActions.push("delete_branch");
		return finalizeReadyResult({
			output: parseOutputMode(opts),
			payload: {
				kind: "ready",
				...localDeliveryReceipt(delivery),
				target_after_oid: delivery.targetOid,
				removed: true,
				containment: "git_ancestry",
				cleanup_actions: cleanupActions,
			},
			summary: `wktree: removed ${delivery.source.branch}; contained in local ${delivery.target.branch}`,
		});
	} catch (error) {
		throw withFailureContext(error, context);
	}
}
