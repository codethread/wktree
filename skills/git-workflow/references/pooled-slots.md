# Pooled slots

A **worktree pool** has fixed slots whose directories remain as working branches change. A **placeholder branch** marks a slot without a working branch; the canonical worktree is separate.

Use the paths returned by Wktree, not paths inferred from branch names: a branch can occupy any available slot.

## Inspect and allocate

Use `wktree status` for configured slots, including missing ones; `list` shows registered worktrees. Read `add --help` to allocate a slot. Use `ensure --help` only for whole-pool preparation or repair: `add` prepares its selected slot itself.

## Recycle rather than delete

Recycle through `wktree remove` or configured `finish` cleanup so Wktree retains the slot directory and manages its placeholder branch. Read `remove --help` for branch-retention options and safety checks.

## When the pool is full

A `pool_full` result reports occupied candidates. Inspect their state with `status`; a clean checkout is not proof that another task has finished using it.

Proactively recycle a checkout without asking again when its work is complete (for example, merged) and no active task still uses it. If either condition is unclear, confirm before recycling. Then retry `add`. If none can be released, report the capacity blocker rather than forcing reuse or creating an unmanaged extra slot.
