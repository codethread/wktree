# Git Worktrees Engine

**Status:** Implemented

**Last Updated:** 2026-11-13

## 1. Overview

### Purpose

`wktree` is a deterministic local engine for creating, preparing, inspecting, integrating, and removing git worktrees. It gives the same lifecycle contract to humans, shell wrappers, terminal multiplexers, and agents. Durable state lives in git metadata, filesystem paths, and project config; terminal multiplexers are an integration, not a database.

### Goals

- Keep git/worktree lifecycle complexity inside one engine with a small command interface.
- Use deterministic branch, path, and session identity.
- Serve human interactive and non-interactive machine workflows with the same semantics.
- Reconstruct current state from authoritative sources rather than a synchronized cache.
- Support deterministic per-worktree copy setup for untracked local configuration and tool assets.
- Allow explicit repository policy for how new work starts and how completed work is integrated.
- Surface destructive or ambiguous states with structured data.

### Non-Goals

- No durable worktree/session database beyond git/filesystem/config state.
- No multiplexer session resurrection or persistent session registry.
- No requirement that each worktree has a live multiplexer session.
- No periodic repository sync daemon, background auto-pull, or auto-push loop.
- No automatic commits for normal source repositories.
- No automatic merge-conflict resolution or force-pushing.
- No pull-request/provider workflow management.
- No glob, environment-variable, or shell expansion in copy configuration beyond leading `~`.

## 2. Design Decisions

- **Decision:** `wktree` owns all git/worktree state transitions (creation, integration, removal, safety checks, bootstrap).
  - **Rationale:** Centralizing avoids duplicated, drift-prone shell behavior across the multiple consumers (humans, wrappers, tmux, agents) that all need identical semantics.
- **Decision:** Terminal multiplexers are an injected integration service, not the source of truth. The engine opens, focuses and closes sessions through a small interface (tmux is the first implementation) but stores no session state; correctness derives from git and filesystem state.
  - **Rationale:** Keeping session handling in the engine removes duplicated wrapper logic, and the interface keeps another multiplexer with a similar API swappable. A persistent session registry would be a second database to keep in sync; reconstructable identity removes that failure mode.
- **Decision:** Focus follows the human, never the agent. Only an explicit `--interactive` flag, passed by human wrappers, permits multiplexer calls and the cd directive. Terminal detection is not used.
  - **Rationale:** Agents run inside the user's multiplexer panes, inherit its environment and may have a PTY, so no ambient signal distinguishes them from a human. Without `--interactive` the engine never touches sessions, so an agent cannot steal focus or close a session the user is working in.
- **Decision:** Branch/path naming is the coordination spine (see §3).
  - **Rationale:** Deterministic naming lets every consumer derive identity independently with no shared state or handshake.
- **Decision:** Worktrees may use the default sibling layout or a configured nested layout. The configured layout is a creation preference, not an invariant for registered worktrees.
  - **Rationale:** Sibling paths remain easy to discover, while `<canonicalRoot>/.worktrees/` avoids clutter around repositories with many worktrees. Treating Git's worktree registry as authoritative keeps existing `.wktree` and manually located worktrees usable when the preference changes.
- **Decision:** New branches default to origin's default branch/trunk unless a base is given.
  - **Rationale:** Commands are often run from inside another worktree; defaulting to the current HEAD would silently create accidental stacked branches.
- **Decision:** Queries do not prepare worktrees. `list` reads Git's registered inventory without loading config, inspecting checkout contents, or running hooks; `path` resolves an actual or expected path without creating it.
  - **Rationale:** Setup belongs to `add` and explicit `copy`, not discovery or cleanup. Inspection must remain available when setup is broken.
- **Decision:** Bootstrap is part of ready-to-work semantics, runs inside the engine, and failures are loud.
  - **Rationale:** A worktree that looks created but isn't prepared is a worse trap than an explicit failure. Running bootstrap in the engine keeps its rollback in one process, so every consumer gets the same result and no caller has to compensate for a failed setup.
- **Decision:** Copy setup runs before configured commands and is rerunnable with `wktree copy`.
  - **Rationale:** Local config and shared tool assets should be present before project bootstrap commands run, and users need an explicit way to apply config changes after a worktree already exists.
