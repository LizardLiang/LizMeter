use thiserror::Error;

/// Errors from the database layer. `Message` carries the exact user-facing text the Electron
/// build throws, so callers (pipe replies, dialogs) and ported tests can match on it.
#[derive(Debug, Error)]
pub enum DbError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, DbError>;

pub(crate) fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(DbError::Message(message.into()))
}
