import { expect, test } from "bun:test";
import history from "../../changelog.json";
// eslint-disable-next-line import/no-nodejs-modules -- Run the CLI outside its repository.
import { tmpdir } from "node:os";
import { version } from "../../package.json";

const SUCCESS = 0;

test("the CLI reads its current recorded release through the shared changelog library", async () => {
	const child = Bun.spawn(
		[
			process.execPath,
			`${import.meta.dir}/../../bin/wktree.ts`,
			"changelog",
			"--release",
			version,
			"--json",
		],
		{ cwd: tmpdir(), stdout: "pipe", stderr: "pipe" },
	);
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	const release = history.find((entry) => entry.version === version);
	expect(release).toBeDefined();
	expect(code).toBe(SUCCESS);
	expect(stderr).toBe("");
	expect(JSON.parse(stdout)).toMatchObject({
		ok: true,
		kind: "changelog",
		tool: "wktree",
		installedVersion: version,
		release: version,
		releases: [release],
	});
});
