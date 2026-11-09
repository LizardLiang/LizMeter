//! Schema equality against Electron's real better-sqlite3 build.
//!
//! `tests/fixtures/electron-schema.json` is the `sqlite_master` + `PRAGMA table_info` dump of a fresh
//! Electron database. Regenerate it from the repo root with:
//!
//! ```text
//! node native/tools/schema-dump/dump.mjs native/crates/db/tests/fixtures/electron-schema.json
//! ```
//!
//! Set `LIZMETER_DEV_DB_COPY` to a COPY of a real database to also prove the migrations land on the
//! same schema as Electron's when opening existing data (see `opens_a_copy_of_a_real_database`).

use lizmeter_db::Database;
use serde_json::Value;
use std::collections::BTreeMap;

const ELECTRON_SCHEMA: &str = include_str!("fixtures/electron-schema.json");

struct Dump {
    master: Vec<(String, String, String, Option<String>)>,
    columns: BTreeMap<String, Vec<(String, String, i64, Option<String>, i64)>>,
}

fn dump(db: &Database) -> Dump {
    let conn = db.conn();
    let mut stmt = conn
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
        .unwrap();
    let master: Vec<(String, String, String, Option<String>)> =
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(|r| r.unwrap()).collect();
    let mut columns = BTreeMap::new();
    for (kind, name, _, _) in &master {
        if kind == "table" {
            let mut s = conn.prepare(&format!("PRAGMA table_info({name})")).unwrap();
            let cols = s
                .query_map([], |r| Ok((r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            columns.insert(name.clone(), cols);
        }
    }
    Dump { master, columns }
}

fn electron() -> Dump {
    let v: Value = serde_json::from_str(ELECTRON_SCHEMA).unwrap();
    let master = v["master"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["type"].as_str().unwrap().to_string(),
                r["name"].as_str().unwrap().to_string(),
                r["tbl_name"].as_str().unwrap().to_string(),
                r["sql"].as_str().map(String::from),
            )
        })
        .collect();
    let mut columns = BTreeMap::new();
    for (table, cols) in v["columns"].as_object().unwrap() {
        let cols = cols
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    c["name"].as_str().unwrap().to_string(),
                    c["type"].as_str().unwrap().to_string(),
                    c["notnull"].as_i64().unwrap(),
                    c["dflt_value"].as_str().map(String::from),
                    c["pk"].as_i64().unwrap(),
                )
            })
            .collect();
        columns.insert(table.clone(), cols);
    }
    Dump { master, columns }
}

fn assert_same(native: &Dump, reference: &Dump) {
    assert_eq!(
        native.master.iter().map(|m| (&m.0, &m.1)).collect::<Vec<_>>(),
        reference.master.iter().map(|m| (&m.0, &m.1)).collect::<Vec<_>>(),
        "set of tables/indexes differs"
    );
    for (n, e) in native.master.iter().zip(&reference.master) {
        assert_eq!(n, e, "sqlite_master entry {} differs", n.1);
    }
    assert_eq!(native.columns, reference.columns, "PRAGMA table_info differs");
}

#[test]
fn fresh_native_database_has_the_same_schema_as_a_fresh_electron_database() {
    let db = Database::open_in_memory().unwrap();
    assert_same(&dump(&db), &electron());
}

#[test]
fn schema_is_stable_across_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lizmeter.db");
    drop(Database::open(&path).unwrap());
    let db = Database::open(&path).unwrap();
    assert_same(&dump(&db), &electron());
}

/// Opens the file named by `LIZMETER_DEV_DB_COPY` (a COPY, never the live data folder) and reads
/// every table. With `LIZMETER_DEV_DB_ELECTRON_DUMP` also set to Electron's dump of its own copy of
/// the same file, asserts both migrated to the same schema.
#[test]
fn opens_a_copy_of_a_real_database() {
    let Ok(source) = std::env::var("LIZMETER_DEV_DB_COPY") else {
        eprintln!("LIZMETER_DEV_DB_COPY not set; skipping real-database check");
        return;
    };
    let db = Database::open(&source).unwrap();

    let tables: Vec<String> = {
        let mut s = db.conn().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap();
        s.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    };
    for t in &tables {
        let n: i64 = db.conn().query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0)).unwrap();
        eprintln!("table {t}: {n} rows");
    }

    // Every typed reader must cope with the real rows.
    let sessions = db.list_sessions(&Default::default()).unwrap();
    for s in &sessions.sessions {
        let _ = db.get_claude_code_data_for_session(&s.id).unwrap();
    }
    let todos = db.list_todos(&Default::default()).unwrap();
    for t in &todos {
        let _ = db.list_todo_attachments(t.id).unwrap();
    }
    db.list_tags().unwrap();
    db.list_todo_states().unwrap();
    db.list_todo_projects().unwrap();
    db.list_todo_labels().unwrap();
    db.list_todo_milestones().unwrap();
    db.get_settings().unwrap();
    let music = db.list_music_tracks(&lizmeter_core::MusicLibraryListInput { limit: Some(1_000_000), ..Default::default() }).unwrap();
    db.list_playlists().unwrap();
    for p in db.list_playlists().unwrap() {
        db.get_playlist_tracks(p.id).unwrap();
    }
    eprintln!("sessions={} todos={} tracks={}", sessions.total, todos.len(), music.total);

    if let Ok(reference) = std::env::var("LIZMETER_DEV_DB_ELECTRON_DUMP") {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(reference).unwrap()).unwrap();
        let theirs: Vec<(String, String, String, Option<String>)> = v["master"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["type"].as_str().unwrap().into(),
                    r["name"].as_str().unwrap().into(),
                    r["tbl_name"].as_str().unwrap().into(),
                    r["sql"].as_str().map(String::from),
                )
            })
            .collect();
        let ours = dump(&db).master;
        assert_eq!(ours, theirs, "schema after migrating the same real database differs from Electron's");
    }
}
