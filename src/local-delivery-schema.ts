import { z } from "zod";

const oid = z.string().regex(/^(?:[\da-f]{40}|[\da-f]{64})$/u);
const receipt = z.object({
	root: z.string(),
	worktree_path: z.string(),
	source_branch: z.string(),
	target_branch: z.string(),
	target_worktree_path: z.string(),
	source_oid: oid,
	target_before_oid: oid,
	target_after_oid: oid,
});
const setupLine = z.object({ stream: z.enum(["stdout", "stderr"]), line: z.string() });
const log = z.object({
	diagnostics: z.array(z.string()),
	setup_output: z.array(setupLine),
});

/** Discover the complete stdout envelopes without reading a repository. */
export function localDeliverySchemas() {
	const integrated = receipt.extend({
		ok: z.literal(true),
		kind: z.literal("ready"),
		strategy: z.literal("ff_only"),
		integrated: z.literal(true),
		cleanup_actions: z.tuple([]),
		...log.shape,
	});
	const removed = receipt.extend({
		ok: z.literal(true),
		kind: z.literal("ready"),
		removed: z.literal(true),
		containment: z.literal("git_ancestry"),
		cleanup_actions: z.tuple([z.literal("remove_worktree"), z.literal("delete_branch")]),
		...log.shape,
	});
	const failure = receipt.partial().extend({
		ok: z.literal(false),
		kind: z.enum(["blocked", "error"]),
		reason: z.string(),
		message: z.string(),
		integration_attempted: z.boolean().optional(),
		integrated: z.boolean().optional(),
		cleanup_actions: z.array(z.string()).optional(),
		...log.shape,
	});
	return {
		integrate: z.toJSONSchema(integrated),
		remove_local: z.toJSONSchema(removed),
		failure: z.toJSONSchema(failure),
	};
}
