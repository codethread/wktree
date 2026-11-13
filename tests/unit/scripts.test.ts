import { expect, test } from "bun:test";
import { generatePostCreateScript } from "../../src/domain/worktree.ts";

// The emitted shell text is a public contract consumed by the Nushell wrapper.
test("generates the bootstrap script", () => {
	expect(
		generatePostCreateScript({
			command: "echo ready",
			created: "/tmp/repo__feature",
			projectName: "app",
			root: "/tmp/repo",
		}),
	).toBe(
		`#!/usr/bin/env bash\n` +
			`set -euo pipefail\n` +
			`export WK_ROOT='/tmp/repo'\n` +
			`export WK_CREATED='/tmp/repo__feature'\n` +
			`echo 'project: app'\n` +
			`cd "$WK_CREATED"\n` +
			`echo ready\n`,
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
			projectName: "app",
			root,
		}),
	).toContain(`export WK_ROOT=${quoted}\n`);
});
