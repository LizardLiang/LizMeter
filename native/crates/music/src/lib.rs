//! lizmeter-music: the music backend. Port of `electron/main/music/*` plus native playback.

pub mod binaries;
pub mod cache;
pub mod dsp;
pub mod error;
pub mod extractor;
pub mod integrity;
pub mod library;
pub mod native;
pub mod output;
pub mod process;
pub mod queue;
pub mod service;
pub mod transport;

pub use error::{MusicError, Result};
pub use service::{MusicEvent, MusicService, MusicSnapshot, OutputKind, PlayResult};
use lizmeter_db::Database;
use lizmeter_core::MusicErrorCode;
use std::ops::Deref;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// The database the whole app shares, plus the flag the host raises while the handle is out of
/// service (a data-folder move). Every music write goes through [`with_db`], which refuses while
/// the flag is up, as `Services::with_db` does for every other service.
#[derive(Clone)]
pub struct DbHandle {
    db: Arc<Mutex<Database>>,
    retired: Option<Arc<AtomicBool>>,
}

impl DbHandle {
    /// A handle whose calls fail while `retired` is set.
    pub fn guarded(db: Arc<Mutex<Database>>, retired: Arc<AtomicBool>) -> Self {
        DbHandle { db, retired: Some(retired) }
    }
}

impl From<Arc<Mutex<Database>>> for DbHandle {
    fn from(db: Arc<Mutex<Database>>) -> Self {
        DbHandle { db, retired: None }
    }
}

impl Deref for DbHandle {
    type Target = Mutex<Database>;
    fn deref(&self) -> &Mutex<Database> {
        &self.db
    }
}

/// Runs `f` on the database under its lock. Never call a slow operation inside `f`.
pub fn with_db<T>(db: &DbHandle, f: impl FnOnce(&Database) -> Result<T>) -> Result<T> {
    let guard = db.db.lock().unwrap_or_else(|e| e.into_inner());
    // Checked under the lock: a move raises the flag while it holds the lock to swap the handle.
    if db.retired.as_ref().is_some_and(|r| r.load(Ordering::SeqCst)) {
        return Err(MusicError::new(MusicErrorCode::ExtractionFailed, "LizMeter is restarting to use the new data folder"));
    }
    f(&guard)
}
