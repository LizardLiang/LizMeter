//! Machine identity for multi-writer sync (`device-identity.ts`): a permanent per-device UUID,
//! independent of any data-folder move, plus the counter this device hands out todo numbers from.
//!
//! Todo numbers are dense and sequential on every machine. Two machines creating todos while
//! apart claim the same number; the collision resolves at merge time (`merge_engine::reconcile_todo_ids`).
//! The device id lives in `device-identity.json` in the per-user folder, never the shared data folder.

use crate::oplog::{get_sync_devices_dir, OPLOG_SUFFIX};
use crate::{js_parse_int, read_setting, write_setting, Result};
use lizmeter_db::util::now_iso;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use std::path::Path;

const IDENTITY_FILE_NAME: &str = "device-identity.json";
const DEVICE_NUMBER_KEY: &str = "sync.deviceNumber";
const NEXT_TODO_ID_KEY: &str = "sync.nextTodoId";

/// The stride the retired block scheme used. An id at or above this could only have been handed out
/// as `deviceNumber * stride + counter`. Kept so the one-time renumber can recognise those ids.
pub const LEGACY_TODO_ID_BLOCK_STRIDE: i64 = 100_000_000;

/// Exclusive upper bound for a randomly drawn device number. Device 0 is reserved.
const RANDOM_DEVICE_NUMBER_MAX: u64 = 10_000_000;

/// This machine's permanent identity: read from `<user_data_dir>/device-identity.json`, or minted
/// once and persisted.
pub fn get_device_id(user_data_dir: &Path) -> Result<String> {
    let file = user_data_dir.join(IDENTITY_FILE_NAME);
    if let Ok(raw) = std::fs::read_to_string(&file) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(id) = parsed.get("deviceId").and_then(|v| v.as_str()) {
                if !lizmeter_db::util::js_trim(id).is_empty() {
                    return Ok(id.to_string());
                }
            }
        }
    }
    let device_id = lizmeter_db::util::new_uuid();
    std::fs::create_dir_all(user_data_dir)?;
    let body = serde_json::to_string_pretty(&serde_json::json!({ "deviceId": device_id }))?;
    std::fs::write(&file, format!("{body}\n"))?;
    Ok(device_id)
}

/// True when the shared folder holds no device's oplog file yet. The only signal that may award
/// device number 0: local row count is not that signal.
fn is_virgin_sync_folder(data_dir: &Path) -> bool {
    let dir = get_sync_devices_dir(data_dir);
    match std::fs::read_dir(&dir) {
        Err(_) => true,
        Ok(entries) => !entries.flatten().any(|e| e.file_name().to_string_lossy().ends_with(OPLOG_SUFFIX)),
    }
}

/// The integer this device hands out todo numbers from, assigned once, lazily.
///
/// Device number 0 is reserved for the one device that creates a shared sync folder: `data_dir`
/// provided and no peer oplog file there yet. Every other case draws a random number, checked
/// against every peer in `sync_devices`. `data_dir` is only passed by the callers that can perform a
/// first-ever assignment; omitting it never assumes 0.
pub fn get_or_assign_device_number(conn: &Connection, data_dir: Option<&Path>) -> Result<i64> {
    if let Some(stored) = read_setting(conn, DEVICE_NUMBER_KEY)? {
        if let Some(n) = js_parse_int(&stored) {
            return Ok(n);
        }
    }
    let number = match data_dir {
        Some(dir) if is_virgin_sync_folder(dir) => 0,
        _ => draw_unused_device_number(conn)?,
    };
    write_setting(conn, DEVICE_NUMBER_KEY, &number.to_string())?;
    Ok(number)
}

fn random_int(min: u64, max_exclusive: u64) -> u64 {
    let r = uuid::Uuid::new_v4().as_u128() as u64;
    min + r % (max_exclusive - min)
}

fn draw_unused_device_number(conn: &Connection) -> Result<i64> {
    let mut stmt = conn.prepare("SELECT device_number FROM sync_devices")?;
    let taken: HashSet<i64> = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    let mut candidate = random_int(1, RANDOM_DEVICE_NUMBER_MAX) as i64;
    while taken.contains(&candidate) {
        candidate = random_int(1, RANDOM_DEVICE_NUMBER_MAX) as i64;
    }
    Ok(candidate)
}

/// The next todo id this device may hand out. Persists the incremented counter before returning, so
/// a crash between allocating and inserting loses at most one number and never reuses one.
///
/// A high-water mark rather than `MAX(id) + 1`: deleting the newest todo must not free its number.
pub fn allocate_next_todo_id(conn: &Connection) -> Result<i64> {
    let current = read_todo_id_watermark(conn)?;
    write_setting(conn, NEXT_TODO_ID_KEY, &(current + 1).to_string())?;
    Ok(current)
}

/// The watermark's current value, seeded from the existing rows the first time it is read.
fn read_todo_id_watermark(conn: &Connection) -> Result<i64> {
    if let Some(stored) = read_setting(conn, NEXT_TODO_ID_KEY)? {
        if let Some(n) = js_parse_int(&stored) {
            return Ok(n);
        }
    }
    // Unset: sync is being enabled over an existing database, or this device rebuilt from a snapshot.
    let max_id: i64 = conn.query_row("SELECT COALESCE(MAX(id), 0) AS maxId FROM todos", [], |r| r.get(0))?;
    Ok(max_id + 1)
}

/// Raises this device's watermark above every todo id a merge just applied, so a machine returning
/// from an offline window stops walking back into numbers its peer already used.
pub fn advance_todo_id_watermark(conn: &Connection, seen_max_id: i64) -> Result<()> {
    if seen_max_id <= 0 {
        return Ok(());
    }
    let current = read_todo_id_watermark(conn)?;
    if seen_max_id < current {
        return Ok(());
    }
    write_setting(conn, NEXT_TODO_ID_KEY, &(seen_max_id + 1).to_string())
}

/// Registers (or refreshes) this device in the local peer registry. Idempotent.
pub fn register_device(conn: &Connection, device_id: &str, device_number: i64) -> Result<()> {
    let now = now_iso();
    let existing: Option<String> = conn
        .query_row("SELECT device_id FROM sync_devices WHERE device_id = ?", [device_id], |r| r.get(0))
        .optional()?;
    if existing.is_some() {
        conn.execute("UPDATE sync_devices SET last_seen_at = ? WHERE device_id = ?", params![now, device_id])?;
        return Ok(());
    }
    conn.execute(
        "INSERT INTO sync_devices (device_id, device_number, first_seen_at, last_seen_at, last_applied_seq) VALUES (?, ?, ?, ?, 0)",
        params![device_id, device_number, now, now],
    )?;
    Ok(())
}
