# Conditional Commands Plan

**Feature:** `conditional-commands`
**Proposal:** [proposal.md](./proposal.md)
**RFC:** None
**Root specs:** [git-worktrees.md](../../specs/git-worktrees.md)
**Feature specs:** [specs/git-worktrees.delta.md](./specs/git-worktrees.delta.md)
**Status:** Shipped
**Last Updated:** 2026-06-23

## 1. Goal and scope

Deliver inherited bootstrap commands for root-glob rules so broad defaults such as `~/dev/projects/**` can prepare new worktrees without exact project entries. The feature keeps command bodies as opaque Bash and uses project-level commands only for exact overrides.

## 2. Approach

Extend the existing config and policy-resolution path rather than adding a new setup rule family. `[[rule]]` gains an optional `command` field, parsed with the same non-empty string validation as `[[project]].command`. The effective configuration for a canonical root should include both policy and bootstrap command resolution.

Introduce a small command-resolution shape instead of threading raw nullable strings everywhere. It should capture the selected command and its source, e.g. built-in none, matching rule glob, or exact project. `explainPolicy` can either be renamed conceptually or kept as the existing exported function while returning additional bootstrap fields. Existing policy semantics must remain unchanged.

Update worktree creation paths to use the effective command, not only `project.command`. For non-pooled adds, rule-only repositories should generate a post-create script even when there is no exact project. Copy setup remains exact-project-only and still runs before the command. For pooled projects, inherited commands can satisfy the required setup command if the exact project has `pool_size`/`copy` but no local command.

Keep the generated script API stable. To avoid manufacturing fake full `ProjectConfig` objects for rule-only roots, change script generation inputs to accept project/display name and command explicitly, while preserving the exported `PostCreateScriptSpec` and `generatePostCreateScript` behavior.

Extend `config explain` so users can see why a command will or will not run. JSON should include enough detail for debugging inherited setup. Human output should remain concise.

## 3. Affected areas

| Area | Expected change |
| --- | --- |
| `src/types.ts` | Add `command` to `PolicyRule`; add effective command/source types if helpful. |
| `src/config.ts` | Parse/validate `[[rule]].command`; resolve effective command source alongside policies. |
| `src/main.ts` | Use effective command when writing post-create scripts for non-pooled and pooled flows; update config explain payload/output. |
| `tests/wktree.test.ts` | Add parser, resolver, explain, non-pooled add, and pooled inherited-command coverage. |
| `devflow/specs/git-worktrees.md` / README | Update durable config docs when implementation ships. |

## 4. Contract and migration impact

This is additive for existing configs. Existing exact `[[project]].command` behavior continues to win. Existing `[[rule]]` policy patches continue to work. The root spec needs revision because it currently says rules are policy selectors only and exact projects are the sole home for bootstrap commands.

Potential JSON additions to `config explain --json` should be treated as additive. Do not remove existing fields.

## 5. Implementation phases

### Phase 1: Config parsing and resolution

Outcome: `parseConfig` accepts non-empty `[[rule]].command`; invalid empty commands fail loudly; effective command resolution respects defaults/rules/project precedence and exposes source metadata.

### Phase 2: Bootstrap integration

Outcome: non-pooled and pooled add/ensure paths generate and run scripts from inherited commands where applicable, while copy setup and exact project override behavior remain unchanged.

### Phase 3: Explain and documentation

Outcome: `config explain` reports effective bootstrap command metadata; README and root spec describe rule-inherited commands and the Bash conditional pattern.

## 6. Validation strategy

- Run `bun test tests`.
- Run `bun run typecheck`.
- Run `bun run check`.
- Add focused tests for config parsing/resolution and explain output.
- Add integration-style tests proving a rule-only matched repo returns a post-create script and exact project command overrides the rule command.
- For Nushell files no syntax validation is expected unless wrapper behavior changes.

## 7. Risks and open questions

- Risk: `findProjectForRoot` currently gates pooled/copy behavior, while rule-only command behavior needs effective config even without a project. Mitigation: keep project lookup for project-only features but use effective command resolution for script generation.
- Risk: pooled code currently assumes `project.command`. Mitigation: compute the effective command once per canonical root and pass it explicitly into pool setup helpers.
- Risk: inherited commands may surprise users. Mitigation: config explain must show command source clearly and docs should emphasize glob scope.
- Open question: whether to support disabling inherited commands for one exact project. Defer unless needed.

## 8. Task context

Council recommended the smallest design: optional `command` on existing `[[rule]]`, no TOML conditional DSL. Bash remains the setup language, so the user's lockfile example should be documented as a multi-line command body.

Important anchors: `src/config.ts` (`parseRuleConfig`, `explainPolicy`), `src/main.ts` (`addCommand`, `ensurePool`, `allocatePooledSlot`, `writePostCreateScript`, `configCommand`), `src/types.ts`, and `tests/wktree.test.ts`.

## 9. Developer Notes

### Planning: initial plan — 2026-06-23

- Feature direction was reviewed by council. Consensus: implement rule-level command inheritance and avoid conditional TOML syntax.

### Implementation: rule command inheritance — 2026-06-23

- Added `[[rule]].command`, effective command resolution, config explain command metadata, non-pooled rule-only bootstrap support, and inherited command support for pooled/copy setup.
- Validation passed: `bun test tests`, `bun run typecheck`, `bun run check`.

### Finish: shipped and archived — 2026-06-23

- Shipped full planned scope: rule-level inherited bootstrap commands, exact project override, pooled/copy effective command handling, config explain metadata, tests, README, and root spec updates.
- No cut or deferred scope. Explicit inherited-command disabling remains intentionally out of MVP scope.
