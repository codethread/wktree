import { run } from "./support.ts";

/** Seed a remote-only branch without creating an unrelated checkout or running hooks. */
export async function createRemoteBranch(remote: string, branch: string): Promise<void> {
	await appendRemoteCommit({
		remote,
		branch,
		parent: "refs/heads/main",
		path: "remote.txt",
		content: `${branch}\n`,
		message: `remote ${branch}`,
	});
}

/** Advance the bare origin's default branch; leave local remote-tracking refs unchanged. */
export async function commitOnRemoteDefault(change: {
	remote: string;
	path: string;
	content: string;
	message: string;
}): Promise<void> {
	await appendRemoteCommit({ ...change, branch: "main", parent: "refs/heads/main" });
}

// --- Private fixture construction ---

async function appendRemoteCommit(change: {
	remote: string;
	branch: string;
	parent: string;
	path: string;
	content: string;
	message: string;
}): Promise<void> {
	const message = `${change.message}\n`;
	// Dereference the parent commit before updating main; fast-import rejects a branch as its own parent.
	await run(
		["git", "-C", change.remote, "fast-import", "--quiet"],
		`commit refs/heads/${change.branch}\n` +
			"committer Test User <test@example.test> 1700000001 +0000\n" +
			`data ${Buffer.byteLength(message)}\n${message}\n` +
			`from ${change.parent}^0\n` +
			`M 100644 inline ${JSON.stringify(change.path)}\n` +
			`data ${Buffer.byteLength(change.content)}\n${change.content}\n\n` +
			"done\n",
	);
}
