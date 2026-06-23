# Task 6: Add policy config resolution

## Scope

Type: AFK

Add the planned policy configuration model without changing `wktree add` or introducing `finish` behavior yet. The completed slice should parse defaults, root-glob rules, and exact project overrides, and expose the effective policy through a deterministic `wktree config explain --cwd <path> [--json]` command.

## Must implement exactly

- Preserve all existing `[[project]]` config behavior for bootstrap, pools, copy setup, and existing callers.
- Add parsing for `[defaults.add]`, `[defaults.finish]`, `[[rule]]`, `[rule.add]`, `[rule.finish]`, `[project.add]`, and `[project.finish]` according to `../../../specs/git-worktrees.md`.
- Support only leading `~` expansion for `root_glob`; do not add environment variable or shell expansion.
- Resolve effective policy in this order: built-in defaults, matching rules in file order with later matching fields winning, then exact `[[project]]` overrides.
- Use built-in add policy `origin_default` when no config overrides it.
- Use built-in finish policy `enabled = true`, `strategy = "ff_only"`, `push = false`, `remove_worktree = false`, and `delete_branch = false` when no config overrides it.
- Parse and validate finish policy fields exactly: `enabled` boolean, `strategy` enum `ff_only | rebase_ff | squash | merge_commit`, `push` boolean, `remove_worktree` boolean, and `delete_branch` boolean.
- Merge nested policy objects field-by-field so a later rule or exact project can override only one finish field without erasing the rest.
- Allow an exact `[[project]]` entry with `root` and policy tables but no `command`; keep `command` required when the project uses bootstrap-only behavior that needs a post-create script, pool initialization command execution, or copy setup.
- Add `wktree config explain --cwd <path> [--json]` to dispatch and Commander help.
- The explain command should report at least canonical root, matched rules, exact project name/root when present, effective add policy, and every effective finish policy field.
- With `--json`, stdout must contain only structured JSON; diagnostics stay on stderr.

## Done when

- Tests cover defaults-only policy resolution.
- Tests cover multiple matching rules where later rule fields win.
- Tests cover an exact project overriding a matching rule.
- Tests cover a policy-only exact project without `command`.
- Tests cover invalid add policy, invalid finish strategy, non-boolean finish fields, and malformed `root_glob` failing loudly as config errors.
- Tests cover finish policy field-by-field merging across defaults, rules, and exact project overrides.
- Integration or dispatch tests cover `wktree config explain --cwd <path> --json` including all effective finish fields.
- `bun test tests` passes.
- `bun run typecheck` passes.

## Out of scope

- Changing `wktree add` behavior based on policy.
- Implementing `wktree finish`.
- README updates beyond command help or snapshots required by tests.
- General glob expansion for copy paths or command strings.

## References

- `../../../specs/git-worktrees.md` sections: Policy configuration, Add freshness policy, Finish lifecycle, Commands, Config.
- `README.md` CLI quick reference and project configuration sections.
- `AGENTS.md` structured output and validation guidance.
