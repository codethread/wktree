import type { MultiplexerOpenRequest } from "../../../src/index";
import { gitLogPreviewCommand } from "../../../src/integrations/multiplexer.ts";

const INITIAL_PREVIEW_CALLS = 0;

/** Records session calls, optionally into a log shared with TestCdDirective to check ordering. */
export interface TestMultiplexer {
	/** Session requests opened during the test. */
	opened: MultiplexerOpenRequest[];
	/** Paths passed to closeUnder, in call order. */
	closedPaths: string[];
	/** Number of preview requests served. */
	previewCalls: number;
	/** Whether the test represents a process attached to tmux. */
	readonly attached: boolean;
	/** Record a session open request. */
	open: (request: MultiplexerOpenRequest) => Promise<void>;
	/** Record a request to close sessions under a path. */
	closeUnder: (path: string) => Promise<void>;
	/** Return the test preview appropriate for attachment state. */
	previewCommand: () => string;
}

export function createTestMultiplexer(attached = true, log: string[] = []): TestMultiplexer {
	const multiplexer: TestMultiplexer = {
		attached,
		closeUnder,
		closedPaths: [],
		open,
		opened: [],
		previewCalls: INITIAL_PREVIEW_CALLS,
		previewCommand,
	};
	return multiplexer;

	function open(request: MultiplexerOpenRequest): Promise<void> {
		log.push(`open ${request.path}`);
		multiplexer.opened.push(request);
		return Promise.resolve();
	}

	function closeUnder(path: string): Promise<void> {
		log.push(`close ${path}`);
		multiplexer.closedPaths.push(path);
		return Promise.resolve();
	}

	function previewCommand(): string {
		multiplexer.previewCalls++;
		if (multiplexer.attached) {
			return "test-preview";
		}
		return gitLogPreviewCommand();
	}
}
