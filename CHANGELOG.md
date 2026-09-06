# Changelog

## [0.3.0] - 2026-09-06

### Added

- `wk select` fuzzy-picks a worktree and changes the current Nushell directory to it, without opening a tmux session.

### Changed

- Config is now read from `${XDG_CONFIG_HOME:-~/.config}/wktree.toml` instead of `ct-worktrees/trees.toml`. Move an existing file to the new path before upgrading.

## [0.2.1] - 2026-08-03

### Changed

- Added the squash-aware cleanup command to the CLI's common workflows help.

## [0.2.0] - 2026-08-03

### Added

- `wktree remove --integrated-into origin/main` verifies a clean branch's source-relative content is present in a fetched remote target before removing its worktree and branch, supporting squash-merged pull requests.

## [0.1.1] - 2026-08-03

### Changed

- Homebrew installs now use stable tagged releases.

### Fixed

- `remove --keep-branch` now removes clean worktrees or recycles clean pool slots without requiring the retained branch to be merged, supporting squash-merged pull requests.
- Corrected the Nushell pool-recycle confirmation normalization.

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
