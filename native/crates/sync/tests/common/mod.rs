//! Two-device harness: two independent in-memory databases wired to the real sync engine, sharing
//! one real temp folder standing in for the cloud-drive folder (port of `src/test/two-device-harness.ts`).

#![allow(dead_code)]

use lizmeter_db::{set_sync_enabled, Database};
use lizmeter_sync::merge_engine::ApplyResult;
use lizmeter_sync::merge_pass::run_merge_pass;
use lizmeter_sync::oplog::{get_oplog_file_path, get_sync_devices_dir};
use lizmeter_sync::SyncWriter;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

pub struct Device {
    pub name: &'static str,
    pub db: Database,
    pub user_data_dir: PathBuf,
    pub device_id: String,
}

pub struct Harness {
    pub root: TempDir,
    pub shared: PathBuf,
    pub a: Device,
    pub b: Device,
}

fn make_device(root: &Path, shared: &Path, name: &'static str) -> Device {
    let user_data_dir = root.join(name);
    std::fs::create_dir_all(&user_data_dir).unwrap();
    let writer = SyncWriter::new(shared, &user_data_dir).unwrap();
    let device_id = writer.device_id().to_string();
    let db = Database::open_with_sync(":memory:", Box::new(writer)).unwrap();
    set_sync_enabled(db.conn(), true).unwrap();
    Device { name, db, user_data_dir, device_id }
}

impl Harness {
    pub fn new() -> Harness {
        let root = tempfile::tempdir().unwrap();
        let shared = root.path().join("shared");
        std::fs::create_dir_all(&shared).unwrap();
        let a = make_device(root.path(), &shared, "device-a");
        let b = make_device(root.path(), &shared, "device-b");
        Harness { root, shared, a, b }
    }

    /// Reads every peer's oplog and applies new entries to `device`'s database.
    pub fn sync(&self, device: &Device) -> ApplyResult {
        run_merge_pass(device.db.conn(), &self.shared, &device.device_id).unwrap()
    }

    pub fn oplog_path(&self, device: &Device) -> PathBuf {
        get_oplog_file_path(&self.shared, &device.device_id)
    }

    pub fn devices_dir(&self) -> PathBuf {
        get_sync_devices_dir(&self.shared)
    }
}

pub fn query_one<T: rusqlite::types::FromSql>(db: &Database, sql: &str) -> T {
    db.conn().query_row(sql, [], |r| r.get(0)).unwrap()
}

pub fn query_opt<T: rusqlite::types::FromSql>(db: &Database, sql: &str, p: impl rusqlite::Params) -> Option<T> {
    use rusqlite::OptionalExtension;
    db.conn().query_row(sql, p, |r| r.get(0)).optional().unwrap()
}

pub fn uuid_of(db: &Database, table: &str, id: i64) -> String {
    db.conn().query_row(&format!("SELECT uuid FROM {table} WHERE id = ?"), [id], |r| r.get(0)).unwrap()
}

pub fn append_raw(path: &Path, lines: &[Value]) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    for l in lines {
        writeln!(f, "{l}").unwrap();
    }
}

pub fn count(db: &Database, sql: &str) -> i64 {
    query_one(db, sql)
}
