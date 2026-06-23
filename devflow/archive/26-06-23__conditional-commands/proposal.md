# Conditional Commands Proposal

**Last Updated:** 2026-06-23
**Related RFCs:** None
**Related root specs:** [git-worktrees.md](../../specs/git-worktrees.md)

## Problem

Bootstrap commands currently must be configured on exact `[[project]]` entries. This makes broad personal defaults verbose, especially for repositories under common roots like `~/dev/projects/**` that can share the same setup behavior.

## Goals

- Allow bootstrap commands to be inherited from root-glob defaults.
- Preserve exact project overrides for exceptional repositories.
- Support lockfile-based command selection by using the existing Bash command body model.
- Keep config resolution explainable and avoid adding a TOML conditional DSL.
- Make inherited command sources visible through `wktree config explain`.

## Non-goals

- No TOML-level `if` / `else` / `when` expression language.
- No built-in package-manager detection preset.
- No glob or environment expansion inside command bodies.
- No broad inheritance for copy entries or pool settings.

## Proposed scope

Add optional `command` support to `[[rule]]` entries. Matching rules apply in file order, with later matching rule commands replacing earlier rule commands. An exact `[[project]].command`, when present, overrides the inherited command. Existing command execution remains unchanged: the selected command is embedded into the generated Bash post-create script and runs from the created worktree after copy setup.

Example:

```toml
[[rule]]
root_glob = "~/dev/projects/**"
command = '''
if [[ -f bun.lock ]]; then
  bun install
elif [[ -f yarn.lock ]]; then
  yarn install
elif [[ -f pnpm-lock.yaml ]]; then
  pnpm install
else
  echo "wktree: no known JS lockfile found; skipping install"
fi
'''
```

## Open questions

- Should exact projects be able to explicitly disable an inherited command? Initial scope: no, unless implementation or tests reveal a clear need.
- Should human `config explain` print the full command or only its source? Initial preference: show source plus command presence; JSON can include the selected command for machine debugging.
