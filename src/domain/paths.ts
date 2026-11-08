// eslint-disable-next-line import/no-nodejs-modules -- Config paths must resolve against the real filesystem.
import { isAbsolute, resolve } from "node:path";
import type { ConfigPathContext } from "./config.ts";

const GLOB_SPECIAL_CHARACTERS = /[.+^${}()|[\]\\]/gu;
const SEGMENT_WILDCARD = "*";
const SEGMENT_WILDCARD_PATTERN = "[^/]*";
const TILDE_PREFIX = "~/";

export function expandConfigPath(path: string, context: ConfigPathContext): string {
	if (path === "~") {
		return context.home;
	}
	if (path.startsWith(TILDE_PREFIX)) {
		return resolve(context.home, path.slice(TILDE_PREFIX.length));
	}
	if (isAbsolute(path)) {
		return resolve(path);
	}
	return resolve(context.cwd, path);
}

export function expandConfigGlob(glob: string, context: ConfigPathContext): string {
	if (isAbsolute(glob)) {
		return glob;
	}
	return expandConfigPath(glob, context);
}

export function rootGlobMatches(glob: string, path: string): boolean {
	return matchGlobSegments(glob.split("/"), path.split("/"));
}
// --- Private functions ---

function globSegmentMatches(pattern: string, value: string): boolean {
	const escaped = pattern
		.replaceAll(GLOB_SPECIAL_CHARACTERS, String.raw`\$&`)
		.replaceAll(SEGMENT_WILDCARD, SEGMENT_WILDCARD_PATTERN);
	return new RegExp(`^${escaped}$`, "u").test(value);
}

function matchGlobSegments(pattern: string[], path: string[]): boolean {
	const [head, ...tail] = pattern;
	const [pathHead, ...pathTail] = path;
	if (head === undefined) {
		return pathHead === undefined;
	}
	if (head === "**") {
		return (
			matchGlobSegments(tail, path) ||
			(pathHead !== undefined && matchGlobSegments(pattern, pathTail))
		);
	}
	if (pathHead === undefined) {
		return false;
	}
	return globSegmentMatches(head, pathHead) && matchGlobSegments(tail, pathTail);
}
