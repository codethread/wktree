#!/usr/bin/env bun

import { RepositoryConfigSchema, createConfigSchema } from "../src/schemas.ts";
import { format } from "oxfmt";
import { z } from "zod";

const schemas = [
	{
		name: "wktree.schema.json",
		schema: createConfigSchema({ cwd: "/", home: "/", normalizePath: (path) => path }),
	},
	{ name: "wktree.local.schema.json", schema: RepositoryConfigSchema },
];

for (const { name, schema } of schemas) {
	const json = z.toJSONSchema(schema, { io: "input", target: "draft-04" });
	// oxlint-disable-next-line eslint/no-await-in-loop -- Generate and verify each small schema artifact in order.
	const { code: contents } = await format(name, JSON.stringify(json), { useTabs: true });
	const artifact = Bun.file(new URL(`../${name}`, import.meta.url));
	if (process.argv.includes("--check")) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- Check each generated artifact against its schema.
		if (!(await artifact.exists()) || (await artifact.text()) !== contents) {
			console.error(`${name} is stale; run bun run schema:generate`);
			process.exitCode = 1;
		}
	} else {
		// oxlint-disable-next-line eslint/no-await-in-loop -- Write each generated artifact in order.
		await Bun.write(artifact, contents);
	}
}