- **Decision:** Copy destinations are worktree-relative untracked setup paths and are recorded in the canonical exclude file.
  - **Rationale:** Copied assets are local workspace material, not repository changes. Refusing to overwrite tracked paths prevents accidental modification of versioned project files, while an idempotent fenced exclude block prevents noisy status output and duplicate rules.
- **Decision:** Fresh parsing over synchronized caches.
  - **Rationale:** Git worktree metadata, filesystem paths, and project config are cheap enough for the engine to inspect directly. Multiplexer state is UI state and must not affect engine correctness.
- **Decision:** Add-time freshness policy belongs in the engine, not only in shell wrappers.
  - **Rationale:** Humans and agents should get the same safety guarantees. If a repository requires new work to start from an up-to-date canonical default branch, that invariant must hold for direct `wktree add --json` consumers as well as human interactive callers.
- **Decision:** Strict add policy fails instead of falling back to stale bases.
  - **Rationale:** Falling back to an old canonical checkout hides the real problem and can cause humans or agents to build, test, or diff against a misleading root worktree. Repositories that cannot support strict worktree development must opt into a looser policy.
- **Decision:** Root-glob rules are selectors for explainable defaults, not a general inheritance language.
  - **Rationale:** Personal defaults such as `~/dev/projects/**` are useful for policy and bootstrap commands, but resolution should remain explainable: defaults are refined by ordered matching rules and exact project entries. Command bodies stay opaque Bash; `wktree` does not parse TOML conditionals or perform broad shell expansion.
- **Decision:** `finish` is a conservative worktree lifecycle operation, not a general Git automation daemon.
  - **Rationale:** Integrating a completed branch into the canonical root is the natural counterpart to `add`, but conflict resolution, force-pushing, scheduled sync, and provider workflows remain explicit human responsibilities.

## 3. Domain Concepts

### Naming spine

Branch, path, and session identity are deterministic and reconstructable from git and filesystem state alone.

- With `worktree_location = "sibling"` (the default): `<canonicalRoot>__<branch with / encoded as -->`.
- With `worktree_location = "nested"`: `<canonicalRoot>/.worktrees/<branch with / encoded as -->`.

The effective location controls only newly created worktrees. Existing worktrees retain the paths reported by `git worktree list`, whether sibling, nested, or manually chosen. `path` returns a registered branch's actual path before deriving a new path from config.

For nested layouts, `wktree` records `/.worktrees/` and the previous `/.wktree/` path in a dedicated fenced block in the repository's shared exclude file before creating a worktree. The canonical checkout therefore remains clean.

### Canonical root

The canonical/root worktree is protected: it MUST NOT be removed, and it anchors config lookup, sibling path generation, default-branch detection, and safety checks.

### Session identity

Emitted in `add`, `remove`, and `list` payloads and used by the multiplexer integration; derived from the worktree path:

- sibling `session.name = basename(worktree_path).replaceAll(".", "_")`
- nested `session.name = "<canonical-root-basename>__<worktree-basename>".replaceAll(".", "_")`
- `session.path = worktree_path`

The nested form preserves the repository prefix used by sibling paths, preventing common branch names in different repositories from colliding in a multiplexer. Manually located worktrees use their path basename.

- default window/title = branch name

Missing multiplexer sessions are normal and reconstructable, never an error.

### Safety invariants

- Unforced operations refuse dirty, ahead, local-only, or otherwise ambiguous states. `remove --keep-branch` is the exception for branch merge/upstream state: it requires a clean worktree but removes it without checking whether the retained branch is merged.
- `remove --integrated-into <origin/ref>` is a conservative squash-aware cleanup path. It fetches `origin`, requires a clean source worktree, verifies the claimed remote-tracking target resolves to a distinct commit with a shared branch point, then requires every source-changed path to be content-equivalent at that target. Git cannot establish forge/PR provenance for a squash commit, so this proves the branch's content is present at the user-named target rather than its causal history. It may use force branch deletion only after that proof, because Git's ordinary merged-branch test cannot recognize squash merges. It cannot be combined with `--force` or `--keep-branch`.
- Forced removal may discard uncommitted work and delete an unmerged branch, but MUST NOT remove the canonical root.

### Bootstrap

