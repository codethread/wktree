# Git Worktrees Engine

**Status:** Implemented
**Last Updated:** 2026-06-22

## 1. Overview

### Purpose

`wktree` is a deterministic local engine for creating, reusing, inspecting, and removing
git worktrees. It gives the same lifecycle contract to humans, shell wrappers, tmux
workflows, and agents. Durable state lives in git metadata, filesystem paths, project
config, and optional per-repository pool slots; tmux is a consumer, not a database.

### Goals

- Keep git/worktree lifecycle complexity inside one engine with a small command interface.
- Use deterministic branch, path, and session identity.
- Serve human interactive and non-interactive machine workflows with the same semantics.
- Reconstruct current state from authoritative sources rather than a synchronized cache.
- Support opt-in fixed pools for high-cost repositories.
- Support deterministic per-worktree copy setup for untracked local configuration and tool assets.
- Allow explicit repository policy for how new work starts and how completed work is integrated.
- Surface destructive or ambiguous states with structured data.

### Non-Goals

- No durable worktree/session database beyond git/filesystem/config state.
- No tmux resurrection or persistent session registry.
- No requirement that each worktree has a live tmux session.
- No implicit pool expansion.
- No periodic repository sync daemon, background auto-pull, or auto-push loop.
- No automatic commits for normal source repositories.
- No automatic merge-conflict resolution or force-pushing.
- No pull-request/provider workflow management.
- No glob, environment-variable, or shell expansion in copy configuration beyond leading `~`.

## 2. Design Decisions

- **Decision:** `wktree` owns all git/worktree state transitions (creation, removal, pool
  allocation, recycling, safety checks, bootstrap script generation).
  - **Rationale:** Centralizing avoids duplicated, drift-prone shell behavior across the
    multiple consumers (humans, wrappers, tmux, agents) that all need identical semantics.
- **Decision:** Tmux is a consumer, not the source of truth. Session identity is emitted
  for wrappers but correctness derives from git and filesystem state.
  - **Rationale:** A persistent session registry would be a second database to keep in
    sync; reconstructable identity removes that failure mode.
- **Decision:** Branch/path naming is the coordination spine (see §3).
  - **Rationale:** Deterministic naming lets every consumer derive identity independently
    with no shared state or handshake.
- **Decision:** New branches default to origin's default branch/trunk unless a base is
  given.
  - **Rationale:** Commands are often run from inside another worktree; defaulting to the
    current HEAD would silently create accidental stacked branches.
- **Decision:** Pools are explicit per-project optimizations, never expanded implicitly.
  - **Rationale:** Pools trade branch-named paths for bounded reusable environments; silent
    growth would defeat the bound and surprise high-cost-repo owners.
- **Decision:** Pool exhaustion is a recoverable, structured `pool_full` outcome.
  - **Rationale:** Machine consumers can branch on it programmatically and humans can pick a
    slot interactively, instead of hitting an opaque hard failure.
- **Decision:** Bootstrap is part of ready-to-work semantics, and failures are loud.
  - **Rationale:** A worktree that looks created but isn't prepared is a worse trap than an
    explicit failure; newly-created pooled slots roll back so state stays clean.
- **Decision:** Copy setup runs before configured commands and is rerunnable with `wktree copy`.
  - **Rationale:** Local config and shared tool assets should be present before project bootstrap
    commands run, and users need an explicit way to apply config changes after a worktree already
    exists.
- **Decision:** Copy destinations are worktree-relative untracked setup paths and are recorded in
  the canonical exclude file.
  - **Rationale:** Copied assets are local workspace material, not repository changes. Refusing to
    overwrite tracked paths prevents accidental modification of versioned project files, while an
    idempotent fenced exclude block prevents noisy status output and duplicate rules.
- **Decision:** Fresh parsing over synchronized caches.
  - **Rationale:** Git worktree metadata, filesystem paths, project config, and live tmux
    state are cheap enough to inspect directly, removing cache-invalidation bugs.
- **Decision:** Add-time freshness policy belongs in the engine, not only in shell wrappers.
  - **Rationale:** Humans and agents should get the same safety guarantees. If a repository
    requires new work to start from an up-to-date canonical default branch, that invariant
    must hold for direct `wktree add --json` consumers as well as the Nushell wrapper.
