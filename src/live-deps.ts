// oxlint-disable import/max-dependencies -- The composition root assembles the live service adapters.
import type { Deps, ProgressReporter } from "./services.ts";
import { createFileCdDirective } from "./integrations/cd-directive.ts";
import { createGitWorktreeInventory } from "./git/worktrees.ts";
import { createLiveConfigService } from "./live-config-service.ts";
import { createLiveGitRunner } from "./git/executor.ts";
import { createLiveHookRunner } from "./hooks.ts";
import { createLiveWorkspaceFiles } from "./setup.ts";
import { pick } from "./live-picker.ts";
import { selectMultiplexer } from "./integrations/tmux.ts";

/** Assemble live services, binding the inventory once to the same runner exposed as git. */
export function createLiveDeps(): Deps {
	const git = createLiveGitRunner();
	const files = createLiveWorkspaceFiles();
	return {
		cdDirective: createFileCdDirective(process.env.WKTREE_CD_FILE),
		config: createLiveConfigService(files.normalizePath),
		files,
		git,
		worktrees: createGitWorktreeInventory(git),
		hooks: createLiveHookRunner(),
		multiplexer: selectMultiplexer({
			TMUX: process.env.TMUX,
			TMUX_PANE: process.env.TMUX_PANE,
		}),
		picker: { pick },
		progress: createProgressReporter(),
	};
}

function createProgressReporter(): ProgressReporter {
	return {
		banner(line) {
			process.stderr.write(`${line}\n`);
		},
		error(msg) {
			process.stderr.write(`${msg}\n`);
		},
		stream(stream, line) {
			process[stream].write(`${line}\n`);
		},
	};
}