Project config may define a bootstrap `command` that prepares a worktree for work, plus copy setup that materializes local files or directories into the created worktree. Copy setup runs before the configured command. The command runs under bash with `WK_ROOT` (canonical root) and `WK_CREATED` (the created worktree) exported.

- `add` runs the command inside `wktree` before reporting `ready`, unless `--skip-command` is selected. On failure the engine rolls back the add: a newly created worktree is removed, a newly created branch is deleted, and a pre-existing branch is restored to its previous head. The command fails as a hook failure (exit `1`); without `--json`, its output streams to the terminal as it runs.
- With `--json`, bootstrap output is captured in the payload's `setup_output`; a failure reports `reason: "setup_failed"` with `setup_exit_code`.
- `add --skip-command` retains copy/symlink setup and all safety checks, and skips only bootstrap. Emit explicit skip diagnostics without changing structured `kind` values.

### Interactive mode

`--interactive` is a global flag for human wrappers. It lets the engine move the user's focus to follow the command:

- `add` opens the worktree's multiplexer session and focuses it. Outside a multiplexer it writes the worktree path to the cd directive instead.
- `remove`, and `finish` when its cleanup removes the worktree, write the canonical root to the cd directive if the caller's working directory was inside that worktree, then close multiplexer sessions rooted at or below its path. Closing sessions is the last step, after all output, because closing the invoking session may end the `wktree` process.
- `pick` writes the selected worktree path to the cd directive; `pick --open` instead opens and focuses its multiplexer session, and requires one.
- Multiplexer failures are warnings on stderr, written after any JSON document. They never undo a completed git operation.

Without `--interactive`, `wktree` makes no multiplexer calls and writes no cd directive.

The cd directive lets a wrapper change its shell's directory. When `WKTREE_CD_FILE` names a file and `--interactive` is set, the engine writes one absolute directory path to it. The wrapper creates the file, reads it after `wktree` exits, `cd`s if it holds a path, and deletes it.

### Copy setup

A project's optional `copy` configuration copies or symlinks local files or directories into a target worktree. Copy entries are deterministic and rerunnable:

- String entries are relative paths materialized from the canonical root to the same relative path in the target worktree using the project `copy_mode_default`, which defaults to `copy`.
- Object entries use `from` and `to`; `from` may be relative to the canonical root, absolute, or start with `~`, while `to` is always relative to the target worktree. Object entries may set `mode = "copy"` or `mode = "symlink"`, overriding `copy_mode_default` for that entry.
- `to` may be a string or array of strings. Each destination is the exact final file or directory path, not a parent directory for nesting the source basename.
- Only leading `~` expands. Globs, environment variables, and shell interpolation are not supported.
- Missing sources, absolute destinations, and destinations that overlap tracked files fail loudly.
- Copy mode requires sources to be regular files or directories. Symlink mode creates each destination as a symlink to the resolved source target, avoiding symlink chains through the canonical root.
- Each destination path is fully engine-managed. Reruns delete the existing destination path before materializing it from the source, so removed source files do not leave stale copied files behind. This may delete untracked local additions under a copied directory; tracked files or tracked descendants still block the operation.

Every configured destination is also written once to the canonical repository's shared exclude file: the real canonical-root `.git/info/exclude` file, following symlinks if needed. This shared git exclude file is the ignore source for linked worktrees, so copied paths are ignored in the worktrees that receive them. The engine owns a fenced block and preserves content outside it:

```gitignore
# wktree-start
.env
.tooling
.editor/tooling
# wktree-end
```

When no copy destinations are configured, the fenced block is removed on the next copy-capable run.

### Policy configuration

Policy and inherited bootstrap command configuration describes default behavior for repositories that may not need exact project entries. It is resolved from four layers:

1. built-in defaults and global `[defaults]`;
2. matching `[[rule]]` entries, evaluated in file order with later matching fields winning;
3. an exact global `[[project]]` entry for the canonical root, whose fields win over rules;
4. `.wktree.toml` at the canonical root, whose explicit fields override the resolved global settings.

Rules match canonical root paths with an explicit `root_glob`. Glob matching is only for root selection; copy paths keep their stricter no-glob contract. Rules may provide an optional bootstrap `command` and optional `pre_remote_check`; matching rule values are evaluated in file order with later values winning. Copy setup may be configured by an exact global project or the repository-local file. Exact projects may also exist only to override policy or command defaults for an exceptional repository. Local options inherit when omitted; finish patches merge field-by-field and copy arrays replace the inherited list, including an explicit empty list. All worktrees use the canonical file rather than a caller-worktree file.

