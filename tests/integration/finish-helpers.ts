import { gitOut, gitText } from "./lifecycle-helpers.ts";
import { pathExists } from "./support.ts";

export interface FinishFixture {
	/** Source branch retained even during a stopped rebase. */
	branch: string;
	/** Bare origin fixture. */
	remote: string;
	/** Canonical checkout. */
	root: string;
	/** Source checkout. */
	worktreePath: string;
}

export async function readCheckoutState(repo: string) {
	const [head, index, status] = await Promise.all([
		gitOut(repo, "rev-parse", "HEAD"),
		gitText(repo, "ls-files", "--stage"),
		gitOut(repo, "status", "--porcelain=v1"),
	]);
	return { head, index, status };
}

export async function readFinishState(fixture: FinishFixture) {
	const [canonical, remoteHead, sourceBranchHead, sourceExists] = await Promise.all([
		readCheckoutState(fixture.root),
		gitOut(fixture.remote, "rev-parse", "HEAD"),
		gitOut(fixture.root, "rev-parse", `refs/heads/${fixture.branch}`),
		pathExists(fixture.worktreePath),
	]);
	return { canonical, remoteHead, sourceBranchHead, sourceExists };
}

export function finishPolicy(strategy: string, fresh = false, cleanup = false): string {
	let policy = "";
	if (fresh) {
		policy = '[project.add]\npolicy = "fresh_canonical"\n';
	}
	policy += `[project.finish]\nstrategy = "${strategy}"\n`;
	if (cleanup) {
		policy += "push = true\nremove_worktree = true\ndelete_branch = true\n";
	}
	return policy;
}

export function finishArgs(worktreePath: string, strategy: string): string[] {
	const args = ["--cwd", worktreePath, "--json"];
	if (strategy === "squash") {
		args.push("--title", "chore: integrate source work");
	}
	return args;
}
