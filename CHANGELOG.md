# Changelog

## [0.4.0] - 2026-09-19

### Added

- `worktree_location` config option (`"sibling"` or `"nested"`) at the global, rule, and exact-project layers. Nested repositories create new worktrees and missing pool slots under `<canonical-root>/.wktree/`, and `wktree` records a fenced `/.wktree/` entry in the repository's shared exclude file so the canonical checkout stays clean.

### Changed

- `wktree path` and `wktree add` resolve an existing branch to its registered worktree path before deriving a path from config, so sibling, nested, and manually located worktrees remain discoverable after changing `worktree_location`.
- Pool slots are discovered from Git worktree metadata in either sibling or nested form; only missing slots use the configured location. Ambiguous sibling/nested claims for the same slot block loudly instead of resolving silently.
- Nested worktrees use `<canonical-root-basename>__<worktree-basename>` as their tmux session name, matching the sibling naming scheme and avoiding cross-repository collisions.
- `wktree config explain` reports the effective `worktree_location` in text and JSON output.
- Nushell wrapper errors use `error make --unspanned`, so messages no longer carry code spans.

### Fixed

- `wktree add` reports a clear duplicate-branch error when the branch is already checked out in another worktree.

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
