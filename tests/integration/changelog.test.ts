import { changelogHistorySchema, renderChangelogMarkdown } from "@codethread/cli-changelog";
import { expect, test } from "bun:test";
import history from "../../changelog.json";
import manifest from "../../package.json";
// eslint-disable-next-line import/no-nodejs-modules -- Run the CLI outside its repository.
import { tmpdir } from "node:os";

const { name, version } = manifest;

const SUCCESS = 0;

test("the generated Markdown changelog matches its complete recorded history", async () => {
	const markdown = await Bun.file(new URL("../../CHANGELOG.md", import.meta.url)).text();
	expect(markdown).toBe(
		renderChangelogMarkdown({
			title: name,
			history: changelogHistorySchema.parse(history),
		}),
	);
});

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
