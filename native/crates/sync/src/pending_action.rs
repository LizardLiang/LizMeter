//! A move-then-relaunch cannot carry state across the process boundary, so the decision of what kind
//! of sync setup a folder move triggers is written to a small marker file in the per-user folder
//! (never the data folder) right before relaunch, and consumed once at the start of the next launch
//! (`pending-action.ts`).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MARKER_FILE_NAME: &str = "pending-sync-action.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingSyncAction {
    Enable,
    Adopt { target_dir: PathBuf },
}

fn marker_path(user_data_dir: &Path) -> PathBuf {
    user_data_dir.join(MARKER_FILE_NAME)
}

pub fn write_pending_sync_action(user_data_dir: &Path, action: &PendingSyncAction) -> crate::Result<()> {
    let value = match action {
        PendingSyncAction::Enable => json!({ "action": "enable" }),
        PendingSyncAction::Adopt { target_dir } => {
            json!({ "action": "adopt", "targetDir": target_dir.to_string_lossy() })
        }
    };
    std::fs::create_dir_all(user_data_dir)?;
    std::fs::write(marker_path(user_data_dir), format!("{}\n", serde_json::to_string_pretty(&value)?))?;
    Ok(())
}

/// Reads and deletes the marker in one call: a crash between the two would otherwise replay a stale
/// action forever.
pub fn consume_pending_sync_action(user_data_dir: &Path) -> Option<PendingSyncAction> {
    let file = marker_path(user_data_dir);
    let raw = std::fs::read_to_string(&file).ok()?;
    let _ = std::fs::remove_file(&file);

    let parsed: Value = serde_json::from_str(&raw).ok()?;
    match parsed.get("action")?.as_str()? {
        "enable" => Some(PendingSyncAction::Enable),
        "adopt" => Some(PendingSyncAction::Adopt {
            target_dir: PathBuf::from(parsed.get("targetDir").and_then(Value::as_str).unwrap_or_default()),
        }),
        _ => None,
    }
}

/// Discards the marker without acting on it (H-004), for a move that was refused after the marker was
/// written: the next launch must not retry a move that never happened.
pub fn clear_pending_sync_action(user_data_dir: &Path) {
    let _ = std::fs::remove_file(marker_path(user_data_dir));
}
