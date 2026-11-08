import { PickerCancelled } from "../../../src/errors.ts";

const INITIAL_CONFIRM_CALLS = 0;

interface PickerItem {
	/** Text displayed to the test caller. */
	display: string;
	/** Stable key selected by this fake. */
	key: string;
	/** Preview attached to the selection. */
	preview: string;
}

interface TestPickerOptions {
	/** Whether the test request asks for interactive selection. */
	interactive?: boolean;
}

/**
 * Picker double that returns a fixed selection. A null choice models the user
 * cancelling in fzf and must stay supported for the pooled add suites.
 */
export interface TestPicker {
	/** Items supplied by the last pick request. */
	items: PickerItem[];
	/** Options supplied by the last pick request. */
	options: TestPickerOptions | undefined;
	/** Number of confirmation requests made by the command. */
	confirmCalls: number;
	/** Record the candidates and resolve the configured selection. */
	pick: (
		/** Candidate worktrees offered to the picker. */
		items: PickerItem[],
		/** Context displayed to the user. */
		_header: string,
		/** Optional mode that controls interactive UI selection. */
		options?: TestPickerOptions,
	) => Promise<PickerItem>;
	/** Resolve with the configured confirmation choice. */
	confirm: () => Promise<boolean>;
}

export function createTestPicker(choice: string | null, confirmed: boolean): TestPicker {
	const picker: TestPicker = {
		confirm,
		confirmCalls: INITIAL_CONFIRM_CALLS,
		items: [],
		options: undefined,
		pick,
	};
	return picker;

	function pick(
		items: PickerItem[],
		_header: string,
		options?: { interactive?: boolean },
	): Promise<PickerItem> {
		picker.items = items;
		picker.options = options;
		if (choice === null) {
			return Promise.reject(new PickerCancelled());
		}
		const item = items.find((candidate) => candidate.key === choice);
		if (!item) {
			return Promise.reject(new PickerCancelled());
		}
		return Promise.resolve(item);
	}

	function confirm(): Promise<boolean> {
		picker.confirmCalls++;
		return Promise.resolve(confirmed);
	}
}
