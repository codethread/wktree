import { EXIT_CODES, dispatch } from "../../src/index";
import {
	createPoolSlot,
	createTestPicker,
	run,
	testDeps,
	useOriginFixture,
	writeConfig,
} from "./support.ts";
import { expect, test } from "bun:test";
import { gitOut, useTmpHome } from "./lifecycle-helpers.ts";

const SINGLE_SLOT = 1;
const NO_CONFIRMATIONS = 0;

const tmp = useTmpHome("wktree-pool-add-full-test-");
const { initRepoWithOrigin } = useOriginFixture();

async function occupySlot() {
	const { root } = await initRepoWithOrigin(tmp.dir);
	writeConfig({ command: "echo ready", poolSize: SINGLE_SLOT, root, tmp: tmp.dir });
	await createPoolSlot({ branch: "feature/one", index: SINGLE_SLOT, initialized: true, root });
	return root;
}

test("machine json pool_full bypasses picker and leaves the occupied slot untouched #test-201", async () => {
	const root = await occupySlot();
	await run([
		"git",
		"-C",
		`${root}__feat1`,
		"branch",
		"--set-upstream-to",
		"origin/main",
		"feature/one",
	]);
	const picker = createTestPicker("1", true);

	const blocked = await dispatch(
		"add",
		["--cwd", root, "--branch", "feature/two", "--json"],
		testDeps({ picker }),
	);

	expect(blocked.exitCode).toBe(EXIT_CODES.BLOCKED);
	expect(JSON.parse(blocked.stdout ?? "{}")).toMatchObject({
		branch: "feature/two",
		candidates: [{ branch: "feature/one", path: `${root}__feat1`, slot: 1 }],
		kind: "pool_full",
	});
	expect(await gitOut(`${root}__feat1`, "branch", "--show-current")).toBe("feature/one");
	expect(picker.items).toEqual([]);
	expect(picker.confirmCalls).toBe(NO_CONFIRMATIONS);
});
