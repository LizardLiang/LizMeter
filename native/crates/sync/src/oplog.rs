//! The oplog format: one JSON Lines file per device, plus the read/write primitives (`oplog.ts`).
//!
//! A device writes only its own file, ever: that is the safety property the design rests on, so
//! the cloud drive only has to copy files. Entries are schema-versioned; a version this build does
//! not understand is skipped, never fatal (FR-020).

use crate::hlc::Hlc;
use crate::hydration_guard::read_file_guarded;
use crate::Result;
use lizmeter_db::util::js_trim;
use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const CURRENT_OPLOG_VERSION: i64 = 1;

/// Tables carrying their own permanent uuid (plus `sessions`, keyed by its text id).
pub const SYNCED_ROW_TABLES: [&str; 6] = ["todos", "tags", "todo_labels", "todo_states", "todo_projects", "sessions"];
/// Merge key is `(todo_uuid, sha256)` joined by `:`.
pub const ATTACHMENT_TABLE: &str = "todo_attachments";
pub const LINK_TABLES: [&str; 2] = ["todo_label_links", "session_tags"];

/// A scalar JSON value: string, number, boolean or null.
pub type OplogFieldValue = Value;

#[derive(Debug, Clone, PartialEq)]
pub struct FieldChange {
    pub value: OplogFieldValue,
    pub hlc: Hlc,
}

/// Field changes in insertion order (the order `Object.entries` yields in the TS engine).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FieldMap(pub Vec<(String, FieldChange)>);

impl FieldMap {
    pub fn get(&self, name: &str) -> Option<&FieldChange> {
        self.0.iter().find(|(k, _)| k == name).map(|(_, v)| v)
    }

    pub fn iter(&self) -> impl Iterator<Item = &(String, FieldChange)> {
        self.0.iter()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn insert(&mut self, key: String, change: FieldChange) {
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = change,
            None => self.0.push((key, change)),
        }
    }

    fn to_value(&self) -> Value {
        let mut map = Map::new();
        for (k, c) in &self.0 {
            map.insert(k.clone(), json!({ "value": c.value, "hlc": hlc_value(&c.hlc) }));
        }
        Value::Object(map)
    }

    fn from_value(v: &Value) -> Option<FieldMap> {
        let obj = v.as_object()?;
        let mut out = FieldMap::default();
        for (k, c) in obj {
            let value = c.get("value")?.clone();
            let hlc: Hlc = serde_json::from_value(c.get("hlc")?.clone()).ok()?;
            out.insert(k.clone(), FieldChange { value, hlc });
        }
        Some(out)
    }
}

impl FieldMap {
    /// Every field stamped with the same clock value.
    pub fn with_hlc<I, K>(fields: I, hlc: Hlc) -> FieldMap
    where
        I: IntoIterator<Item = (K, OplogFieldValue)>,
        K: Into<String>,
    {
        let mut out = FieldMap::default();
        for (k, value) in fields {
            out.insert(k.into(), FieldChange { value, hlc });
        }
        out
    }
}

fn hlc_value(h: &Hlc) -> Value {
    json!({ "physicalMs": h.physical_ms, "counter": h.counter, "deviceNumber": h.device_number })
}

