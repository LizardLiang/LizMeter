//! Opening the services at launch: the order `app.whenReady()` follows in `electron/main/index.ts`
//! for everything that is not a window.

use crate::attachments::sweep_orphan_blobs;
use crate::claude_tracker::ClaudeTracker;
use crate::error::{Result, ServiceError};
use crate::os::guard::{ElectronMatcher, GuardError, SingleWriterGuard};
use crate::os::Host;
use crate::Services;
use lizmeter_core::SyncNoticeKind;
use lizmeter_db::data_location::{same_path, DataLocation};
use lizmeter_db::{is_sync_enabled, Database};
use lizmeter_sync::notices::add_sync_notice;
use lizmeter_sync::pending_action::{consume_pending_sync_action, write_pending_sync_action, PendingSyncAction};
use lizmeter_sync::sync_manager::{Notifier, SyncManager};
use lizmeter_sync::SyncWriter;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

/// What the launch did, for the caller to log or show.
#[derive(Debug, Default)]
pub struct StartupReport {
    pub db_path: PathBuf,
    pub applied_pending_action: bool,
    /// A deferred sync action failed and was written back for the next launch.
    pub pending_action_error: Option<String>,
    pub swept_orphans: bool,
}

struct HostNotifier(Arc<dyn Host>);

impl Notifier for HostNotifier {
    fn notify(&self, title: &str, body: &str) {
        self.0.notify(title, body);
    }
}

impl Services {
    /// Opens the data folder's database with the sync engine attached, applies a sync action the
    /// last session deferred, and sweeps orphan attachment blobs. The caller holds the
    /// single-writer guard for `location.get_db_dir()` before calling this.
    pub fn open(
        location: DataLocation,
        host: Arc<dyn Host>,
        projects_root: impl Into<PathBuf>,
    ) -> Result<(Arc<Services>, StartupReport)> {
        let location = Arc::new(location);
        let user_data_dir = location.default_data_dir().to_path_buf();
        let user_data_dir_copy = user_data_dir.clone();
        let user_data_hub = user_data_dir.clone();
        let mut report = StartupReport::default();

        // Step 1 of 2 for a deferred sync action: marker files, before the database opens.
        let pending = consume_pending_sync_action(&user_data_dir);
        let mut adopt_backup = None;
        let prepared: Result<()> = (|| {
            match &pending {
                Some(PendingSyncAction::Adopt { .. }) => {
                    location.mark_device_as_adopted()?;
                    adopt_backup = location.backup_existing_private_db_before_adopt()?;
                }
                Some(PendingSyncAction::Enable) => location.mark_private_db()?,
                None => {}
            }
            Ok(())
        })();
        if let Err(e) = prepared {
            // Retry on the next launch rather than lose the action.
            if let Some(p) = &pending {
                let _ = write_pending_sync_action(&user_data_dir, p);
            }
            return Err(e);
        }

        // Any failure from here on writes the consumed action back, so the next launch retries it.
        let rest = (|| -> Result<_> {
            let data_dir = location.get_data_dir();
            let writer = SyncWriter::new(&data_dir, &user_data_dir)?;
            let db_path = location.get_db_path();
            report.db_path = db_path.clone();
            let db = Arc::new(Mutex::new(Database::open_with_sync(&db_path, Box::new(writer.clone()))?));
            let sync = SyncManager::new(
                db.clone(),
                writer.clone(),
                user_data_dir,
                Some(db_path),
                Arc::new(HostNotifier(host.clone())),
            );

            match sync.apply_pending_sync_action_after_init(pending.as_ref()) {
                Ok(()) => report.applied_pending_action = pending.is_some(),
                Err(e) => {
                    report.pending_action_error = Some(e.to_string());
                    if let Some(p) = &pending {
                        let _ = sync.write_pending_sync_action(p);
                    }
                }
            }

            if let Some(backup) = adopt_backup {
                let guard = db.lock().unwrap_or_else(|e| e.into_inner());
                add_sync_notice(
                    guard.conn(),
                    SyncNoticeKind::AdoptedBackup,
                    "This machine's previous database was kept as a backup before adopting the shared data.",
                    Some(&backup.to_string_lossy()),
                )?;
            }

            {
                let guard = db.lock().unwrap_or_else(|e| e.into_inner());
                if !is_sync_enabled(guard.conn())? {
                    sweep_orphan_blobs(&guard, &data_dir);
                    report.swept_orphans = true;
                }
            }

            Ok((db, sync, writer))
        })();
        let (db, sync, writer) = match rest {
            Ok(v) => v,
            Err(e) => {
                if let Some(p) = &pending {
                    let _ = write_pending_sync_action(&user_data_dir_copy, p);
                }
                return Err(e);
            }
        };

        let services = Arc::new(Services {
            db,
            location,
            sync,
            writer,
            host,
            tracker: Mutex::new(ClaudeTracker::new(projects_root)),
            retired: AtomicBool::new(false),
            guards: Mutex::new(Vec::new()),
            hub: crate::issues::Hub::new(&user_data_hub),
        });
        services.migrate_electron_tokens();
        Ok((services, report))
    }

    /// [`Services::open`] behind the single-writer guard: refuses to start when another native
    /// LizMeter, or a running Electron LizMeter on the same data, already writes this folder.
    /// The refusal text names the holder.
    pub fn open_guarded(
        location: DataLocation,
        host: Arc<dyn Host>,
        projects_root: impl Into<PathBuf>,
    ) -> Result<(Arc<Services>, StartupReport)> {
        // The installed Electron build keeps its device identity, pointer file and private
        // database in %APPDATA%\lizmeter; any other folder (soak copy, test folder) is not shared with it.
        let electron_dir = std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("lizmeter"));
        let shares_electron = electron_dir.is_some_and(|d| same_path(&d, location.default_data_dir()));
        let matcher = shares_electron.then(ElectronMatcher::default);
        Self::open_guarded_with(location, host, projects_root, matcher)
    }

    /// [`Services::open_guarded`] with the Electron check chosen by the caller.
    pub fn open_guarded_with(
        location: DataLocation,
        host: Arc<dyn Host>,
        projects_root: impl Into<PathBuf>,
        electron: Option<ElectronMatcher>,
    ) -> Result<(Arc<Services>, StartupReport)> {
        let to_error = |e: GuardError| ServiceError::Message(e.to_string());
        // The per-user folder holds the device id, the pointer file and a private database: it
        // gets the mutex and the lock file. A custom data folder holds the shared oplog and may
        // be cloud-synced, so it gets the mutex alone, never a file.
        let mut guards = vec![SingleWriterGuard::acquire(location.default_data_dir(), electron.as_ref()).map_err(to_error)?];
        let data_dir = location.get_data_dir();
        if !same_path(&data_dir, location.default_data_dir()) {
            guards.push(SingleWriterGuard::acquire_mutex_only(&data_dir).map_err(to_error)?);
        }
        let (services, report) = Self::open(location, host, projects_root)?;
        *services.guards.lock().unwrap_or_else(|e| e.into_inner()) = guards;
        Ok((services, report))
    }

    /// Starts the sync watcher and periodic merge. A strict no-op while sync is off. Call after
    /// the window exists, as `index.ts` does with `setImmediate`.
    pub fn start_background(&self) -> Result<()> {
        Ok(self.sync.start()?)
    }

    /// Stops sync and releases the tracker. The database closes when the last handle drops.
    pub fn shutdown(&self) {
        self.sync.stop();
        self.tracker.lock().unwrap_or_else(|e| e.into_inner()).destroy();
    }
}