- **Decision:** Strict add policy fails instead of falling back to stale bases.
  - **Rationale:** Falling back to an old canonical checkout hides the real problem and
    can cause humans or agents to build, test, or diff against a misleading root worktree.
    Repositories that cannot support strict worktree development must opt into a looser policy.
- **Decision:** Root-glob rules are policy selectors, not a general inheritance language.
  - **Rationale:** Personal defaults such as `~/dev/projects/**` are useful, but policy
    resolution should remain explainable: defaults are refined by ordered matching rules and
    exact project entries, with no conditionals or broad shell expansion.
- **Decision:** `finish` is a conservative worktree lifecycle operation, not a general Git
  automation daemon.
  - **Rationale:** Integrating a completed branch into the canonical root is the natural
    counterpart to `add`, but conflict resolution, force-pushing, scheduled sync, and provider
    workflows remain explicit human responsibilities.

## 3. Domain Concepts

### Naming spine

Branch, path, and session identity are deterministic and reconstructable from git and
filesystem state alone.

- Non-pooled worktree path: `<canonicalRoot>__<branch with / encoded as -->`.
- Pooled worktree path: `<canonicalRoot>__featN`.
- Pooled placeholder branch: `wk-pool/featN`.

### Canonical root

The canonical/root worktree is protected: it MUST NOT be removed or recycled, and it
anchors config lookup, sibling path generation, default-branch detection, and safety
checks.

### Session identity

Emitted in `add`, `remove`, and `list` payloads; the wrapper/tmux layer derives the same
identity from the worktree path:

- `session.name = basename(worktree_path).replaceAll(".", "_")`
- `session.path = worktree_path`
- default window/title = branch name

Missing tmux sessions are normal and reconstructable, never an error.

### Safety invariants

- Unforced operations refuse dirty, ahead, local-only, or otherwise ambiguous states.
- Forced operations may be destructive but MUST preserve gitignored files such as
  dependency directories when recycling.

### Pool semantics

A project with `pool_size` uses fixed reusable slots. Pooled mode changes command-visible
behavior across `path`, `add`, `remove`, `list`, `ensure`, `status`, and `recycle`, and
introduces the `pool_full` outcome.

- Slot path `<root>__featN`; placeholder branch `wk-pool/featN`; initialized marker
  `wk-pool-initialized` in git metadata.
- `add`, `list`, and pooled `remove` initialize absent or half-initialized slots before
  allocating, listing, or recycling them. Allocation happens only after this ensure step
  succeeds; initialization failures are loud and no `pool_full` payload is returned for an
  initialization failure.
- Allocation prefers initialized placeholder slots first.
- Safe recycling refuses dirty slots, branches without upstreams, and branches not merged
  to upstream. Forced recycling may discard tracked/untracked work and delete the old
  branch.
- Exhaustion returns `pool_full` with recyclable candidates (see §4).

### Bootstrap

Project config defines required `command`s that prepare a worktree or slot for work, plus
optional copy setup that materializes local files or directories into the created worktree.
Copy setup runs before the configured command. For add/allocation the engine writes a fresh
temporary post-create script (run under bash) and returns its path; the script exports
`WK_ROOT` (canonical root) and `WK_CREATED` (the created worktree or allocated slot). Human
wrappers run the returned script synchronously before opening a session. Pool initialization
runs setup inside `wktree` so initialized slots are actually ready; newly-created pooled
slots roll back on setup failure, while existing half-initialized slots remain uninitialized
until a later successful run.

### Copy setup

A project's optional `copy` configuration copies or symlinks local files or directories into a
target worktree. Copy entries are deterministic and rerunnable:

- String entries are relative paths materialized from the canonical root to the same relative path
  in the target worktree using the project `copy_mode_default`, which defaults to `copy`.
- Object entries use `from` and `to`; `from` may be relative to the canonical root, absolute,
  or start with `~`, while `to` is always relative to the target worktree. Object entries may
  set `mode = "copy"` or `mode = "symlink"`, overriding `copy_mode_default` for that entry.
