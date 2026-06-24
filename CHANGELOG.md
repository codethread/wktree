# Changelog

## [0.1.0] - 2026-06-24

### Added

- Initial `wktree` TypeScript engine and CLI for deterministic git worktree lifecycle management.
- Deterministic add, list, path, remove, ensure, status, copy, finish, and config explain commands.
- JSON output contracts for automation and agent workflows.
- Optional fixed worktree pools with safe allocation, recycling, and initialization.
- Local file/directory copy and symlink setup for new or existing worktrees.
- Add policies for origin-default and fresh-canonical branch creation.
- Finish policies for fast-forward, rebase-fast-forward, squash, and merge-commit integration.
- Homebrew HEAD formula and build wrapper for local installation.

### Fixed

- Supported absolute Nushell lint paths.
- Allowed copy destinations under tracked directories while preserving tracked-content safety checks.
