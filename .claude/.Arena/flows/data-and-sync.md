---
scope: electron/main/database.ts, electron/main/sync/*, electron/main/pipe-server.ts, native/crates/{db,sync,services}
updated: 2026-11-11
source: odysseus (2026-11-09-native-rust-directx-full-port); ares (2026-11-11-sync-outbox-write-path-both-engines)
---

# Data and sync flow

1. UI → service call (Electron: `ipcMain.handle`; native: `crates/services`)
2. Service → DB (`database.ts` / `crates/db`), idempotent migrations, no `user_version`
3. Synced write → `sync_outbox` row inside the write's own transaction → after the commit, `flushOutbox` appends the queued lines to the own append-only oplog in the OneDrive sync folder (HLC-stamped)
4. Watcher sees a peer oplog → merge engine → DB rows; todo ids resolved per `.claude/.Arena/specs/todo-sync/spec.md`
5. External writer: named pipe server ← `mcp/lizmeter-todo-mcp.mjs`. Native: `crates/services/src/pipe.rs` runs each command inside `Services::with_db` (same hook, same `retired` guard as the UI) and bumps a change counter the window polls.

| State | Set by | Cleared by | Scope | Stale when |
|-------|--------|------------|-------|------------|
| `lizmeter.db` rows | services, pipe server, merge engine | user deletes, merge tombstones | per device | another process writes the same file |
| `sync_outbox` rows (local table: never in a snapshot, a synced-table list or the oplog) | `recordUpsert` / `recordLink` / `recordDelete` / `SyncHook` inside the row's transaction; enable-sync publish | `flushOutbox` after a successful append (`DELETE ... WHERE seq <= max`); a rolled-back transaction takes its rows with it | per device, local DB | the shared folder is unreachable (rows wait, a "N changes waiting to publish" notice shows), or sync is turned off with rows queued (they stay until sync is on again) |
| `publish-pending` notice | `flushOutbox` on a failed append (one notice, count refreshed) | `flushOutbox` on success or an empty outbox | per device, `sync_notices` | a dismissed notice stays dismissed while the failure continues |
| Own oplog file | `flushOutbox` (sync writer) | retention | per device in shared folder | two processes write with the same device id; a crash between append and outbox delete re-sends lines (peers dedupe by `opId`) |
| HLC / todo-id high-water mark | sync writer, merge | never (monotonic) | per device | a second writer uses the same device id |

## Outbox flow (write path)

```
synced write ─▶ txn { row change + recordUpsert/Link/Delete ─▶ INSERT sync_outbox } ─▶ commit
                                                                                       │
          sync on? ──no──▶ rows wait ◀──────────────────────────────────────────────────┤
              │yes                                                                     
              ▼
        flushOutbox ─▶ read rows ─▶ one append (heal a torn last line first)
              │ ok                         │ fail
              ▼                            ▼
   DELETE rows, clear notice     cut file back to its old length, keep rows,
                                 raise notice with count, retry after 30 s
```

Flush triggers: after each synced write (outermost transaction only, sync on only); startup before the watcher and first merge; 30 s retry timer while rows remain; quit and data-folder move (both only while sync is on); oplog trim and snapshot write flush first. Reads never flush.

## Invariants
- A line is in the shared oplog only if the row change it describes committed: record calls run inside the write's transaction, the file append happens after the commit. A failed write leaves no public line.
- A committed change is never lost to a failed publish: its line stays in `sync_outbox` until an append succeeds. The user's edit succeeds when the folder is unreachable.
- Publishing is at-least-once. Duplicate lines are harmless because peers skip applied `opId`s (`merge-engine.ts`, `sync_applied_ops`).
- A failed append is cut back to the file's earlier length, so no torn fragment stays mid-file. A torn last line from a crash is healed by starting the next append on a new line.
- Flush runs only while `sync.enabled` is true, on every trigger including quit and folder move. Rows queued before sync was turned off wait.
- Enable-sync sets `sync.enabled` and queues every publish line in ONE transaction, then flushes: a crash leaves nothing done or a complete outbox that the startup flush publishes.
- Rollback: an Electron build older than 1.14.4 ignores `sync_outbox`, so lines queued by native at a crash stay unpublished until native or Electron 1.14.4+ runs again. The rollback target is 1.14.4 or newer.
- Both engines keep this identical (proven by the outbox scenarios in `native/tools/sync-equivalence/outbox.mjs`: write fails after record, unreachable then recovers, duplicate flush, enable-sync resume, quit with sync off, failed append undone).
- One process writes a device's DB and oplog. Electron: no guarantee today (`requestSingleInstanceLock` is never called in `electron/main/index.ts`; found in phase 5). Native: single-writer guard (`native/crates/services/src/os/guard.rs`), one direction only: it stops a second native app, and it stops native when it finds a running Electron at start. Electron never checks, so an Electron started after native is a second writer on `%APPDATA%\lizmeter`. The Electron check also runs only when the native per-user folder is `%APPDATA%\lizmeter`: a `--data-dir` profile whose pointer names the folder Electron uses gets no Electron check.
  - Guard: named mutex `Local\LizMeter-DataDir-<hash>` plus an exclusively opened `lizmeter.lock` (and `lizmeter.lock.json` naming the holder pid) in the per-user folder. The custom data folder gets the mutex only: a lock file in a cloud-synced folder would be read as a stray file and uploaded to the peer.
  - Electron detection is read-only: a process snapshot for `LizMeter.exe` with `resources\app.asar` beside it, checked only when the native app uses `%APPDATA%\lizmeter`. A soak copy or test folder is never blocked by a running Electron build.
- A missing custom data folder is never opened at startup. Native: `ensure_data_dir_available` (`services/src/startup.rs`) asks Retry / Use Default / Quit as `ensureDataDirAvailable` does, and `Services::open` refuses a missing custom folder so no empty database is created there.
- During the switch-over, the Rust and TS engines produce identical rows from identical oplogs (proven by `native/tools/sync-equivalence/`).
- Soak mode (`native/crates/services/src/soak.rs`): `%APPDATA%\lizmeter-soak` holds a private copy of the database and device identity, its pointer file names a local test sync folder, and `--soak` refuses any data folder inside OneDrive. It keeps the real device id, so the real sync folder must never be reachable from it: the OneDrive refusal is that barrier.
