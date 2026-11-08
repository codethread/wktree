import type { CommandResult, CommandRunner, TmuxEnvironment } from "../../src/integrations/tmux.ts";
import {
	TmuxError,
	createTmuxMultiplexer,
	parseSessionList,
	selectMultiplexer,
} from "../../src/integrations/tmux.ts";
import {
	WORKTREE_PATH_FIELD,
	createNoMultiplexer,
	gitLogPreviewCommand,
	openRequestForWorktree,
} from "../../src/integrations/multiplexer.ts";
import { describe, expect, test } from "bun:test";
import type { Multiplexer } from "../../src/integrations/multiplexer.ts";

const TMUX = "/private/tmp/tmux-501/default,123,0";
const TAB = "\t";
const FAILURE_EXIT_CODE = 1;
const INVOKING: TmuxEnvironment = { TMUX, TMUX_PANE: "%5" };

interface RecordingRunner extends CommandRunner {
	/** Ordered tmux invocations received by the service under test. */
	calls: RunnerCall[];
}

interface RunnerCall {
	/** Executable invoked for this call. */
	command: string;
	/** Arguments passed to the executable. */
	args: string[];
}

function ok(stdout = ""): CommandResult {
	return { exitCode: 0, stderr: "", stdout };
}

function fails(stderr = "failed", exitCode = FAILURE_EXIT_CODE): CommandResult {
	return {
		exitCode,
		stderr,
		stdout: "",
	};
}

function createRecordingRunner(results: CommandResult[] = []): RecordingRunner {
	const runner: RecordingRunner = { calls: [], run };
	return runner;

	function run(command: string, args: string[]): Promise<CommandResult> {
		runner.calls.push({ args, command });
		return Promise.resolve(results.shift() ?? ok());
	}
}

function tmux(runner: CommandRunner, env: TmuxEnvironment = INVOKING): Multiplexer {
	return createTmuxMultiplexer(runner, env);
}

describe("TmuxMultiplexer.open session handling", () => {
	test("creates a missing session and switches the invoking client", async () => {
		const runner = createRecordingRunner([fails(), ok(), ok("/dev/ttys001\n"), ok()]);

		await tmux(runner).open({
			name: "repo__feature--foo",
			path: "/repo__feature--foo",
			title: "feature/foo",
		});

		expect(runner.calls).toEqual([
			{ args: ["has-session", "-t", "=repo__feature--foo"], command: "tmux" },
			{
				args: [
					"new-session",
					"-d",
					"-s",
					"repo__feature--foo",
					"-n",
					"feature/foo",
					"-c",
					"/repo__feature--foo",
				],
				command: "tmux",
			},
			{
				args: ["display-message", "-p", "-t", "%5", "#{client_tty}"],
				command: "tmux",
			},
			{
				args: ["switch-client", "-c", "/dev/ttys001", "-t", "=repo__feature--foo"],
				command: "tmux",
			},
		]);
	});

	test("reuses an existing session", async () => {
		const runner = createRecordingRunner([ok(), ok("/dev/ttys002"), ok()]);

		await tmux(runner).open({ name: "repo__a", path: "/repo__a", title: "a" });

		expect(runner.calls.map(({ args: [subcommand] }) => subcommand)).toEqual([
			"has-session",
			"display-message",
			"switch-client",
		]);
	});
});

describe("TmuxMultiplexer.open client switching", () => {
	test("switches without a client handle when the pane is unknown", async () => {
		const runner = createRecordingRunner([ok(), ok()]);

		await tmux(runner, { TMUX }).open({ name: "repo__a", path: "/repo__a", title: "a" });

		expect(runner.calls).toEqual([
			{ args: ["has-session", "-t", "=repo__a"], command: "tmux" },
			{ args: ["switch-client", "-t", "=repo__a"], command: "tmux" },
		]);
	});

	test("switches without a client handle when client resolution fails", async () => {
		const runner = createRecordingRunner([ok(), fails("no current client"), ok()]);

		await tmux(runner).open({ name: "repo__a", path: "/repo__a", title: "a" });

		expect(runner.calls).toEqual([
			{ args: ["has-session", "-t", "=repo__a"], command: "tmux" },
			{
				args: ["display-message", "-p", "-t", "%5", "#{client_tty}"],
				command: "tmux",
			},
			{ args: ["switch-client", "-t", "=repo__a"], command: "tmux" },
		]);
	});
});

