//! The top-level sync orchestrator (`sync-manager.ts`): starts the watcher and periodic re-scan,
//! exposes status/enable/disable, and wires the Data Location "Change Folder" flow to sync setup via a
//! pending-action marker that survives the move-then-relaunch flow.

use crate::device_identity::{get_or_assign_device_number, register_device};
use crate::hlc::now_ms;
use crate::merge_pass::run_merge_pass;
use crate::migration::{
    count_block_allocated_todos, enable_sync_on_existing_machine, renumber_block_allocated_todo_ids,
};
use crate::notices::{add_sync_notice, dismiss_sync_notice, list_sync_notices};
use crate::oplog::{get_sync_devices_dir, OPLOG_SUFFIX};
use crate::pending_action::{
    clear_pending_sync_action, consume_pending_sync_action, write_pending_sync_action, PendingSyncAction,
};
use crate::snapshot::{get_last_synced_at, is_stale, mark_synced_now, rebuild_from_snapshot, write_snapshot_if_due};
use crate::stray_files::scan_for_stray_files;
use crate::sync_writer::SyncWriter;
use crate::watcher::{start_watching, SyncWatcher, PERIODIC_RESCAN};
use crate::{Result, SyncError};
use lizmeter_core::{
    RenumberOutcome, RenumberPair, RenumberStatus, SyncDeviceInfo, SyncHalted, SyncNotice, SyncNoticeKind, SyncStatus,
};
use lizmeter_db::data_location::DB_FILE_NAME;
use lizmeter_db::{is_sync_enabled, set_sync_enabled, Database};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

/// FR-031: quiet by default, one OS notification for exactly the cases the user must act on.
pub trait Notifier: Send + Sync {
    fn notify(&self, title: &str, body: &str);
}

/// Drops every notification. For tests and headless runs.
pub struct NoNotifier;

impl Notifier for NoNotifier {
    fn notify(&self, _: &str, _: &str) {}
}

#[derive(Default)]
struct State {
    last_synced_at: Option<String>,
    halted_reason: Option<String>,
}

/// Replaces the merge pass. Tests use it to force a pass failure.
pub type MergePassFn = Box<dyn Fn(&Connection) -> Result<crate::merge_engine::ApplyResult> + Send + Sync>;

