# Task 10: Add finish merge strategies

## Scope

Type: AFK

Extend `wktree finish` beyond `ff_only` by implementing the remaining planned local integration strategies: `squash`, `merge_commit`, and `rebase_ff`. The command should remain conservative, non-interactive, and local-only in this slice.

## Must implement exactly

- Support strategy selection from effective finish config and from `--strategy <strategy>` when provided; the explicit CLI strategy wins over config.
- Implement `squash` by applying source branch changes onto the target branch as one deterministic commit.
- Use a deterministic non-interactive squash commit message of `finish: <source_branch>` unless an existing project convention in the codebase already defines finish messages.
- Implement `merge_commit` by merging the source branch into the target branch with an explicit merge commit.
- Implement `rebase_ff` by rebasing the source branch onto the target branch, then fast-forwarding the target branch to the rebased source.
- Preserve the existing `ff_only` behavior from Task 9.
- Stop on conflicts without attempting automatic resolution; with `--json`, emit `kind: "blocked"` and `reason: "conflict"`.
- Ensure failed strategy attempts do not remove/recycle worktrees or push anything.

## Done when

- Tests cover successful `squash` integration producing one target commit with the deterministic message.
- Tests cover successful `merge_commit` integration producing a merge commit.
- Tests cover successful `rebase_ff` integration rebasing source then fast-forwarding target.
- Tests cover conflict refusal for at least one non-ff strategy with structured JSON.
- Tests confirm CLI `--strategy` overrides configured finish strategy.
- `bun test tests` passes.
- `bun run typecheck` passes.

## Out of scope

- Push, branch deletion, worktree remove/recycle cleanup.
- User-customized commit message templates.
- Provider/PR integration.
- Automatic conflict resolution.

## References

- `specs/git-worktrees.md` sections: Finish lifecycle and Config.
- Task 9 `wktree finish` command shape and safety checks.
