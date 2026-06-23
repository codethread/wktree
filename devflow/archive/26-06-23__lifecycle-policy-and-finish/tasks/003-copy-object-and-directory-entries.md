# Task 3: Copy object and directory entries

## Scope

Type: AFK

Extend the copy engine from root-relative file strings to the full configured union: object entries with relative, absolute, or leading-`~` sources; string or array destinations; and file or directory sources copied to exact final destination paths.

## Must implement exactly

- Replace Task 2's temporary object-entry rejection with parsing and execution for object entries.
- Resolve object `from` values according to the spec:
  - relative paths resolve against the canonical root
  - absolute paths are used as-is
  - leading `~` expands to the user's home directory
  - no environment variables, globs, or shell interpolation are expanded
- Require every object `to` value to be relative to the target worktree; reject absolute, `~`, empty, or escaping destinations.
- Support `to` as either a single string or an array of strings.
- Copy regular files and directories.
- Treat every `to` as the exact final destination path, never as a parent path that implicitly appends the source basename.
- For directory destinations, delete the existing destination tree before copying, then recreate it from the source.
- Refuse to replace a destination if the destination itself or any descendant under a directory destination is tracked by git in the target worktree.
- De-duplicate exclude paths across all string/object entries and all multi-target destinations.
- Include each copied destination in the JSON payload with absolute `from`, relative `to`, and `type: "file"` or `"directory"`.

## Done when

- Tests cover object `from` values that are root-relative, absolute, and leading-`~`.
- Tests cover `to` as both a string and an array.
- Tests cover directory copy to exact final paths, including the example shape that produces `.claude/skills/skill-dir/foo.ts` and `.pi/agents/skill-dir/foo.ts`.
- Tests cover directory rerun replacement removing stale untracked files from the destination tree.
- Tests cover tracked descendants under a directory destination blocking replacement with exit code `11`; with `--json`, it emits `kind: "blocked"` and `reason: "unsafe"`.
- Tests cover exclude path de-duplication across multiple entries.
- Tests cover invalid object config and invalid destinations failing as usage/config errors with exit code `12` and no structured stdout payload, even with `--json`; cases include missing `from`, missing `to`, empty strings, absolute destinations, leading-`~` destinations, and escaping destinations.
- Tests cover missing object sources failing as usage/config errors with exit code `12` and no structured stdout payload, even with `--json`.
- Tests cover unsupported expansion behavior by proving env-var/glob-looking strings are treated literally rather than expanded.
- `bun test tests` passes for the touched behavior.
- `bun run typecheck` passes.

## Out of scope

- Integration with `add`, pooled allocation, or `ensure`.
- User-facing documentation updates.
- Changing existing `add` JSON payloads.

## References

- `../../../specs/git-worktrees.md` sections: Copy setup and Config.
- Existing filesystem helper patterns in tests.
