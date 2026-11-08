import { expect, test } from "bun:test";
import { DirtySlotError } from "../../src/errors.ts";
import type { Slot } from "../../src/domain/worktree.ts";
import { explicitSlotAction } from "../../src/domain/worktree.ts";

const coldPlaceholder = {
	index: 1,
	path: "/repo__feat1",
	exists: true,
	branch: "wk-pool/feat1",
	placeholder: true,
	dirty: false,
	lastCommitIso: "2026-10-24T00:00:00Z",
	lastCommitSubject: "Initial commit",
	initialized: false,
} satisfies Slot;
const warmPlaceholder = { ...coldPlaceholder, initialized: true } satisfies Slot;
const occupied = {
	...coldPlaceholder,
	branch: "feature/occupied",
	placeholder: false,
} satisfies Slot;
const missing = {
	...coldPlaceholder,
	exists: false,
	placeholder: false,
	// eslint-disable-next-line unicorn/no-null -- Missing slots have no native branch or commit metadata.
	branch: null,
	// eslint-disable-next-line unicorn/no-null -- Missing slots have no native commit metadata.
	lastCommitIso: null,
	// eslint-disable-next-line unicorn/no-null -- Missing slots have no native commit metadata.
	lastCommitSubject: null,
} satisfies Slot;

test.each([
	{ name: "missing", slot: missing, force: false, action: "allocate" },
	{ name: "forced missing", slot: missing, force: true, action: "allocate" },
	{ name: "cold clean placeholder", slot: coldPlaceholder, force: false, action: "allocate" },
	{ name: "forced cold clean placeholder", slot: coldPlaceholder, force: true, action: "allocate" },
	{ name: "warm clean placeholder", slot: warmPlaceholder, force: false, action: "allocate" },
	{ name: "forced warm clean placeholder", slot: warmPlaceholder, force: true, action: "allocate" },
	{
		name: "forced cold dirty placeholder",
		slot: { ...coldPlaceholder, dirty: true },
		force: true,
		action: "recycle",
	},
	{
		name: "forced warm dirty placeholder",
		slot: { ...warmPlaceholder, dirty: true },
		force: true,
		action: "recycle",
	},
	{ name: "clean occupied", slot: occupied, force: false, action: "recycle" },
	{ name: "forced clean occupied", slot: occupied, force: true, action: "recycle" },
	{ name: "dirty occupied", slot: { ...occupied, dirty: true }, force: false, action: "recycle" },
	{
		name: "forced dirty occupied",
		slot: { ...occupied, dirty: true },
		force: true,
		action: "recycle",
	},
])("explicit $name slot routes to $action", ({ slot, force, action }) => {
	expect(explicitSlotAction(slot, force)).toBe(action);
});

test.each([
	{ ...coldPlaceholder, dirty: true },
	{ ...warmPlaceholder, dirty: true },
])("unforced dirty placeholder is refused (initialized=$initialized)", (slot) => {
	expect(() => explicitSlotAction(slot, false)).toThrow(DirtySlotError);
});
