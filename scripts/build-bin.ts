#!/usr/bin/env bun

import {chmod, mkdir} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";

const DEST_DIR = join(homedir(), ".local", "bin");
const ENTRY_PATH = join(import.meta.dir, "..", "bin", "wktree.ts");
const DEST_PATH = join(DEST_DIR, "wktree");

await mkdir(DEST_DIR, {recursive: true});
await Bun.write(DEST_PATH, `#!/usr/bin/env bash\nexec bun run "${ENTRY_PATH}" "$@"\n`);
await chmod(DEST_PATH, 0o755);
console.log(`Generated ${DEST_PATH}`);
