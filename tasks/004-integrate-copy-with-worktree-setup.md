# Task 4: Integrate copy with worktree setup

## Scope

Type: AFK

Run the completed copy setup path before project bootstrap commands in normal worktree lifecycle flows, so `wktree add`, pooled allocation, and pooled `ensure` all prepare copied files before the configured `command` observes the worktree.

## Must implement exactly

- Run copy setup for non-pooled `wktree add` after the worktree exists and before returning the post-create script path.
- Run copy setup for pooled slot allocation after the slot checks out the requested branch and before returning the post-create script path.
- Run copy setup during pooled `ensure` before the configured command is executed inline for a newly-created or half-initialized slot.
- Preserve the existing behavior where `list` and pooled `remove` trigger pool initialization; because pool initialization now includes copy setup, those commands must also apply copy setup when they initialize absent or half-initialized slots.
- Preserve existing `add --json` payload shape; copy details do not need to be added to `add` payloads.
- Preserve existing pool initialization rollback semantics: if copy setup fails while creating a new pooled slot, remove the in-flight slot; if copy setup fails on an existing half-initialized slot, leave it uninitialized for a later retry.
- Ensure the shared exclude fence is updated as part of each copy-capable setup run.
- Keep stderr/stdout behavior compatible with existing structured output rules.

## Done when

- Tests demonstrate non-pooled `add --json` creates a worktree with copied files present before the returned post-create script is run.
- Tests demonstrate a post-create command can read a copied file in a non-pooled worktree.
- Tests demonstrate pooled `ensure` copies files before running the configured command inside each initialized slot.
- Tests demonstrate `list` applies copy setup when it initializes a missing pooled slot.
- Tests demonstrate pooled `remove` applies copy setup when it initializes a missing or half-initialized slot before resolving the removal target.
- Tests demonstrate pooled allocation copies files after branch checkout and before the returned post-create script is run.
- Tests demonstrate copied destinations are ignored by `git status --porcelain` after setup-triggered copy runs.
- Tests demonstrate copy failure during newly-created pooled slot initialization rolls back that slot.
- Tests demonstrate copy failure on an existing half-initialized slot leaves it present but uninitialized.
- Existing smoke behavior for Nushell `wk add` still passes.
- `bun test tests` passes for the touched behavior.
- `bun run typecheck` passes.

## Out of scope

- Adding copy details to `add` payloads.
- Changing Nushell wrapper flow beyond what is necessary to preserve existing behavior.
- User-facing documentation updates.

## References

- `specs/git-worktrees.md` sections: Bootstrap, Copy setup, Pool semantics.
- Existing tests for non-pooled add, pooled add, and ensure rollback behavior.
- `nu/wktree/` wrapper behavior that runs returned post-create scripts.
