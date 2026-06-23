# Git Worktrees Spec Delta: Rule-Inherited Bootstrap Commands

**Status:** Merged
**Last Updated:** 2026-06-23
**Root spec:** [../../specs/git-worktrees.md](../../../specs/git-worktrees.md)

## Delta

Update the policy/configuration contract so `[[rule]]` entries may provide an optional inherited bootstrap `command` in addition to policy patches.

## Proposed contract changes

- `[[rule]].command` is an optional non-empty string.
- Rules still match only canonical root paths using `root_glob`.
- Matching rules are evaluated in file order.
- For command resolution, later matching rule commands replace earlier matching rule commands.
- An exact `[[project]].command`, when present, overrides any inherited rule command.
- If no project command and no matching rule command exist, no bootstrap script is generated.
- Command bodies remain opaque Bash snippets. `wktree` does not parse command conditionals or expand globs/environment variables inside commands.
- The selected command runs in the existing post-create script lifecycle: after worktree creation, after copy setup, with `WK_ROOT` and `WK_CREATED` exported, and with the script `cd`ed into the created worktree.
- Projects using `pool_size`, `copy`, or `copy_mode_default` require an effective command, which may come from either an exact project command or a matching rule command.
- `config explain --json` includes selected bootstrap command metadata: the selected command and its source, or nulls when no command applies.

## Non-changes

- Copy setup remains exact-project-only.
- Pool sizing remains exact-project-only.
- `root_glob` remains a selector, not a general inheritance or shell expansion mechanism.
- No TOML conditional DSL is introduced.
