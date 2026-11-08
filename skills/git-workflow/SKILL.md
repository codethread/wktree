---
name: git-workflow
description: Manage Git worktrees with Wktree, including pooled slot allocation and cleanup.
---

Use the application's Wktree policy to manage worktrees. Read `wktree -h` for command discovery and focused command help before mutations.

- Reuse the task's existing worktree; create one when needed.
- Prefer `--json` where supported; use structured results rather than parsing messages.
- Run noninteractively: use `list`/`path` for discovery, without `--interactive`.
- Use `wktree config explain --json` when you need to inspect effective repository policy.

Read [Pooled slots](references/pooled-slots.md) only for pool allocation, recycling or repair, or when `add` returns `pool_full`. Retrieve that reference with `wktree skills file git-workflow references/pooled-slots.md`.
