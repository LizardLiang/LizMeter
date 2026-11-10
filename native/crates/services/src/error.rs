use thiserror::Error;

/// Errors a service call returns. `Message` carries the exact text the Electron handler throws.
#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Db(#[from] lizmeter_db::DbError),
    #[error(transparent)]
    Sync(#[from] lizmeter_sync::SyncError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl From<lizmeter_music::MusicError> for ServiceError {
    fn from(e: lizmeter_music::MusicError) -> Self {
        ServiceError::Message(e.message)
    }
}

pub type Result<T> = std::result::Result<T, ServiceError>;

pub(crate) fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(ServiceError::Message(message.into()))
}
