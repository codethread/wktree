# Git Worktrees Engine

**Status:** Implemented  
**Last Updated:** 2026-06-16

## 1. Overview

`wktree` is a deterministic local engine for creating, reusing, inspecting, and removing git worktrees. It provides the same lifecycle contract to humans, shell wrappers, tmux workflows, and agents.

Durable state lives in git metadata, filesystem paths, project config, and optional per-repository pool slots. Tmux is a consumer, not a database.

## 2. Goals

- Keep git/worktree lifecycle complexity inside one engine with a small command interface.
- Use deterministic branch, path, and session identity.
- Support human interactive workflows and non-interactive machine workflows with the same engine semantics.
- Reconstruct current state from authoritative sources instead of maintaining a synchronized app database/cache.
- Support opt-in fixed pools for high-cost repositories.
- Surface destructive or ambiguous states with structured data.

## 3. Non-goals

- No durable worktree/session database beyond git/filesystem/config state.
- No tmux resurrection or persistent session registry.
- No requirement that each worktree has a live tmux session.
- No implicit pool expansion.
- No repo-specific bootstrap policy beyond executing configured project commands.

## 4. Design decisions

- **`wktree` owns git/worktree state transitions.** Creation, removal, pool allocation, recycling, safety checks, and bootstrap script generation are centralized to avoid duplicated shell behavior.
- **Tmux is a consumer, not source of truth.** Session identity is emitted for wrappers, but correctness comes from git and filesystem state.
- **Branch/path naming is the coordination spine.** Non-pooled paths are `<canonicalRoot>__<branch encoded with / as -->`; pooled paths are `<canonicalRoot>__featN`; placeholder branches are `wk-pool/featN`.
- **Canonical/root worktree is protected.** It anchors config lookup, sibling path generation, default branch detection, and safety checks.
- **New branches default to origin's default branch/trunk.** This avoids accidental stacked branches when commands are run from another worktree.
- **Pooled worktrees are explicit per-project optimizations.** Pools trade branch-named paths for bounded reusable environments.
- **Pool exhaustion is recoverable and explicit.** Machine consumers receive `pool_full` with candidates; humans can choose a slot interactively.
- **Bootstrap is part of ready-to-work semantics.** Configured commands prepare worktrees/slots and failures are loud.
- **Fresh parsing beats synchronized caches.** Git worktree metadata, filesystem paths, project config, and live tmux state are cheap enough to inspect directly.

## 5. Command contract

Current command surface:

- `wktree root --cwd <path>` prints canonical worktree root.
- `wktree list --cwd <path> [--json]` lists worktrees and initializes configured pools.
- `wktree path --cwd <path> --branch <branch>` prints the worktree path for a branch.
- `wktree add --cwd <path> --branch <branch> [--json] [--slot <path>] [--base <branch>] [--force]` creates or allocates a worktree.
- `wktree remove --cwd <path> (--branch <branch> | --self <path>) [--json] [--force]` removes or recycles a worktree.
- `wktree ensure --cwd <path>` materializes configured pool slots.
- `wktree status --cwd <path>` prints pool status JSON.
- `wktree recycle --cwd <path> --slot <path> [--force]` recycles a pooled slot.

Structured command output rules:

- `--json` writes only structured payloads to stdout.
- stderr contains diagnostics, progress, warnings, and human-readable errors.
- exit `0` means success/ready.
- blocked/recoverable JSON outcomes may use non-zero exit codes.
- consumers branch on `kind`, not stderr text.

Exit codes:

- `0` success / ready
- `10` blocked / recoverable state
- `11` unsafe operation refused without force
- `12` usage or config error
- `130` cancelled
- `1` unexpected runtime or hook failure

Successful add-like payload:

```json
{
  "kind": "ready",
  "worktree_path": "/repo__feature--foo",
  "branch": "feature/foo",
  "root": "/repo",
  "title": "feature/foo",
  "session": {
    "name": "repo__feature--foo",
    "path": "/repo__feature--foo"
  },
  "post_create_script_path": null,
  "created_new_branch": true
}
```

Successful remove-like payload:

```json
{
  "kind": "ready",
  "worktree_path": "/repo__feature--foo",
  "removed": true,
  "session": {
    "name": "repo__feature--foo",
    "path": "/repo__feature--foo"
  }
}
```

Pool-full payloads include recyclable candidates with risk metadata: slot, path, branch, dirty state, ahead count, local-only state, and last commit summary.

## 6. Session identity

Consumers must use the session identity emitted or implied by the engine:

- `session.name = basename(worktree_path).replaceAll(".", "_")`
- `session.path = worktree_path`
- default window/title = branch name

Missing tmux sessions are normal and reconstructable from worktree state.

## 7. Pool semantics

A project with `pool_size` uses fixed reusable slots:

- slot path: `<root>__featN`
- placeholder branch: `wk-pool/featN`
- initialized marker: `wk-pool-initialized` in git metadata

Allocation uses initialized placeholder slots first. Safe recycling refuses dirty slots, branches without upstreams, and branches not merged to upstream. Forced recycling may discard tracked/untracked work and delete the old branch while preserving gitignored files such as dependency directories.

## 8. Bootstrap scripts

Project config is read from `ct-worktrees/trees.toml` under XDG config home. Each project may define `name`, `root`, `command`, and optional `pool_size`.

For add/allocation, `wktree` writes a fresh temporary post-create script under the OS temp directory and returns `post_create_script_path`. The script runs under bash and exports:

- `WK_ROOT` — canonical/root worktree path
- `WK_CREATED` — created worktree or allocated slot path

Human wrappers run returned post-create scripts synchronously before opening/switching to a worktree session. Pool initialization commands run scripts inside `wktree` so initialized slots are actually ready. Newly-created pooled slots are rolled back on bootstrap failure; existing half-initialized slots remain uninitialized until a later successful run.

## 9. Code and tests

Implementation lives in this repository:

- `bin/wktree.ts` — CLI dispatch and engine behavior
- `shared/git/` — git execution and worktree parsers
- `shared/fzf.ts` — interactive picker helper
- `nu/wktree/` — human-facing Nushell wrapper
- `tests/` — engine and wrapper behavior

The tests are the detailed reference for edge cases; this spec captures durable contracts and rationale.