- `to` may be a string or array of strings. Each destination is the exact final file or
  directory path, not a parent directory for nesting the source basename.
- Only leading `~` expands. Globs, environment variables, and shell interpolation are not
  supported.
- Missing sources, absolute destinations, and destinations that overlap tracked files fail
  loudly.
- Copy mode requires sources to be regular files or directories. Symlink mode creates each
  destination as a symlink to the resolved source target, avoiding symlink chains through the
  canonical root.
- Each destination path is fully engine-managed. Reruns delete the existing destination path
  before materializing it from the source, so removed source files do not leave stale copied
  files behind. This may delete untracked local additions under a copied directory; tracked
  files or tracked descendants still block the operation.

Every configured destination is also written once to the canonical repository's shared
exclude file: the real canonical-root `.git/info/exclude` file, following symlinks if
needed. This shared git exclude file is the ignore source for linked worktrees, so copied
paths are ignored in the worktrees that receive them. The engine owns a fenced block and
preserves content outside it:

```gitignore
# wktree-start
.env
.claude/skills/skill-dir
.pi/agents/skill-dir
# wktree-end
```

When no copy destinations are configured, the fenced block is removed on the next copy-capable
run.

### Policy configuration

Policy configuration describes default behavior for repositories that may not need bootstrap
commands or pools. It is resolved from three layers:

1. built-in defaults;
2. matching `[[rule]]` entries, evaluated in file order with later matching fields winning;
3. an exact `[[project]]` entry for the canonical root, whose fields win over rules.

Rules match canonical root paths with an explicit `root_glob`. Glob matching is only for root
selection; copy paths keep their stricter no-glob contract. Exact project entries remain the
place for bootstrap commands, pools, and copy setup, but they may also exist only to override
policy for an exceptional repository.

### Add freshness policy

`add` policy controls how a new branch chooses its starting point and whether the canonical
root must be up to date first:

| Policy | Contract |
|---|---|
| `fresh_canonical` | Fetch `origin`, require the canonical root to be clean and checked out on origin's default branch, fast-forward it to `origin/<default>`, then create new branches from the canonical default branch. Any failure blocks `add`. |
| `origin_default` | Fetch `origin` and create new branches from `origin/<default>` without mutating the canonical root. This is the escape hatch for repositories that cannot reliably keep the canonical checkout clean or worktree-only. |

An explicit `--base` remains a user override, but freshness still applies to the selected base
where meaningful: strict policies must fetch first and must not silently fall back to a stale
local ref. Existing local or remote branches are checked out according to normal branch-state
rules; if policy later governs remote fast-forward of existing branch worktrees, failures must
be structured as either blocked or warning outcomes rather than stderr-only text.

### Finish lifecycle

`finish` integrates a completed non-canonical worktree into the canonical root using configured
policy. It is intentionally conservative:

- refuse to run from the canonical root;
- require the source worktree to be clean;
- fetch before integration;
- require the target/canonical checkout to be clean and up to date according to the active add
  freshness policy;
- never force-push;
- do not remove or recycle the source worktree unless integration and any configured push both
  succeed;
- stop on conflicts and leave resolution to the user.

Supported strategies mirror common forge merge choices while preserving local determinism:

| Strategy | Contract |
|---|---|
| `ff_only` | Move the target only if it can fast-forward to the source branch. |
| `rebase_ff` | Rebase the source onto the target, then fast-forward the target. |
| `squash` | Apply the source branch changes onto the target as one new commit. |
| `merge_commit` | Merge the source into the target with an explicit merge commit. |

`finish` may optionally push the target branch, delete the finished branch, and remove or recycle
the worktree after successful integration. Push rejection is a blocking result, not a reason to
retry with force. Cleanup uses finish-aware safety: once a configured strategy has successfully
integrated the source changes into the target, the source branch/worktree may be cleaned up even
when the source branch is local-only or was squash-finished. Branch deletion requires removing or
recycling the source worktree in the same `finish` invocation; otherwise finish blocks before
integration. Standalone `remove`/`recycle` keep their upstream-merge safety rules.

