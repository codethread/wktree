import { expect, test } from "bun:test";
import { generatePostCreateScript } from "../../src/domain/worktree.ts";

// The emitted shell text is a public contract consumed by the Nushell wrapper.
test.each([
	{ created: "/tmp/repo__feature", marker: "", name: "regular", pooled: false },
	{
		created: "/tmp/repo__feat1",
		marker: ': > "$(git -C "$WK_CREATED" rev-parse --git-path wk-pool-initialized)"\n',
		name: "pooled",
		pooled: true,
	},
])("generates the $name bootstrap script", ({ pooled, created, marker }) => {
	expect(
		generatePostCreateScript({
			command: "echo ready",
			created,
			pooled,
			projectName: "app",
			root: "/tmp/repo",
		}),
	).toBe(
		`#!/usr/bin/env bash\n` +
			`set -euo pipefail\n` +
			`export WK_ROOT='/tmp/repo'\n` +
			`export WK_CREATED='${created}'\n` +
			`echo 'project: app'\n` +
			`cd "$WK_CREATED"\n` +
			`echo ready\n` +
			`${marker}`,
	);
});

test.each([
	{ quoted: "'/tmp/root with spaces'", root: "/tmp/root with spaces" },
	{ quoted: "'/tmp/it'\\''s a repo'", root: "/tmp/it's a repo" },
])("shell-quotes $root", ({ root, quoted }) => {
	expect(
		generatePostCreateScript({
			command: 'echo "$WK_CREATED"',
			created: `${root}__feature`,
			pooled: false,
			projectName: "app",
			root,
		}),
	).toContain(`export WK_ROOT=${quoted}\n`);
});
