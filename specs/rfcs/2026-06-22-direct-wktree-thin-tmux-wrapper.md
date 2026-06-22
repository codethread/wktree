# RFC: Direct `wktree` with a thin tmux wrapper

**Status:** Draft
**Created:** 2026-06-22
**Last Updated:** 2026-06-22
**Driver:** Unknown
**Related:** [`../git-worktrees.md`](../git-worktrees.md), [`../../README.md`](../../README.md), [`../../nu/wktree/mod.nu`](../../nu/wktree/mod.nu), [`../../nu/wktree/tmux.nu`](../../nu/wktree/tmux.nu), [`../../src/main.ts`](../../src/main.ts), [`../../src/hooks.ts`](../../src/hooks.ts)

## 1. Summary

`wktree` should become directly usable as the complete lifecycle command for creating, preparing, inspecting, and removing worktrees. The existing Nushell `wk` wrapper should be reduced to an optional tmux/shell user-interface layer rather than owning lifecycle correctness.

The recommended direction is to move non-pooled add bootstrap execution and rollback into the TypeScript engine first. After that, `wk` can be simplified to open, close, and switch tmux sessions around structured `wktree` payloads, or users can replace it with their own tmux bindings.

## 2. Problem / Opportunity

The Nushell wrapper was originally useful because worktree lifecycle and tmux integration were intertwined in the dotfiles workflow. The engine has since grown to own deterministic paths, pools, copy setup, command payloads, safety checks, pool recycling, and session identity.

However, direct `wktree add` is not yet equivalent to `wk add`: the engine returns a `post_create_script_path` for project commands, while the wrapper runs that script and rolls back if it fails. This creates a split-brain contract where direct CLI users may receive `kind: "ready"` before the configured bootstrap command has actually succeeded.

## 3. Goals and Non-Goals

### Goals

- Make direct `wktree` lifecycle commands safe and complete for humans, agents, and scripts.
- Ensure `wktree add` reports `ready` only after required copy setup and project bootstrap have succeeded.
- Keep tmux as a consumer of emitted session/path metadata, not a correctness dependency.
- Reduce Nushell code to optional interactive shell/tmux ergonomics.
- Preserve structured JSON contracts for machine consumers.

### Non-Goals

- Do not make tmux a source of truth or required runtime dependency for `wktree`.
- Do not port every Nushell convenience into the engine immediately.
- Do not implement planned `finish` or policy configuration as part of this RFC.
- Do not define a general shell integration framework for changing parent-shell directories.

## 4. Context

The durable worktree spec says `wktree` owns git/worktree state transitions and that tmux is a consumer, not a database. It also says bootstrap is part of ready-to-work semantics.

Current TypeScript behavior already owns most lifecycle work:

- worktree add/remove/recycle/pool allocation;
- copy setup before configured commands;
- pool initialization, including in-engine hook execution;
- JSON payloads with `kind`-based branching;
- session identity derived from worktree paths;
- interactive pool slot selection for non-JSON CLI usage.

Current Nushell behavior still owns:

- running returned post-create scripts for normal add/allocation;
- rollback after post-create failure;
- `wk add --self` and `wk add --latest` conveniences;
- tmux open/close behavior;
- `wk switch` worktree picker UI;
- parent-shell `cd` behavior outside tmux.

## 5. Proposal

Move lifecycle-critical bootstrap execution into the engine. For add/allocation, `wktree` should run the configured project command through the existing hook runner and perform rollback if the command fails. A successful `ready` payload should mean the worktree is actually prepared for use.

After this change, treat Nushell as an optional tmux adapter:

- `wk add` delegates to `wktree add`, then opens the emitted session/path.
- `wk remove` delegates to `wktree remove`, then closes matching tmux sessions.
- `wk switch` remains a shell/tmux UI over `wktree list --json` unless a future RFC decides to add a native switch command.

Engine-level conveniences may be added when they are shell-independent. `add --self` is a plausible engine flag because it resolves the current branch as a base. `--latest` should preferably be replaced by the planned add freshness policy rather than preserved as wrapper-only behavior.

## 6. Alternatives Considered

| Option | Pros | Cons | Notes |
| --- | --- | --- | --- |
| Do nothing / keep current behavior | No migration cost; current `wk` workflow works; clear human wrapper remains available | Direct `wktree add` can report ready before bootstrap runs; lifecycle rollback is split across TypeScript and Nushell; custom non-Nushell integrations must reimplement hook execution | Baseline |
| Delete Nushell wrapper now | Forces one command surface; removes Nushell maintenance | Breaks or regresses post-create execution, rollback, tmux navigation, `wk switch`, and parent-shell `cd`; current smoke tests depend on wrapper behavior | Not recommended |
| Move all tmux behavior into TypeScript | Single binary for human UX; no Nushell dependency | Couples engine to tmux presentation concerns; contradicts tmux-as-consumer design; still cannot change parent shell cwd | Not recommended now |
| Make engine lifecycle-complete and keep thin `wk` | Direct `wktree` becomes safe; wrapper shrinks to tmux/shell ergonomics; custom bindings are easy | Requires engine contract change and test migration; two commands remain for users who want tmux UX | Recommended |
| Keep wrapper but document it as required for humans | Low implementation cost | Preserves split-brain lifecycle semantics; makes `wktree` less useful directly despite engine goals | Acceptable only as short-term documentation |

## 7. Impact and Risks

- User impact: direct `wktree add` becomes safer and more intuitive; `wk` remains available for tmux workflows.
- Machine-consumer impact: consumers that currently expect to run `post_create_script_path` themselves may need a compatibility path or updated contract.
- Maintenance impact: lifecycle rollback logic consolidates in TypeScript; Nushell becomes smaller and easier to replace.
- Compatibility risk: changing when hooks run may alter timing, output, and failure behavior for `--json` callers.
- Mitigation: preserve JSON cleanliness by streaming hook progress to stderr, update specs/tests together, and consider an explicit flag only if existing consumers need script-return behavior.

## 8. Open Questions

- Should `wktree add --json` always run project bootstrap before emitting `ready`, or should there be an explicit opt-out for callers that want to run the script themselves?
- Should `post_create_script_path` remain in the payload as diagnostic/compatibility data after engine-run hooks, or be removed from the public contract in a later breaking change?
- Should `add --self` be added to the engine now, or left as wrapper-only sugar?
- Should `--latest` be removed in favor of the planned freshness policy, and is that policy a prerequisite for simplifying the wrapper?
- Is `wk switch` valuable enough to keep indefinitely as Nushell/tmux UI, or should a future proposal consider a native `wktree switch`?

## 9. Decision

Pending while Draft.
