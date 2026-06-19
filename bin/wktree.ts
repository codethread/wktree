#!/usr/bin/env bun

export {main} from "../src/cli.ts";
export * from "../src/main.ts";

import {main} from "../src/cli.ts";

if (import.meta.main) {
	await main();
}
