# Implementation Notes — #941 real SQLite verification

## Summary

Added a plain-Node verification path that bundles the production database and sync modules with
esbuild, substitutes a minimal Electron `app.getPath` stub, and deliberately leaves
`better-sqlite3` external so Node loads the real native driver. The pre-push hook runs this focused
check on every branch before retaining the existing full Vitest run on `master` and `main`.

## Fail-Then-Pass Evidence

- RED: `bun run verify:real-db` exited 1 with `Script not found "verify:real-db"` before implementation.
- GREEN: `bun run verify:real-db` exited 0 and reported all three real-driver cases passed.

## Coverage

- A raw boolean reaches the production `applyFieldsLww` path through `applyOplogEntries`.
- A raw boolean reaches the production `applySessionUpsert` path through `applyOplogEntries`.
- `reconcileTodoIds` performs a 1↔2 swap that requires its negative-ID parking phase.

## Deviations

None.