## 4. Interfaces

### Commands

| Command | Purpose |
|---|---|
| `wktree root --cwd <path>` | Print canonical worktree root. |
| `wktree list --cwd <path> [--json]` | List worktrees and initialize configured pools. |
| `wktree path --cwd <path> --branch <branch>` | Print the worktree path for a branch. |
| `wktree add --cwd <path> --branch <branch> [--json] [--slot <path>] [--base <branch>] [--force]` | Create or allocate a worktree. |
| `wktree remove --cwd <path> (--branch <branch> \| --self <path>) [--json] [--force]` | Remove or recycle a worktree. |
| `wktree ensure --cwd <path>` | Materialize configured pool slots. |
| `wktree status --cwd <path>` | Print pool status JSON. |
| `wktree recycle --cwd <path> --slot <path> [--force]` | Recycle a pooled slot. |
| `wktree copy --cwd <path> [--json]` | Re-run configured copy setup for the non-canonical worktree containing `cwd`. |
| `wktree config explain --cwd <path> [--json]` | Show the effective policy after defaults, matching rules, and exact project overrides. |
| `wktree finish --cwd <path> [--json] [--strategy ff_only\|rebase_ff\|squash\|merge_commit] [--push] [--remove-worktree] [--delete-branch]` | Integrate a completed worktree into the canonical root, optionally push the target branch, then remove/recycle the source worktree and delete the source branch. |

### Structured output rules

- `--json` writes only structured payloads to stdout.
- stderr carries diagnostics, progress, warnings, and human-readable errors.
- Consumers branch on `kind`, never on stderr text.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | success / ready |
| `10` | blocked / recoverable state |
| `11` | unsafe operation refused without force |
| `12` | usage or config error |
| `130` | cancelled |
| `1` | unexpected runtime or hook failure |

### Payloads

Successful add-like payload:

```json
{
  "kind": "ready",
  "worktree_path": "/repo__feature--foo",
  "branch": "feature/foo",
  "root": "/repo",
  "title": "feature/foo",
  "session": { "name": "repo__feature--foo", "path": "/repo__feature--foo" },
  "post_create_script_path": null,
  "created_new_branch": true,
  "rollback_branch_head": null
}
```

Successful remove-like payload. Non-pooled removal reports `removed: true`; pooled removal
recycles the slot in place and reports `kind: "ready"` with `removed: false`:

```json
{
  "kind": "ready",
  "worktree_path": "/repo__feature--foo",
  "removed": true,
  "session": { "name": "repo__feature--foo", "path": "/repo__feature--foo" }
}
```

Blocked/recoverable failures (when `--json`) emit a `blocked` payload. `reason` is an
enumerated machine token such as `duplicate_branch`, `dirty_slot`, `unmerged_branch`,
`canonical_root`, `unsafe`, `dirty_canonical`, `wrong_canonical_branch`,
`non_ff_canonical`, `dirty_worktree`, `target_not_fresh`, `push_rejected`, `conflict`,
or `blocked`, and `message` is human-readable. Optional `branch`, `worktree_path`, and
`slot_path` are included when known:

```json
{
  "kind": "blocked",
  "reason": "dirty_slot",
  "message": "slot has uncommitted changes",
  "slot_path": "/repo__feat1"
}
```

`pool_full` payloads include recyclable candidate slots with risk metadata (see the slot
shape below): index, path, branch, dirty state, last-commit ISO timestamp and subject,
placeholder/initialized flags.

`list --json` emits an array of worktree items, each: `path`, `head`, `branch`,
`branch_ref`, `detached`, `bare`, `locked`, `lock_reason`, `prunable`, `prunable_reason`,
`canonical`, `pool`, and `session` (`{ name, path }`).

`status` emits pool state. With no configured pool it is `{ root, trunk: null, size: 0,
slots: [] }`; otherwise `trunk` and `size` are populated and `slots` is an array of:
`index`, `path`, `exists`, `branch`, `placeholder`, `dirty`, `lastCommitIso`,
`lastCommitSubject`, `initialized`.

