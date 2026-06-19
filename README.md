# wktree

Deterministic local worktree manager for creating, reusing, inspecting, and removing git worktrees. `wktree` centralizes git/worktree lifecycle behavior so humans, Nushell wrappers, tmux workflows, and agents all use the same command contract.

See [`specs/git-worktrees.md`](./specs/git-worktrees.md) for the durable design contract and edge-case semantics.

## What it provides

- Branch/path/session names derived deterministically from git state.
- Safe creation and removal of regular sibling worktrees.
- Optional fixed-size per-repository worktree pools for expensive projects.
- Structured JSON outcomes for machine consumers.
- Human-facing Nushell commands that open/switch tmux sessions.
- No durable app database: state is reconstructed from git metadata, filesystem paths, project config, and live tmux panes.

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
- `specs/` — persistent product/design specifications.

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
wktree root --cwd <path>
wktree list --cwd <path> [--json]
wktree path --cwd <path> --branch <branch>
wktree add --cwd <path> --branch <branch> [--json] [--slot <path>] [--base <branch>] [--force]
wktree remove --cwd <path> (--branch <branch> | --self <path>) [--json] [--force]
wktree ensure --cwd <path>
wktree status --cwd <path>
wktree recycle --cwd <path> --slot <path> [--force]
wktree copy --cwd <path> [--json]
```

Machine consumers should prefer `--json` where available and branch on payload `kind` rather than stderr text.

## Nushell wrapper

Import `nu/wktree/mod.nu` to get the human-facing commands:

- `wk root`
- `wk path <branch>`
- `wk add <branch> [base] [--self] [--latest] [--force]`
- `wk remove <branch> | wk remove --self [--force]`
- `wk copy [--json]`
- `wk list [--json]`
- `wk switch`

The wrapper runs any returned post-create script and then opens or switches to the emitted tmux session/path.

## Project configuration

Project config is read from `ct-worktrees/trees.toml` under XDG config home. Projects can define `name`, `root`, `command`, optional `pool_size`, and optional `copy` entries.

Example:

```toml
[[project]]
name = "example"
root = "~/dev/example"
command = "bun install"
pool_size = 3
copy_mode_default = "copy"
copy = [
  ".env",
  { from = "~/my/repo/skill-dir", to = [".claude/skills/skill-dir", ".pi/agents/skill-dir"] },
  { from = ".env.shared", to = ".env.shared", mode = "symlink" },
]
```

String `copy` entries copy root-relative files to the same relative path in the created worktree by default. Object entries use `from` and `to`; `from` may be root-relative, absolute, or start with `~`, and `to` may be a destination string or array of destination strings. Destination paths are always relative to the created worktree. `copy_mode_default` may be `"copy"` or `"symlink"` and applies to all entries unless an object entry sets `mode`. Symlink mode creates destination symlinks to the resolved source target. Copy setup runs before the configured `command`, and can be rerun for an existing non-root worktree with `wktree copy --cwd <path> [--json]` or `wk copy [--json]`.

For pooled projects, `wktree ensure --cwd <path>` materializes slots named like `<root>__featN` with placeholder branches `wk-pool/featN`.