### Add freshness policy

`add` policy controls how a new branch chooses its starting point and whether the canonical root must be up to date first:

| Policy | Contract |
| --- | --- |
| `fresh_canonical` | Fetch `origin`, require the canonical root to be clean and checked out on origin's default branch, fast-forward it to `origin/<default>`, then create new branches without an explicit `--base` from the canonical default branch. Any failure blocks default-base `add`. |
| `origin_default` | Fetch `origin` and create new branches without an explicit `--base` from `origin/<default>` without mutating the canonical root. This is the escape hatch for repositories that cannot reliably keep the canonical checkout clean or worktree-only. |

An explicit `--base` or `--base-current` remains a user override for stacked or non-default work. It still fetches first and resolves the selected base deterministically, but it does not require or mutate the canonical default branch. Strict policies must not silently fall back to stale `HEAD` when the requested base cannot be resolved. Existing local or remote branches are checked out according to normal branch-state rules; if policy later governs remote fast-forward of existing branch worktrees, failures must be structured as either blocked or warning outcomes rather than stderr-only text.

`add --no-network` requires Git 2.45+ for `--no-lazy-fetch`. Skip `pre_remote_check`, fetch and network default discovery, retaining normal add policy against cached refs. Discover the default name only from local `origin/HEAD`. `origin_default` starts new default-base branches from cached `origin/<default>` without canonical mutation. `fresh_canonical` retains clean/on-default/ancestor checks and the FF-only canonical merge before branching; a locally ahead or diverged canonical still blocks. Existing branches retain the normal cached-origin FF-only attempt, with warning and local-work preservation on failure.

If the cached default ref is absent, use the known local default committed tip; `fresh_canonical` retains clean/on-default checks without a remote ancestry/merge target. Unknown default metadata or absent cached and local defaults requires actionable `--base` guidance, never guessed `HEAD`. Explicit `--base`/`--base-current` retain their policy override and resolve locally. Present refs with missing required objects fail loudly, without fallback or lazy fetching, including reads, checkouts and copy checks. Ordinary fetch failure does not automatically select offline behavior.

A successful canonical fast-forward remains after later setup failure, matching ordinary add. Other commands retain their policies. `--no-network` and `--skip-command` are independent; configured commands and user Git hooks remain capable of network IO and may require skipped bootstrap or user intervention.

### Remote pre-check

Repositories may resolve an optional `pre_remote_check` Bash snippet from matching rules, an exact project entry and repository-local settings. `wktree` runs the resolved snippet from the canonical root before any remote-aware operation: fetch/push, origin default-branch detection, or freshness checks against `origin/*` refs in `add`, remote-proof `remove`, and `finish`. Inventory and path queries never run this pre-check.

- exit `0`: stay silent and continue;
- non-zero exit: abort immediately, do not perform later remote checks/contact, and surface the script's stderr to the user.

`pre_remote_check` uses the same inline Bash conventions as inherited/bootstrap `command`s; there is no extra shell-selection or fallback behavior.

### Finish lifecycle

`finish` integrates a completed non-canonical worktree into the canonical root using configured policy. It is intentionally conservative:

- refuse to run from the canonical root;
- require the source worktree to be clean;
- fetch before integration;
- require the target/canonical checkout to be clean and up to date according to the active add freshness policy;
- never force-push;
- do not clean up the source worktree unless integration and any configured push both succeed;
- check conflict safety before changing the canonical HEAD, index or worktree, including before `fresh_canonical` advancement;
- refuse merge conflicts without changing canonical or pushing/cleaning up source work; leave resolution to the user.

Supported strategies mirror common forge merge choices while preserving local determinism:

| Strategy | Contract |
| --- | --- |
| `ff_only` | Move the target only if it can fast-forward to the source branch. |
| `rebase_ff` | Rebase the source onto the resolved target before advancing canonical, then fast-forward the target. Conflicts remain in the source checkout for native rebase recovery. |
| `squash` | Preview the merge, then apply the source branch changes onto the target as one new commit. `--title` is required; `--body` is optional. |
| `merge_commit` | Preview the merge, then merge the source into the target with an explicit merge commit. |

