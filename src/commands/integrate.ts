import { BlockedError, EXIT_CODES, withFailureContext } from "../errors.ts";
import {
	assertLocalMergeOptions,
	isLocalAncestor,
	localDeliveryReceipt,
	parseDeliveryOid,
	prepareLocalDelivery,
	verifyLocalDelivery,
} from "../application/local-delivery.ts";
import {
	finalizeReadyResult,
	parseOptions,
	parseOutputMode,
	renderJsonResult,
	requireOption,
} from "../protocol.ts";
import type { CommandResult } from "../protocol.ts";
import type { Deps } from "../services.ts";
import type { FailureContext } from "../errors.ts";
import type { LocalDelivery } from "../application/local-delivery.ts";
import { localDeliverySchemas } from "../local-delivery-schema.ts";
import { withoutLazyFetch } from "../git/executor.ts";

/** Fast-forward one explicit local feature checkout; caller owns queue admission. */
// eslint-disable-next-line max-statements -- Keep the mutation and its partial-effect accounting together.
export async function integrateCommand(args: string[], deps: Deps): Promise<CommandResult> {
	const opts = parseOptions(args);
	if (opts.schema) {
		const result = {
			exitCode: EXIT_CODES.SUCCESS,
			payload: { kind: "local_delivery_schema", schemas: localDeliverySchemas() },
		};
		if (opts.json) {
			return result;
		}
		return renderJsonResult(result);
	}
	const request = {
		cwd: requireOption(opts, "cwd"),
		into: requireOption(opts, "into"),
		expectedSource: parseDeliveryOid(requireOption(opts, "expected-source"), "expected-source"),
		expectedTarget: parseDeliveryOid(requireOption(opts, "expected-target"), "expected-target"),
	};
	const git = withoutLazyFetch(deps.git);
	const context: FailureContext = {
		integration_attempted: false,
		integrated: false,
		cleanup_actions: [],
	};
	try {
		const delivery = await prepareLocalDelivery(request, { ...deps, git });
		Object.assign(context, localDeliveryReceipt(delivery));
		await assertLocalMergeOptions({
			git,
			path: delivery.target.path,
			branch: delivery.target.branch,
		});
		if (
			!(await isLocalAncestor({
				git,
				cwd: delivery.target.path,
				ancestor: delivery.targetOid,
				descendant: delivery.sourceOid,
			}))
		) {
			throw new BlockedError(
				"destination is not an ancestor of the reviewed source; refresh and revalidate before retrying",
			);
		}
		context.integration_attempted = true;
		context.integrated = undefined;
		try {
			await git.run([
				"-C",
				delivery.target.path,
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"submodule.recurse=false",
				"merge",
				"--ff-only",
				"--no-squash",
				"--no-autostash",
				"--no-edit",
				delivery.sourceOid,
			]);
		} catch (error) {
			const observed = await git.runRaw([
				"-C",
				delivery.target.path,
				"rev-parse",
				"--verify",
				"HEAD^{commit}",
			]);
			if (observed.exitCode === EXIT_CODES.SUCCESS) {
				recordIntegrationObservation(context, delivery, observed.stdout.trim());
			}
			throw error;
		}
		const after = await git.run([
			"-C",
			delivery.target.path,
			"rev-parse",
			"--verify",
			"HEAD^{commit}",
		]);
		recordIntegrationObservation(context, delivery, after.stdout.trim());
		await verifyLocalDelivery({ ...delivery, targetOid: delivery.sourceOid }, { ...deps, git });

		return finalizeReadyResult({
			output: parseOutputMode(opts),
			payload: {
				kind: "ready",
				...localDeliveryReceipt(delivery),
				target_after_oid: delivery.sourceOid,
				strategy: "ff_only",
				integrated: true,
				cleanup_actions: [],
			},
			summary: `wktree: integrated ${delivery.source.branch} into local ${delivery.target.branch}`,
		});
	} catch (error) {
		throw withFailureContext(error, context);
	}
}

// --- Private functions ---

function recordIntegrationObservation(
	context: FailureContext,
	delivery: LocalDelivery,
	observed: string,
): void {
	context.target_after_oid = observed;
	context.integrated = undefined;
	if (observed === delivery.sourceOid) {
		context.integrated = true;
	} else if (observed === delivery.targetOid) {
		context.integrated = false;
	}
}
