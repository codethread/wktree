---
name: release
description: Publish a Wktree release, update its changelog, and advance the Homebrew formula.
---

# Release process

Use this checklist only when release publication is authorized. Ordinary implementation work does not authorize tags or pushes.

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

Use the commit messages since the last tag to determine whether the release is patch, minor, or major. If there are no previous tags, review the full history and create the first version intentionally.

## 3. Run the full checks

Run all project checks before changing release metadata:

```bash
bun run typecheck
bun run check
bun run test
bun run build
```

If any command fails, fix that before continuing.

## 4. Update release metadata

Update every version source to the same new version:

- `package.json` `version`
- The CLI imports its version from `package.json`; no separate CLI version edit is needed.

Do not update `Formula/wktree.rb` yet. The formula should point at the final release tag and peeled commit revision, which only exist after the release commit is tagged.

## 5. Update `changelog.json`

Add a release object to `changelog.json`, using the existing JSON structure:

- `version`: the new package version.
- `changes`: user-facing changes since the last tag, each with `commit`, `summary`, `body`, `breaking`, and `adoption` fields.
- An adoption note has `requirement` (`optional` or `required`) and `text` fields.

Use `git log --oneline <last-tag>..HEAD` as evidence. Preserve existing history and verify the rendered result with `bun run bin/wktree.ts changelog --release x.y.z --json`.

## 6. Re-run checks

After metadata and changelog edits, run the full verification again:

```bash
bun run typecheck
bun run check
bun run test
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
git add package.json changelog.json
git commit -m "chore(release): x.y.z"
git tag -a "vx.y.z" -m "wktree x.y.z"
```

Use `v`-prefixed tags unless the repository has already established a different convention.

## 8. Push release commit and tags

```bash
git push origin main
git push origin "vx.y.z"
```

Verify the pushed tag exists remotely and capture the peeled commit SHA:

```bash
git ls-remote --tags origin "vx.y.z"
git rev-list -n 1 "vx.y.z"
```

For annotated tags, use the peeled commit SHA from `git rev-list -n 1`, not the tag-object SHA.

## 9. Update Homebrew formula

Update `Formula/wktree.rb` so the stable formula uses the new tag rather than `head`/`--HEAD`:

```ruby
url "https://github.com/codethread/wktree.git",
    tag:      "vx.y.z",
    revision: "<peeled-commit-sha>"
```

Validate the formula locally:

```bash
ruby -c Formula/wktree.rb
brew style Formula/wktree.rb
```

Commit and push the formula update:

```bash
git add Formula/wktree.rb
git commit -m "chore(homebrew): update formula to vx.y.z"
git push origin main
```

Keep `README.md` aligned with the release style if Homebrew install or upgrade commands change; it should document normal tagged-release installs, not `brew install --HEAD`.

## 10. Post-release sanity check

Optionally install or run from a fresh checkout and confirm:

```bash
wktree --version
wktree --help
```

The reported version should match `package.json`, `changelog.json`, the git tag, and `Formula/wktree.rb`.
