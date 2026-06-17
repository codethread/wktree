# Contributing

## Setup

```bash
bun install
```

This installs the TypeScript toolchain, Biome, Husky, and lint-staged. Husky installs the repository pre-commit hook via the `prepare` script.

## Required local tools

Maintainers need to install `nufmt` themselves. It is intentionally not installed by this repository, but the pre-commit hook expects it to be available on `PATH` when committing Nushell files.

Nushell syntax validation also uses `nu-check` through `nu`, so make sure your Nushell environment provides that command.

Check your installs with:

```bash
nufmt --version
nu -c 'nu-check --help'
```

## Pre-commit checks

The pre-commit hook mirrors the local formatting workflow from the dots repository:

- skips rebase and cherry-pick intermediate commits;
- formats staged TypeScript and JSON files with Biome through lint-staged;
- formats staged Nushell files with `nufmt` through lint-staged;
- validates staged Nushell modules with `nu-check --debug --as-module`;
- re-stages formatter changes before the commit proceeds.

## Useful commands

```bash
bun test tests
bun run typecheck
bun run check
bun run build
```
