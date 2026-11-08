import type { CdDirective } from "../services.ts";
// oxlint-disable-next-line import/no-nodejs-modules -- The cd handoff is a filesystem IO boundary.
import { writeFileSync } from "node:fs";

/** Writes the directory to the file a wrapper names in WKTREE_CD_FILE; a no-op without one. */
export function createFileCdDirective(file: string | undefined): CdDirective {
	return { write };

	function write(path: string): void {
		if (file) {
			// CdDirective.write is synchronous: the wrapper reads the file after process exit.
			// oxlint-disable-next-line node/no-sync
			writeFileSync(file, path);
		}
	}
}
