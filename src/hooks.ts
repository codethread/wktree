import {HookError} from "./errors.ts";
import type {HookRunner} from "./types.ts";

export async function runInlineBash(
	script: string,
	cwd: string,
	env: Record<string, string>,
	onLine: (stream: "stdout" | "stderr", line: string) => void = () => undefined,
): Promise<{stdout: string[]; stderr: string[]; exitCode: number}> {
	return runBash(["bash", "-c", script], cwd, env, onLine);
}

export class LiveHookRunner implements HookRunner {
	runInline = async (...args: Parameters<HookRunner["runInline"]>): Promise<void> => {
		const [scriptPath, cwd, env, onLine] = args;
		const result = await runBash(["bash", scriptPath], cwd, env, onLine);
		if (result.exitCode !== 0) throw new HookError(result.exitCode, cwd);
	};
}

async function runBash(
	command: string[],
	cwd: string,
	env: Record<string, string>,
	onLine: (stream: "stdout" | "stderr", line: string) => void,
): Promise<{stdout: string[]; stderr: string[]; exitCode: number}> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const proc = Bun.spawn(command, {
		cwd,
		env: {...process.env, ...env},
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdoutDone, stderrDone, exitCode] = await Promise.all([
		pumpLines(proc.stdout, "stdout", (stream, line) => {
			stdout.push(line);
			onLine(stream, line);
		}),
		pumpLines(proc.stderr, "stderr", (stream, line) => {
			stderr.push(line);
			onLine(stream, line);
		}),
		proc.exited,
	]);
	await Promise.all([stdoutDone, stderrDone]);
	return {stdout, stderr, exitCode};
}

async function pumpLines(
	stream: ReadableStream<Uint8Array>,
	name: "stdout" | "stderr",
	onLine: (stream: "stdout" | "stderr", line: string) => void,
): Promise<void> {
	const decoder = new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>;
	const reader = stream.pipeThrough(decoder).getReader();
	let buffer = "";
	while (true) {
		const {value, done} = await reader.read();
		if (done) break;
		buffer += value;
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? "";
		for (const line of lines) onLine(name, line);
	}
	if (buffer !== "") onLine(name, buffer);
}