Squash integration is explicit: `--title` is required and `--body` is optional. The squash commit body is composed from the caller's body, the source branch, and every squashed commit message, oldest first, so breaking-change notes and per-commit context survive squashing. Strategies other than `squash` reject `--title` and `--body`.

Merge previews use native `git merge-tree --write-tree` and attributes from the resolved target commit (`git --attr-source`). A conflict returns `blocked` / `conflict`, `integrated=false` and no cleanup actions. Other preview errors fail as Git errors before canonical mutation. To keep preview and integration consistent, `squash` and `merge_commit` refuse nonempty `branch.<target>.mergeOptions` and `pull.twohead` values other than `ort`. During preview only, every configured custom `merge.<name>.driver` command is overridden with a diagnostic and the fatal shell builtin `exit 129` through per-invocation Git configuration. Git can resolve merges that never invoke a custom driver; any merge that needs one returns `blocked` before canonical mutation, without executing the configured command. A fatal exit prevents Git from absorbing ordinary conflicts while combining multiple merge bases; the diagnostic identifies this refusal separately from other Git failures. The override does not alter repository configuration or the actual integration invocation. Built-in merge settings and ordinary Git hooks remain enabled.

This protects canonical from integration conflicts; it does not roll back arbitrary hook side effects or commit-hook failures. A rejected commit can leave cleanly merged changes staged for the user. Finish assumes exclusive use of the source and canonical checkouts during the operation.

`finish` may optionally push the target branch, delete the finished branch, and clean up the worktree after successful integration when enabled by effective finish policy. Push rejection is a blocking result, not a reason to retry with force. Cleanup uses finish-aware safety: once a configured strategy has successfully integrated the source changes into the target, the source branch/worktree may be cleaned up even when the source branch is local-only or was squash-finished. Branch deletion requires cleaning up the source worktree in the same effective finish policy; otherwise finish blocks before integration. Standalone `remove` keeps its upstream-merge safety rules.

## 4. Interfaces

### Commands

| Command | Purpose |
| --- | --- |
| `wktree [--cwd <path>] root` | Print canonical worktree root. |
| `wktree [--cwd <path>] list [--json]` | List registered worktrees without setup or inspecting checkout contents. |
| `wktree [--cwd <path>] tree [--json]` | Group registered worktrees relative to the repository default branch, infer feature stacks from local ancestry. |
| `wktree [--cwd <path>] path --branch <branch>` | Print the worktree path for a branch. |
| `wktree [--cwd <path>] add --branch <branch> [--json] [--base <ref>] [--base-current] [--no-network] [--skip-command]` | Create and prepare a branch worktree at its deterministic path. |
| `wktree [--cwd <path>] remove (--branch <branch> \| --self) [--json] [--force] [--keep-branch] [--integrated-into <origin/ref>]` | Remove a branch worktree without integrating its changes. `--self` targets the worktree containing `cwd`. `--integrated-into` proves clean squash-aware cleanup against a fetched target. |
| `wktree [--cwd <path>] copy [--json]` | Re-run configured copy setup for the non-canonical worktree containing `cwd`. |
| `wktree [--cwd <path>] config explain [--json]` | Show effective policy/setup and provenance after global layers and canonical-root local overrides. |
| `wktree [--cwd <path>] finish [--title <subject>] [--body <text>] [--json]` | Integrate a completed worktree into the canonical root using effective finish policy. `--title` is required with the `squash` strategy; other strategies reject both message options. |
| `wktree [--cwd <path>] pick [--open]` | Fuzzy-pick a worktree with fzf, marking the one containing `cwd`, and print its path. `--open` requires `--interactive`. Cancelling exits `130` without output. With `--interactive` inside tmux, the picker opens in a popup and previews each worktree's session; otherwise it runs inline and previews recent history. |

`wktree shell-init <zsh|nu>` prints a single `wk` picker function without requiring a repository. It invokes `wktree --interactive pick`, forwards pick options, applies the cd directive on success, and cleans up its temporary file. Other commands use the CLI directly.