#[derive(Debug, Clone, PartialEq)]
pub struct UpsertEntry {
    pub v: i64,
    pub op_id: String,
    pub hlc: Hlc,
    pub table: String,
    pub row_uuid: String,
    pub fields: FieldMap,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeleteEntry {
    pub v: i64,
    pub op_id: String,
    pub hlc: Hlc,
    pub table: String,
    pub row_uuid: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    Link,
    Unlink,
}

impl LinkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkKind::Link => "link",
            LinkKind::Unlink => "unlink",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinkEntry {
    pub v: i64,
    pub op_id: String,
    pub hlc: Hlc,
    pub table: String,
    pub op: LinkKind,
    pub from_uuid: String,
    pub to_uuid: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OplogEntry {
    Upsert(UpsertEntry),
    Delete(DeleteEntry),
    Link(LinkEntry),
}

impl OplogEntry {
    pub fn hlc(&self) -> &Hlc {
        match self {
            OplogEntry::Upsert(e) => &e.hlc,
            OplogEntry::Delete(e) => &e.hlc,
            OplogEntry::Link(e) => &e.hlc,
        }
    }

    pub fn op_id(&self) -> &str {
        match self {
            OplogEntry::Upsert(e) => &e.op_id,
            OplogEntry::Delete(e) => &e.op_id,
            OplogEntry::Link(e) => &e.op_id,
        }
    }

    pub fn table(&self) -> &str {
        match self {
            OplogEntry::Upsert(e) => &e.table,
            OplogEntry::Delete(e) => &e.table,
            OplogEntry::Link(e) => &e.table,
        }
    }

    /// Key order matches `JSON.stringify` of the TS entry objects.
    pub fn to_value(&self) -> Value {
        match self {
            OplogEntry::Upsert(e) => json!({
                "v": e.v, "opId": e.op_id, "hlc": hlc_value(&e.hlc), "table": e.table,
                "op": "upsert", "rowUuid": e.row_uuid, "fields": e.fields.to_value(),
            }),
            OplogEntry::Delete(e) => json!({
                "v": e.v, "opId": e.op_id, "hlc": hlc_value(&e.hlc), "table": e.table,
                "op": "delete", "rowUuid": e.row_uuid,
            }),
            OplogEntry::Link(e) => json!({
                "v": e.v, "opId": e.op_id, "hlc": hlc_value(&e.hlc), "table": e.table,
                "op": e.op.as_str(), "fields": { "fromUuid": e.from_uuid, "toUuid": e.to_uuid },
            }),
        }
    }

    pub fn to_line(&self) -> String {
        self.to_value().to_string()
    }

    /// Converts an already-plausible entry. `None` for a shape the engine cannot apply.
    pub fn from_value(v: &Value) -> Option<OplogEntry> {
        let version = v.get("v")?.as_f64()? as i64;
        let op_id = v.get("opId")?.as_str()?.to_string();
        let hlc: Hlc = serde_json::from_value(v.get("hlc")?.clone()).ok()?;
        let table = v.get("table")?.as_str()?.to_string();
        let op = v.get("op")?.as_str()?;
        let is_row_table = SYNCED_ROW_TABLES.contains(&table.as_str()) || table == ATTACHMENT_TABLE;
        match op {
            "upsert" if is_row_table => Some(OplogEntry::Upsert(UpsertEntry {
                v: version,
                op_id,
                hlc,
                table,
                row_uuid: v.get("rowUuid")?.as_str()?.to_string(),
                fields: FieldMap::from_value(v.get("fields")?)?,
            })),
            "delete" if is_row_table => Some(OplogEntry::Delete(DeleteEntry {
                v: version,
                op_id,
                hlc,
                table,
                row_uuid: v.get("rowUuid")?.as_str()?.to_string(),
            })),
            "link" | "unlink" => {
                let fields = v.get("fields")?;
                Some(OplogEntry::Link(LinkEntry {
                    v: version,
                    op_id,
                    hlc,
                    table,
                    op: if op == "link" { LinkKind::Link } else { LinkKind::Unlink },
                    from_uuid: fields.get("fromUuid")?.as_str()?.to_string(),
                    to_uuid: fields.get("toUuid")?.as_str()?.to_string(),
                }))
            }
            _ => None,
        }
    }
}

fn new_op_id() -> String {
    lizmeter_db::util::new_uuid()
}

pub fn build_upsert_entry(hlc: Hlc, table: &str, row_uuid: &str, fields: FieldMap) -> OplogEntry {
    OplogEntry::Upsert(UpsertEntry {
        v: CURRENT_OPLOG_VERSION,
        op_id: new_op_id(),
        hlc,
        table: table.to_string(),
        row_uuid: row_uuid.to_string(),
        fields,
    })
}

pub fn build_delete_entry(hlc: Hlc, table: &str, row_uuid: &str) -> OplogEntry {
    OplogEntry::Delete(DeleteEntry {
        v: CURRENT_OPLOG_VERSION,
        op_id: new_op_id(),
        hlc,
        table: table.to_string(),
        row_uuid: row_uuid.to_string(),
    })
}

pub fn build_link_entry(hlc: Hlc, table: &str, op: LinkKind, from_uuid: &str, to_uuid: &str) -> OplogEntry {
    OplogEntry::Link(LinkEntry {
        v: CURRENT_OPLOG_VERSION,
        op_id: new_op_id(),
        hlc,
        table: table.to_string(),
        op,
        from_uuid: from_uuid.to_string(),
        to_uuid: to_uuid.to_string(),
    })
}

/// Joins an attachment's composite merge key into the string `row_uuid` entries carry.
pub fn attachment_row_key(todo_uuid: &str, sha256: &str) -> String {
    format!("{todo_uuid}:{sha256}")
}

const SYNC_SUBDIR: &str = "sync";
const DEVICES_SUBDIR: &str = "devices";
pub const OPLOG_SUFFIX: &str = ".oplog.jsonl";
pub const SNAPSHOT_SUFFIX: &str = ".snapshot.json";

pub fn get_sync_devices_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(SYNC_SUBDIR).join(DEVICES_SUBDIR)
}

pub fn get_oplog_file_path(data_dir: &Path, device_id: &str) -> PathBuf {
    get_sync_devices_dir(data_dir).join(format!("{device_id}{OPLOG_SUFFIX}"))
}

pub fn get_snapshot_file_path(data_dir: &Path, device_id: &str) -> PathBuf {
    get_sync_devices_dir(data_dir).join(format!("{device_id}{SNAPSHOT_SUFFIX}"))
}

/// Appends one entry to this device's own oplog file. Never call this against another device's file.
pub fn append_oplog_entry(data_dir: &Path, device_id: &str, entry: &OplogEntry) -> Result<()> {
    std::fs::create_dir_all(get_sync_devices_dir(data_dir))?;
    let mut line = entry.to_line();
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(get_oplog_file_path(data_dir, device_id))?;
    file.write_all(line.as_bytes())?;
    Ok(())
}

const KNOWN_OPS: [&str; 4] = ["upsert", "delete", "link", "unlink"];
const KNOWN_TABLES: [&str; 9] = [
    "todos",
    "tags",
    "todo_labels",
    "todo_states",
    "todo_projects",
    "sessions",
    "todo_attachments",
    "todo_label_links",
    "session_tags",
];

#[derive(Debug, Default)]
pub struct ReadOplogResult {
    pub entries: Vec<OplogEntry>,
    /// Lines skipped because of a future schema version or malformed JSON, never fatal (FR-020).
    pub skipped: usize,
}

/// Reads and parses a device's oplog file, applying the hydration guard first (FR-014). A
/// [`crate::SyncError::NotFullyHydrated`] must halt the whole sync pass. A missing file is an
/// empty result: a peer that has not published yet is normal.
pub fn read_oplog_entries(path: &Path) -> Result<ReadOplogResult> {
    if !path.exists() {
        return Ok(ReadOplogResult::default());
    }
    let bytes = read_file_guarded(path)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut out = ReadOplogResult::default();

    for line in text.split('\n') {
        let trimmed = js_trim(line);
        if trimmed.is_empty() {
            continue;
        }
        let parsed: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => {
                out.skipped += 1;
                continue;
            }
        };
        if !is_plausible_entry(&parsed) {
            out.skipped += 1;
            continue;
        }
        let version = parsed.get("v").and_then(Value::as_f64).unwrap_or(0.0);
        if version > CURRENT_OPLOG_VERSION as f64 {
            out.skipped += 1;
            continue;
        }
        match OplogEntry::from_value(&parsed) {
            Some(entry) => out.entries.push(entry),
            None => out.skipped += 1,
        }
    }
    Ok(out)
}

