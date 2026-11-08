import type { Deps, ProgressReporter } from "../services.ts";
import { openRequestForWorktree } from "../integrations/multiplexer.ts";
import { pathContains } from "./repository.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- resolve cwd at the filesystem boundary
import { resolve } from "node:path";

type InteractiveDeps = Pick<Deps, "cdDirective" | "files" | "multiplexer" | "progress">;

/** Move the user's focus into a worktree: its multiplexer session, or the cd directive outside one. */
export async function focusWorktree(
	deps: InteractiveDeps,
	worktree: { path: string; title: string },
): Promise<void> {
	if (!deps.multiplexer.attached) {
		await warnOnFailure(deps.progress, "write cd directive", () =>
			deps.cdDirective.write(worktree.path),
		);
		return;
	}
	await warnOnFailure(deps.progress, "open multiplexer session", () =>
		deps.multiplexer.open(openRequestForWorktree(worktree.path, worktree.title)),
	);
}

/**
 * Plan leaving a worktree that is about to be removed or recycled. Call it while the
 * worktree still exists so the caller's directory resolves; run the returned step after
 * all output, because closing the invoking session may end this process.
 */
export function planLeaveWorktree(
	deps: InteractiveDeps,
	options: { cwd: string; root: string; worktreePath: string },
): () => Promise<void> {
	const { cwd, root, worktreePath } = options;
	const callerInside = pathContains(
		deps.files.normalizePath(worktreePath),
		deps.files.normalizePath(resolve(cwd)),
	);
	return async () => {
		if (callerInside) {
			await warnOnFailure(deps.progress, "write cd directive", () => deps.cdDirective.write(root));
		}
		await warnOnFailure(deps.progress, "close multiplexer sessions", () =>
			deps.multiplexer.closeUnder(worktreePath),
		);
	};
}
// --- Private functions ---

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/** Interactive effects follow a completed git operation, so failures only warn. */
async function warnOnFailure(
	progress: ProgressReporter,
	action: string,
	effect: () => void | Promise<void>,
): Promise<void> {
	try {
		await effect();
	} catch (error) {
		progress.error(`warning: couldn't ${action}: ${errorMessage(error)}`);
	}
}
