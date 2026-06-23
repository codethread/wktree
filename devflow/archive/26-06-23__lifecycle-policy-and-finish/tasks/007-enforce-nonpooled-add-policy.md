# Task 7: Enforce nonpooled add policy

## Scope

Type: AFK

Apply the effective add policy from Task 6 to ordinary non-pooled `wktree add` flows. This slice should preserve the current safe default through `origin_default`, and make `fresh_canonical` fail hard when the canonical default branch cannot be brought up to date before new work starts.

## Must implement exactly

- Use effective add policy resolution from Task 6 inside non-pooled `wktree add`.
- Preserve `origin_default` behavior as the built-in/default policy: fetch `origin`, create new branches from `origin/<default>`, and do not mutate the canonical root.
- Implement `fresh_canonical` for new branches without an explicit non-default `--base`:
  - fetch `origin` first;
  - detect origin's default branch;
  - require the canonical root to be clean;
  - require the canonical root to be checked out on the origin default branch;
  - fast-forward the canonical root to `origin/<default>`;
  - create the new branch from the updated canonical default branch;
  - block the add if any requirement fails.
- For explicit `--base`, fetch first and resolve the requested base deterministically. Do not silently fall back to stale `HEAD`; if the requested base cannot be resolved, fail as a usage/config error as existing base resolution does.
- When `--json` is used, policy blocks must emit `kind: "blocked"` with stable reasons from the spec such as `dirty_canonical`, `wrong_canonical_branch`, or `non_ff_canonical`.
- Preserve rollback behavior if worktree creation succeeds but later setup fails.
- Preserve existing behavior for adding existing local or remote branches except for any policy-required fetch before state detection.

## Done when

- Tests cover `origin_default` creating a new non-pooled worktree from fetched origin default without mutating canonical root.
- Tests cover `fresh_canonical` fast-forwarding a clean canonical default branch before creating a new worktree.
- Tests cover `fresh_canonical` blocking on dirty canonical root with JSON reason `dirty_canonical`.
- Tests cover `fresh_canonical` blocking when canonical root is on the wrong branch with JSON reason `wrong_canonical_branch`.
- Tests cover `fresh_canonical` blocking on non-fast-forward canonical update with JSON reason `non_ff_canonical`.
- Tests cover explicit `--base` still resolving deterministically after fetch.
- `bun test tests` passes.
- `bun run typecheck` passes.

## Out of scope

- Pooled add/allocation policy behavior.
- Nushell wrapper changes.
- `wktree finish`.
- Auto-stash, auto-rebase, merge-conflict resolution, or force-push behavior.

## References

- `../../../specs/git-worktrees.md` sections: Add freshness policy, Safety invariants, Payloads.
- Task 6 effective policy model.
- Existing add behavior and rollback tests in `tests/`.
