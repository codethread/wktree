# Release process

Use this checklist to publish a new `wktree` release.

## 1. Start clean on `main`

```bash
git switch main
git pull --ff-only
git status --short
git branch --show-current
```

Confirm:

- current branch is `main`
- working tree is clean before release edits
- local `main` is up to date with origin

## 2. Choose the next version

Inspect existing tags and decide the next SemVer version:

```bash
git tag --sort=-v:refname | head -20
git log --oneline $(git describe --tags --abbrev=0)..HEAD
```

Use the commit messages since the last tag to determine whether the release is patch, minor, or major.
If there are no previous tags, review the full history and create the first version intentionally.

## 3. Run the full checks

Run all project checks before changing release metadata:

```bash
bun run typecheck
bun run check
bun test tests
bun run build
```

If any command fails, fix that before continuing.

## 4. Update release metadata

Update every version source to the same new version:

- `package.json` `version`
- `src/cli.ts` CLI version exposed by Commander, for example `.version("x.y.z")`

If `package.json` does not yet have a `version` field, add one near the package name.
If `src/cli.ts` does not yet expose a version, add it to the root `Command` setup so `wktree --version` reports the release version.

## 5. Update `CHANGELOG.md`

Add a new entry using the [Keep a Changelog](https://keepachangelog.com/) style:

```markdown
# Changelog

## [x.y.z] - YYYY-MM-DD

### Added

- ...

### Changed

- ...

### Fixed

- ...
```

Guidance:

- Build the entry from commit messages since the last tag: `git log --oneline <last-tag>..HEAD`.
- Group bullets under standard headings: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
- Omit empty headings.
- Keep bullets user-facing; do not include internal noise unless it affects users or maintainers.
- Include compare links at the bottom when helpful, especially once releases are public.

## 6. Re-run checks

After metadata and changelog edits, run the full verification again:

```bash
bun run typecheck
bun run check
bun test tests
bun run build
```

## 7. Commit and tag

Review the exact diff:

```bash
git diff
git status --short
```

Commit the release changes and create an annotated tag:

```bash
git add package.json src/cli.ts CHANGELOG.md
git commit -m "chore(release): x.y.z"
git tag -a "vx.y.z" -m "wktree x.y.z"
```

Use `v`-prefixed tags unless the repository has already established a different convention.

## 8. Push release commit and tags

```bash
git push origin main
git push origin "vx.y.z"
```

Verify the pushed tag exists remotely:

```bash
git ls-remote --tags origin "vx.y.z"
```

## 9. Post-release sanity check

Optionally install or run from a fresh checkout and confirm:

```bash
wktree --version
wktree --help
```

The reported version should match `package.json`, `src/cli.ts`, `CHANGELOG.md`, and the git tag.
