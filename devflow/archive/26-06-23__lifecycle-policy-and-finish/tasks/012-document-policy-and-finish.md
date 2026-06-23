# Task 12: Document policy and finish

## Scope

Type: AFK

Update user-facing documentation and final spec status for policy-driven add behavior and the implemented `wktree finish` flow.

## Must implement exactly

- Update README CLI quick reference for `wktree config explain` and `wktree finish`.
- Update README project configuration examples to show `[defaults.add]`, `[[rule]] root_glob`, `[rule.add]`, `[rule.finish]`, and exact `[[project]]` overrides.
- Document `fresh_canonical` and `origin_default` in user-facing language, including the fact that `fresh_canonical` fails hard instead of falling back to stale canonical state.
- Document `finish` safety requirements, supported strategies, push behavior, and cleanup behavior.
- Update Nushell wrapper documentation if wrapper flags or behavior changed.
- Review `../../../specs/git-worktrees.md` against the final implementation. Change the document-level status back to `Implemented` only if the whole spec matches implementation reality; otherwise keep `Partial` and make any feature-specific wording accurate.
- Keep documentation concise and avoid implementation-plan details.

## Done when

- README documents policy config, root-glob defaults, exact project overrides, and finish usage.
- `../../../specs/git-worktrees.md` accurately reflects implemented behavior and status.
- `../../../specs/README.md` remains accurate.
- `bun test tests` passes.
- `bun run typecheck` passes.
- `bun run check` passes.
- Nushell module syntax checks pass for touched module files.

## Out of scope

- Implementing missing policy or finish behavior.
- Adding new strategies or config fields beyond the spec.
- Creating background sync/daemon documentation.

## References

- `README.md` CLI quick reference, Nushell wrapper, and project configuration sections.
- `../../../specs/git-worktrees.md`.
- `../../../specs/README.md`.
- `AGENTS.md` validation commands.
