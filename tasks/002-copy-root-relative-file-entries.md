# Task 2: Copy root-relative file entries

## Scope

Type: AFK

Implement the first complete copy behavior for string entries such as `copy = [".env"]`: parse and execute root-relative file copies from the canonical root into the target non-canonical worktree, update the canonical shared exclude fence, and report copied files in `wktree copy --json`.

## Must implement exactly

- Replace Task 1's temporary `copy`-field rejection with parsing that accepts string entries only.
- Treat a string copy entry as a relative source path under the canonical root and the same relative destination path under the target worktree.
- Reject object-form entries clearly in this interim slice; Task 3 will add object execution.
- Reject string entries that are absolute paths, start with `~`, are empty, or escape the intended relative-path contract.
- Fail loudly when the source file is missing or is not a regular file for this slice.
- Before replacing a destination, refuse if that destination path is tracked by git in the target worktree.
- Replace existing untracked or ignored destination files deterministically.
- Write all string-entry destination paths once to the canonical repository shared exclude file inside an idempotent fenced block:
  - `# wktree-start`
  - sorted or otherwise deterministic destination paths with no leading slash
  - `# wktree-end`
- Preserve content outside the fenced block.
- Remove any previous fenced block when there are no configured copy destinations.
- Follow symlinks for the real exclude file path.
- Include copied file entries in the JSON payload with absolute `from`, relative `to`, and `type: "file"`.

## Done when

- Tests demonstrate `wktree copy --json` copies `.env` from the canonical root to a non-canonical worktree and returns the expected payload.
- Tests demonstrate rerunning `wktree copy` replaces an untracked destination file with the current source contents.
- Tests demonstrate a tracked destination file blocks with exit code `11`; with `--json`, it emits `kind: "blocked"` and `reason: "unsafe"`, and leaves the tracked file intact.
- Tests demonstrate invalid string paths and missing sources fail as usage/config errors with exit code `12` and no structured stdout payload, even with `--json`.
- Tests demonstrate object-form entries are rejected clearly until Task 3 implements them.
- Tests demonstrate the canonical shared exclude fence is idempotent and preserves unrelated exclude content.
- Tests demonstrate removing `copy` from config and rerunning `wktree copy` removes the fenced block.
- Tests demonstrate copied destinations are ignored by `git status --porcelain` in the linked target worktree.
- `bun test tests` passes for the touched behavior.
- `bun run typecheck` passes.

## Out of scope

- Object-form copy entries.
- Directory copy.
- Multi-target destinations.
- Integration with `add`, pooled allocation, or `ensure`.
- Documentation updates.

## References

- `specs/git-worktrees.md` sections: Copy setup, Structured output rules, Payloads.
- Existing tests around real temporary git repositories and config helpers.
