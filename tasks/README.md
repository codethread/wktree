# AFK Task Plan: wktree lifecycle policy and finish

## Problem statement / MVP goal

Implement the planned `wktree` lifecycle policy work now captured in `specs/git-worktrees.md`: config-driven add freshness, effective policy explanation, and a conservative `wktree finish` flow for integrating completed worktrees back into the canonical root.

MVP completion means a user can set personal defaults such as `~/dev/projects/**` to `fresh_canonical`, keep escape-hatch repositories on `origin_default`, rely on `wktree add` to fail hard instead of building from stale canonical state, inspect effective policy with `wktree config explain`, and finish a clean non-canonical worktree with configured local strategy, optional push, and safe cleanup.

Tasks 1-5 in this plan are historical completed copy-setup tasks and should not be reopened unless a regression blocks the new work. Tasks 6-12 are the active policy/finish implementation plan.

## Important references

- `specs/git-worktrees.md` — durable lifecycle contract, planned policy config, add freshness, finish semantics, commands, payloads, safety rules.
- `specs/README.md` — spec index that must remain accurate as status changes.
- `README.md` — user-facing command/config reference to update after implementation.
- `src/` — TypeScript CLI/engine, config parsing, git execution, and lifecycle behavior.
- `nu/wktree/` — Nushell wrapper behavior that runs returned post-create scripts and should stop owning add freshness directly.
- `tests/` — existing Bun integration and smoke coverage patterns.
- `AGENTS.md` — project-specific development and validation expectations.

## Task strategy

The active slices build vertical behavior in dependency order:

1. Task 6 adds policy parsing/resolution and `wktree config explain` without changing lifecycle behavior.
2. Task 7 applies add policy to ordinary non-pooled worktree creation so `fresh_canonical` becomes real in the simplest end-to-end path.
3. Task 8 extends add policy to pooled paths and removes wrapper-owned freshness so the engine owns the invariant.
4. Task 9 introduces `wktree finish` with one conservative `ff_only` local strategy and all safety gates.
5. Task 10 adds the remaining local merge strategies.
6. Task 11 adds optional push and safe cleanup after successful finish.
7. Task 12 updates user-facing docs and final spec status.

All active slices are AFK. The design choices have been captured in the spec and conversation: no background sync daemon, no auto-commit, no force push, no provider/PR workflow, and no automatic conflict resolution.

## Developer Notes

Append notes here. Do not rewrite earlier notes.

### Task plan amendment: lifecycle policy and finish — 2026-06-22

- Added Tasks 6-12 to implement the newly planned policy config, strict add freshness, and conservative `wktree finish` flow from `specs/git-worktrees.md`.
- Existing Tasks 1-5 remain complete historical copy-setup work and should not be rewritten.
- Active plan intentionally keeps daemon sync, auto-commit, force-push, PR/provider workflow, and automatic conflict resolution out of scope.

### Task plan review amendments — 2026-06-22

- Task 6 now explicitly owns the full finish policy schema, field-by-field merge behavior, and `config explain` output for `enabled`, `strategy`, `push`, `remove_worktree`, and `delete_branch`.
- Task 11 now uses finish-aware cleanup safety so local-only and squash-finished branches can be cleaned up after successful integration without weakening standalone `wktree remove` safety rules.
- Finish cleanup flags are pinned as `--push`, `--remove-worktree`, and `--delete-branch`, and the spec command table was aligned.

### Alignment fix-forward — 2026-06-22

- After implementation review, `fresh_canonical` was clarified to enforce canonical default-branch freshness only for default-base adds. Explicit `--base` remains an intentional stacked/non-default workflow: it fetches and resolves deterministically without requiring or mutating the canonical default branch.
- `finish --remove-worktree` cleanup now kills the tmux session for the source path, matching standalone recycle/remove cleanup expectations.

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

### Task 6 implementation notes — 2026-06-22

- Added policy parsing for defaults, root-glob rules, and exact project overrides, with field-by-field finish policy merging and `wktree config explain` JSON output.
- Exact project entries can now omit `command` only when they are policy-only; pools/copy/bootstrap setup still require a command.
- Root glob matching intentionally supports only leading `~/` expansion plus simple `*`/`**` matching; no environment or shell expansion was added.

### Task 7 implementation notes — 2026-06-22

- Non-pooled `add` now resolves the effective add policy before branch-state detection and always fetches origin first.
- `origin_default` intentionally uses `origin/<default>` as the start point for new branches so fetched remote default commits are used without advancing the canonical root.
- `fresh_canonical` blocks before worktree creation when the canonical root is dirty, on the wrong branch, or cannot fast-forward; JSON reasons are `dirty_canonical`, `wrong_canonical_branch`, and `non_ff_canonical`.

### Task 8 implementation notes — 2026-06-22

- Pooled `add` now resolves add freshness before pool initialization/recycle/allocation, so `fresh_canonical` failures stop before an occupied slot can be recycled.
- Pooled new branches share the non-pooled base selection: `fresh_canonical` fast-forwards canonical root and starts from the default branch; `origin_default` starts from `origin/<default>` without mutating canonical root.
- The Nushell wrapper no longer owns `--latest`/`git pull --ff-only`; freshness behavior is engine/config driven for both human and agent entry points.

### Task 9 implementation notes — 2026-06-22

- Added `finish --cwd <path> [--json] [--strategy ff_only]` as a local-only fast-forward integration from a clean non-canonical source worktree into the canonical default branch.
- Finish now fetches `origin`, blocks disabled policy before integration, refuses canonical-root and dirty-source invocations, and emits structured blocked reasons for `dirty_worktree`, `target_not_fresh`, and `conflict`.
- For `fresh_canonical`, finish reuses canonical freshness checks and fast-forwards the canonical root before integration; for `origin_default`, the target root must already be clean, on the default branch, and not behind `origin/<default>`.

### Task 10 implementation notes — 2026-06-22

- Finish now accepts `ff_only`, `squash`, `merge_commit`, and `rebase_ff` from config or `--strategy`, with the CLI strategy taking precedence.
- `squash` uses a fixed `finish: <source_branch>` commit message; `merge_commit` forces an explicit merge commit; `rebase_ff` rebases the source worktree then fast-forwards the canonical target.
- Conflict or failed strategy commands surface as structured `reason: "conflict"` under `--json`; push and cleanup remain untouched for Task 11.

### Task 11 implementation notes — 2026-06-22

- `finish` now accepts config/flag enabled push, source worktree removal or pooled recycle, and source branch deletion, with deterministic `cleanup_actions` in ready JSON payloads.
- Push uses a normal `git push origin <target_branch>` and maps any rejection/failure to `reason: "push_rejected"`; cleanup is skipped when push fails.
- Finish cleanup intentionally uses a separate integrated-branch safety path from standalone `remove`/`recycle`: the source must still be clean, but local-only and squash-finished branches can be removed/recycled after successful integration.
- Branch deletion currently requires worktree cleanup in the same finish invocation because Git refuses deleting a branch still checked out in a linked worktree; attempting deletion alone returns a structured unsafe blocked payload before integration.

### Task 12 implementation notes — 2026-06-22

- User-facing README now covers add policy resolution, `fresh_canonical` failure behavior, `origin_default`, finish strategies, push, cleanup, and wrapper ownership boundaries.
- The root worktree spec status is back to `Implemented`; the spec index now describes finish as implemented rather than planned.
