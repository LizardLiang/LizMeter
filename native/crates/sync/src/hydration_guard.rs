//! FR-014: refuses a shared-folder file that a cloud client has not fully downloaded
//! (`hydration-guard.ts`). Compares what was read against the size the filesystem reported.

use crate::{Result, SyncError};
use std::path::Path;

/// Reads a file's full bytes, refusing a partial read. Any other read error propagates as-is.
pub fn read_file_guarded(path: &Path) -> Result<Vec<u8>> {
    let expected = std::fs::metadata(path)?.len();
    let bytes = std::fs::read(path)?;
    check_read_length(path, expected, bytes)
}

/// The size taken immediately before the read must equal what was read: a placeholder can finish
/// hydrating between calls, so this never assumes that once truncated, always truncated.
pub fn check_read_length(path: &Path, expected: u64, bytes: Vec<u8>) -> Result<Vec<u8>> {
    if bytes.len() as u64 != expected {
        return Err(SyncError::NotFullyHydrated {
            path: path.to_path_buf(),
            expected,
            actual: bytes.len() as u64,
        });
    }
    Ok(bytes)
}
