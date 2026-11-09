use lizmeter_db::DbError;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SyncError {
    /// A shared-folder file read back shorter than the filesystem reported (cloud placeholder).
    #[error(
        "\"{}\" is not fully downloaded (expected {expected} bytes, read {actual}). Mark the shared folder \"Always keep on this device\" and try again.",
        path.display()
    )]
    NotFullyHydrated { path: PathBuf, expected: u64, actual: u64 },
    #[error("could not write the pre-rebuild backup: {0}")]
    RebuildBackupFailed(String),
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Db(#[from] DbError),
}

pub type Result<T> = std::result::Result<T, SyncError>;

impl From<SyncError> for DbError {
    fn from(e: SyncError) -> Self {
        match e {
            SyncError::Db(d) => d,
            SyncError::Sqlite(s) => DbError::Sqlite(s),
            SyncError::Io(i) => DbError::Io(i),
            SyncError::Json(j) => DbError::Json(j),
            other => DbError::Message(other.to_string()),
        }
    }
}
