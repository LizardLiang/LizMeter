---
scope: electron/main/database.ts, electron/main/sync/*, electron/main/pipe-server.ts, native/crates/{db,sync,services}
updated: 2026-11-09
source: odysseus (2026-11-09-native-rust-directx-full-port)
---

# Data and sync flow

1. UI → service call (Electron: `ipcMain.handle`; native: `crates/services`)
2. Service → DB (`database.ts` / `crates/db`), idempotent migrations, no `user_version`
3. Synced write → own append-only oplog in the OneDrive sync folder (HLC-stamped)
4. Watcher sees a peer oplog → merge engine → DB rows; todo ids resolved per `.claude/.Arena/specs/todo-sync/spec.md`
5. External writer: named pipe server ← `mcp/lizmeter-todo-mcp.mjs`. Native: `crates/services/src/pipe.rs` runs each command inside `Services::with_db` (same hook, same `retired` guard as the UI) and bumps a change counter the window polls.

| State | Set by | Cleared by | Scope | Stale when |
|-------|--------|------------|-------|------------|
| `lizmeter.db` rows | services, pipe server, merge engine | user deletes, merge tombstones | per device | another process writes the same file |
| Own oplog file | sync writer | retention | per device in shared folder | two processes write with the same device id |
| HLC / todo-id high-water mark | sync writer, merge | never (monotonic) | per device | a second writer uses the same device id |

## Invariants
- One process writes a device's DB and oplog. Electron: no guarantee today (`requestSingleInstanceLock` is never called in `electron/main/index.ts`; found in phase 5). Native: single-writer guard (`native/crates/services/src/os/guard.rs`) across both builds.
  - Guard: named mutex `Local\LizMeter-DataDir-<hash>` plus an exclusively opened `lizmeter.lock` (and `lizmeter.lock.json` naming the holder pid) in the per-user folder. The custom data folder gets the mutex only: a lock file in a cloud-synced folder would be read as a stray file and uploaded to the peer.
  - Electron detection is read-only: a process snapshot for `LizMeter.exe` with `resources\app.asar` beside it, checked only when the native app uses `%APPDATA%\lizmeter`. A soak copy or test folder is never blocked by a running Electron build.
- During the switch-over, the Rust and TS engines produce identical rows from identical oplogs (proven by `native/tools/sync-equivalence/`).
- Soak mode (`native/crates/services/src/soak.rs`): `%APPDATA%\lizmeter-soak` holds a private copy of the database and device identity, its pointer file names a local test sync folder, and `--soak` refuses any data folder inside OneDrive. It keeps the real device id, so the real sync folder must never be reachable from it: the OneDrive refusal is that barrier.