describe("TmuxMultiplexer.closeUnder", () => {
	test("kills sessions at or below the path", async () => {
		const listed = [
			`repo__a${TAB}/repo__a`,
			`repo__b${TAB}/repo__b`,
			`repo__a--nested${TAB}/repo__a/nested`,
			`repo__aX${TAB}/repo__aX`,
		].join("\n");
		const runner = createRecordingRunner([ok(listed), ok(), ok()]);

		await tmux(runner).closeUnder("/repo__a");

		const [listCall, ...killCalls] = runner.calls;

		expect(listCall).toEqual({
			args: ["list-sessions", "-F", `#{session_name}${TAB}#{session_path}`],
			command: "tmux",
		});
		expect(killCalls).toEqual([
			{ args: ["kill-session", "-t", "=repo__a"], command: "tmux" },
			{ args: ["kill-session", "-t", "=repo__a--nested"], command: "tmux" },
		]);
	});

	test.each([
		{ name: "no server", stderr: "no server running on /tmp/tmux-501/default" },
		{ name: "no sessions", stderr: "no sessions" },
	])("observes nothing when tmux reports $name", async ({ stderr }) => {
		const runner = createRecordingRunner([fails(stderr)]);

		await tmux(runner).closeUnder("/repo__a");

		expect(runner.calls).toEqual([
			{ args: ["list-sessions", "-F", `#{session_name}${TAB}#{session_path}`], command: "tmux" },
		]);
	});

	test("surfaces unexpected list failures", async () => {
		const runner = createRecordingRunner([fails("invalid option: --nope")]);

		await expect(tmux(runner).closeUnder("/repo__a")).rejects.toBeInstanceOf(TmuxError);
	});

	test("surfaces kill failures", async () => {
		const runner = createRecordingRunner([
			ok(`repo__a${TAB}/repo__a`),
			fails("can't find session"),
		]);

		await expect(tmux(runner).closeUnder("/repo__a")).rejects.toBeInstanceOf(TmuxError);
	});
});

describe("TmuxMultiplexer.previewCommand", () => {
	test("captures a pane under the worktree or falls back to git log", () => {
		const preview = tmux(createRecordingRunner()).previewCommand();

		expect(preview).toBe(
			[
				`worktree_path=${WORKTREE_PATH_FIELD}`,
				`pane=$(tmux list-panes -a -F '#{pane_id}${TAB}#{pane_current_path}' 2>/dev/null | awk -F ` +
					`'\\t' -v path="$worktree_path" '$2 == path || index($2, path "/") == 1 { print $1; exit }')`,
				'[ -n "$pane" ] && tmux capture-pane -ep -t "$pane" 2>/dev/null || git -C "$worktree_path" log --oneline -20',
			].join("; "),
		);
	});
});

describe("parseSessionList", () => {
	test("keeps only complete name/path rows", () => {
		const output = `a${TAB}/repo/a\nb${TAB}/repo/b\nmalformed\nmissing${TAB}\n`;

		expect(parseSessionList(output)).toEqual([
			{ name: "a", path: "/repo/a" },
			{ name: "b", path: "/repo/b" },
		]);
	});
});

describe("multiplexer selection", () => {
	test("selects tmux inside tmux and the null implementation outside", () => {
		expect(selectMultiplexer({ TMUX }).attached).toBe(true);
		expect(selectMultiplexer({}).attached).toBe(false);
	});

	test("NoMultiplexer is inert and previews git history", async () => {
		const multiplexer = createNoMultiplexer();

		await multiplexer.open({ name: "repo__a", path: "/repo__a", title: "a" });
		await multiplexer.closeUnder("/repo__a");

		expect(multiplexer.previewCommand()).toBe(gitLogPreviewCommand());
	});

	test("openRequestForWorktree derives the session name from the worktree path", () => {
		expect(openRequestForWorktree("/repo__feature--foo", "feature/foo")).toEqual({
			name: "repo__feature--foo",
			path: "/repo__feature--foo",
			title: "feature/foo",
		});
		expect(openRequestForWorktree("/repo/.worktrees/feat.1", "feat/1").name).toBe("repo__feat_1");
	});
});
