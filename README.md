# wktree

`wktree` is a deterministic git worktree manager. It creates, finds, prepares, finishes, and removes worktrees using one consistent contract for humans, shell/tmux wrappers, scripts, and agents.

It is useful when you want predictable worktree paths, safe cleanup, JSON output, optional fixed worktree pools, and repeatable setup for local files such as `.env`.

## Install

Requirements: git and Bun.

### Homebrew

Tap this repository directly, then install the latest tagged release:

```bash
brew tap codethread/wktree https://github.com/codethread/wktree
brew install codethread/wktree/wktree
```

Or as one shell command:

```bash
brew tap codethread/wktree https://github.com/codethread/wktree && brew install codethread/wktree/wktree
```

This installs a small `wktree` launcher that runs the tagged TypeScript CLI with Homebrew's Bun. Because the CLI is installed from source instead of distributed as a downloaded macOS executable, it avoids Developer ID signing/notarization friction.

To upgrade to the newest tagged release after the formula is updated:

```bash
brew update
brew upgrade wktree
```

### Build from source

```bash
make
```

`make` runs `bun install` and `bun run build`. The build writes:

```text
~/.local/bin/wktree
```

Make sure `~/.local/bin` is on your `PATH`.

After installing, use the built-in help for the full command reference:

```bash
wktree --help
wktree add --help
wktree config explain --help
```

## How it works

`wktree` resolves one checkout as the **canonical root** for a repository. That root is protected and anchors config lookup, default-branch policy, generated paths, and safety checks.

Normal worktrees are created beside the root:

```text
<canonical-root>__<branch-name-with-/encoded-as-->
```

Pooled repositories reuse fixed slots instead:

```text
<canonical-root>__feat1
<canonical-root>__feat2
...
```

There is no app database. Current state comes from git worktree metadata, filesystem paths, and config. Tmux integration consumes emitted path/session data; it is not the source of truth.

## Basic use

From any path inside a repository worktree set:

```bash
wktree root
wktree add --branch feature/example
wktree list
wktree path --branch feature/example
wktree remove --branch feature/example
```

For scripts and agents, prefer JSON where available and branch on the payload `kind`:

```bash
wktree add --branch feature/example --json
wktree list --json
wktree finish --json
```

If `add --json` returns `post_create_script_path`, run that script with bash before treating the worktree as ready.

Use this to see what config applies to the current repository:

```bash
wktree config explain --json
```

## Config

Config is optional. Without it, `wktree` still creates deterministic sibling worktrees.

Config is read from:

```text
${XDG_CONFIG_HOME:-~/.config}/ct-worktrees/trees.toml
```

Resolution order:

1. built-in defaults;
2. matching `[[rule]]` entries in file order;
3. exact `[[project]]` entry for the canonical root.

Later layers override earlier ones.

### Schema

```toml
[defaults.add]
policy = "origin_default" # "origin_default" | "fresh_canonical"

[defaults.finish]
enabled = true
strategy = "ff_only"      # "ff_only" | "rebase_ff" | "squash" | "merge_commit"
push = false
remove_worktree = false
delete_branch = false

[[rule]]
root_glob = "~/dev/projects/**"   # required for rules; leading ~/ supported
command = "bun install"           # optional bash snippet
pre_remote_check = "test -f .env" # optional bash snippet

[rule.add]
policy = "fresh_canonical"

[rule.finish]
enabled = true
strategy = "squash"
push = true
remove_worktree = true
delete_branch = true

[[project]]
root = "~/dev/projects/example"   # required for projects
name = "example"                  # optional; defaults to basename(root)
command = "bun install"           # required for pools/copy unless inherited from a rule
pre_remote_check = "test -f .env" # optional
pool_size = 3                      # optional; enables fixed slots
copy_mode_default = "copy"        # optional: "copy" | "symlink"; default "copy"
copy = [                           # optional
  ".env",
  { from = "~/shared/tooling", to = ".tooling", mode = "symlink" },
  { from = ".claude", to = [".claude", ".pi/claude"], mode = "copy" },
]

[project.add]
policy = "origin_default"

[project.finish]
enabled = true
strategy = "ff_only"
push = false
remove_worktree = false
delete_branch = false
```

Notes:

- `command` and `pre_remote_check` run under bash.
- `command` receives `WK_ROOT` and `WK_CREATED`.
- `origin_default` starts default-base work from `origin/<default>` without mutating the canonical root.
- `fresh_canonical` fetches, requires a clean canonical root on the default branch, fast-forwards it, then starts work from that fresh local branch.
- `copy` destinations are always worktree-relative. String entries copy from the canonical root to the same relative path.
- `delete_branch = true` requires `remove_worktree = true` in the same effective finish policy.

## Examples

### Personal defaults

```toml
[defaults.add]
policy = "origin_default"

[[rule]]
root_glob = "~/dev/projects/**"
command = '''
if [[ -f bun.lock ]]; then
  bun install
elif [[ -f package-lock.json ]]; then
  npm install
else
  echo "wktree: no known install step"
fi
'''
```

### Strict work repos

```toml
[[rule]]
root_glob = "~/work/**"
pre_remote_check = "test -f .envrc || { echo 'missing .envrc' >&2; exit 1; }"

[rule.add]
policy = "fresh_canonical"
```

### Expensive repo with a pool

```toml
[[project]]
name = "big-app"
root = "~/dev/projects/big-app"
pool_size = 4
command = "bun install"
copy = [".env"]
```

```bash
wktree ensure --cwd ~/dev/projects/big-app
wktree status --cwd ~/dev/projects/big-app
```

### Finish and clean up

```toml
[[project]]
name = "library"
root = "~/dev/projects/library"

[project.finish]
strategy = "squash"
push = true
remove_worktree = true
delete_branch = true
```

From a non-canonical worktree:

```bash
wktree finish --json
```

## Nushell wrapper

The TypeScript CLI is the source of truth. `nu/wktree/` provides human-friendly `wk` commands and tmux switching around the same engine.

## Development

```bash
bun test tests
bun run typecheck
bun run check
```

The durable design contract lives in [`devflow/specs/git-worktrees.md`](./devflow/specs/git-worktrees.md).