pub struct SyncManager {
    merge_override: Mutex<Option<MergePassFn>>,
    db: Arc<Mutex<Database>>,
    writer: SyncWriter,
    user_data_dir: PathBuf,
    db_path: Option<PathBuf>,
    notifier: Arc<dyn Notifier>,
    on_todos_changed: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    state: Mutex<State>,
    watcher: Mutex<Option<SyncWatcher>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl SyncManager {
    /// `db_path` is `None` for an in-memory database. `writer.data_dir()` is the shared folder.
    pub fn new(
        db: Arc<Mutex<Database>>,
        writer: SyncWriter,
        user_data_dir: PathBuf,
        db_path: Option<PathBuf>,
        notifier: Arc<dyn Notifier>,
    ) -> Arc<SyncManager> {
        Arc::new(SyncManager {
            merge_override: Mutex::new(None),
            db,
            writer,
            user_data_dir,
            db_path,
            notifier,
            on_todos_changed: Mutex::new(None),
            state: Mutex::new(State::default()),
            watcher: Mutex::new(None),
        })
    }

    #[doc(hidden)]
    pub fn set_merge_pass_for_testing(&self, merge: Option<MergePassFn>) {
        *lock(&self.merge_override) = merge;
    }

    /// A callback the caller wires up once, so this module never reaches into the UI.
    pub fn set_todos_changed_callback(&self, callback: Arc<dyn Fn() + Send + Sync>) {
        *lock(&self.on_todos_changed) = Some(callback);
    }

    fn data_dir(&self) -> &Path {
        self.writer.data_dir()
    }

    fn notify_todos_changed(&self) {
        let callback = lock(&self.on_todos_changed).clone();
        if let Some(cb) = callback {
            cb();
        }
    }

    /// One merge pass. Never returns an error: every failure is recorded as a halt plus a notice.
    pub fn run_merge_pass_safely(&self) {
        let todos_changed = {
            let db = lock(&self.db);
            self.run_pass_locked(db.conn())
        };
        if todos_changed {
            self.notify_todos_changed();
        }
    }

    fn halt(&self, conn: &Connection, reason: String, notice: Option<(SyncNoticeKind, &str, Option<&str>)>, notify: bool) {
        let is_new_halt = {
            let mut state = lock(&self.state);
            let fresh = state.halted_reason.is_none();
            state.halted_reason = Some(reason.clone());
            fresh
        };
        // Only raise a notice (and notify) on the transition into "halted", not on every 30-second
        // retry while still blocked: FR-031 wants silence except when the user must act.
        if is_new_halt {
            if let Some((kind, message, detail)) = notice {
                let _ = add_sync_notice(conn, kind, message, detail);
            }
            if notify {
                self.notifier.notify("LizMeter sync paused", &reason);
            }
        }
    }

    fn run_pass_locked(&self, conn: &Connection) -> bool {
        if !is_sync_enabled(conn).unwrap_or(false) {
            return false;
        }
        let data_dir = self.data_dir();
        let device_id = self.writer.device_id();
        let mut todos_changed = false;

        let outcome: Result<()> = (|| {
            // FR-032: reported, never blocking.
            scan_for_stray_files(conn, data_dir)?;

            if is_stale(conn, now_ms())? {
                if rebuild_from_snapshot(conn, data_dir, device_id, self.db_path.as_deref(), now_ms())? {
                    todos_changed = true;
                    self.notifier.notify(
                        "LizMeter sync",
                        "This machine was offline for a long time and rebuilt from the latest snapshot. Check Settings for details.",
                    );
                }
            } else {
                let result = match lock(&self.merge_override).as_ref() {
                    Some(merge) => merge(conn)?,
                    None => run_merge_pass(conn, data_dir, device_id)?,
                };
                if result.applied > 0 {
                    todos_changed = true;
                }
                if result.notices > 0 {
                    let body = if result.notices == 1 {
                        "One edit was discarded during sync. Check Settings for details.".to_string()
                    } else {
                        format!("{} edits were discarded during sync. Check Settings for details.", result.notices)
                    };
                    self.notifier.notify("LizMeter sync", &body);
                }
            }
            mark_synced_now(conn, now_ms())?;
            write_snapshot_if_due(conn, data_dir, device_id, now_ms())?;
            Ok(())
        })();

        match outcome {
            Ok(()) => {
                let mut state = lock(&self.state);
                state.halted_reason = None; // recovered from a previous halt
                state.last_synced_at = Some(lizmeter_db::util::now_iso());
            }
            Err(err @ SyncError::NotFullyHydrated { .. }) => {
                let message = err.to_string();
                self.halt(conn, message.clone(), Some((SyncNoticeKind::PlaceholderBlocked, &message, None)), true);
            }
            Err(err @ SyncError::RebuildBackupFailed(_)) => {
                // Fail-safe for data: the backup is written before the wipe opens, so nothing changed.
                let message = err.to_string();
                self.halt(
                    conn,
                    message.clone(),
                    Some((
                        SyncNoticeKind::StaleMachineRebuild,
                        "This machine needed to rebuild from the latest snapshot, but the safety backup could not be written, so nothing was changed.",
                        Some(&message),
                    )),
                    true,
                );
            }
            Err(err) => {
                // Every other error halts too, with the same dedupe: the underlying message is the
                // whole diagnosis, so it goes in the notice detail.
                let message = err.to_string();
                self.halt(
                    conn,
                    message.clone(),
                    Some((
                        SyncNoticeKind::MergeFailed,
                        "A recent change could not be merged, so sync is paused until this is resolved.",
                        Some(&message),
                    )),
                    true,
                );
            }
        }
        todos_changed
    }

    /// Starts the watcher and periodic re-scan. A strict no-op when sync has never been turned on.
    pub fn start(self: &Arc<Self>) -> Result<()> {
        self.start_with_interval(PERIODIC_RESCAN)
    }

    pub fn start_with_interval(self: &Arc<Self>, periodic: Duration) -> Result<()> {
        let enabled = is_sync_enabled(lock(&self.db).conn())?;
        if !enabled {
            return Ok(());
        }
        self.run_merge_pass_safely();
        let me = Arc::clone(self);
        let watcher = start_watching(self.data_dir(), Arc::new(move || me.run_merge_pass_safely()), periodic)?;
        let previous = lock(&self.watcher).replace(watcher);
        if let Some(w) = previous {
            w.stop();
        }
        Ok(())
    }

    pub fn stop(&self) {
        // Taken out of the mutex first: stopping joins the worker, which may be mid-pass.
        let watcher = lock(&self.watcher).take();
        if let Some(w) = watcher {
            w.stop();
        }
    }

    pub fn get_sync_status(&self) -> Result<SyncStatus> {
        let db = lock(&self.db);
        let conn = db.conn();
        let mut stmt = conn
            .prepare("SELECT device_id, device_number, last_seen_at FROM sync_devices ORDER BY first_seen_at ASC")?;
        let devices = stmt
            .query_map([], |r| {
                Ok(SyncDeviceInfo { device_id: r.get(0)?, device_number: r.get(1)?, last_seen_at: r.get(2)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let state = lock(&self.state);
        Ok(SyncStatus {
            enabled: is_sync_enabled(conn)?,
            // Falls back to the persisted setting before the first pass of this run completes.
            last_synced_at: match &state.last_synced_at {
                Some(s) => Some(s.clone()),
                None => get_last_synced_at(conn)?,
            },
            halted: state.halted_reason.clone().map(|reason| SyncHalted { reason }),
            devices,
        })
    }

    pub fn list_notices(&self, include_dismissed: bool) -> Result<Vec<SyncNotice>> {
        list_sync_notices(lock(&self.db).conn(), include_dismissed)
    }

    pub fn dismiss_notice(&self, id: i64) -> Result<()> {
        dismiss_sync_notice(lock(&self.db).conn(), id)
    }

    pub fn disable_sync(&self) -> Result<()> {
        self.stop();
        set_sync_enabled(lock(&self.db).conn(), false)?;
        Ok(())
    }

    /// How many todos still carry a number the retired block scheme handed out.
    pub fn get_pending_renumber_count(&self) -> Result<i64> {
        count_block_allocated_todos(lock(&self.db).conn())
    }

    /// Folds this machine's block-allocated todo ids into the dense sequence, once, on request.
    /// Refuses without an explicit `confirm`: it rewrites numbers the user may have referenced
    /// elsewhere and cannot be undone except from the backup it takes.
    pub fn renumber_legacy_todo_ids(&self, confirm: bool) -> Result<RenumberOutcome> {
        let outcome = {
            let db = lock(&self.db);
            let conn = db.conn();
            let count = count_block_allocated_todos(conn)?;
            if count == 0 {
                return Ok(RenumberOutcome {
                    status: RenumberStatus::NothingToDo,
                    count: 0,
                    renumbered: Vec::new(),
                    backup_path: None,
                });
            }
            if !confirm {
                return Ok(RenumberOutcome {
                    status: RenumberStatus::ConfirmRequired,
                    count,
                    renumbered: Vec::new(),
                    backup_path: None,
                });
            }
            let result = renumber_block_allocated_todo_ids(conn, &self.writer, self.db_path.as_deref())?;
            RenumberOutcome {
                status: RenumberStatus::Done,
                count: result.renumbered.len() as i64,
                renumbered: result.renumbered.iter().map(|(from, to)| RenumberPair { from: *from, to: *to }).collect(),
                backup_path: result.backup_path.map(|p| p.to_string_lossy().into_owned()),
            }
        };
        self.notify_todos_changed();
        Ok(outcome)
    }

    /// Step 1 of 2, called at the very start of a launch, before the database opens.
    pub fn consume_pending_sync_action(&self) -> Option<PendingSyncAction> {
        consume_pending_sync_action(&self.user_data_dir)
    }

    pub fn write_pending_sync_action(&self, action: &PendingSyncAction) -> Result<()> {
        write_pending_sync_action(&self.user_data_dir, action)
    }

    pub fn clear_pending_sync_action(&self) {
        clear_pending_sync_action(&self.user_data_dir)
    }

    /// Called before `move_data_to` runs, so the decision is captured while the database is open.
    /// `None` for an ordinary relocate with nothing sync-relevant to do.
    pub fn decide_pending_sync_action(&self, target_dir: &Path) -> Result<Option<PendingSyncAction>> {
        if target_has_other_devices_data(target_dir, self.writer.device_id()) {
            return Ok(Some(PendingSyncAction::Adopt { target_dir: target_dir.to_path_buf() }));
        }
        let db = lock(&self.db);
        let conn = db.conn();
        if has_any_syncable_local_data(conn)? && !is_sync_enabled(conn)? {
            return Ok(Some(PendingSyncAction::Enable));
        }
        Ok(None)
    }

    /// Step 2 of 2, called right after the database opens at the start of a launch.
    pub fn apply_pending_sync_action_after_init(&self, pending: Option<&PendingSyncAction>) -> Result<()> {
        let Some(pending) = pending else {
            return Ok(());
        };
        let mut db = lock(&self.db);
        db.set_sync_hook(Box::new(self.writer.clone()));
        let conn = db.conn();

        match pending {
            PendingSyncAction::Enable => {
                // This machine's live database was already relocated to private storage by the move
                // handler: `data_dir` names the shared folder it publishes into.
                enable_sync_on_existing_machine(conn, self.db_path.as_deref(), self.data_dir(), &self.writer)?;
                // Without this, `is_stale` reads lastSyncedAt as null forever when the first merge
                // pass throws before reaching its own mark.
                mark_synced_now(conn, now_ms())?;
            }
            PendingSyncAction::Adopt { .. } => {
                // The launch already marked this device adopted, moved any prior database aside, and
                // opened a fresh private database, so the rebuild below has nothing of this device's own to lose.
                set_sync_enabled(conn, true)?;
                let data_dir = self.data_dir();
                let device_id = self.writer.device_id();
                let rebuilt = rebuild_from_snapshot(conn, data_dir, device_id, self.db_path.as_deref(), now_ms())?;
                if !rebuilt {
                    // No snapshot published anywhere yet: replay every peer's full oplog.
                    run_merge_pass(conn, data_dir, device_id)?;
                }
                // An adopt's target is never virgin, so the number was already drawn at random
                // while applying entries; this reads it back so it can be registered.
                let device_number = get_or_assign_device_number(conn, Some(data_dir))?;
                register_device(conn, device_id, device_number)?;
                mark_synced_now(conn, now_ms())?;
            }
        }
        Ok(())
    }
}

/// Todos and sessions are the "does this machine have real work worth protecting" signal: states and
/// projects always hold seeded defaults, even on a brand new install.
fn has_any_syncable_local_data(conn: &Connection) -> Result<bool> {
    for table in ["todos", "sessions"] {
        let count: i64 = conn.query_row(&format!("SELECT COUNT(*) AS count FROM {table}"), [], |r| r.get(0))?;
        if count > 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

/// True when `target_dir` already holds another device's oplog: the FR-017 onboarding trigger.
fn target_has_other_devices_data(target_dir: &Path, my_id: &str) -> bool {
    let dir = get_sync_devices_dir(target_dir);
    match std::fs::read_dir(&dir) {
        Err(_) => false,
        Ok(entries) => entries.flatten().any(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.ends_with(OPLOG_SUFFIX) && !name.starts_with(my_id)
        }),
    }
}

/// R2-B1: the refusal that guards adoption. Picking a folder that holds another machine's history
/// must never be enough by itself to discard this device's working set.
pub fn requires_adopt_confirmation(pending: Option<&PendingSyncAction>, confirm_adopt: bool) -> bool {
    matches!(pending, Some(PendingSyncAction::Adopt { .. })) && !confirm_adopt
}

/// The sibling guard: enabling sync into a folder that already holds a real `lizmeter.db` would
/// silently orphan that database, so the user must say so first.
pub fn requires_unsynced_db_confirmation(
    pending: Option<&PendingSyncAction>,
    target_dir: &Path,
    confirm_unsynced_db: bool,
) -> bool {
    if !matches!(pending, Some(PendingSyncAction::Enable)) || confirm_unsynced_db {
        return false;
    }
    target_dir.join(DB_FILE_NAME).exists()
}
