# wktree

`wktree` is a deterministic git worktree manager. It creates, finds, prepares, finishes, and removes worktrees using one consistent contract for humans, shell/tmux wrappers, scripts, and agents.

It is useful when you want predictable worktree paths, safe cleanup, JSON output, optional fixed worktree pools, and repeatable setup for local files such as `.env`.

## Install with Homebrew

```sh
brew tap codethread/wktree https://github.com/codethread/wktree
brew install codethread/wktree/wktree
```

For an existing installation, use `brew upgrade codethread/wktree/wktree`. Homebrew installs the compiled executable; Bun is required only while building it.

## Build and install

Requirements: Git; Bun for building. The optional `wk` picker requires fzf and zsh or Nushell.

From the repository root, install dependencies, compile locally, then install the executable:

```nu
bun install --frozen-lockfile
bun run build
bun run install:bin
```

The shared `@codethread/cli-changelog` dependency is pinned to a GitHub commit and installed by Bun. Source, CI and Homebrew builds use the same committed lockfile.

The build writes `dist/wktree` and bundles the shared changelog library. Installation copies that standalone executable to `~/.local/bin`; put that directory on `PATH`. Building alone does not change installed commands.

After installing, use the built-in help for the full command reference:

```nu
wktree --help
wktree add --help
wktree config explain --help
```

## Bundled agent skills

Wktree ships version-matched instructions that can be read offline, including outside a Git repository:

```bash
wktree skills                       # same as skills list
wktree skills list --json           # names, descriptions, and resource paths
wktree skills get git-workflow      # Markdown body without frontmatter
wktree skills file git-workflow references/pooled-slots.md
```

Each command supports `--json` using the standard Wktree envelope. Listing returns `kind: "skills_list"` with a `skills` array; reads return `kind: "skills_get"` with `name`, `path`, and `content`. Skill instructions contain only the Markdown body, without YAML frontmatter, in both text and JSON output. Unknown skills or resource paths fail with the usage exit code `12` and `reason: "usage"`.

## Zsh completions

Generate a completion script after installing Wktree:

```nu
wktree completions zsh | save --force ~/.wktree-completion.zsh
```

Add these lines to `~/.zshrc`, after putting `wktree` on your `PATH`. Skip `compinit` if your shell framework already runs it:

```zsh
autoload -Uz compinit
compinit
source ~/.wktree-completion.zsh
```

Restart zsh to enable completion for commands, nested subcommands, and flags. The script queries the installed `wktree` at tab time, so suggestions follow the current CLI. Branch names and filesystem paths are not suggested.

## How it works

`wktree` resolves one checkout as the **canonical root** for a repository. That root is protected and anchors config lookup, default-branch policy, generated paths, and safety checks.

By default, normal worktrees are created beside the root:

```text
<canonical-root>__<branch-name-with-/encoded-as-->
```

Set `worktree_location = "nested"` to create new worktrees under the canonical root instead:

```text
<canonical-root>/.worktrees/<branch-name-with-/encoded-as-->
```

Pooled repositories reuse fixed slots. These are `<canonical-root>__featN` in sibling mode and `<canonical-root>/.worktrees/featN` in nested mode. `add` prepares only its selected slot: it prefers a clean initialized placeholder, otherwise chooses one missing slot or clean uninitialized placeholder. Copy/setup runs once after checking out the requested branch. Unrelated slots are left untouched. Use `--slot <path>` to select a configured slot, including one that is missing; occupied slots retain the usual recycle safety checks, and dirty placeholders require `--force`. Use `ensure` to pre-warm or repair the entire pool explicitly.

`list` only reads Git's registered worktree inventory. It does not load config, scan checkout contents, contact remotes, or run setup, so missing slots stay absent and existing slots remain listable even when setup is broken. `status` inspects pool readiness without repairing it. Pooled `remove` recycles its existing target without initializing any slots.

The setting is a preference for newly created worktrees and missing pool slots. Existing sibling, `.wktree`, and manually located worktrees remain discoverable through Git metadata, so changing the preference does not require migration.

There is no app database. Current state comes from git worktree metadata, filesystem paths, and config. Tmux integration consumes emitted path/session data; it is not the source of truth.

Generated setup scripts live at `<state-root>/wktree/<session>.wktree.*/post-create.sh`. The state root is `XDG_STATE_HOME` only when it is an absolute path; unset, empty or relative values use `$HOME/.local/state`. Wktree retains these directories after setup succeeds or fails; remove unused directories only after confirming no setup command still uses them.

## Basic use

From any path inside a repository worktree set:

```bash
wktree root
wktree add --branch feature/example
wktree list
wktree tree
wktree path --branch feature/example
wktree remove --branch feature/example
# Remove a clean checkout while retaining its branch
wktree remove --branch feature/example --keep-branch
# Delete a clean branch after proving a squash merge into the fetched target
wktree remove --branch feature/example --integrated-into origin/main
# Fuzzy-pick a worktree with fzf and print its path
wktree pick
```

For scripts and agents, prefer JSON where available and branch on the payload `kind`:

```bash
wktree add --branch feature/example --json
wktree list --json
wktree finish --json
wktree finish --title "<subject>" --json   # squash strategy
```

With `--json`, stdout is always a single JSON object and stderr stays silent. Check `ok`: failures carry `ok: false` with a `kind` (`blocked` or `error`) and a machine-readable `reason`. `add` runs the configured setup command before reporting `ready`, capturing its output in `setup_output`, unless `--skip-command` is selected. If setup fails, `add` rolls back and exits `1` with `reason: "setup_failed"`.

For an add using only local Git state, or to omit configured bootstrap:

```bash
wktree add --branch feature/example --no-network
wktree add --branch feature/example --skip-command
wktree add --branch feature/example --no-network --skip-command --json
```

`--no-network` requires Git 2.45+ to suppress on-demand object fetching. It skips `pre_remote_check`, fetching and remote default discovery while retaining the configured add policy using cached refs. `origin_default` starts new default-base branches at cached `origin/<default>` without changing the canonical root. `fresh_canonical` requires a clean canonical root on the default branch and safely fast-forwards it to the cached origin tip before branching; local-ahead or diverged roots still block. Existing branches retain their cached-origin fast-forward attempt, warning and preserving local work if it fails.

The default name must be recorded locally in `origin/HEAD`. When the cached default ref is absent, a known local default committed tip remains usable; `fresh_canonical` still requires a clean root on that branch. Missing metadata or both default refs requires `--base <local-ref>` or `--base-current`, which override default policy and resolve locally. Missing required objects fail instead of being downloaded. Pool recycling and rollback use one commit resolved before slot mutation: cached origin default first, then local default, then an explicit base if neither default is available.

`--skip-command` independently skips bootstrap while retaining copies/symlinks and safety checks. It permits cold pooled allocation without writing an initialization marker. An existing marker remains: it records historical successful pool initialization. An occupied unmarked slot remains occupied and appears among recycling candidates. Successful skipped adds keep `kind: "ready"`; the skipped steps appear in `diagnostics` with `--json` or terminal progress otherwise.

`--no-network` governs Wktree's Git operations. Configured commands and user Git hooks can perform their own network operations; combine `--skip-command` or intervene in those hooks when needed. These flags apply only to `add`; other commands retain their configured behavior.

Use this to see what config applies to the current repository:

```bash
wktree config explain --json
```

## Local feature delivery

`integrate` fast-forwards reviewed task commits into an explicit local feature checkout. A separate `remove --integrated-into-local` proves commit ancestry before deleting the regular task checkout and its branch. Use `finish` for the configured canonical/default-branch lifecycle.

See command help for required revision pins, checkout checks, local default-branch metadata, caller serialization, cleanup and recovery after partial changes:

```bash
wktree integrate --help
wktree remove --help
wktree integrate --schema --json
```

## Worktree ancestry tree

```nu
wktree tree
wktree tree --json
```

`tree` groups worktrees relative to the **repository's default branch**, then infers feature stacks from current Git ancestry. It does not record branch creation history.

```text
Worktrees (default-branch groups; inferred feature stacks, not creation history)
└── main [canonical] [default]
    ├── feature/api [2 ahead, 3 behind]
    │   └── feature/ui = feature/ui-review [same HEAD] [4 ahead, 3 behind]
    └── feature/docs [1 ahead, 1 behind]

Free pool slots (relative to default branch)
├── wk-pool/feat1 [pool:free] [0 ahead, 20 behind]
└── wk-pool/feat2 [pool:free] [0 ahead, 5 behind]
```

The default **name** comes from local `origin/HEAD` metadata, not the canonical checkout or a hardcoded name. The baseline is that branch's local tip, or its cached `origin/<default>` tip when the local branch does not exist. A default without a checkout still appears as the baseline header. This is a local snapshot, not a claim that origin is current.

- Direct children of the default are **baseline grouping**, not proof they descend from its current tip. Independent branches forked from older default commits remain siblings. Already-contained HEADs also stay at this level.
- Below feature branches, nesting means one nearest strict ancestor HEAD among active worktrees with commits outside the default history. A branch based on an older default commit can still parent a stack. Baseline history and free pool slots never become feature parents.
- Equal active HEADs share a node (`=` / `[same HEAD]`); equality does not imply parentage. Free pool slots are displayed separately and flat, including slots with commits ahead of the default.
- Multiple incomparable nearest feature ancestors remain at the top level, marked `?`. HEADs with no common ancestor in local history and bare/unborn worktrees without a HEAD also stay separate. Detached worktrees use their paths as labels.

