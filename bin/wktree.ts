#!/usr/bin/env bun

import { main } from "../src/cli.ts";

if (import.meta.main) {
	await main();
}

export { main } from "../src/cli.ts";
export * from "../src/main.ts";
