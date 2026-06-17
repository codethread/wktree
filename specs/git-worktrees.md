# Git Worktrees Engine

**Status:** Partial  
**Last Updated:** 2026-06-17

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
- Surface destructive or ambiguous states with structured data.

### Non-Goals

- No durable worktree/session database beyond git/filesystem/config state.
- No tmux resurrection or persistent session registry.
- No requirement that each worktree has a live tmux session.
- No implicit pool expansion.
- No repo-specific bootstrap policy beyond deterministic copy setup and executing configured project commands.
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

A project's optional `copy` configuration copies local files or directories into a target
worktree. Copy entries are deterministic and rerunnable:

- String entries are relative paths copied from the canonical root to the same relative path
  in the target worktree.
- Object entries use `from` and `to`; `from` may be relative to the canonical root, absolute,
  or start with `~`, while `to` is always relative to the target worktree.
- `to` may be a string or array of strings. Each destination is the exact final file or
  directory path, not a parent directory for nesting the source basename.
- Only leading `~` expands. Globs, environment variables, and shell interpolation are not
  supported.
- Missing sources, absolute destinations, and destinations that overlap tracked files fail
  loudly.
- Each destination path is fully engine-managed. Reruns delete the existing destination path
  before copying, then recreate it from the source, so removed source files do not leave
  stale copied files behind. This may delete untracked local additions under a copied
  directory; tracked files or tracked descendants still block the operation.

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
  "created_new_branch": true
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
enumerated machine token — `duplicate_branch`, `dirty_slot`, `unmerged_branch`,
`canonical_root`, `unsafe`, or `blocked` — and `message` is human-readable. Optional
`branch`, `worktree_path`, and `slot_path` are included when known:

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
    {"from": "/Users/me/my/repo/skill-dir", "to": ".claude/skills/skill-dir", "type": "directory"}
  ],
  "exclude_paths": [".env", ".claude/skills/skill-dir"]
}
```

With no copy configuration, `copied` and `exclude_paths` are empty arrays.

### Config

Project config is read from `ct-worktrees/trees.toml` under XDG config home. Each project
entry may define:

| Field | Required | Purpose |
|---|---|---|
| `root` | yes | Canonical root worktree path. |
| `command` | yes | Bootstrap command run as the post-create script. |
| `name` | no | Project identifier; defaults to the basename of `root`. |
| `pool_size` | no | Enables pooled mode with this many fixed slots. |
| `copy` | no | Files or directories to copy into created worktrees before `command` runs. |

Bootstrap scripts run under bash with `WK_ROOT` and `WK_CREATED` exported (see §3).

Example:

```toml
[[project]]
name = "example"
root = "~/dev/example"
command = "bun install"
copy = [
  ".env",
  { from = "~/my/repo/skill-dir", to = [".claude/skills/skill-dir", ".pi/agents/skill-dir"] },
]
```