Counts are commits reachable only from the worktree (`ahead`) or baseline (`behind`), not content-equivalence or squash-merge detection. Merges, rebases and shallow history can change the inferred stacks. Even an inferred edge does not establish which branch a worktree was created from.

Like `list`, `tree` never loads config or runs setup. It requires Git 2.45+ to prevent on-demand fetching and never contacts remotes. Missing local objects and Git errors fail the command rather than becoming uncertainty markers. A committed inventory without a known default fails with `trunk_detection_failed`; set its local designation with `git remote set-head origin <default-branch>` (the named remote-tracking branch must exist). An inventory with no committed HEADs remains displayable without a baseline.

JSON retains `kind: "tree"`, `basis: "git_ancestry"`, and a flat `nodes` array containing every registered worktree, including free slots. `default_branch` supplies `{ branch, ref, head }`, or `null` when there are no committed HEADs. Each node contains:

- `id`: its full commit OID, or worktree path when no commit exists.
- `worktrees`: the same fields as `list --json`. Equal HEADs stay grouped here, even when free and active members are displayed separately in text.
- `comparison`: `{ kind: "related" | "no_common_ancestor", ahead, behind }` against the baseline, or `null` for a missing HEAD. No common ancestor means none was observed locally; shallow history may be incomplete.
- `parentage`: `{ kind: "inferred", head }` for a nearest eligible feature ancestor; `{ kind: "ambiguous", heads }` for incomparable candidates; or `{ kind: "unknown", reason: "no_ancestor" | "no_head" }`. `no_ancestor` means no eligible **feature** parent, not no baseline association.

The text view groups related nodes without an inferred or ambiguous parent beneath the baseline; this grouping is not stored as an inferred `parentage` edge. Free members are selected by `worktrees[].pool.placeholder` and never removed from the JSON inventory.

## Config

Config is optional. Without it, `wktree` still creates deterministic sibling worktrees.

Global config is read only from:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/wktree.toml
```

The default is `~/.config/wktree.toml`. Configuration stays under the config root, separate from generated state.

Repository-local config is read from `.wktree.toml` at the **canonical root** (the path printed by `wktree root`). Commit that file to share setup and policy with the repository. Every worktree uses the canonical file, including commands invoked from a feature worktree or its subdirectories. A same-named file in a feature worktree is ignored; changes take effect when the canonical file changes.

Resolution order:

1. built-in defaults, global `[defaults]` and top-level `worktree_location`;
2. matching `[[rule]]` entries in file order;
3. exact global `[[project]]` entry for the canonical root;
4. repository-local `.wktree.toml`.

Later layers override earlier ones. Omitted local fields inherit the resolved global values. Nested `[finish]` fields merge individually, including explicit `false` values. A local `copy` list replaces the inherited list; `copy = []` disables inherited copying.

`wktree config explain --json` reports global `matched_rules` and `project`, the local file's path and explicit settings in `local_config` when present, effective `add`/`finish`/`worktree_location`, and effective name, pool size and copy settings in `setup`. Local command and hook sources use `local:<canonical-root>/wktree.toml`; inherited values retain their global sources. The text output also shows the local path and effective setup.

### Repository-local configuration

The local file accepts the same repository options as a global project entry: `name`, `command`, `pre_remote_check`, `worktree_location`, `pool_size`, `copy_mode_default`, `copy`, `[add]` and `[finish]`. Every option is optional. Put the options directly in the file:

```toml
command = "bun install"
worktree_location = "nested"
copy = [".env"]

[add]
policy = "origin_default"

