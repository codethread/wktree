// oxlint-disable import/max-dependencies -- The composition root assembles the live service adapters.
import type { Deps, ProgressReporter } from "./services.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- Direct terminal IO belongs in the live terminal boundary.
import { closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { createBundledSkills } from "./bundled-skills.ts";
import { createFileCdDirective } from "./integrations/cd-directive.ts";
import { createGitWorktreeInventory } from "./git/worktrees.ts";
import { createLiveConfigService } from "./live-config-service.ts";
import { createLiveGitRunner } from "./git/executor.ts";
import { createLiveHookRunner } from "./hooks.ts";
import { createLiveWorkspaceFiles } from "./setup.ts";
import { pick } from "./live-picker.ts";
import { selectMultiplexer } from "./integrations/tmux.ts";

const ANSWER_BYTES = 1;

/** Assemble live services, binding the inventory once to the same runner exposed as git. */
export function createLiveDeps(): Deps {
	const git = createLiveGitRunner();
	const files = createLiveWorkspaceFiles();
	return {
		skills: createBundledSkills(),
		cdDirective: createFileCdDirective(process.env.WKTREE_CD_FILE),
		clock: { now: Date.now },
		config: createLiveConfigService(files.normalizePath),
		files,
		git,
		worktrees: createGitWorktreeInventory(git),
		hooks: createLiveHookRunner(),
		multiplexer: selectMultiplexer({
			TMUX: process.env.TMUX,
			TMUX_PANE: process.env.TMUX_PANE,
		}),
		picker: { confirm, pick },
		progress: createProgressReporter(),
	};
}

// Private terminal helpers.
// Keep synchronous terminal interaction inside an async boundary so IO errors reject the returned promise.
// oxlint-disable-next-line eslint/require-await
async function confirm(prompt: string): Promise<boolean> {
	// oxlint-disable-next-line node/no-sync -- The interactive single-byte prompt owns the terminal until answered.
	const tty = openSync("/dev/tty", "r+");
	try {
		// oxlint-disable-next-line node/no-sync -- Display the prompt before the blocking terminal read.
		writeFileSync(tty, prompt);
		const answer = Buffer.alloc(ANSWER_BYTES);
		// Read one byte at the descriptor's current position.
		// oxlint-disable-next-line node/no-sync
		readSync(tty, answer);
		// oxlint-disable-next-line node/no-sync -- Finish the prompt before returning control to the caller.
		writeFileSync(tty, "\n");
		return answer.toString() === "y" || answer.toString() === "Y";
	} finally {
		// oxlint-disable-next-line node/no-sync -- Release the terminal on both success and failure.
		closeSync(tty);
	}
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
