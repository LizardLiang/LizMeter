//! lizmeter-services: one Rust API in place of the Electron IPC channels.
//!
//! [`Services`] owns the database, the sync engine, the attachment store, the Claude Code tracker
//! and the OS host. Every channel in `electron/preload/index.ts` that belongs to the service
//! layer is a typed method here and is also reachable by name through [`Services::dispatch`]
//! (same argument order as the preload call, JSON in and out). Channels owned by later phases
//! (the widget) are listed in [`channels`].

pub mod attachments;
pub mod avatars;
pub mod channels;
pub mod claude_tracker;
mod dispatch;
mod error;
mod issues;
pub mod pipe;
pub mod soak;
pub mod providers;
pub mod tokens;
pub mod os;
mod startup;
pub mod worklog_merge;

pub use error::{Result, ServiceError};
pub use startup::{ensure_data_dir_available, DataDirChoice, StartupReport};

use claude_tracker::{ClaudeTracker, PollOutput, ScanResult};
use error::fail;
use lizmeter_core::*;
use lizmeter_db::attachment_url::{attachment_kind_for_ext, ext_from_file_name};
use lizmeter_db::data_location::{DataLocation, MoveDataResult, MoveOptions};
use lizmeter_db::{is_sync_enabled, CreateTodoAttachmentInput, Database};
use lizmeter_sync::pending_action::PendingSyncAction;
use lizmeter_sync::sync_manager::{requires_adopt_confirmation, requires_unsynced_db_confirmation, SyncManager};
use lizmeter_sync::SyncWriter;
use os::Host;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// `Number.parseInt(s, 10)`: the leading integer, or `None` for NaN.
fn leading_int(s: &str) -> Option<i64> {
    let t = lizmeter_db::util::js_trim(s);
    let (neg, rest) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let n: i64 = digits.parse().ok()?;
    Some(if neg { -n } else { n })
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct Services {
    pub(crate) db: Arc<Mutex<Database>>,
    pub(crate) location: Arc<DataLocation>,
    pub(crate) sync: Arc<SyncManager>,
    pub(crate) writer: SyncWriter,
    pub(crate) host: Arc<dyn Host>,
    pub(crate) tracker: Mutex<ClaudeTracker>,
    /// Set while the database handle is out of service: during a data-folder move, and after a
    /// successful one until the relaunch. A failed reopen leaves it set.
    pub(crate) retired: Arc<AtomicBool>,
    /// Single-writer guards, held until this value drops.
    pub(crate) guards: Mutex<Vec<os::guard::SingleWriterGuard>>,
    /// Issue-tracker tokens, endpoints and result caches.
    pub(crate) hub: issues::Hub,
    /// The music library, playlists, cache, binaries and the player.
    pub(crate) music: Arc<lizmeter_music::MusicService>,
}

impl Services {
    /// Runs `f` on the open database. Fails once the data folder has been moved and the app is
    /// about to relaunch.
    pub fn with_db<T>(&self, f: impl FnOnce(&Database) -> Result<T>) -> Result<T> {
        let guard = lock(&self.db);
        // Checked under the lock: a move sets the flag while it holds the lock to swap the handle.
        if self.retired.load(Ordering::SeqCst) {
            return fail("LizMeter is restarting to use the new data folder");
        }
        f(&guard)
    }

    /// The music backend. The UI drives playback and the library through it directly; the
    /// `music:*` channels of [`Services::dispatch`] call the same methods.
    pub fn music(&self) -> &Arc<lizmeter_music::MusicService> {
        &self.music
    }

    pub fn sync_manager(&self) -> &Arc<SyncManager> {
        &self.sync
    }

    pub fn host(&self) -> &Arc<dyn Host> {
        &self.host
    }

    pub fn data_dir(&self) -> PathBuf {
        self.location.get_data_dir()
    }

    // --- Sessions ---

    pub fn save_session(&self, input: &SaveSessionInput) -> Result<Session> {
        self.with_db(|db| Ok(db.save_session(input)?))
    }

    pub fn save_session_with_tracking(&self, input: &SaveSessionWithTrackingInput) -> Result<Session> {
        self.with_db(|db| Ok(db.save_session_with_tracking(input)?))
    }

    pub fn list_sessions(&self, input: &ListSessionsInput) -> Result<ListSessionsResult> {
        self.with_db(|db| Ok(db.list_sessions(input)?))
    }

    pub fn update_session_duration(&self, id: &str, actual_duration_seconds: i64) -> Result<Session> {
        self.with_db(|db| Ok(db.update_session_duration(id, actual_duration_seconds)?))
    }

    pub fn delete_session(&self, id: &str) -> Result<()> {
        self.with_db(|db| Ok(db.delete_session(id)?))
    }

    /// `worklog:mark-logged`: marks uploadable sessions as logged without a Jira call.
    pub fn mark_worklog_logged(&self, session_ids: &[String], worklog_id: &str) -> Result<()> {
        self.with_db(|db| {
            for id in session_ids {
                if let Some(session) = db.get_session_by_id(id)? {
                    if matches!(session.timer_type, TimerType::Work | TimerType::Stopwatch) {
                        db.update_worklog_status(id, WorklogStatus::Logged, Some(worklog_id))?;
                    }
                }
            }
            Ok(())
        })
    }

    // --- Settings ---

    pub fn get_settings(&self) -> Result<TimerSettings> {
        self.with_db(|db| Ok(db.get_settings()?))
    }

    pub fn save_settings(&self, settings: &TimerSettings) -> Result<()> {
        self.with_db(|db| Ok(db.save_settings(settings)?))
    }

    pub fn get_setting_value(&self, key: &str) -> Result<Option<String>> {
        self.with_db(|db| Ok(db.get_setting_value(key)?))
    }

    /// `settings:set-value`: a `None` value deletes the key.
    pub fn set_setting_value(&self, key: &str, value: Option<&str>) -> Result<()> {
        self.with_db(|db| {
            match value {
                None => db.delete_setting_value(key)?,
                Some(v) => db.set_setting_value(key, v)?,
            }
            Ok(())
        })
    }

    // --- Tags ---

    pub fn create_tag(&self, input: &CreateTagInput) -> Result<Tag> {
        self.with_db(|db| Ok(db.create_tag(input)?))
    }

    pub fn list_tags(&self) -> Result<Vec<Tag>> {
        self.with_db(|db| Ok(db.list_tags()?))
    }

    pub fn update_tag(&self, input: &UpdateTagInput) -> Result<Tag> {
        self.with_db(|db| Ok(db.update_tag(input)?))
    }

    pub fn delete_tag(&self, id: i64) -> Result<()> {
        self.with_db(|db| Ok(db.delete_tag(id)?))
    }

    pub fn assign_tag(&self, input: &AssignTagInput) -> Result<()> {
        self.with_db(|db| Ok(db.assign_tag(input)?))
    }

    pub fn unassign_tag(&self, input: &AssignTagInput) -> Result<()> {
        self.with_db(|db| Ok(db.unassign_tag(input)?))
    }

    pub fn list_tags_for_session(&self, session_id: &str) -> Result<Vec<Tag>> {
        self.with_db(|db| Ok(db.list_tags_for_session(session_id)?))
    }

    // --- Todos ---

    pub fn create_todo(&self, input: &CreateTodoInput) -> Result<Todo> {
        self.with_db(|db| Ok(db.create_todo(input)?))
    }

    pub fn list_todos(&self, input: &ListTodosInput) -> Result<Vec<Todo>> {
        self.with_db(|db| Ok(db.list_todos(input)?))
    }

    pub fn update_todo(&self, input: &UpdateTodoInput) -> Result<Todo> {
        self.with_db(|db| Ok(db.update_todo(input)?))
    }

    /// Blobs outlive the row only until nothing references them.
    pub fn delete_todo(&self, id: i64) -> Result<()> {
        let dir = self.data_dir();
        self.with_db(|db| {
            let shas = db.delete_todo(id)?;
            attachments::collect_attachment_blobs(db, &dir, &shas)
        })
    }

    pub fn clear_completed_todos(&self) -> Result<i64> {
        let dir = self.data_dir();
        self.with_db(|db| {
            let swept = db.clear_completed_todos()?;
            attachments::collect_attachment_blobs(db, &dir, &swept.deleted_shas)?;
            Ok(swept.count)
        })
    }

    pub fn list_todo_milestones(&self) -> Result<Vec<String>> {
        self.with_db(|db| Ok(db.list_todo_milestones()?))
    }

    // --- Todo states, projects, labels ---

    pub fn list_todo_states(&self) -> Result<Vec<TodoState>> {
        self.with_db(|db| Ok(db.list_todo_states()?))
    }

    pub fn create_todo_state(&self, input: &CreateTodoStateInput) -> Result<TodoState> {
        self.with_db(|db| Ok(db.create_todo_state(input)?))
    }

    pub fn update_todo_state(&self, input: &UpdateTodoStateInput) -> Result<TodoState> {
        self.with_db(|db| Ok(db.update_todo_state(input)?))
    }

    pub fn delete_todo_state(&self, id: i64, reassign_to_id: i64) -> Result<i64> {
        self.with_db(|db| Ok(db.delete_todo_state(id, reassign_to_id)?))
    }

    pub fn reorder_todo_states(&self, ordered_ids: &[i64]) -> Result<Vec<TodoState>> {
        self.with_db(|db| Ok(db.reorder_todo_states(ordered_ids)?))
    }

    pub fn list_todo_projects(&self) -> Result<Vec<TodoProject>> {
        self.with_db(|db| Ok(db.list_todo_projects()?))
    }

    pub fn create_todo_project(&self, input: &CreateTodoProjectInput) -> Result<TodoProject> {
        self.with_db(|db| Ok(db.create_todo_project(input)?))
    }

    pub fn update_todo_project(&self, input: &UpdateTodoProjectInput) -> Result<TodoProject> {
        self.with_db(|db| Ok(db.update_todo_project(input)?))
    }

    pub fn delete_todo_project(&self, id: i64) -> Result<i64> {
        self.with_db(|db| Ok(db.delete_todo_project(id)?))
    }

    pub fn reorder_todo_projects(&self, ordered_ids: &[i64]) -> Result<Vec<TodoProject>> {
        self.with_db(|db| Ok(db.reorder_todo_projects(ordered_ids)?))
    }

    pub fn list_todo_labels(&self) -> Result<Vec<TodoLabel>> {
        self.with_db(|db| Ok(db.list_todo_labels()?))
    }

    pub fn create_todo_label(&self, input: &CreateTodoLabelInput) -> Result<TodoLabel> {
        self.with_db(|db| Ok(db.create_todo_label(input)?))
    }

    pub fn update_todo_label(&self, input: &UpdateTodoLabelInput) -> Result<TodoLabel> {
        self.with_db(|db| Ok(db.update_todo_label(input)?))
    }

    pub fn delete_todo_label(&self, id: i64) -> Result<i64> {
        self.with_db(|db| Ok(db.delete_todo_label(id)?))
    }

    // --- Attachments ---

    fn attach_bytes(&self, todo_id: i64, bytes: &[u8], file_name: &str, mime_type: Option<&str>) -> Result<TodoAttachment> {
        let dir = self.data_dir();
        let stored = attachments::store_buffer(&dir, bytes, file_name)?;
        let mime = match mime_type {
            Some(m) if !m.is_empty() => m.to_string(),
            _ => attachments::mime_type_for_ext(&stored.ext).to_string(),
        };
        self.with_db(|db| {
            Ok(db.create_todo_attachment(&CreateTodoAttachmentInput {
                todo_id,
                sha256: stored.sha256.clone(),
                file_name: file_name.to_string(),
                mime_type: mime,
                size_bytes: stored.size_bytes as i64,
                kind: Some(attachment_kind_for_ext(&stored.ext)),
            })?)
        })
    }

    /// `attachment:add`: native file picker, then attach. `None` when the user cancels.
    pub fn add_attachment(&self, todo_id: i64) -> Result<Option<TodoAttachment>> {
        let Some(path) = self.host.pick_file("Attach a file to this todo") else { return Ok(None) };
        let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let data = std::fs::read(&path)?;
        self.attach_bytes(todo_id, &data, &file_name, None).map(Some)
    }

    /// `attachment:add-buffer`: paste or drop.
    pub fn add_attachment_buffer(&self, input: &AddTodoAttachmentBufferInput) -> Result<TodoAttachment> {
        self.attach_bytes(input.todo_id, &input.data, &input.file_name, Some(&input.mime_type))
    }

    pub fn list_attachments(&self, todo_id: i64) -> Result<Vec<TodoAttachment>> {
        self.with_db(|db| Ok(db.list_todo_attachments(todo_id)?))
    }

    pub fn delete_attachment(&self, id: i64) -> Result<()> {
        let dir = self.data_dir();
        self.with_db(|db| {
            if let Some(removed) = db.delete_todo_attachment(id)? {
                // Every extension variant of the sha goes: the same bytes attached as x.png and
                // x.jpg are two files, and the last row out must remove both.
                attachments::delete_blob_if_unreferenced(db, &dir, &removed.sha256, None)?;
            }
            Ok(())
        })
    }

    fn attachment_file(&self, id: i64) -> Result<Option<PathBuf>> {
        let dir = self.data_dir();
        let row = self.with_db(|db| Ok(db.get_todo_attachment(id)?))?;
        match row {
            None => Ok(None),
            Some(a) => Ok(Some(attachments::attachment_path_for(&dir, &a.sha256, &ext_from_file_name(&a.file_name))?)),
        }
    }

    /// `attachment:open`: `None` on success, otherwise the message to show.
    pub fn open_attachment(&self, id: i64) -> Result<Option<String>> {
        let Some(file) = self.attachment_file(id)? else { return Ok(Some("Attachment not found".into())) };
        if !file.exists() {
            return Ok(Some("The attached file is missing from disk".into()));
        }
        Ok(self.host.open_path(&file).err())
    }

    pub fn reveal_attachment(&self, id: i64) -> Result<()> {
        if let Some(file) = self.attachment_file(id)? {
            self.host.show_in_folder(&file);
        }
        Ok(())
    }

    /// The `app-media://` request resolver the editor's image loader uses.
    pub fn resolve_attachment_url(&self, url: &str) -> Option<PathBuf> {
        let dir = attachments::attachments_dir(&self.data_dir()).ok()?;
        attachments::resolve_attachment_path(url, &dir)
    }

    /// The resolver for the editor's `set_image_resolver`: maps an `app-media://` destination to
    /// the blob on disk. It reads the data folder on every call, so it follows a moved folder.
    pub fn image_resolver(self: &Arc<Self>) -> Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync> {
        let services = Arc::clone(self);
        Arc::new(move |url| services.resolve_attachment_url(url))
    }

    // --- Nvim activity ---

    pub fn list_nvim_activity_by_date(&self, date: &str) -> Result<ListNvimActivityResult> {
        self.with_db(|db| Ok(ListNvimActivityResult { records: db.list_nvim_activity_by_date(date)? }))
    }

    // --- Claude Code tracker ---

    pub fn claude_scan(&self, project_dir_name: &str) -> Result<ScanResult> {
        let minutes = self
            .get_setting_value("claude_tracker.idle_threshold_minutes")?
            .and_then(|v| leading_int(&v))
            .unwrap_or(5);
        Ok(lock(&self.tracker).scan_sessions(project_dir_name, Some(minutes)))
    }

    pub fn claude_track_selected(&self, uuids: &[String]) -> usize {
        lock(&self.tracker).track_selected_sessions(uuids, false)
    }

    pub fn claude_stop(&self) -> Vec<ClaudeCodeSessionData> {
        lock(&self.tracker).stop_and_get_data()
    }

    pub fn claude_pause(&self) {
        lock(&self.tracker).pause();
    }

    pub fn claude_resume(&self) {
        lock(&self.tracker).resume();
    }

    pub fn claude_projects(&self) -> Vec<ClaudeCodeProject> {
        lock(&self.tracker).get_projects()
    }

    pub fn claude_scan_all(&self) -> Vec<ClaudeCodeSessionPreviewWithProject> {
        lock(&self.tracker).scan_all_projects()
    }

    pub fn claude_data_for_session(&self, session_id: &str) -> Result<Option<Vec<ClaudeCodeSessionSummary>>> {
        self.with_db(|db| Ok(db.get_claude_code_data_for_session(session_id)?))
    }

    /// Call on a timer (about every 500 ms): the stats and new-session events Electron pushes.
    pub fn poll_claude_tracker(&self) -> PollOutput {
        lock(&self.tracker).poll()
    }

    // --- OS ---

    /// `shell:open-external`: http and https only.
    pub fn open_external(&self, url: &str) {
        if os::shell::is_openable_external_url(url) {
            self.host.open_external(url);
        }
    }

    /// `notification:timer-complete`.
    pub fn notify_timer_complete(&self, title: &str, body: &str) {
        self.host.notify(title, body);
    }

    // --- Sync ---

    pub fn sync_status(&self) -> Result<SyncStatus> {
        Ok(self.sync.get_sync_status()?)
    }

    pub fn sync_disable(&self) -> Result<()> {
        Ok(self.sync.disable_sync()?)
    }

    pub fn sync_notices(&self, include_dismissed: bool) -> Result<Vec<SyncNotice>> {
        Ok(self.sync.list_notices(include_dismissed)?)
    }

    pub fn sync_dismiss_notice(&self, id: i64) -> Result<()> {
        Ok(self.sync.dismiss_notice(id)?)
    }

    pub fn sync_pending_renumber_count(&self) -> Result<i64> {
        Ok(self.sync.get_pending_renumber_count()?)
    }

    pub fn sync_renumber_legacy_ids(&self, confirm: bool) -> Result<RenumberOutcome> {
        Ok(self.sync.renumber_legacy_todo_ids(confirm)?)
    }

    // --- Data location ---

    pub fn data_location_get(&self) -> DataLocationInfo {
        self.location.get_data_dir_status()
    }

    /// `data-location:choose`: the native folder picker. `None` when the user cancels.
    pub fn data_location_choose(&self) -> Option<String> {
        let status = self.location.get_data_dir_status();
        self.host
            .pick_folder("Choose where LizMeter keeps its data", Path::new(&status.data_dir))
            .map(|p| p.to_string_lossy().into_owned())
    }

    pub fn data_location_reveal(&self) {
        let status = self.location.get_data_dir_status();
        let dir = PathBuf::from(status.data_dir);
        if dir.exists() {
            let _ = self.host.open_path(&dir);
        }
    }

    /// `data-location:move`. On success the database is closed and the host is asked to relaunch;
    /// every later call fails until then.
    pub fn data_location_move(&self, input: &DataLocationMoveInput) -> Result<DataLocationMoveResult> {
        let target = PathBuf::from(&input.target_dir);
        let refuse = |code: DataLocationMoveErrorCode, message: &str| {
            Ok(DataLocationMoveResult::Err { ok: false, code, message: message.to_string() })
        };

        // Decided while the database is still open, on the pre-move data.
        let pending = self.sync.decide_pending_sync_action(&target)?;

        if requires_adopt_confirmation(pending.as_ref(), input.confirm_adopt == Some(true)) {
            return refuse(
                DataLocationMoveErrorCode::AdoptConfirmRequired,
                "That folder holds another machine's synced data. Using it here discards this machine's own working set and adopts the other machine's todos and sessions instead \u{2014} this machine's current database is kept as a backup, but there is no way back to it from inside LizMeter.",
            );
        }
        if requires_unsynced_db_confirmation(pending.as_ref(), &target, input.confirm_unsynced_db == Some(true)) {
            return refuse(
                DataLocationMoveErrorCode::TargetHasUnsyncedDbConfirmRequired,
                "That folder already holds a LizMeter database, but no other machine has synced through it yet. Enabling sync here will publish this machine's own data instead \u{2014} the database already in that folder will not be read by sync and is left behind, unused but untouched.",
            );
        }
        let sync_on = self.with_db(|db| Ok(is_sync_enabled(db.conn())?))?;
        if pending.is_none() && sync_on && input.confirm_disconnect_sync != Some(true) {
            return refuse(
                DataLocationMoveErrorCode::SyncEnabledConfirmRequired,
                "This device is syncing with another machine. Moving the data folder now will disconnect it from sync \u{2014} the new folder does not hold the other machine's history.",
            );
        }

        // Fold the WAL into the main file and drop the connection before anything is copied. The
        // sync worker stops first (it shares the handle) and every other call fails while the
        // flag is set, so nothing writes to the stand-in database.
        self.sync.stop();
        {
            let stand_in = Database::open_in_memory()?;
            let mut guard = lock(&self.db);
            self.retired.store(true, Ordering::SeqCst);
            let _ = guard.conn().execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
            let open = std::mem::replace(&mut *guard, stand_in);
            let _ = open.close();
        }

        let attempt = (|| -> Result<MoveDataResult> {
            let source_dir = self.location.get_data_dir();
            if matches!(pending, Some(PendingSyncAction::Enable)) {
                self.location.relocate_db_to_private_storage(&source_dir)?;
            }
            // Written before the pointer can move: a crash before the relaunch still leaves
            // evidence that the action has to run.
            if let Some(p) = &pending {
                self.sync.write_pending_sync_action(p)?;
            }
            Ok(self.location.move_data_to(
                &target,
                MoveOptions {
                    use_existing: input.use_existing == Some(true),
                    copy_db: Some(pending.is_none()),
                    copy_attachments: Some(!matches!(pending, Some(PendingSyncAction::Adopt { .. }))),
                },
            ))
        })();

        // Nothing moved: the marker authorises nothing, and the app must keep working.
        let reopen = |this: &Self| -> Result<()> {
            if pending.is_some() {
                this.sync.clear_pending_sync_action();
            }
            let reopened = Database::open_with_sync(this.location.get_db_path(), Box::new(this.writer.clone()))?;
            {
                let mut guard = lock(&this.db);
                *guard = reopened;
                this.retired.store(false, Ordering::SeqCst);
            }
            let _ = this.sync.start();
            Ok(())
        };

        match attempt {
            Ok(MoveDataResult::Ok { data_dir }) => {
                self.host.request_relaunch();
                Ok(DataLocationMoveResult::Ok { ok: true, data_dir: data_dir.to_string_lossy().into_owned() })
            }
            Ok(MoveDataResult::Err { code, message }) => {
                reopen(self)?;
                Ok(DataLocationMoveResult::Err { ok: false, code, message })
            }
            Err(e) => {
                reopen(self)?;
                Err(e)
            }
        }
    }
}
