# Task 1: Add copy config and command skeleton

## Scope

Type: AFK

Add the public command skeleton for copy setup without accepting copy entries or implementing actual file copying yet. The completed slice should expose `wktree copy --cwd <path> [--json]`, preserve valid projects that omit `copy`, and return a deterministic empty ready payload when no copy entries are configured.

## Must implement exactly

- Preserve the existing requirement that `command` is required.
- Keep projects that omit `copy` valid and behavior-compatible with the current config contract.
- If a `copy` field is present in this slice, fail loudly with a config/usage error explaining that copy entries are not implemented yet; later tasks will replace this temporary rejection with real parsing and execution. Do not silently ignore `copy`.
- Add the `copy` subcommand to the same dispatch and Commander paths as existing commands.
- Require `--cwd <path>` for `wktree copy` and support optional `--json`.
- Resolve the canonical root and target worktree containing `cwd`.
- Refuse canonical-root targets with exit code `11`; with `--json`, return `kind: "blocked"` and `reason: "canonical_root"`.
- For non-canonical targets with no configured copy entries, return success; with `--json`, emit `kind: "ready"`, `root`, `worktree_path`, `copied: []`, and `exclude_paths: []`.
- Update command usage/help text to include `copy`.

## Done when

- Unit tests cover projects with no `copy` field still parse as before.
- Unit tests cover a present `copy` field failing loudly instead of being ignored in this interim slice.
- Integration tests cover `wktree copy --cwd <non-canonical> --json` with no copy config and canonical-root refusal with JSON.
- `bun test tests` passes for the touched behavior.
- `bun run typecheck` passes.

## Out of scope

- Actual filesystem copying.
- Shared exclude file updates.
- Integration with `add`, pooled allocation, or `ensure`.
- README updates beyond any test snapshots or command help directly required by this slice.

## References

- `specs/git-worktrees.md` sections: Copy setup, Commands, Payloads, Config.
- `AGENTS.md` command and structured output guidance.
