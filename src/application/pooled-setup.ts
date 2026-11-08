import type { GitRunner, HookRunner, ProgressReporter, WorkspaceFiles } from "../services.ts";
import type { CopyEntry } from "../domain/config.ts";
import { runBootstrap } from "./hooks.ts";

interface PooledSetupDeps {
	/** Caller-scoped Git runner forwarded unchanged to copy setup. */
	git: GitRunner;
	/** Copy setup and bootstrap script generation. */
	files: Pick<WorkspaceFiles, "copy" | "writePostCreateScript">;
	/** Bootstrap script execution. */
	hooks: Pick<HookRunner, "runInline">;
	/** Bootstrap output forwarding. */
	progress: Pick<ProgressReporter, "stream">;
}

interface PooledSetupRequest {
	/** Canonical root supplying relative copy sources. */
	root: string;
	/** Pool slot path after checkout of the requested branch. */
	target: string;
	/** Resolved copy/symlink entries; an empty list still runs copy setup. */
	entries: CopyEntry[];
	/** Project name supplied to bootstrap. */
	projectName: string;
	/** Resolved bootstrap command, or null when absent. */
	command: string | null;
	/** Skip bootstrap while retaining copy setup. */
	skipCommand: boolean;
}

/** Apply setup to the selected checkout; the allocation caller owns rollback. */
export async function setupPooledCheckout(
	deps: PooledSetupDeps,
	request: PooledSetupRequest,
): Promise<void> {
	const { root, target, entries, projectName, command, skipCommand } = request;
	await deps.files.copy({ root, target, entries, git: deps.git });
	if (!skipCommand && command) {
		await runBootstrap(deps, {
			root,
			created: target,
			command,
			projectName,
			pooled: true,
		});
	}
}
