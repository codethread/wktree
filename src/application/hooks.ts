import type { Deps, HookRunner, ProgressReporter, WorkspaceFiles } from "../services.ts";
import { EXIT_CODES, PreRemoteCheckError } from "../errors.ts";
import type { PostCreateScriptSpec } from "../domain/worktree.ts";
import type { TreesConfig } from "../domain/config.ts";

export async function runPreRemoteCheck(
	deps: Pick<Deps, "config" | "hooks">,
	options: {
		config: TreesConfig;
		root: string;
		operation: string;
	},
): Promise<void> {
	const { config, root, operation } = options;
	const { preRemoteCheck } = deps.config.explain(config, root);
	if (!preRemoteCheck.value) {
		return;
	}
	const result = await deps.hooks.runCommand(preRemoteCheck.value, root, {});
	if (result.exitCode === EXIT_CODES.SUCCESS) {
		return;
	}
	throw new PreRemoteCheckError(operation, preRemoteCheck.source, result.stderr.join("\n"));
}

export async function runBootstrap(
	deps: {
		/** Bootstrap script generation. */
		files: Pick<WorkspaceFiles, "writePostCreateScript">;
		/** Bootstrap script execution. */
		hooks: Pick<HookRunner, "runInline">;
		/** Bootstrap output forwarding. */
		progress: Pick<ProgressReporter, "stream">;
	},
	spec: PostCreateScriptSpec,
): Promise<void> {
	const scriptPath = deps.files.writePostCreateScript(spec);
	await deps.hooks.runInline(scriptPath, {
		cwd: spec.created,
		env: {},
		onLine: (stream, line) => deps.progress.stream(stream, line),
	});
}
