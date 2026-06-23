# Task 11: Add finish push and cleanup

## Scope

Type: AFK

Add configured and flag-driven post-integration actions for `wktree finish`: push the target branch, delete the finished source branch, and remove or recycle the source worktree only after integration and any configured push succeed.

## Must implement exactly

- Support finish config fields `push`, `remove_worktree`, and `delete_branch`.
- Support exact CLI flags `--push`, `--remove-worktree`, and `--delete-branch`; explicit flags enable the corresponding action for that invocation.
- After successful local integration, if push is enabled, push the target branch to its origin/default upstream without force.
- If push is rejected or fails, emit a blocked result with `reason: "push_rejected"` under `--json` and do not delete the branch or remove/recycle the worktree.
- If remove cleanup is enabled, remove or recycle the source worktree only after the chosen finish strategy has successfully integrated the source changes into the target and any configured push has succeeded.
- Use finish-aware cleanup safety rather than upstream-merge safety: a successfully integrated source branch is safe to clean up even for local-only or squash-finished branches, but the source worktree must still be clean and the cleanup must preserve gitignored files such as dependency directories when recycling pooled slots.
- If branch deletion is enabled, delete the finished source branch only after integration and any push succeed, using the finish-aware safety above rather than requiring the branch to be merged to its own upstream.
- Ensure cleanup ordering is deterministic and reported in the success payload.
- Keep no-force-push as a hard invariant.

## Done when

- Tests cover successful finish with push enabled.
- Tests cover push rejection blocking cleanup and preserving the source worktree/branch.
- Tests cover successful non-pooled worktree removal after finish.
- Tests cover successful pooled worktree recycling after finish for a local-only branch without upstream.
- Tests cover successful source branch deletion after squash finish.
- Tests cover cleanup refusal leaving a clear structured blocked payload without force deletion.
- `bun test tests` passes.
- `bun run typecheck` passes.

## Out of scope

- Force push or force cleanup modes.
- Remote branch deletion.
- Pull-request/provider integration.
- Changing existing standalone `wktree remove` safety semantics.

## References

- `../../../specs/git-worktrees.md` sections: Finish lifecycle, Safety invariants, Pool semantics, Payloads.
- Existing `remove` and `recycle` behavior.
- Task 10 finish strategy behavior.
