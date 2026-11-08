import { ConfigError, EXIT_CODES, HookError } from "../../src/errors.ts";
import type {
	GitRunner,
	HookRunner,
	ProgressReporter,
	WorkspaceFiles,
} from "../../src/services.ts";
import { expect, mock, test } from "bun:test";
import type { CopyEntry } from "../../src/domain/config.ts";
import { setupPooledCheckout } from "../../src/application/pooled-setup.ts";

const emptyEntries: CopyEntry[] = [];
const entries: CopyEntry[] = [{ from: ".env", to: [".env"], mode: "copy" }];
const request = {
	root: "/repo",
	target: "/repo__feat2",
	entries,
	projectName: "project",
	command: "setup-project",
	skipCommand: false,
};

function setupFixture() {
	const git = {
		run: mock<GitRunner["run"]>(() => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 })),
		runRaw: mock<GitRunner["runRaw"]>(() =>
			Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
		),
	};
	const files = {
		copy: mock<WorkspaceFiles["copy"]>(() => Promise.resolve([])),
		writePostCreateScript: mock<WorkspaceFiles["writePostCreateScript"]>(() => "/setup.sh"),
	};
	const hooks = { runInline: mock<HookRunner["runInline"]>(() => Promise.resolve()) };
	const progress = { stream: mock<ProgressReporter["stream"]>() };
	return { git, files, hooks, progress };
}

function expectCopy(deps: ReturnType<typeof setupFixture>, copiedEntries: CopyEntry[]) {
	expect(deps.files.copy.mock.calls).toEqual([
		[
			{
				root: request.root,
				target: request.target,
				entries: copiedEntries,
				git: deps.git,
			},
		],
	]);
	for (const [copyRequest] of deps.files.copy.mock.calls) {
		expect(copyRequest.git).toBe(deps.git);
	}
}

function expectBootstrap(deps: ReturnType<typeof setupFixture>) {
	expect(deps.files.writePostCreateScript.mock.calls).toEqual([
		[
			{
				root: request.root,
				created: request.target,
				command: request.command,
				projectName: request.projectName,
				pooled: true,
			},
		],
	]);
	expect(deps.hooks.runInline.mock.calls).toEqual([
		[
			"/setup.sh",
			{
				cwd: request.target,
				env: {},
				onLine: expect.any(Function),
			},
		],
	]);
	expect(deps.progress.stream.mock.calls).toEqual([
		["stdout", "prepared"],
		["stderr", "diagnostic"],
	]);
	expect(deps.git.run).not.toHaveBeenCalled();
	expect(deps.git.runRaw).not.toHaveBeenCalled();
}

function pendingCopyFixture() {
	const deps = setupFixture();
	const copy = Promise.withResolvers<Awaited<ReturnType<WorkspaceFiles["copy"]>>>();
	deps.files.copy.mockReturnValue(copy.promise);
	deps.hooks.runInline.mockImplementation((_path, options) => {
		options.onLine?.("stdout", "prepared");
		options.onLine?.("stderr", "diagnostic");
		return Promise.resolve();
	});
	return { deps, copy };
}

test("pooled setup waits for copying before running the configured bootstrap", async () => {
	const { deps, copy } = pendingCopyFixture();
	const pending = setupPooledCheckout(deps, request);
	expectCopy(deps, entries);
	await Promise.resolve();
	expect(deps.files.writePostCreateScript).not.toHaveBeenCalled();
	expect(deps.hooks.runInline).not.toHaveBeenCalled();
	copy.resolve([]);
	await pending;
	expectBootstrap(deps);
});

test.each([
	{ command: "setup-project", entries },
	// eslint-disable-next-line unicorn/no-null -- The resolved command contract uses null.
	{ command: null, entries },
	{ command: "setup-project", entries: emptyEntries },
])("skipping bootstrap retains copying (case %#, entries=$entries.length)", async (options) => {
	const deps = setupFixture();
	await setupPooledCheckout(deps, { ...request, ...options, skipCommand: true });
	expectCopy(deps, options.entries);
	expect(deps.files.writePostCreateScript).not.toHaveBeenCalled();
	expect(deps.hooks.runInline).not.toHaveBeenCalled();
});

test("copy failure prevents bootstrap and preserves the failure", async () => {
	const deps = setupFixture();
	const failure = new ConfigError("copy failed");
	deps.files.copy.mockRejectedValue(failure);
	await expect(setupPooledCheckout(deps, request)).rejects.toBe(failure);
	expect(deps.files.writePostCreateScript).not.toHaveBeenCalled();
	expect(deps.hooks.runInline).not.toHaveBeenCalled();
});

test("script write failure prevents hook execution and preserves the failure", async () => {
	const deps = setupFixture();
	const failure = new Error("script write failed");
	deps.files.writePostCreateScript.mockImplementation(() => {
		throw failure;
	});
	await expect(setupPooledCheckout(deps, request)).rejects.toBe(failure);
	expect(deps.hooks.runInline).not.toHaveBeenCalled();
});

test("bootstrap failure propagates to the allocation caller", async () => {
	const deps = setupFixture();
	const failure = new HookError(EXIT_CODES.FAILURE, request.target);
	deps.hooks.runInline.mockRejectedValue(failure);
	await expect(setupPooledCheckout(deps, request)).rejects.toBe(failure);
});
