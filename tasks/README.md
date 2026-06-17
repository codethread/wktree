# AFK Task Plan: wktree copy setup

## Problem statement / MVP goal

Implement the planned `copy` project configuration for `wktree`: optional per-project file/directory copy setup that runs before project bootstrap commands, can be rerun with `wktree copy --cwd <path> [--json]`, refuses unsafe tracked destinations, and keeps the canonical shared exclude file in sync through an idempotent fenced block.

MVP completion means a user can configure root-relative file copies, object-form absolute/`~`/relative sources, multiple relative destinations, directory copies with deterministic replacement, and then rely on `wktree add`, pooled `ensure`/allocation, and explicit `wktree copy` to apply the same setup behavior.

## Important references

- `specs/git-worktrees.md` — durable copy setup contract, command payloads, config shape, safety rules.
- `README.md` — user-facing command/config reference to update after implementation.
- `bin/` — TypeScript CLI/engine entry point and config parsing patterns.
- `nu/wktree/` — Nushell wrapper behavior that runs returned post-create scripts.
- `tests/` — existing Bun integration and smoke coverage patterns.
- `AGENTS.md` — project-specific development and validation expectations.

## Task strategy

The slices build a thin path first, then expand behavior without leaving ambiguous integration gaps:

1. Add copy config parsing and the explicit `wktree copy` command skeleton so the public API exists and no-copy projects have a deterministic response.
2. Add the first real end-to-end copy behavior for root-relative file entries, including shared exclude updates and tracked-target refusal.
3. Extend the same engine path to object entries, multi-target destinations, `~` source expansion, directory copy, and deterministic replacement.
4. Wire the copy engine into normal worktree setup flows before post-create commands, covering non-pooled and pooled behavior.
5. Update user-facing docs and final verification once behavior is implemented.

All slices are AFK. Product decisions have already been captured in the spec; no HITL decision task is required for the MVP.

## Developer Notes

Append notes here. Do not rewrite earlier notes.

### Task plan review amendments — 2026-06-17

- Task 1 now rejects any present `copy` field instead of accepting syntax that is not executable yet.
- Task 2 owns string-entry parsing/execution and keeps object entries explicitly rejected until Task 3.
- Task 2 includes exclude cleanup for removed copy config and an assertion that copied paths are actually ignored in linked worktrees.
- Task 3 promotes invalid object/destination/source and unsupported-expansion guardrails into acceptance criteria.
- Task 4 explicitly covers copy setup through `list` and pooled `remove` because those commands can initialize pool slots.
- Task 5 now cautions against changing the whole spec status unless the whole spec matches implementation reality.
- Copy failure semantics were pinned down after cohesion review: malformed copy config, invalid paths, and missing sources are usage/config failures with exit code 12 and no structured stdout payload; tracked destination overlap is an unsafe blocked JSON outcome with exit code 11.

### Task 1 implementation notes — 2026-06-17

- The interim parser rejects any present `copy` field at config-load time with a `ConfigError`; later copy-entry slices should replace this boundary rejection with real parsing.
- The `copy` skeleton resolves the target from `git worktree list --porcelain` by longest containing path, refuses the canonical root with the existing unsafe blocked JSON path, and emits an empty ready payload for non-canonical worktrees.

### Task 2 implementation notes — 2026-06-17

- String copy entries now parse into file copy operations; object-form entries remain an explicit `ConfigError` for Task 3.
- Root-relative file copying updates the canonical shared exclude fence on every `wktree copy`, including fence removal when no copy destinations remain.
- Destination tracked-file checks currently use exact `git ls-files --error-unmatch -- <path>`, which matches this slice's file-only destination contract; Task 3 should revisit descendant overlap for directories.

### Task 3 implementation notes — 2026-06-17

- Copy entries now normalize to `{ from, to[] }` internally so string and object forms share one execution path.
- Object `from` values intentionally expand only leading `~`; env-var/glob-looking names are literal filesystem paths.
- Directory destinations are treated as exact managed paths and are deleted/recreated on rerun after a git tracked-descendant preflight.
- Exclude paths are de-duplicated and sorted for the JSON payload and shared exclude fence.
- Deep review follow-up tightened destination handling: leading-`~` destinations are rejected, tracked ancestor paths fail as unsafe blocked outcomes, and file copies now use filesystem copy semantics to preserve modes.

### Task 4 implementation notes — 2026-06-17

- Worktree lifecycle paths now run the same copy setup engine before returning post-create scripts for non-pooled add and pooled allocation.
- Pooled ensure runs copy setup inside the existing initialization rollback boundary before invoking the configured command, so list/remove-triggered initialization inherits the same behavior.
- Existing explicit `wktree copy` tests that intentionally exercise invalid copy config now create the worktree before installing invalid copy config, because normal add setup now fails loudly on those same invalid configurations.

### Task 5 implementation notes — 2026-06-17

- README now documents copy config forms, destination relativity, leading-`~` source expansion, setup ordering, and explicit `wktree copy` usage.
- The durable spec status was moved back to `Implemented` after final validation confirmed the documented copy behavior is covered by the current implementation and tests.
