# wktree Agent Guide

## Project purpose

`wktree` is a Bun/TypeScript engine plus Nushell wrapper for deterministic git worktree lifecycle management. It was lifted out of the dotfiles `oven` workspace; keep the focused repo docs here current rather than relying on the old monorepo context.

Read first:

- [`README.md`](./README.md) — usage, layout, commands.
- [`specs/git-worktrees.md`](./specs/git-worktrees.md) — durable contract and design decisions.
- [`specs/README.md`](./specs/README.md) — spec index.

## Commands

```bash
bun test tests      # run tests
bun run typecheck   # TypeScript check
bun run check       # Biome check
bun run build       # generate ~/.local/bin/wktree wrapper
```

When touching Nushell files, also validate syntax with absolute paths, using `--as-module` for module files:

```bash
nu -c 'nu-check --debug --as-module /absolute/path/to/nu/wktree/mod.nu'
nu -c 'nu-check --debug --as-module /absolute/path/to/nu/wktree/tmux.nu'
```

## Code standards

- Keep high-level flow easy to read: CLI/help/dispatch first, domain logic next, lower-level helpers later.
- Do not put executable code at module top level except `if (import.meta.main)` guarded startup.
- Export core logic so tests can import it without running the CLI.
- Prefer loud, contextual errors over silent fallback behavior.
- Structured command output is part of the public contract; preserve JSON field names and `kind`-based branching unless the spec changes.
- Keep stderr for diagnostics/progress and stdout clean for structured payloads when `--json` is used.
- Use Bun-native APIs where they make sense, but keep shell/git execution behind injectable interfaces.

## Testing standards

- Tests live in `tests/` and use Bun's test runner.
- Test exported library/dispatch functions directly where possible rather than spawning the CLI for every case.
- Favor real temporary git repositories and filesystem operations for integration behavior.
- Use fake implementations for dependencies that would otherwise make tests slow, flaky, or hard to assert.
- Avoid conditional assertions that can silently pass; assert the contract first.
- Avoid hard-coded machine paths; use `process.execPath`, `import.meta.dir`, temp directories, or resolved repository paths.

## Dependency injection for shell/git behavior

This codebase intentionally uses dependency injection for testability. Do not call shell/git/tmux/fzf primitives directly from deep logic when that behavior needs to be tested.

Existing patterns:

- `GitRunner` / `LiveGitRunner` in `shared/git/executor.ts` abstract git execution.
- `Deps` in `bin/wktree.ts` groups git, hook runner, picker, and progress reporting.
- Tests pass fake `Deps` where they need deterministic behavior.

When adding behavior:

1. Put pure parsing/planning logic in exported functions where practical.
2. Add a narrow interface for external effects.
3. Provide a live implementation for production.
4. Inject that implementation through existing `Deps` or a similarly explicit options object.
5. In tests, provide a fake that asserts the command contract and returns controlled output.

Avoid trying to mock Bun's `$` operator or global process state. Wrap the effect instead.

## Worktree safety rules

- The canonical/root worktree is protected and anchors config lookup, sibling path generation, default branch detection, and safety checks.
- New branches should default to origin's default branch/trunk unless a caller explicitly supplies a base.
- Tmux is a consumer, not source of truth. Do not persist correctness in tmux session state.
- Pool exhaustion and unsafe removal/recycle states should be explicit and recoverable with structured payloads.
- Forced operations may be destructive, but unforced operations should refuse dirty, ahead, local-only, or otherwise ambiguous states according to the spec.

## Documentation expectations

If command semantics, payload shapes, pool behavior, or safety rules change, update `specs/git-worktrees.md` in the same change. If setup or common usage changes, update `README.md` too.