`--cwd` is a global option. It may point at any path inside the intended worktree set and defaults to the current directory. Commands resolve the canonical root from that path; commands that operate on the current/source worktree, such as `copy`, `finish` and `remove --self`, target the worktree containing that path.

`add --base-current` uses the branch checked out in the worktree containing `--cwd` as its base. A detached worktree and combining it with `--base` are usage errors.

`--interactive` is a global option for human wrappers; see §3 Interactive mode. Scripts and agents omit it and use structured output where available. `add`, `remove`, and `finish` own lifecycle transitions; `root`, `list`, `path`, and `tree` are queries; `copy` reapplies untracked setup files without bootstrap.

### Structured output rules

The CLI uses the following output contract.

- `--json` writes exactly one JSON object to stdout, on success and on every failure, and nothing to stderr.
- Every document carries `ok` (`true` exactly when the exit code is `0`), a `kind`, and the captured output of the run: `diagnostics` (wktree's progress lines and warnings) and `setup_output` (bootstrap lines as `{ stream, line }`).
- Without `--json`, stdout carries results and stderr carries diagnostics, progress, warnings, and human-readable errors.
- Consumers branch on `ok`, `kind`, and `reason`, never on message text.
- Payload changes for surviving commands are additive: existing `kind` values and fields are kept.

### Exit codes

| Code  | Meaning                                |
| ----- | -------------------------------------- |
| `0`   | success / ready                        |
| `10`  | blocked / recoverable state            |
| `11`  | unsafe operation refused without force |
| `12`  | usage or config error                  |
| `130` | cancelled                              |
| `1`   | unexpected runtime or hook failure     |

### Payloads

Successful add-like payload:

```json
{
	"ok": true,
	"kind": "ready",
	"worktree_path": "/repo__feature--foo",
	"branch": "feature/foo",
	"root": "/repo",
	"title": "feature/foo",
	"session": { "name": "repo__feature--foo", "path": "/repo__feature--foo" },
	"post_create_script_path": null,
	"created_new_branch": true,
	"rollback_branch_head": null,
	"diagnostics": [],
	"setup_output": [{ "stream": "stdout", "line": "installed 12 packages" }]
}
```

`post_create_script_path` is retained for compatibility and is always `null` because the engine runs bootstrap itself.

Later examples omit `ok`, `diagnostics`, and `setup_output`.

Successful removal reports `kind: "ready"` and `removed: true`:

```json
{
	"kind": "ready",
	"worktree_path": "/repo__feature--foo",
	"removed": true,
	"session": { "name": "repo__feature--foo", "path": "/repo__feature--foo" }
}
```

Failures emit `ok: false` with a `kind`, an enumerated machine `reason`, and a human-readable `message`. Optional `branch` and `worktree_path` are included when known.

Blocked/recoverable refusals use `kind: "blocked"` with a `reason` such as `duplicate_branch`, `unmerged_branch`, `canonical_root`, `unsafe`, `dirty_canonical`, `wrong_canonical_branch`, `non_ff_canonical`, `dirty_worktree`, `target_not_fresh`, `push_rejected`, `conflict`, `pre_remote_check_failed`, or `blocked`:

```json
{
	"kind": "blocked",
	"reason": "dirty_worktree",
	"message": "worktree has uncommitted changes",
	"worktree_path": "/repo__feature--foo"
}
```

Failures to run use `kind: "error"` with a `reason` such as `usage`, `config`, `trunk_detection_failed`, `setup_failed`, `git_failed`, `cancelled`, or `internal`. Setup failures add `setup_exit_code`. Failed `finish` runs report partial progress as `integrated` and the `cleanup_actions` that completed:

```json
{
	"ok": false,
	"kind": "error",
	"reason": "setup_failed",
	"message": "hook failed in /repo__feature--foo (7)",
	"branch": "feature/foo",
	"worktree_path": "/repo__feature--foo",
	"setup_exit_code": 7,
	"diagnostics": [],
	"setup_output": [{ "stream": "stderr", "line": "missing .envrc" }]
}
```

`list --json` emits `{ "kind": "list", "worktrees": [...] }`, each worktree item carrying: `path`, `head`, `branch`, `branch_ref`, `detached`, `bare`, `locked`, `lock_reason`, `prunable`, `prunable_reason`, `canonical`, `pool`, and `session` (`{ name, path }`). `pool` is always `null`, retained only for JSON contract stability.

`tree --json` retains `{ "kind": "tree", "basis": "git_ancestry", "nodes": [...] }` and adds `default_branch: { branch, ref, head }` plus each node's `comparison: { kind: "related" | "no_common_ancestor", ahead, behind }`. The baseline is null for an inventory without commits; a missing HEAD has null comparison. Nodes retain their OID/path IDs and all list-payload worktrees, grouping equal HEADs. `parentage` retains inferred/ambiguous/unknown variants, but only HEADs with locally observed shared ancestry and commits outside the default history are eligible feature parents. No eligible ancestor is `unknown/no_ancestor`; it does not deny baseline association.

Text groups related, non-ambiguous feature roots and contained HEADs beneath the default header without asserting a parentage edge. Feature descendants nest under their nearest strict feature ancestor; ambiguous, no-common-ancestor and missing-HEAD groups remain separate. Equality never implies parentage; no creation history is recorded.

The default name comes only from local `origin/HEAD`, with the local default branch tip preferred over the cached origin tip; absence of both or the designation fails with `trunk_detection_failed` for committed inventories. It never guesses the default from the canonical checkout. Inventory and baseline are snapshotted before immutable-OID comparisons. All Git queries prevent lazy fetching, with no config, setup, remote access or metadata repair. Git errors fail with `git_failed` rather than becoming unknown ancestry. See the [ancestry tree guide](../../README.md#worktree-ancestry-tree) for exact presentation and JSON semantics.

`copy` targets the non-canonical worktree containing `--cwd` or the current directory. Targeting the canonical root is refused with exit code `11` and, when `--json` is used, a `{"kind":"blocked","reason":"canonical_root"}` payload, matching the root protection invariant. Copy config errors, invalid copy paths, and missing sources are config failures with exit code `12`; with `--json`, they emit an error payload with `reason: "config"`. Destinations that overlap tracked files are unsafe refusals with exit code `11`; with `--json`, they emit a blocked payload with `reason: "unsafe"`.

`copy --json` emits a successful setup payload:

```json
{
	"kind": "ready",
	"root": "/repo",
	"worktree_path": "/repo__feature--foo",
	"copied": [
		{ "from": "/repo/.env", "to": ".env", "type": "file" },
		{
			"from": "/Users/me/shared/tooling",
			"to": ".tooling",
			"type": "directory"
		},
		{
			"from": "/Users/me/secrets/app.env",
			"to": ".env.shared",
			"type": "symlink"
		}
	],
	"exclude_paths": [".env", ".tooling"]
}
```

With no copy configuration, `copied` and `exclude_paths` are empty arrays.

`config explain --json` emits the effective policy and the config layers that matched the canonical root:

```json
{
	"kind": "config_explain",
	"root": "/repo",
	"matched_rules": [{ "root_glob": "~/dev/projects/**" }],
	"project": { "name": "example", "root": "/repo" },
	"command": {
		"source": "rule:~/dev/projects/**",
		"value": "bun install"
	},
	"pre_remote_check": {
		"source": "rule:~/dev/projects/**",
		"value": "test -f .envrc || { echo 'missing .envrc' >&2; exit 1; }"
	},
	"worktree_location": "sibling",
	"add": { "policy": "fresh_canonical" },
	"finish": {
		"enabled": true,
		"strategy": "ff_only",
		"push": false,
		"remove_worktree": false,
		"delete_branch": false
	}
}
```

With no exact global project match, `project` is `null`. With no matching root-glob rules, `matched_rules` is empty. `setup` reports effective name, copy default and copy entries. When a canonical-root local file exists, `local_config` reports its path and explicit settings; locally supplied commands and hooks have `local:<path>` sources. Local-only setup does not manufacture a global project match.

Successful `finish --json` emits the integrated source, target, strategy, and ordered cleanup actions that actually ran:

```json
{
	"kind": "ready",
	"root": "/repo",
	"worktree_path": "/repo__feature--foo",
	"source_branch": "feature/foo",
	"target_branch": "main",
	"strategy": "ff_only",
	"cleanup_actions": ["push", "remove_worktree", "delete_branch"]
}
```

If push or cleanup is not enabled, the corresponding action is absent.

### Config

Global config is read only from `wktree.toml` under XDG config home (default `~/.config/wktree.toml`). Project entries define exact canonical roots for bootstrap, copy setup, and exact policy overrides. Policy configuration also supports defaults and root-glob rules that can affect repositories without requiring bootstrap setup. A repository-local `.wktree.toml` at the canonical root supplies a final patch using the same applicable option shapes, with no `root`, `root_glob`, `defaults`, `rule` or `project` selectors. See the [configuration guide](../../README.md#repository-local-configuration) for local syntax, inheritance, validation and editor schemas.

Top-level fields:

| Field | Default | Purpose |
| --- | --- | --- |
| `worktree_location` | `"sibling"` | Global preference for creating new sibling paths or nested paths under `<canonicalRoot>/.worktrees/`. |

Implemented exact project fields:

| Field | Required | Purpose |
| --- | --- | --- |
| `root` | yes | Canonical root worktree path. |
| `command` | when no matching rule command exists and using copy or bootstrap setup | Bootstrap command run after worktree creation and copy setup. Policy-only exact projects may omit it; absent effective commands skip bootstrap. |
| `pre_remote_check` | no | Bash snippet run before remote-aware operations for this exact root; exact project values override matching rules. |
| `name` | no | Project identifier; defaults to the basename of `root`. |
| `worktree_location` | no | Exact-root override for where new worktrees are created. |
| `copy_mode_default` | no | `copy` or `symlink`; defaults to `copy` and applies to all copy entries unless overridden. |
| `copy` | no | Files or directories to copy or symlink into created worktrees before `command` runs. |

Policy fields:

| Field | Scope | Purpose |
| --- | --- | --- |
| `[defaults.add].policy` | global defaults | Fallback add policy when no rule or project overrides it. |
| `[defaults.finish]` | global defaults | Fallback finish policy when no rule or project overrides it: `enabled`, `strategy`, `push`, `remove_worktree`, and `delete_branch`. |
| `[[rule]].root_glob` | rule | Canonical root glob to match, with leading `~` expansion only. |
| `[[rule]].command` | rule | Optional inherited Bash bootstrap command for matching roots; later matching rule commands win. |
| `[[rule]].pre_remote_check` | rule | Optional inherited Bash snippet run before remote-aware operations; later matching rule values win. |
| `[[rule]].worktree_location` | rule | Optional location preference for matching roots; later matching rule values win. |
| `[rule.add].policy` | rule | Add policy for matching roots. |
| `[rule.finish]` | rule | Finish policy for matching roots: `enabled`, `strategy`, `push`, `remove_worktree`, and `delete_branch`. |
| `[project.add].policy` | exact project | Exact-root add policy override. |
| `[project.finish]` | exact project | Exact-root finish policy override: `enabled`, `strategy`, `push`, `remove_worktree`, and `delete_branch`. |

Bootstrap commands run under bash with `WK_ROOT` and `WK_CREATED` exported (see §3).

Example:

```toml
worktree_location = "nested"

[defaults.add]
policy = "origin_default"

[defaults.finish]
enabled = true
strategy = "ff_only"
push = false
remove_worktree = false
delete_branch = false

[[rule]]
root_glob = "~/dev/projects/**"
worktree_location = "sibling"
pre_remote_check = "test -f .envrc || { echo 'missing .envrc' >&2; exit 1; }"
command = '''
if [[ -f bun.lock ]]; then
  bun install
elif [[ -f yarn.lock ]]; then
  yarn install
elif [[ -f pnpm-lock.yaml ]]; then
  pnpm install
else
  echo "wktree: no known JS lockfile found; skipping install"
fi
'''

[rule.add]
policy = "fresh_canonical"

[rule.finish]
strategy = "squash"
push = true
remove_worktree = true
delete_branch = true

[[project]]
name = "example"
root = "~/dev/example"
command = "bun install"
worktree_location = "nested"
copy_mode_default = "copy"
copy = [
  ".env",
  { from = "~/shared/tooling", to = [".tooling", ".editor/tooling"] },
  { from = ".env.shared", to = ".env.shared", mode = "symlink" },
]

[[project]]
name = "dots"
root = "~/dev/dots"

[project.add]
policy = "origin_default"

[project.finish]
enabled = false
```
