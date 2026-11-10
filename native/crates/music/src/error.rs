//! `music-error.ts`: one error type with the code the UI maps to a message.

use lizmeter_core::MusicErrorCode;
use std::fmt;

#[derive(Debug, Clone)]
pub struct MusicError {
    pub code: MusicErrorCode,
    pub message: String,
}

impl MusicError {
    pub fn new(code: MusicErrorCode, message: impl Into<String>) -> Self {
        MusicError { code, message: message.into() }
    }

    /// The wire form of the code, e.g. `BINARY_MISSING`.
    pub fn code_str(&self) -> String {
        serde_json::to_value(self.code).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
    }
}

impl fmt::Display for MusicError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for MusicError {}

impl From<lizmeter_db::DbError> for MusicError {
    fn from(e: lizmeter_db::DbError) -> Self {
        MusicError::new(MusicErrorCode::ExtractionFailed, e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, MusicError>;