`copy --cwd <path>` targets the non-canonical worktree containing `cwd`. Targeting the
canonical root is refused with exit code `11` and, when `--json` is used, a
`{"kind":"blocked","reason":"canonical_root"}` payload, matching the root protection
invariant. Copy config errors, invalid copy paths, and missing sources are usage/config
failures with exit code `12`; even with `--json`, they fail like existing config errors
rather than emitting a structured stdout payload. Destinations that overlap tracked files
are unsafe refusals with exit code `11`; with `--json`, they emit a blocked payload with
`reason: "unsafe"`.

`copy --json` emits a successful setup payload:

```json
{
  "kind": "ready",
  "root": "/repo",
  "worktree_path": "/repo__feature--foo",
  "copied": [
    {"from": "/repo/.env", "to": ".env", "type": "file"},
    {"from": "/Users/me/my/repo/skill-dir", "to": ".claude/skills/skill-dir", "type": "directory"},
    {"from": "/Users/me/secrets/app.env", "to": ".env.shared", "type": "symlink"}
  ],
  "exclude_paths": [".env", ".claude/skills/skill-dir"]
}
```

With no copy configuration, `copied` and `exclude_paths` are empty arrays.

`config explain --json` emits the effective policy and the config layers that matched the
canonical root:

```json
{
  "kind": "config_explain",
  "root": "/repo",
  "matched_rules": [{"root_glob": "~/dev/projects/**"}],
  "project": {"name": "example", "root": "/repo"},
  "add": {"policy": "fresh_canonical"},
  "finish": {
    "enabled": true,
    "strategy": "ff_only",
    "push": false,
    "remove_worktree": false,
    "delete_branch": false
  }
}
```

With no exact project match, `project` is `null`. With no matching root-glob rules,
`matched_rules` is empty.

Successful `finish --json` emits the integrated source, target, strategy, and ordered cleanup
actions that actually ran:

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

Pooled cleanup reports `"recycle_worktree"` instead of `"remove_worktree"`. If push or cleanup
is not enabled, the corresponding action is absent.

### Config

Config is read from `ct-worktrees/trees.toml` under XDG config home. Project entries define
exact canonical roots for bootstrap, pools, copy setup, and exact policy overrides. Policy
configuration also supports defaults and root-glob rules that can affect repositories without
requiring bootstrap setup.

Implemented exact project fields:

| Field | Required | Purpose |
|---|---|---|
| `root` | yes | Canonical root worktree path. |
| `command` | when using pools, copy, or bootstrap setup | Bootstrap command run as the post-create script. Policy-only exact projects may omit it; absent commands emit no bootstrap script. |
| `name` | no | Project identifier; defaults to the basename of `root`. |
| `pool_size` | no | Enables pooled mode with this many fixed slots. |
| `copy_mode_default` | no | `copy` or `symlink`; defaults to `copy` and applies to all copy entries unless overridden. |
| `copy` | no | Files or directories to copy or symlink into created worktrees before `command` runs. |

Policy fields:

| Field | Scope | Purpose |
|---|---|---|
| `[defaults.add].policy` | global defaults | Fallback add policy when no rule or project overrides it. |
| `[defaults.finish]` | global defaults | Fallback finish policy when no rule or project overrides it: `enabled`, `strategy`, `push`, `remove_worktree`, and `delete_branch`. |
| `[[rule]].root_glob` | rule | Canonical root glob to match, with leading `~` expansion only. |
| `[rule.add].policy` | rule | Add policy for matching roots. |
| `[rule.finish]` | rule | Finish policy for matching roots: `enabled`, `strategy`, `push`, `remove_worktree`, and `delete_branch`. |
| `[project.add].policy` | exact project | Exact-root add policy override. |
| `[project.finish]` | exact project | Exact-root finish policy override: `enabled`, `strategy`, `push`, `remove_worktree`, and `delete_branch`. |

Bootstrap scripts run under bash with `WK_ROOT` and `WK_CREATED` exported (see §3).

Example:

```toml
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
copy_mode_default = "copy"
copy = [
  ".env",
  { from = "~/my/repo/skill-dir", to = [".claude/skills/skill-dir", ".pi/agents/skill-dir"] },
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
