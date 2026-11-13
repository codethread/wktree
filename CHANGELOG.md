# Changelog

All notable changes to wktree are documented in this file.

## 0.11.0

### Changes

- Remove worktree pools and bundled agent skills (2baf075)

  Wktree now creates ordinary branch worktrees only. Remove pool allocation, recycling, initialization markers and bundled skill assets, and simplify command help and configuration schemas. Existing registered checkouts remain discoverable at their actual paths. Surviving command kinds and JSON fields remain stable, with pool and pool_size fields retained as null.

  - **Breaking:** The pool\_size setting is no longer accepted in global project entries or repository-local configuration.
  - **Breaking:** The ensure, status and skills commands and add --slot/--force options are removed.
  - **Breaking:** Previously pooled checkouts are ordinary worktrees. Successful remove or finish cleanup removes their directories instead of recycling slots; tree no longer displays a separate free-slot section.
  - **Adoption (required):** Remove pool\_size from global wktree.toml project entries and canonical-root .wktree.toml files. Replace pool allocation scripts with add --branch, use list/tree for inventory, and stop calling ensure, status, skills or add --slot/--force. Keep any needed agent instructions outside Wktree.
  - **Adoption (required):** If you used pools, review existing checkout paths before cleanup: remove and configured finish cleanup now delete the checkout directory rather than preserving a reusable slot. Existing worktrees do not need to be moved.
  - **Adoption (optional):** Regenerate shell completions after upgrading so removed commands and options are no longer offered.

## 0.10.2

### Changes

- Install the shared changelog library from GitHub (30cf906)

  Pin @codethread/cli-changelog to a full GitHub commit and record its integrity in bun.lock. Standard frozen-lockfile installs fetch the shared package for source, CI and Homebrew builds. Compiled executables bundle the dependency.

  - **Adoption (optional):** Run bun install --frozen-lockfile and rebuild the executable to use the GitHub-pinned dependency.

## 0.10.1

### Changes

- Use the shared CLI changelog library (3020b83)

  Load changelog schemas, version queries, pagination and rendering from the local @codethread/cli-changelog package. The compiled executable bundles the library.

  - **Adoption (required):** For source builds, install dependencies in the cli-changelog checkout and run bun link there before installing this repository with bun install --frozen-lockfile. Compiled executables need no additional files.

## 0.10.0

### Changes

- Identify the standalone Bun engine with a distinct version (66507f7)

  Advance the standalone Bun-based Wktree release to 0.10.0, above the inherited 0.9.1 version. The engine is unchanged from standalone 0.5.0; wktree --version now clearly distinguishes this build from older installed binaries.

  - **Adoption (optional):** Upgrade or rebuild Wktree, then run wktree --version and confirm it reports 0.10.0.

## 0.9.1

No recorded changes.

## 0.9.0

No recorded changes.

## 0.8.1

No recorded changes.

## 0.8.0

No recorded changes.

## 0.7.1

### Changes

- integrate reviewed tasks into a pinned local feature base (66cc8d9)

  Use `integrate --into` with full source/target commit pins for local-only
  fast-forward delivery into an explicit registered feature worktree. Local
  cleanup uses `remove --self --integrated-into-local` with containment and
  expected-old-ref proof. Existing default-branch finish policy is unchanged.

  Optional: use the new commands for independently delivered feature tasks.
  When adopting them, hold the matching target queue with exclusive checkout
  use and inspect partial-effect receipts. Run cleanup from a surviving
  checkout, selecting the source with `--cwd`. Local default-name identification
  requires an `origin/HEAD` symbolic NAME designation, which may be dangling;
  integration and containment need no remote history.

## 0.7.0

No recorded changes.

## 0.6.3

No recorded changes.

## 0.6.2

No recorded changes.

## 0.6.1

### Changes

- expose worktree tool release history offline (e35554e)

  Run `wktree changelog` to inspect recorded changes without a repository.
  Use its help for version selection, pagination and JSON output.

- quote preserved source messages in squash commits (e35554e)

  Wktree appends the source branch and archived commit messages after
  the caller's reviewed squash body. For Hive release generation, archived
  changelog blocks are provenance: only top-level `changelog v1` blocks
  declare the integrated commit's tool changes.

  For example, a block in the reviewed squash body can contain a shell example:

  ~~~~text
  ~~~changelog v1
  feat(wktree): describe the consumer-visible change

  Explain the change and any required or optional adoption actions.

  ```sh
  wktree changelog
  ```
  ~~~
  ~~~~

  The record format version `v1` is independent of the Hive suite version.

  - **Breaking:** Every preserved source-message line now has a Markdown blockquote prefix \(\`&gt; \`\). Consumers that parse Wktree squash-message archives must account for this format change.
  - **Adoption (required):** For Hive changelog authors: put the authoritative top-level changelog v1 blocks in the final reviewed squash body passed to wktree finish --body, with a separate single-tool Conventional Commit header for each affected tool. This is a Hive release-authoring requirement, not a requirement for other repositories using Wktree.

## 0.6.0

### Changes

- Finish checks integration conflicts before changing the canonical worktree. (83a02d8)

## 0.5.0

### Changes

- Restore the evolved worktree engine as standalone Wktree (66507f7)

  Ship a compiled standalone CLI with safe worktree lifecycle operations, fixed pools, offline add, pinned local integration, structured JSON, bundled skills, and generated zsh and Nushell picker functions. Global configuration is read from ~/.config/wktree.toml (or XDG_CONFIG_HOME/wktree.toml); repository-local overrides come from .wktree.toml at the canonical root. Homebrew builds and installs the standalone executable.

  - **Breaking:** The old nu/wktree modules are replaced by wktree shell-init zsh and wktree shell-init nu.
  - **Breaking:** The old --skip-pre-remote-check flag is replaced by --no-network for offline add.
  - **Adoption (required):** Replace old shell module imports with the output of wktree shell-init for your shell. Regenerate the Nushell module after upgrading.
  - **Adoption (optional):** Use a canonical-root .wktree.toml to share repository setup and policy across worktrees.