/// The oplog boundary's one validation gate (B-1): nothing downstream trusts an entry that did not
/// name a real table and a well-formed shape. Snapshot entries pass through the same gate.
pub fn is_plausible_entry(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    obj.get("v").is_some_and(Value::is_number)
        && obj.get("opId").is_some_and(Value::is_string)
        && obj.get("op").and_then(Value::as_str).is_some_and(|o| KNOWN_OPS.contains(&o))
        && obj.get("table").and_then(Value::as_str).is_some_and(|t| KNOWN_TABLES.contains(&t))
        && obj.get("hlc").is_some_and(Value::is_object)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hlc(p: i64) -> Hlc {
        Hlc { physical_ms: p, counter: 0, device_number: 1 }
    }

    #[test]
    fn upsert_line_keeps_ts_key_order() {
        let e = build_upsert_entry(hlc(5), "todos", "u1", FieldMap::with_hlc([("title", json!("x"))], hlc(5)));
        let line = e.to_line();
        let order: Vec<usize> =
            ["\"v\"", "\"opId\"", "\"hlc\"", "\"table\"", "\"op\"", "\"rowUuid\"", "\"fields\""]
                .iter()
                .map(|k| line.find(k).unwrap())
                .collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]), "{line}");
        assert!(line.contains(r#""hlc":{"physicalMs":5,"counter":0,"deviceNumber":1}"#));
    }

    #[test]
    fn round_trips_through_a_line() {
        let e = build_link_entry(hlc(7), "session_tags", LinkKind::Unlink, "s", "t");
        let v: Value = serde_json::from_str(&e.to_line()).unwrap();
        assert!(is_plausible_entry(&v));
        assert_eq!(OplogEntry::from_value(&v).unwrap(), e);
    }

    #[test]
    fn rejects_unknown_tables_and_ops() {
        let bad_table = json!({"v":1,"opId":"a","op":"upsert","table":"users; DROP","hlc":{}});
        let bad_op = json!({"v":1,"opId":"a","op":"nuke","table":"todos","hlc":{}});
        assert!(!is_plausible_entry(&bad_table));
        assert!(!is_plausible_entry(&bad_op));
    }

    #[test]
    fn missing_file_reads_empty_and_bad_lines_are_counted() {
        let dir = tempfile::tempdir().unwrap();
        let missing = read_oplog_entries(&dir.path().join("none.oplog.jsonl")).unwrap();
        assert_eq!(missing.entries.len(), 0);

        let good = build_delete_entry(hlc(1), "todos", "u").to_line();
        let future = r#"{"v":999,"opId":"f","hlc":{"physicalMs":1,"counter":0,"deviceNumber":1},"table":"todos","op":"delete","rowUuid":"x"}"#;
        let path = dir.path().join("d.oplog.jsonl");
        std::fs::write(&path, format!("{good}\nnot json\n{future}\n\n")).unwrap();
        let read = read_oplog_entries(&path).unwrap();
        assert_eq!(read.entries.len(), 1);
        assert_eq!(read.skipped, 2);
    }
}
