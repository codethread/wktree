export const HELP = {
	add: `
Use when:
  Creating a branch worktree at a deterministic path, with repository policy,
  configured copies/symlinks, and bootstrap applied before reporting ready.

Notes:
  Without --base, new branches start from the configured policy target. --base
  selects an explicit starting ref; --base-current uses the branch checked out
  in the worktree containing --cwd. --base-current is refused for a detached
  HEAD or combined with --base. Setup failure rolls the add back and exits 1
  with reason setup_failed; with --json, setup output is in setup_output.
  --no-network requires Git 2.45+. It skips pre_remote_check, fetch and remote
  default discovery. Cached refs still follow add policy: origin_default starts
  at cached origin/<default>; fresh_canonical requires a clean root on default
  and safely fast-forwards it to the cached tip. Existing branches attempt their
  normal cached-origin fast-forward, warning and preserving local work on failure.
  With no cached default ref, use the known local default tip; fresh_canonical
  still requires a clean root on default. Missing origin/HEAD metadata or both
  default refs requires --base <local-ref> or --base-current. Explicit bases
  override default policy and resolve locally. Missing local objects fail
  instead of downloading them.
  --skip-command independently omits bootstrap, retaining copies/symlinks and
  safety checks. Skips appear in diagnostics with --json. Configured commands
  and user Git hooks can still contact the network; use --skip-command or
  intervene as needed.

Blocked outcomes:
  Existing checkouts and stale or dirty canonical roots are reported explicitly.
  Success uses kind ready; refusals use blocked and failures use error.
`,
	config: `
Use subcommands to explain the configuration resolved for a repository.

Related:
  config explain --cwd <path> --json
`,
	copy: `
Use when:
  Project copy configuration changed, local tool assets were updated, or a
  worktree needs its untracked setup files materialized again without recreating
  the checkout.

Notes:
  copy targets the non-canonical worktree containing --cwd (the current directory
  by default) and refuses the canonical root. Destinations are engine-managed
  untracked setup paths; reruns replace them from their configured sources.
  copy does not run bootstrap or change branches.
`,
	explain: `
Use when:
  Debugging why add, finish, copy setup, or bootstrap commands behave a
  certain way for a repository.

Notes:
  Global config is read only from $XDG_CONFIG_HOME/wktree.toml
  (default ~/.config/wktree.toml).
  Resolution starts with built-in defaults, applies matching root_glob rules in
  file order, then exact project overrides, then .wktree.toml at the canonical
  root. Omitted local fields inherit global values. Use --json for the matched
  rules, global project, local file, command source, policies, and effective setup.
`,
	finish: `
Use when:
  Work on a branch is complete and should be folded back into the canonical
  target branch with the same lifecycle rules used by creation and cleanup.

Notes:
  finish refuses the canonical root, requires a clean source worktree, fetches,
  requires a clean/fresh target, and checks conflicts before changing canonical,
  including before fresh_canonical advancement. Conflicts prevent push/cleanup;
  rebase_ff leaves conflicts in the source checkout for resolution or rebase --abort.
  Strategy, push, worktree
  cleanup, and branch deletion all come from finish policy in config; use config
  explain to inspect the effective values. Valid strategies are ff_only,
  rebase_ff, squash, and merge_commit. The squash strategy requires --title and
  writes a commit body from --body, the source branch, and every source commit
  message; other strategies reject --title and --body.
  Squash/merge previews require built-in ort: nonempty target branch mergeOptions
  and pull.twohead other than ort are refused. Preview replaces custom merge driver
  commands with a fatal refusal: unused drivers are allowed, but a merge needing
  a custom driver returns blocked without running it, including recursive bases. Integration retains the
  configured drivers. Git hooks remain enabled;
  commit-hook failures can leave cleanly merged changes staged.

Cleanup:
  Configured remove_worktree removes the source worktree only after integration
  and configured push succeed. Configured delete_branch requires remove_worktree
  to be enabled in the same effective policy.

Examples:
  wktree finish
  wktree finish --title "feat: add search"   # squash policy
  wktree config explain --json
`,
	integrate: `
Use when:
  Delivering reviewed task commits into an explicit local feature branch. Run
  inside the task checkout or select it with global --cwd TASK_PATH.

Preconditions:
  --into selects one registered destination. Both checkouts must be distinct,
  clean, unlocked and noncanonical, each on a uniquely checked-out local branch
  other than the default. Live paths, branches and repository identity must match.
  Local origin/HEAD must symbolically designate the default name; it may dangle,
  with no origin remote or cached origin commits. Missing designation fails.
  Both full lowercase OID pins must match current HEADs. The destination must be
  an ancestor of the source. Nonempty destination branch mergeOptions are refused.

Effects:
  Native ff-only integration uses local objects (Git 2.45+) and preserves the
  source. No Wktree setup/finish policy, fetch, push, cleanup or shell/session
  handoff runs. Merge hooks and recursive submodule updates are disabled.
  Native Git filters are not a network sandbox.

Caller sequence:
  Hold qlock --merge-target BRANCH and exclusive source/target checkout use
  through integration, postcondition proof and local cleanup. The queue identity
  does not select the destination. Finish reviews before entering the queue.
  On stale pins, release it, refresh, revalidate/review and requeue.
  After success, see remove --help for --integrated-into-local cleanup.

Receipts:
  --json reports checkout identities and pinned/observed OIDs. Failures can retain
  integrated=true. After integration_attempted=true, absent integrated means
  unknown; target_after_oid is present only if observed. Inspect native Git and
  filesystem state after failure or interruption before repair/retry. Pins and
  receipts do not make the operation atomic; no automatic rollback or retry runs.
  wktree integrate --schema --json exposes integration, cleanup and failure
  envelopes without repository access.
`,
	list: `
Use when:
  Discovering existing worktrees, identifying the canonical root, or inspecting
  branch/path/session identity.

Notes:
  Reads Git's worktree inventory without loading config, scanning checkout
  contents, contacting remotes, or running setup. With --json, the payload's
  worktrees array holds one item per registered worktree.

Related:
  root identifies the protected canonical checkout. path resolves one branch
  to its worktree path. tree infers feature stacks from local Git ancestry.
`,
	overview: `
Purpose:
  Manage deterministic Git worktrees, from creation and setup to safe cleanup.
  add creates and prepares a branch checkout. remove cleans it up without
  integration. finish integrates into the canonical target, then optionally
  pushes and cleans up according to repository policy.

Queries and setup:
  root, list, path and tree inspect repository/worktree identity and ancestry.
  copy reapplies configured untracked files; config explain shows active policy.
  integrate delivers reviewed commits to an explicit local feature checkout.

Automation vs interactive use:
  Scripts and agents call commands directly, use --json where available, and
  omit --interactive. Only --interactive permits multiplexer focus and shell
  directory handoffs. shell-init provides the human wk picker wrapper.

Examples:
  wktree add --branch feature/example
  wktree list
  wktree finish --title "feat: add search"   # squash policy

JSON output:
  Commands supporting --json emit one stdout document on success or failure;
  stderr stays silent. Results include ok and kind; error payloads also carry
  reason and message. Setup output and warnings appear in setup_output and
  diagnostics.

Safety:
  Cleanup protects the canonical root. Read remove --help for branch-deletion
  proofs and force behavior. finish can push and clean up according to policy.

Use wktree <command> --help for command behaviour, flags, and examples.
`,
	path: `
Use when:
  A script or agent needs the expected checkout path for a branch without
  creating, switching, or removing anything.

Notes:
  Returns the actual registered path when the branch is already checked out.
  Otherwise derives its deterministic sibling or nested path from repository
  configuration; it does not create a checkout.
`,
	pick: `
Use when:
  Selecting a worktree with fzf in a terminal. For noninteractive lookup, use
  list or path.

Notes:
  Rows list every worktree, with * marking the one containing --cwd, and preview
  its multiplexer session or recent history. Inside tmux fzf opens in a popup.
  Without --open, the selected path is printed; with --interactive it is also
  written to the file named by WKTREE_CD_FILE so a shell wrapper can change to
  it. --open requires --interactive and a multiplexer session. Cancelling exits
  without output or side effects: 0 with --interactive, otherwise 130.
`,
	remove: `
Use when:
  Cleaning up branch worktrees after work is done or abandoned. Use --branch for
  a named branch, or --self to remove the worktree containing the global --cwd
  path when a wrapper or agent wants to remove the checkout it is operating in.

Ordinary removal:
  The canonical root is protected. Without --force, removal refuses dirty or
  otherwise ambiguous work. Without --keep-branch, it also refuses ahead,
  local-only, or unmerged branches. --keep-branch removes only the clean
  checkout and leaves the branch ref intact. For a clean branch squash-merged
  by a hosting platform, --integrated-into origin/main fetches the
  target and requires its source-relative changes to be content-equivalent before
  removing both checkout and branch. It cannot be combined with --force or
  --keep-branch.

Local feature delivery:
  --self --integrated-into-local BRANCH uses integrate's checkout, default-name
  and full-pin checks; see integrate --help for caller sequencing and schemas.
  Keep --expected-source at the reviewed OID; set --expected-target to the observed
  current destination OID after integration. Cleanup proves source ancestry in
  that target, removes the regular task worktree without force, then deletes its
  branch only if the ref still matches the source pin. No upstream or origin
  history is needed. Combining this mode with --branch, --force, --keep-branch,
  --integrated-into or --interactive is refused.
  Run from a surviving checkout with global --cwd TASK_PATH selecting the source.
  Continue workflow commands from that surviving checkout after removal.
  Failures retain confirmed cleanup_actions, including removal before failed
  branch deletion. Inspect native state before repair/retry; the receipt is not
  an atomic transaction log.

Related:
  finish can integrate a completed worktree and then clean it up as one
  conservative lifecycle operation.

Examples:
  wktree remove --branch feature/example
  wktree remove --branch feature/example --keep-branch
  wktree remove --branch feature/example --integrated-into origin/main
`,
	root: `
Use when:
  You need the repository anchor that wktree uses for config lookup, sibling path
  generation, default-branch policy, and root-protection checks.

Notes:
  The canonical root is never removed by wktree.
`,
	shellInit: `
Setup:
  zsh: add eval "$(wktree shell-init zsh)" to ~/.zshrc.
  Nushell: save wktree shell-init nu to wktree.nu in your config directory,
  then import it with use in config.nu.

Usage:
  wk picks a worktree and changes the current shell's directory.
  Arguments are passed to wktree --interactive pick, not other commands.

Wrapper mode:
  With --interactive, add focuses the new worktree's multiplexer session;
  remove/finish move the caller to the canonical root and close the removed
  worktree's sessions. Directory handoffs are written to the file named by
  WKTREE_CD_FILE for the invoking shell wrapper to apply.
`,
	tree: `
Use when:
  Viewing worktrees relative to the repository default branch, with feature
  stacks inferred from local commit ancestry.

Notes:
  Discovers the default name from local origin/HEAD, not canonical HEAD or a
  hardcoded branch name. Uses its local tip, or cached origin tip if absent.
  Missing default metadata/tips fail; set git remote set-head origin <branch>
  when the remote-tracking branch exists. An inventory without commits needs
  no baseline. The default header can appear even without a checkout.
  Children of the default are baseline groups, not proven ancestry edges.
  Feature nesting uses nearest strict ancestor HEADs with commits outside
  default history; old default snapshots cannot parent stacks.
  Equal HEADs share a node marked "same HEAD". ? marks ambiguous stacks,
  no common ancestor in local history, or no HEAD; these stay separate.
  Ahead/behind counts compare commits with the baseline, not file contents.
  Reads local Git history only (Git 2.45+); no config, setup, or remote access.
  Missing objects and Git errors fail, not become uncertainty. Shallow history,
  merges and rebases can change the view; it is not branch creation history.
  --json retains kind "tree" and all worktrees in nodes, adding default_branch
  and node comparison metadata. parentage describes feature ancestry only;
  default grouping does not assert parentage.
`,
};
