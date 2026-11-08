/** Records shell directory-change requests in a log shared with TestMultiplexer. */
export interface TestCdDirective {
	/** Paths passed to write, in call order. */
	paths: string[];
	/** Record a shell directory-change handoff. */
	write: (path: string) => void;
}

export function createTestCdDirective(log: string[] = []): TestCdDirective {
	const directive: TestCdDirective = { paths: [], write };
	return directive;

	function write(path: string): void {
		log.push(`cd ${path}`);
		directive.paths.push(path);
	}
}
