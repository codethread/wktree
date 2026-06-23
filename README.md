# wktree

Deterministic local worktree manager for creating, reusing, inspecting, and removing git worktrees. `wktree` centralizes git/worktree lifecycle behavior so humans, Nushell wrappers, tmux workflows, and agents all use the same command contract.

See [`devflow/specs/git-worktrees.md`](./devflow/specs/git-worktrees.md) for the durable design contract and edge-case semantics.

## What it provides

- Branch/path/session names derived deterministically from git state.
- Safe creation and removal of regular sibling worktrees.
- Optional fixed-size per-repository worktree pools for expensive projects.
- Structured JSON outcomes for machine consumers.
- Human-facing Nushell commands that open/switch tmux sessions.
- No durable app database: engine state is reconstructed from git metadata, filesystem paths, and project config; live tmux panes are wrapper-only UI state.

## Repository layout

- `bin/wktree.ts` — thin executable entrypoint.
- `src/main.ts` — exported engine/dispatch behavior used by tests and consumers.
- `src/cli.ts` — Commander-based process CLI wiring.
- `src/config.ts` and `src/schemas.ts` — TOML config parsing and validation schemas.
- `src/git/` — git execution abstractions and worktree parsers.
- `src/fzf.ts` — interactive picker helper.
- `nu/wktree/` — Nushell wrapper and tmux workflow integration.
- `tests/` — Bun tests for engine and wrapper behavior.
- `scripts/build-bin.ts` — builds the `~/.local/bin/wktree` wrapper.
- `devflow/specs/` — persistent product/design specifications.

## Development

This project uses Bun, TypeScript, and Biome.

```bash
bun install
bun test tests
bun run typecheck
bun run check
bun run build
```

Useful package scripts:

- `bun test tests` — run the test suite.
- `bun run typecheck` — run `tsc --noEmit`.
- `bun run check` — run Biome checks.
- `bun run build` — generate `~/.local/bin/wktree`, a thin wrapper around `bun run bin/wktree.ts`.

## CLI quick reference

```bash
wktree [--cwd <path>] root
wktree [--cwd <path>] list [--json]
wktree [--cwd <path>] path --branch <branch>
wktree [--cwd <path>] add --branch <branch> [--json] [--slot <path>] [--base <branch>] [--force]
wktree [--cwd <path>] remove (--branch <branch> | --self <path>) [--json] [--force]
wktree [--cwd <path>] ensure
wktree [--cwd <path>] status
wktree [--cwd <path>] copy [--json]
wktree [--cwd <path>] config explain [--json]
wktree [--cwd <path>] finish [--json]
```

`--cwd` is a global option. It may point at any path inside the intended worktree set and defaults to the current directory; commands resolve the canonical root from there. Machine consumers should prefer `--json` where available and branch on payload `kind` rather than stderr text.

## Nushell wrapper

Import `nu/wktree/mod.nu` to get the human-facing commands:

- `wk root`
- `wk path <branch>`
- `wk add <branch> [base] [--self] [--force]`
- `wk remove <branch> | wk remove --self [--force]`
- `wk copy [--json]`
- `wk finish [--json]`
- `wk list [--json]`
- `wk switch`

`wk add` delegates freshness policy to the TypeScript engine, runs any returned post-create script, and then opens or switches to the emitted tmux session/path. `wk remove` and cleanup-enabled `wk finish` close wrapper-owned tmux sessions after successful engine operations.

## Project configuration

Project config is read from `ct-worktrees/trees.toml` under XDG config home. Projects can define `name`, `root`, optional `command`, optional `pool_size`, optional `copy` entries, and policy overrides. Rules can define inherited default `command`s for matching roots. `command` is required when a project uses pools or copy/bootstrap setup, but it may come from either the exact project or a matching rule. Policy-only exact projects may omit it. Use `wktree config explain --cwd <path> [--json]` to inspect the effective policy and bootstrap command source.

Resolution starts with built-in defaults, applies matching `[[rule]]` entries in file order, then applies exact `[[project]]` overrides. Finish policy fields merge field-by-field. For inherited commands, later matching rule commands win and exact project commands override rules.

```toml
[defaults.add]
policy = "origin_default"

[defaults.finish]
enabled = true
strategy = "ff_only"
push = false
remove_worktree = false
delete_branch = false

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

[rule.add]
policy = "fresh_canonical"

[rule.finish]
strategy = "squash"
push = true

[[project]]
name = "example"
root = "~/dev/example"
command = "bun install"
pool_size = 3
copy = [".env"]

[project.add]
policy = "origin_default"

[project.finish]
strategy = "merge_commit"
remove_worktree = true
delete_branch = true
```

Valid finish strategies are `ff_only`, `rebase_ff`, `squash`, and `merge_commit`.

Add policy values are:

- `origin_default`: fetch `origin` and start new branches from `origin/<default>` without changing the canonical root.
- `fresh_canonical`: fetch `origin`, require the canonical root to be clean and checked out on the default branch, fast-forward it, then start new branches without an explicit `--base` from that fresh local default branch. If the root is dirty, on the wrong branch, or cannot fast-forward, default-base `add` fails hard rather than falling back to stale canonical state.

An explicit `--base` is treated as an intentional stacked/non-default base: `wktree` fetches first and resolves that base deterministically, but does not require or mutate the canonical default branch.

`finish` integrates the current non-canonical worktree into the canonical default branch. It requires a clean source worktree, fetches first, requires a clean/fresh canonical target, and stops on conflicts. Strategy, push, worktree cleanup, and branch deletion come from effective finish policy in config; use `wktree config explain --cwd <path> [--json]` to inspect them. Configured push is a normal non-forced push; rejection blocks cleanup. Configured `remove_worktree` removes a regular worktree or frees a pooled slot after successful integration and push. Configured `delete_branch` requires cleaning up the worktree in the same effective policy.

String `copy` entries copy root-relative files to the same relative path in the created worktree by default. Object entries use `from` and `to`; `from` may be root-relative, absolute, or start with `~`, and `to` may be a destination string or array of destination strings. Destination paths are always relative to the created worktree. `copy_mode_default` may be `"copy"` or `"symlink"` and applies to all entries unless an object entry sets `mode`. Symlink mode creates destination symlinks to the resolved source target. Copy setup runs before the configured `command`, and can be rerun for an existing non-root worktree with `wktree copy --cwd <path> [--json]` or `wk copy [--json]`.

For pooled projects, `wktree ensure` materializes slots named like `<root>__featN` with placeholder branches `wk-pool/featN`.
