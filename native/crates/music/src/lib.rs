//! lizmeter-music: the music backend. Port of `electron/main/music/*` plus native playback.

pub mod binaries;
pub mod cache;
pub mod error;
pub mod extractor;
pub mod integrity;
pub mod output;
pub mod process;
pub mod transport;

pub use error::{MusicError, Result};
use lizmeter_db::Database;
use std::sync::{Arc, Mutex};

/// The database the whole app shares.
pub type DbHandle = Arc<Mutex<Database>>;

/// Runs `f` on the database under its lock. Never call a slow operation inside `f`.
pub fn with_db<T>(db: &DbHandle, f: impl FnOnce(&Database) -> Result<T>) -> Result<T> {
    let guard = db.lock().unwrap_or_else(|e| e.into_inner());
    f(&guard)
}
