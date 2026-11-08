import type { PickerItem, PickerOptions } from "./services.ts";
import { PickerCancelled } from "./errors.ts";
import { fzf } from "./fzf.ts";

export async function pick(
	items: PickerItem[],
	header: string,
	options: PickerOptions = {},
): Promise<PickerItem> {
	const [first] = items;
	const byDisplay = new Map(items.map((item) => [item.display, item]));
	const selection = await fzf(
		items.map((item) => item.display),
		{
			delimiter: "\t",
			header,
			preview: first?.preview,
			// Fzf switches below the list when the side preview would be under 80 columns.
			previewWindow: "right,70%,wrap,<80(down,70%,wrap)",
			tmux: tmuxPopup(options),
			withNth: "2..",
		},
	);
	const item = byDisplay.get(selection);
	if (!item) {
		throw new PickerCancelled();
	}
	return item;
}

// --- Private helpers ---

function tmuxPopup(options: PickerOptions): string | undefined {
	if (options.interactive) {
		return "center,80%,70%";
	}
	return undefined;
}
