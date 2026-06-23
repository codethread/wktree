# Task 8: Apply add policy to pools and wrapper

## Scope

Type: AFK

Extend add policy enforcement to pooled allocation paths and remove wrapper-owned freshness behavior so the engine is the single source of truth for add-time policy.

## Must implement exactly

- Apply the same effective add policy used by non-pooled add to pooled `wktree add` allocation before a slot checks out or creates the requested branch.
- For `fresh_canonical`, require the canonical root to be clean, checked out on the origin default branch, and fast-forwarded before allocating or checking out a slot for new work.
- For `origin_default`, preserve the current pooled behavior of fetching and creating/checking out branches from fetched origin state without mutating canonical root.
- Ensure policy failures occur before a pooled slot is destructively recycled or repurposed.
- Preserve pool initialization semantics and rollback behavior for setup failures.
- Remove the Nushell wrapper's direct `git pull --ff-only` freshness implementation; direct `wktree` engine behavior must own freshness for humans and agents.
- Update Nushell wrapper help/parameters so it no longer advertises a wrapper-only `--latest` mode unless an engine-level override exists in this slice.
- Keep `wk add` running returned post-create scripts and opening/switching sessions exactly as before.

## Done when

- Tests cover `fresh_canonical` blocking before pooled slot allocation when canonical root is dirty.
- Tests cover `fresh_canonical` fast-forwarding canonical root before pooled branch checkout/allocation.
- Tests cover policy failure not modifying or recycling an occupied pooled slot.
- Existing pool initialization and allocation tests still pass.
- Nushell module syntax checks pass for touched module files.
- `bun test tests` passes.
- `bun run typecheck` passes.
- `bun run check` passes.

## Out of scope

- Adding a new CLI flag to override configured policy per invocation.
- `wktree finish`.
- Changing tmux session identity or navigation behavior.
- Background sync or automatic pushes.

## References

- `../../../specs/git-worktrees.md` sections: Add freshness policy, Pool semantics, Bootstrap.
- `README.md` Nushell wrapper section.
- `AGENTS.md` Nushell validation commands.
