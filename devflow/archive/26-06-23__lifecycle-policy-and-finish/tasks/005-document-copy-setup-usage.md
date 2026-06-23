# Task 5: Document copy setup usage

## Scope

Type: AFK

Update user-facing documentation and final validation for the implemented copy setup feature, keeping the durable spec aligned with shipped behavior.

## Must implement exactly

- Update the README project configuration section to document optional `copy` entries, including:
  - string entries for root-relative files
  - object entries with `from` and string or array `to`
  - leading `~` expansion for sources
  - destination paths relative to the created worktree
  - copy runs before the configured command
- Update the CLI quick reference to include `wktree copy --cwd <path> [--json]`.
- Add or update an example TOML snippet that demonstrates `.env` and the skill-directory multi-target example.
- Review `../../../specs/git-worktrees.md` against the final implementation. Change the document-level status back to `Implemented` only if the entire spec now matches implementation reality; otherwise leave it unchanged and make any copy-specific status/wording accurate without overstating unrelated areas.
- Keep docs concise and avoid implementation-plan details.

## Done when

- README documents copy setup and the explicit `wktree copy` command.
- The durable spec status and copy-specific wording accurately reflect implementation reality without overstating unrelated areas.
- `bun test tests` passes.
- `bun run typecheck` passes.
- `bun run check` passes.
- Nushell module syntax checks pass for the existing module files if they were touched.

## Out of scope

- Implementing missing copy behavior; earlier tasks should complete that.
- Adding new product semantics beyond the current spec.
- Creating extra speculative future-work tasks.

## References

- `README.md` project configuration and CLI quick reference sections.
- `../../../specs/git-worktrees.md`.
- `AGENTS.md` validation commands.