[finish]
strategy = "squash"
push = false
```

The local file rejects `defaults`, `rule`, `project`, `root`, `root_glob` and unknown fields. Malformed TOML and invalid options fail with an error identifying the local file. Either file can be absent; an empty local file inherits all global settings. The global file must still be valid on its own.

Local pools, nonempty copy lists and explicitly set `copy_mode_default` require an effective bootstrap command, supplied locally or inherited from a matching global rule/project. For a local copy list, omitted entry modes use local `copy_mode_default`, then the inherited exact project's default, then `copy`; explicit entry modes win. When local `copy` is omitted, inherited entries keep their already-resolved modes, even if local `copy_mode_default` changes.

### Editor completion and validation

Choose the schema for the file you are editing:

| Config file                      | Editor schema                                            |
| -------------------------------- | -------------------------------------------------------- |
| Global XDG config                | [`wktree.schema.json`](./wktree.schema.json)             |
| Canonical-root repository config | [`wktree.local.schema.json`](./wktree.local.schema.json) |

Copy the chosen schema beside your `wktree.toml` or `.wktree.toml`, then place the corresponding directive at the top of the TOML file. For repository-local config:

```toml
#:schema ./wktree.local.schema.json
```

For global config:

```toml
#:schema ./wktree.schema.json
```

[Taplo](https://taplo.tamasfe.dev/configuration/directives.html), including editors using its TOML language server, resolves that path relative to the saved TOML file. Only comments or other directives may precede it. The schema supplies field completion, descriptions, allowed values, and validation of nested tables. Unknown fields are configuration errors.

Once the schemas are available on Wktree's `main` branch, a remotely fetched repository-local schema can use this header instead:

```toml
#:schema https://raw.githubusercontent.com/codethread/wktree/main/wktree.local.schema.json
```

Use `wktree.schema.json` in that URL for global config. The remote URL requires access to that GitHub repository and follows `main`; replace `main` with a published commit SHA to pin the schema to your installed revision. The local-file directive works before publication and without network access.

Both artifacts are [JSON Schema Draft 4](https://taplo.tamasfe.dev/configuration/developing-schemas.html), generated with [Zod's native JSON Schema conversion](https://zod.dev/json-schema) from the same TOML schemas used by the CLI. They describe the input, so fields with defaults remain optional. Runtime loading also checks expanded-root uniqueness, inherited bootstrap requirements and normalized copy destination containment; JSON Schema cannot express those filesystem and cross-entry rules. Effective finish-policy safety is checked when the command runs.

### Global configuration reference

```toml
worktree_location = "sibling" # "sibling" | "nested"; defaults to "sibling"

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
worktree_location = "nested"      # optional override for matching repositories
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
worktree_location = "sibling"     # optional exact-root override
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

- `worktree_location` may be set globally, on a rule, on an exact project, or locally. It controls where new worktrees and missing pool slots are created; registered worktrees keep their actual Git-reported paths. `nested` adds `/.worktrees/` and the previous `/.wktree/` path to the repository's shared exclude file so the canonical checkout remains clean.
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
wktree finish --title "feat: integrate library work" --json
```

The `squash` strategy requires `--title` and accepts an optional `--body`. After the caller's body, Wktree records the source branch and every source commit message, oldest first, prefixing each archived line with `> ` as a Markdown blockquote. Other strategies reject `--title` and `--body`.

Finish checks conflicts before changing canonical, including before `fresh_canonical` advancement. Merge conflicts preserve canonical HEAD, index and worktree and prevent push/cleanup. With `rebase_ff`, conflicts remain in the source checkout; resolve them there or run `git rebase --abort`.

Squash and merge previews require Git's built-in `ort` strategy: nonempty target `branch.<name>.mergeOptions` and `pull.twohead` other than `ort` are refused. During preview, configured custom merge driver commands are replaced by a diagnostic and fatal shell exit using per-invocation Git configuration. Unused drivers are allowed; a merge that needs a custom driver returns `blocked` without executing that driver, including during recursive merge-base calculation. Repository configuration and the drivers used by actual integration remain unchanged. Git hooks still run; a commit-hook failure can leave cleanly merged changes staged. See the [finish contract](devflow/specs/git-worktrees.md#finish-lifecycle).

## Shell picker

`wktree shell-init zsh` and `wktree shell-init nu` print shell integration without requiring a repository. They define just `wk`: a function that runs `wktree --interactive pick` and changes the current shell's directory to the selected worktree. Arguments are forwarded to `pick`; use `wktree` directly for other commands.

### zsh

Add this line to `~/.zshrc`, then restart zsh. After upgrading Wktree, restart zsh or rerun the line to reload `wk`:

```text
eval "$(wktree shell-init zsh)"
```

### Nushell

Generate the module once, and regenerate it after upgrading Wktree:

```nu
wktree shell-init nu | save --force ($nu.default-config-dir | path join "wktree.nu")
```

Add this import to `config.nu`, then restart Nushell:

```nu
use ($nu.default-config-dir | path join "wktree.nu") wk
```

### Use

```nu
wk                         # pick a worktree and cd into it
wk --cwd ~/dev/my-project   # pick from another repository
wk --open                  # focus its multiplexer session instead of changing directory
```

The engine owns selection and multiplexer behaviour; the function only applies the `WKTREE_CD_FILE` handoff. Both shells create the handoff file with the `mktemp` template `<state-root>/wktree/picker.XXXXXX`, using the same [state root](#how-it-works) as setup scripts. The function removes the file after use, including cancellation or failure. These ephemeral handoffs need no migration.

Cancellation or failure leaves the current directory unchanged. Agents and scripts call `wktree` directly and must not pass `--interactive`.
