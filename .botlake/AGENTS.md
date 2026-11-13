# Botlake lake

Install dependencies from the repository root with `bun install --frozen-lockfile`; the root workspace and lockfile own this package. Shared configuration comes from `@botlake/extension-ct-config`. The root checks include lake formatting, linting, and typechecking. After changing `.botlake/lake.ts`, run commands from the repository root: restart only this lake with `botlake lake restart --workspace "$(pwd)"` and inspect the loaded snapshot with `botlake lake info --workspace "$(pwd)"`.
