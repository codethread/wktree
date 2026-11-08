import type { Deps, GitRunner, PickerItem } from "../services.ts";
import type { PoolState, Slot } from "../domain/worktree.ts";
import type { PoolFullPayload } from "../protocol.ts";
import { WktreeError } from "../errors.ts";
import { describeSlotRisk } from "../application/pool.ts";

const NO_COMMITS = 0;
const NO_ELAPSED_UNITS = 0;
const MILLISECONDS_PER_DAY = 86_400_000;
const MILLISECONDS_PER_HOUR = 3_600_000;
type SlotRisk = Awaited<ReturnType<typeof describeSlotRisk>>;

export async function pickFullPoolSlot(options: {
	deps: Deps;
	state: Pick<PoolState, "root" | "slots">;
	interactive: boolean;
	noNetwork: boolean;
}): Promise<Slot> {
	const { deps, state, interactive } = options;
	const candidates = state.slots.filter((slot) => slot.exists && !slot.placeholder);
	const [firstCandidate] = candidates;
	if (!firstCandidate) {
		throw new WktreeError("pool full; no recyclable slots found");
	}
	const items = await buildPickerItems(deps, candidates, options.noNetwork);
	const selected = await deps.picker.pick(items, "Select a worktree slot to recycle", {
		interactive,
	});
	return candidates.find((slot) => String(slot.index) === selected.key) ?? firstCandidate;
}

export async function buildRecycleConfirmPrompt(git: GitRunner, slot: Slot): Promise<string> {
	const risk = await describeSlotRisk(git, slot);
	const warnings = recycleWarnings(slot, risk);
	let suffix = "";
	if (warnings) {
		suffix = `: ${warnings}`;
	}
	return `Recycle feat${slot.index} (${slot.branch ?? "detached"})${suffix}? [y/N] `;
}

export async function toPoolFullPayload(
	git: GitRunner,
	state: Pick<PoolState, "root" | "slots">,
	branch: string,
): Promise<PoolFullPayload> {
	const candidates = state.slots.filter((slot) => slot.exists && !slot.placeholder);
	return {
		branch,
		candidates: await Promise.all(
			candidates.map(async (slot) => {
				const risk = await describeSlotRisk(git, slot);
				return {
					ahead: risk.ahead,
					branch: slot.branch,
					dirty: slot.dirty,
					last_commit_iso: slot.lastCommitIso,
					last_commit_subject: slot.lastCommitSubject,
					local_only: risk.localOnly,
					path: slot.path,
					slot: slot.index,
				};
			}),
		),
		kind: "pool_full",
		root: state.root,
	};
}
// --- Private functions ---

function formatRelativeAge(iso: string | null, now: number): string {
	if (!iso) {
		return "unknown";
	}
	const ageMs = now - Date.parse(iso);
	const days = Math.floor(ageMs / MILLISECONDS_PER_DAY);
	if (days > NO_ELAPSED_UNITS) {
		return `${days}d ago`;
	}
	const hours = Math.floor(ageMs / MILLISECONDS_PER_HOUR);
	if (hours > NO_ELAPSED_UNITS) {
		return `${hours}h ago`;
	}
	return "now";
}

function slotFlags(slot: Slot, risk: SlotRisk): string {
	const flags: string[] = [];
	if (slot.dirty) {
		flags.push("  [dirty]");
	}
	if (risk.ahead > NO_COMMITS) {
		flags.push(`  [${risk.ahead} ahead]`);
	}
	if (risk.localOnly) {
		flags.push("  [local-only]");
	}
	return flags.join("");
}

function buildPickerPreview(noNetwork: boolean): string {
	let git = "git";
	if (noNetwork) {
		git += " --no-lazy-fetch";
	}
	return (
		`slot={1}; counts=$(${git} -C "$slot" rev-list --left-right --count @{upstream}...HEAD ` +
		`2>/dev/null); if [ $? -ne 0 ] || [ -z "$counts" ]; then echo '⚠ local-only branch'; else ` +
		`ahead=$(echo "$counts" | awk '{print $2}'); [ "$ahead" -gt 0 ] 2>/dev/null && echo "⚠ $ahead ` +
		`unpushed commits will be lost"; echo "upstream: $(echo "$counts" | awk '{print $1}') behind, ` +
		`$ahead ahead"; fi; ${git} -C "$slot" log -5 --format='%h %s'; ${git} -C "$slot" status ` +
		`--porcelain | head`
	);
}

async function buildPickerItems(
	deps: Deps,
	candidates: Slot[],
	noNetwork: boolean,
): Promise<PickerItem[]> {
	const items: PickerItem[] = [];
	for (const slot of candidates) {
		// Preserve ordered Git observations and first-failure behavior for picker rows.
		// eslint-disable-next-line no-await-in-loop
		const risk = await describeSlotRisk(deps.git, slot);
		items.push({
			display:
				`${slot.path}\tfeat${slot.index}  ${slot.branch ?? "(detached)"}  ` +
				`${formatRelativeAge(slot.lastCommitIso, deps.clock.now())}${slotFlags(slot, risk)}`,
			key: String(slot.index),
			preview: buildPickerPreview(noNetwork),
		});
	}
	return items;
}

function recycleWarnings(slot: Slot, risk: SlotRisk): string {
	const warnings: string[] = [];
	if (slot.dirty) {
		warnings.push("dirty changes will be lost");
	}
	if (risk.localOnly) {
		warnings.push("local-only branch");
	}
	if (risk.ahead > NO_COMMITS) {
		warnings.push(`⚠ ${risk.ahead} unpushed commits will be lost`);
	}
	return warnings.join("; ");
}
