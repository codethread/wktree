import {HookError} from "./errors.ts";
import type {HookRunner} from "./types.ts";

export class LiveHookRunner implements HookRunner {
	runInline = async (...args: Parameters<HookRunner["runInline"]>): Promise<void> => {
		const [scriptPath, cwd, env, onLine] = args;
		const proc = Bun.spawn(["bash", scriptPath], {
			cwd,
			env: {...process.env, ...env},
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			pumpLines(proc.stdout, "stdout", onLine),
			pumpLines(proc.stderr, "stderr", onLine),
			proc.exited,
		]);
		await Promise.all([stdout, stderr]);
		if (exitCode !== 0) throw new HookError(exitCode, cwd);
	};
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
