# Sync equivalence harness

Proves the Rust sync engine (`native/crates/sync`) and the TypeScript engine (`electron/main/sync/`)
produce the same rows from the same oplogs. The TypeScript side runs under node with real
better-sqlite3, never the Vitest sql.js shim (the shim accepts boolean binds that real better-sqlite3
rejects).

## Run

```
cd native && cargo build -p lizmeter-sync --bin sync_cli
cd .. && node native/tools/sync-equivalence/run.mjs [--tmp <dir>] [--keep] [--fuzz 6] [--rounds 6]
```

- Needs a Node-ABI better-sqlite3 at `<OS temp>/node_modules/better-sqlite3`. The repo copy is built
  for Electron. `scripts/verify-real-better-sqlite3.mjs` depends on the same copy.
- Every path is under `--tmp` (default: a new folder in the OS temp directory). The script refuses a
  `--tmp` that looks like `%APPDATA%` or OneDrive and never reads `%APPDATA%/lizmeter` or the real sync
  folder.
- Exit code 0 means every comparison matched.

## What it checks

| Part | Input | Compared |
|---|---|---|
| (a) fixtures | `fixtures.ts`: one hand-written scenario (a case per merge rule) and 6 seeded fuzz scenarios, two phases each | merge counts per pass, then every synced table, field clocks, tombstones, aliases, applied ops, notices, `sync.nextTodoId`, and the snapshot entries each engine builds |
| (b) mixed run | one TypeScript device and one Rust device on one shared folder, random edits on both sides for several rounds | after every round: todos (ids included), states, projects, labels, tags, sessions, links, attachments, tombstone identities |
| (b) adopt | a snapshot written by each engine | a fresh Rust device and a fresh TypeScript device rebuilt from the mixed folder must match each other |

## What is left out, and why

- Device-local ids and `position`: only uuids and `sync_order` are shared. Foreign keys are compared as uuids.
- Wall-clock columns (`deleted_at`, `applied_at`, notice `created_at`): they differ by run time.
- Mixed run only: field clocks, aliases, applied ops, notices and the id watermark. A field the author wrote
  but a peer could not resolve yet (a parent deleted meanwhile) is clocked only on the author. Part (a)
  compares those tables.
- Mixed run only: tombstone clocks. Two devices that delete the same row each keep the other device's
  tombstone clock.

## Known behavior the harness shows in both engines

A todo whose parent has a higher id than the todo itself loses its parent link when a device rebuilds from
a snapshot (adopt, or a stale-machine rebuild). Snapshot entries apply in row order, the parent does not
exist yet, the entry stays unmarked, and nothing re-reads a snapshot. Both engines do this. It is logged in
`.claude/.Arena/debt.md`.
