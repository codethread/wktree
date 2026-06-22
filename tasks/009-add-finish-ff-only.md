# Task 9: Add finish ff-only flow

## Scope

Type: AFK

Add the first usable `wktree finish` vertical slice: a conservative local `ff_only` integration from a non-canonical source worktree into the canonical root. This slice should establish command shape, safety checks, structured blocked results, and one complete strategy without push or cleanup options.

## Must implement exactly

- Add `wktree finish --cwd <path> [--json] [--strategy ff_only]` to dispatch and Commander help.
- Resolve the source worktree and canonical root from `--cwd`.
- Respect effective finish policy `enabled = false` by blocking before integration; with `--json`, emit `kind: "blocked"` and `reason: "blocked"` with a message that finish is disabled for this repository.
- Refuse to run from the canonical root; with `--json`, emit `kind: "blocked"` and `reason: "canonical_root"`.
- Require the source worktree to be clean before integration; with `--json`, emit `reason: "dirty_worktree"` when blocked.
- Fetch `origin` before integration.
- Require the canonical root/target branch to satisfy the effective add policy freshness requirements before integration; use `target_not_fresh` or the more specific canonical policy reason when blocked.
- Determine the target branch as origin's default branch for this MVP.
- Implement `ff_only` by moving the target branch only when it can fast-forward to the source branch.
- Stop without modifying the target when fast-forward is impossible; with `--json`, emit a blocked result with `reason: "conflict"` or `target_not_fresh` as appropriate.
- Emit a successful JSON payload containing at least `kind: "ready"`, `root`, `worktree_path`, `source_branch`, `target_branch`, and `strategy`.

## Done when

- Tests cover `enabled = false` refusing finish before integration, with JSON `kind: "blocked"` and a message that finish is disabled.
- Tests cover canonical-root refusal.
- Tests cover dirty source worktree refusal.
- Tests cover target freshness enforcement before integration.
- Tests cover successful `ff_only` integration moving the canonical default branch to the source branch.
- Tests cover non-fast-forward `ff_only` refusal without target modification.
- Command help/snapshots are updated if applicable.
- `bun test tests` passes.
- `bun run typecheck` passes.

## Out of scope

- `squash`, `merge_commit`, or `rebase_ff` strategies.
- Push, branch deletion, worktree remove/recycle cleanup.
- Conflict resolution.
- Running project bootstrap or copy setup.

## References

- `specs/git-worktrees.md` sections: Finish lifecycle, Commands, Payloads, Config.
- Task 6 effective finish policy parsing.
- Existing remove/recycle safety checks for source worktree cleanliness patterns.
