import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/* oxlint-disable-next-line import/no-nodejs-modules -- fixtures stub an fzf binary on disk */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
/* oxlint-disable-next-line import/no-nodejs-modules -- stub fixtures live at known paths */
import { join } from "node:path";
/* oxlint-disable-next-line import/no-nodejs-modules -- the stub PATH needs a temporary directory */
import { tmpdir } from "node:os";

const FZF_MODULE = join(import.meta.dir, "../../src/fzf.ts");
const EXECUTABLE_MODE = 0o755;
const FZF_SUCCESS = 0;
const FZF_NO_MATCH = 1;
const FZF_INTERRUPTED = 130;
const FZF_FAILURE = 2;

const FZF_SCRIPT = `
		const { fzf } = await import(${JSON.stringify(FZF_MODULE)});
		try {
			process.stdout.write(await fzf(["/a\\tfirst", "/b\\tsecond"], { delimiter: "\\t", withNth: "2.." }));
		} catch (error) {
			process.stdout.write(error.name + ": " + error.message);
		}
	`;

/**
 * Run a picker script in a child Bun whose PATH starts with a stub fzf that records its
 * arguments, echoes the first input line, and exits with exitCode. The child
 * prints the selection, or the thrown error's name and message.
 */
async function runWithStub(bin: string, exitCode: number, script = FZF_SCRIPT) {
	await writeFile(
		join(bin, "fzf"),
		`#!/bin/sh\nprintf '%s\\n' "$@" > "${join(bin, "args")}"\n` +
			`IFS= read -r line\nprintf '%s\\n' "$line"\nexit ${exitCode}\n`,
		{ mode: EXECUTABLE_MODE },
	);

	const proc = Bun.spawn([process.execPath, "-e", script], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		stdout: "pipe",
	});
	const output = await new Response(proc.stdout).text();
	await proc.exited;
	return output;
}

describe("fzf", () => {
	let bin = "";

	beforeEach(async () => {
		bin = await mkdtemp(join(tmpdir(), "wktree-fzf-test-"));
	});

	afterEach(async () => {
		await rm(bin, { force: true, recursive: true });
	});

	test("returns the selected line and passes options as flags #test-267", async () => {
		expect(await runWithStub(bin, FZF_SUCCESS)).toBe("/a\tfirst");
		expect(await Bun.file(join(bin, "args")).text()).toBe("--delimiter\n\t\n--with-nth\n2..\n");
	});

	test("live picker requests a responsive preview layout #test-268", async () => {
		const livePickerModule = join(import.meta.dir, "../../src/live-picker.ts");
		const script = `
			const { pick } = await import(${JSON.stringify(livePickerModule)});
			const item = await pick(
				[{ key: "/a", display: "/a\\tfirst", preview: "echo preview" }],
				"Select a worktree",
				{ interactive: true },
			);
			process.stdout.write(item.key);
		`;

		expect(await runWithStub(bin, FZF_SUCCESS, script)).toBe("/a");
		const args = await Bun.file(join(bin, "args")).text();
		expect(args).toContain("--preview-window\nright,70%,wrap,<80(down,70%,wrap)\n");
		expect(args).toContain("--tmux\ncenter,80%,70%\n");
	});

	test.each([FZF_NO_MATCH, FZF_INTERRUPTED])("exit %d cancels #test-266", async (exitCode) => {
		expect(await runWithStub(bin, exitCode)).toBe("PickerCancelled: cancelled");
	});

	test("other exit statuses fail #test-269", async () => {
		expect(await runWithStub(bin, FZF_FAILURE)).toBe("WktreeError: fzf failed (exit 2)");
	});
});
