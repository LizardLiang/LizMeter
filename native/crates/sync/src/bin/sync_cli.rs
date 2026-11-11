//! Driver for `native/tools/sync-equivalence/`: runs the Rust sync engine against a database file the
//! harness names, so a Node script can compare it with the TypeScript engine row for row.
//!
//! Every path comes from the command line. This binary never resolves `%APPDATA%` and never reads a
//! default data folder: the harness passes temp folders only.
//!
//! Commands (all take `--db <file>`):
//!   init            --db F --user-data U --shared S      fresh device, deterministic seed uuids, sync on
//!   setup           --db F --user-data U --shared S --role originate|adopt
//!   merge           --db F --user-data U --shared S      one merge pass, prints {applied,...}
//!   edit            --db F --user-data U --shared S --seed N --ops K
//!   clear-scenario  --db F --user-data U --shared S --tag T   two done todos (one with a child), one open, then "Clear done"
//!   outbox-scenario --db F --user-data U --shared S --name N   one outbox scenario, prints the shared JSON shape
//!   dump            --db F --out O --mode fixture|mixed
//!   snapshot-entries --db F --out O
//!   write-snapshot  --db F --user-data U --shared S
//!   rebuild         --db F --user-data U --shared S

use lizmeter_core::{
    AssignTagInput, CreateTagInput, CreateTodoInput, CreateTodoLabelInput, CreateTodoProjectInput, ListTodosInput,
    SaveSessionInput, TimerType, UpdateTodoInput,
};
use lizmeter_db::{set_sync_enabled, Database};
use lizmeter_sync::hlc::now_ms;
use lizmeter_sync::merge_pass::run_merge_pass;
use lizmeter_sync::migration::enable_sync_on_existing_machine;
use lizmeter_sync::pending_action::PendingSyncAction;
use lizmeter_sync::row_codec::query_rows;
use lizmeter_sync::snapshot::{build_snapshot_entries, rebuild_from_snapshot, write_snapshot_if_due};
use lizmeter_sync::sync_manager::{NoNotifier, SyncManager};
use lizmeter_sync::SyncWriter;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

struct Args(HashMap<String, String>);

impl Args {
    fn parse(items: &[String]) -> Args {
        let mut map = HashMap::new();
        let mut i = 0;
        while i < items.len() {
            if let Some(key) = items[i].strip_prefix("--") {
                map.insert(key.to_string(), items.get(i + 1).cloned().unwrap_or_default());
                i += 2;
            } else {
                i += 1;
            }
        }
        Args(map)
    }
    fn get(&self, k: &str) -> Res<&str> {
        self.0.get(k).map(String::as_str).ok_or_else(|| format!("missing --{k}").into())
    }
    fn path(&self, k: &str) -> Res<PathBuf> {
        Ok(PathBuf::from(self.get(k)?))
    }
}

fn open_db(args: &Args) -> Res<Database> {
    let writer = SyncWriter::new(args.path("shared")?, &args.path("user-data")?)?;
    Ok(Database::open_with_sync(args.path("db")?, Box::new(writer))?)
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = argv.first() else {
        eprintln!("usage: sync_cli <command> --db F ...");
        std::process::exit(2);
    };
    if let Err(e) = run(command, &Args::parse(&argv[1..])) {
        eprintln!("sync_cli {command}: {e}");
        std::process::exit(1);
    }
}

fn run(command: &str, args: &Args) -> Res<()> {
    match command {
        "init" => {
            let db = open_db(args)?;
            // Seed rows get fixed uuids so two engines can start from the same rows.
            db.conn().execute(
                "UPDATE todo_states SET uuid = 'seed-state-' || id, created_at = '2026-01-01T00:00:00.000Z'",
                [],
            )?;
            db.conn().execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sync.deviceNumber', '941')", [])?;
            set_sync_enabled(db.conn(), true)?;
            Ok(())
        }
        "setup" => setup(args),
        "merge" => {
            let db = open_db(args)?;
            let writer = SyncWriter::new(args.path("shared")?, &args.path("user-data")?)?;
            let result = run_merge_pass(db.conn(), args.path("shared")?.as_path(), writer.device_id())?;
            println!("{}", json!({ "applied": result.applied, "skipped": result.skipped_already_applied, "notices": result.notices }));
            Ok(())
        }
        "edit" => edit(args),
        "clear-scenario" => clear_scenario(args),
        "outbox-scenario" => outbox_scenario(args),
        "dump" => {
            let db = open_db(args)?;
            let mixed = args.get("mode")? == "mixed";
            std::fs::write(args.path("out")?, serde_json::to_string_pretty(&dump(db.conn(), mixed)?)?)?;
            Ok(())
        }
        "snapshot-entries" => {
            let db = open_db(args)?;
            let entries = build_snapshot_entries(db.conn(), now_ms())?;
            let mut normalized: Vec<String> = entries.iter().map(|e| normalize_snapshot_entry(&e.to_value()).to_string()).collect();
            normalized.sort();
            std::fs::write(args.path("out")?, serde_json::to_string_pretty(&normalized)?)?;
            Ok(())
        }
        "write-snapshot" => {
            let db = open_db(args)?;
            let writer = SyncWriter::new(args.path("shared")?, &args.path("user-data")?)?;
            let wrote = write_snapshot_if_due(db.conn(), &args.path("shared")?, writer.device_id(), now_ms())?;
            println!("{}", json!({ "wrote": wrote }));
            Ok(())
        }
        "rebuild" => {
            let db = open_db(args)?;
            let writer = SyncWriter::new(args.path("shared")?, &args.path("user-data")?)?;
            let rebuilt = rebuild_from_snapshot(db.conn(), &args.path("shared")?, writer.device_id(), None, now_ms())?;
            println!("{}", json!({ "rebuilt": rebuilt }));
            Ok(())
        }
        other => Err(format!("unknown command {other}").into()),
    }
}

/// Mirrors `tsClearScenario` in `native/tools/sync-equivalence/clear-completed.ts`.
fn clear_scenario(args: &Args) -> Res<()> {
    let db = open_db(args)?;
    let tag = args.get("tag")?;
    let make = |title: String, parent_id: Option<i64>| -> Res<i64> {
        Ok(db.create_todo(&CreateTodoInput { title, parent_id, ..Default::default() })?.id)
    };
    let done1 = make(format!("{tag}-done-1"), None)?;
    let done2 = make(format!("{tag}-done-2"), None)?;
    make(format!("{tag}-open"), None)?;
    make(format!("{tag}-child"), Some(done1))?;
    let done_state = db.list_todo_states()?.into_iter().find(|st| st.is_completed).ok_or("no completed state")?.id;
    for id in [done1, done2] {
        db.update_todo(&UpdateTodoInput { id, state_id: Some(done_state), ..Default::default() })?;
    }
    let cleared = db.clear_completed_todos()?;
    println!("{}", json!({ "cleared": cleared.count }));
    Ok(())
}

fn init_sync_device(db: &Database) -> Res<()> {
    db.conn().execute(
        "UPDATE todo_states SET uuid = 'seed-state-' || id, created_at = '2026-01-01T00:00:00.000Z'",
        [],
    )?;
    db.conn().execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sync.deviceNumber', '941')", [])?;
    set_sync_enabled(db.conn(), true)?;
    Ok(())
}

fn scalar(db: &Database, sql: &str) -> Res<i64> {
    Ok(db.conn().query_row(sql, [], |r| r.get(0))?)
}

fn sorted_strings(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

fn checkpoint(db: &Database) -> Res<Value> {
    let mut stmt = db.conn().prepare("SELECT message FROM sync_notices WHERE kind = 'publish-pending'")?;
    let notices: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(json!({
        "outbox": scalar(db, "SELECT COUNT(*) FROM sync_outbox")?,
        "notices": notices,
        "tags": sorted_strings(db.list_tags()?.into_iter().map(|t| t.name).collect()),
        "todos": sorted_strings(db.list_todos(&ListTodosInput::default())?.into_iter().map(|t| t.title).collect()),
    }))
}

fn own_oplog(args: &Args, writer: &SyncWriter) -> Res<Vec<String>> {
    let file = lizmeter_sync::oplog::get_oplog_file_path(&args.path("shared")?, writer.device_id());
    Ok(match std::fs::read_to_string(file) {
        Ok(text) => text.split('\n').filter(|l| !l.is_empty()).map(String::from).collect(),
        Err(_) => vec![],
    })
}

fn block_shared(args: &Args) -> Res<PathBuf> {
    let blocker = args.path("shared")?.join("sync");
    let _ = std::fs::remove_dir_all(&blocker);
    std::fs::write(&blocker, "not a folder")?;
    Ok(blocker)
}

/// A fresh sync-enabled device in a different database merges the shared folder twice.
fn peer_view(args: &Args) -> Res<Value> {
    let shared = args.path("shared")?;
    let mut peer_db = args.path("db")?.into_os_string();
    peer_db.push(".peer");
    let mut peer_user = args.path("user-data")?.into_os_string();
    peer_user.push("-peer");
    let peer_user = PathBuf::from(peer_user);
    std::fs::create_dir_all(&peer_user)?;
    let writer = SyncWriter::new(&shared, &peer_user)?;
    let db = Database::open_with_sync(PathBuf::from(peer_db), Box::new(writer.clone()))?;
    init_sync_device(&db)?;
    let first = run_merge_pass(db.conn(), &shared, writer.device_id())?;
    let second = run_merge_pass(db.conn(), &shared, writer.device_id())?;
    Ok(json!({
        "firstApplied": first.applied,
        "secondApplied": second.applied,
        "appliedOps": scalar(&db, "SELECT COUNT(*) FROM sync_applied_ops")?,
        "tags": sorted_strings(db.list_tags()?.into_iter().map(|t| t.name).collect()),
        "todos": sorted_strings(db.list_todos(&ListTodosInput::default())?.into_iter().map(|t| t.title).collect()),
    }))
}

/// Mirrors `tsOutboxScenario` in `native/tools/sync-equivalence/outbox.ts`.
fn outbox_scenario(args: &Args) -> Res<()> {
    let shared = args.path("shared")?;
    let writer = SyncWriter::new(&shared, &args.path("user-data")?)?;
    let db = Database::open_with_sync(args.path("db")?, Box::new(writer.clone()))?;
    let tag = |name: &str| CreateTagInput { name: name.into(), color: "#7aa2f7".into() };
    let todo = |title: &str| CreateTodoInput { title: title.into(), ..Default::default() };

    let result = match args.get("name")? {
        "enable-sync-resume" => {
            db.create_todo(&todo("one"))?;
            db.create_todo(&todo("two"))?;
            db.create_tag(&tag("tag-one"))?;
            let blocker = block_shared(args)?;
            enable_sync_on_existing_machine(db.conn(), None, &shared, &writer)?;
            let enabled: Option<String> = db
                .conn()
                .query_row("SELECT value FROM settings WHERE key = 'sync.enabled'", [], |r| r.get(0))
                .ok();
            let mut blocked = checkpoint(&db)?;
            blocked["enabled"] = json!(enabled);
            std::fs::remove_file(blocker)?;
            db.flush_outbox();
            json!({ "blocked": blocked, "recovered": checkpoint(&db)?, "oplog": own_oplog(args, &writer)?, "peer": peer_view(args)? })
        }
        "write-fails-after-record" => {
            init_sync_device(&db)?;
            db.conn().execute_batch(
                "CREATE TRIGGER fail_clock BEFORE INSERT ON sync_field_clocks BEGIN SELECT RAISE(ABORT, 'boom'); END",
            )?;
            let failed = db.create_tag(&tag("ghost")).is_err();
            let after_failure = checkpoint(&db)?;
            let oplog_after_failure = own_oplog(args, &writer)?;
            db.conn().execute_batch("DROP TRIGGER fail_clock")?;
            db.create_tag(&tag("kept"))?;
            json!({
                "failed": failed,
                "afterFailure": after_failure,
                "oplogAfterFailure": oplog_after_failure,
                "final": checkpoint(&db)?,
                "oplog": own_oplog(args, &writer)?,
                "peer": peer_view(args)?,
            })
        }
        "unreachable-then-recovers" => {
            init_sync_device(&db)?;
            let blocker = block_shared(args)?;
            db.create_todo(&todo("first"))?;
            db.create_tag(&tag("t"))?;
            db.create_todo(&todo("second"))?;
            let blocked = checkpoint(&db)?;
            let oplog_while_blocked = shared.join("sync").join("devices").exists();
            std::fs::remove_file(blocker)?;
            db.flush_outbox();
            json!({
                "blocked": blocked,
                "oplogWhileBlocked": oplog_while_blocked,
                "recovered": checkpoint(&db)?,
                "oplog": own_oplog(args, &writer)?,
                "peer": peer_view(args)?,
            })
        }
        "duplicate-flush" => {
            init_sync_device(&db)?;
            db.create_tag(&tag("deep"))?;
            db.create_todo(&todo("x"))?;
            let once = own_oplog(args, &writer)?;
            for line in &once {
                db.conn().execute(
                    "INSERT INTO sync_outbox (line, created_at) VALUES (?, ?)",
                    rusqlite::params![line, "2026-01-01T00:00:00.000Z"],
                )?;
            }
            db.flush_outbox();
            json!({ "onceLength": once.len(), "final": checkpoint(&db)?, "oplog": own_oplog(args, &writer)?, "peer": peer_view(args)? })
        }
        "quit-with-sync-off" => {
            init_sync_device(&db)?;
            let blocker = block_shared(args)?;
            db.create_tag(&tag("queued"))?;
            let queued = checkpoint(&db)?;
            set_sync_enabled(db.conn(), false)?;
            std::fs::remove_file(blocker)?;
            let db = Arc::new(Mutex::new(db));
            let manager = SyncManager::new(db.clone(), writer.clone(), args.path("user-data")?, None, Arc::new(NoNotifier));
            manager.flush_outbox();
            let after_quit_off = checkpoint(&db.lock().unwrap())?;
            let oplog_after_quit_off = own_oplog(args, &writer)?;
            set_sync_enabled(db.lock().unwrap().conn(), true)?;
            manager.flush_outbox();
            let db = db.lock().unwrap();
            json!({
                "queued": queued,
                "afterQuitOff": after_quit_off,
                "oplogAfterQuitOff": oplog_after_quit_off,
                "final": checkpoint(&db)?,
                "oplog": own_oplog(args, &writer)?,
                "peer": peer_view(args)?,
            })
        }
        "failed-append-undone" => {
            init_sync_device(&db)?;
            db.create_tag(&tag("before"))?;
            db.conn().execute(
                "INSERT INTO sync_outbox (line, created_at) VALUES (?, ?)",
                rusqlite::params!["{\"v\":1,\"torn\":true}", "2026-01-01T00:00:00.000Z"],
            )?;
            writer.flush_outbox_with_writer(db.conn(), |file, bytes| {
                std::io::Write::write_all(file, &bytes[..10])?;
                Err(std::io::Error::other("disk full"))
            });
            let after_failure = checkpoint(&db)?;
            let oplog_after_failure = own_oplog(args, &writer)?;
            db.flush_outbox();
            json!({
                "afterFailure": after_failure,
                "oplogAfterFailure": oplog_after_failure,
                "final": checkpoint(&db)?,
                "oplog": own_oplog(args, &writer)?,
                "peer": peer_view(args)?,
            })
        }
        other => return Err(format!("unknown outbox scenario {other}").into()),
    };
    println!("{result}");
    Ok(())
}

fn setup(args: &Args) -> Res<()> {
    let shared = args.path("shared")?;
    let user_data = args.path("user-data")?;
    let writer = SyncWriter::new(&shared, &user_data)?;
    let db = Database::open_with_sync(args.path("db")?, Box::new(writer.clone()))?;
    match args.get("role")? {
        "originate" => {
            enable_sync_on_existing_machine(db.conn(), None, &shared, &writer)?;
        }
        "adopt" => {
            let db = Arc::new(Mutex::new(db));
            let manager = SyncManager::new(db, writer, user_data, None, Arc::new(NoNotifier));
            manager.apply_pending_sync_action_after_init(Some(&PendingSyncAction::Adopt { target_dir: shared }))?;
        }
        other => return Err(format!("unknown role {other}").into()),
    }
    Ok(())
}

// --- normalized dump ---

fn rows(conn: &rusqlite::Connection, sql: &str) -> Res<Vec<Value>> {
    Ok(query_rows(conn, sql, [])?.into_iter().map(Value::Object).collect())
}

fn sorted_by(mut rows: Vec<Value>, key: impl Fn(&Value) -> String) -> Vec<Value> {
    rows.sort_by_key(|r| key(r));
    rows
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())).unwrap_or_default()
}

fn drop_keys(rows: Vec<Value>, keys: &[&str]) -> Vec<Value> {
    rows.into_iter()
        .map(|mut r| {
            if let Value::Object(m) = &mut r {
                for k in keys {
                    m.remove(*k);
                }
            }
            r
        })
        .collect()
}

/// The shape both engines produce. Device-local ids and wall-clock stamps are dropped; foreign keys
/// are expressed as uuids. Keep in step with `native/tools/sync-equivalence/dump.ts`.
fn dump(conn: &rusqlite::Connection, mixed: bool) -> Res<Value> {
    let mut out = Map::new();

    let todos = rows(
        conn,
        "SELECT t.*,
                (SELECT uuid FROM todo_states x WHERE x.id = t.state_id) AS state_uuid,
                (SELECT uuid FROM todo_projects x WHERE x.id = t.project_id) AS project_uuid,
                (SELECT uuid FROM todos x WHERE x.id = t.parent_id) AS parent_uuid
         FROM todos t",
    )?;
    out.insert("todos".into(), Value::Array(sorted_by(drop_keys(todos, &["state_id", "project_id", "parent_id"]), |r| s(r, "uuid"))));

    for (table, key) in [("todo_states", "uuid"), ("todo_projects", "uuid"), ("todo_labels", "uuid"), ("tags", "uuid")] {
        let r = rows(conn, &format!("SELECT * FROM {table}"))?;
        out.insert(table.into(), Value::Array(sorted_by(drop_keys(r, &["id", "position"]), |r| s(r, key))));
    }

    let sessions = rows(conn, "SELECT * FROM sessions")?;
    out.insert("sessions".into(), Value::Array(sorted_by(sessions, |r| s(r, "id"))));

    out.insert(
        "todo_label_links".into(),
        Value::Array(sorted_by(
            rows(conn, "SELECT t.uuid AS todo_uuid, l.uuid AS label_uuid FROM todo_label_links k INNER JOIN todos t ON t.id = k.todo_id INNER JOIN todo_labels l ON l.id = k.label_id")?,
            |r| format!("{}|{}", s(r, "todo_uuid"), s(r, "label_uuid")),
        )),
    );
    out.insert(
        "session_tags".into(),
        Value::Array(sorted_by(
            rows(conn, "SELECT st.session_id AS session_id, t.uuid AS tag_uuid FROM session_tags st INNER JOIN tags t ON t.id = st.tag_id")?,
            |r| format!("{}|{}", s(r, "session_id"), s(r, "tag_uuid")),
        )),
    );
    out.insert(
        "todo_attachments".into(),
        Value::Array(sorted_by(
            rows(conn, "SELECT t.uuid AS todo_uuid, a.sha256, a.file_name, a.mime_type, a.size_bytes, a.kind FROM todo_attachments a INNER JOIN todos t ON t.id = a.todo_id")?,
            |r| format!("{}|{}", s(r, "todo_uuid"), s(r, "sha256")),
        )),
    );
    out.insert(
        "sync_tombstones".into(),
        Value::Array(sorted_by(
            rows(
                conn,
                if mixed {
                    "SELECT table_name, row_uuid FROM sync_tombstones"
                } else {
                    "SELECT table_name, row_uuid, hlc_physical_ms, hlc_counter, hlc_device_number FROM sync_tombstones"
                },
            )?,
            |r| format!("{}|{}", s(r, "table_name"), s(r, "row_uuid")),
        )),
    );
    // A mixed run leaves the clocks out: a field the author wrote but a peer could not resolve yet
    // (a parent that was deleted meanwhile) is clocked only on the author. Fixture mode compares them.
    if !mixed {
        out.insert(
            "sync_field_clocks".into(),
            Value::Array(sorted_by(
                rows(conn, "SELECT table_name, row_uuid, field_name, hlc_physical_ms, hlc_counter, hlc_device_number FROM sync_field_clocks")?,
                |r| format!("{}|{}|{}", s(r, "table_name"), s(r, "row_uuid"), s(r, "field_name")),
            )),
        );
    }

    if !mixed {
        out.insert(
            "sync_id_aliases".into(),
            Value::Array(sorted_by(
                rows(conn, "SELECT table_name, old_uuid, new_uuid FROM sync_id_aliases")?,
                |r| format!("{}|{}", s(r, "table_name"), s(r, "old_uuid")),
            )),
        );
        out.insert(
            "sync_applied_ops".into(),
            Value::Array(sorted_by(rows(conn, "SELECT op_id, device_id FROM sync_applied_ops")?, |r| s(r, "op_id"))),
        );
        out.insert(
            "sync_notices".into(),
            Value::Array(sorted_by(rows(conn, "SELECT kind, message, detail FROM sync_notices")?, |r| {
                format!("{}|{}|{}", s(r, "kind"), s(r, "message"), s(r, "detail"))
            })),
        );
        out.insert(
            "settings".into(),
            Value::Array(rows(conn, "SELECT key, value FROM settings WHERE key = 'sync.nextTodoId'")?),
        );
    }
    Ok(Value::Object(out))
}

/// A snapshot's own HLC is wall-clock, so only tombstone (delete) entries keep theirs.
fn normalize_snapshot_entry(entry: &Value) -> Value {
    let mut e = entry.clone();
    if let Value::Object(m) = &mut e {
        m.remove("opId");
        if m.get("op").and_then(Value::as_str) != Some("delete") {
            m.remove("hlc");
        }
        if let Some(Value::Object(fields)) = m.get_mut("fields") {
            for (_, change) in fields.iter_mut() {
                if let Value::Object(c) = change {
                    c.remove("hlc");
                }
            }
        }
    }
    sort_value(&e)
}

fn sort_value(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for k in keys {
                out.insert(k.clone(), sort_value(&m[k]));
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(sort_value).collect()),
        other => other.clone(),
    }
}

// --- random edits ---

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        if items.is_empty() {
            None
        } else {
            Some(&items[self.below(items.len())])
        }
    }
}

const LABELS: [&str; 5] = ["bug", "urgent", "idea", "chore", "docs"];
const PROJECTS: [&str; 4] = ["Alpha", "Beta", "Gamma", "Delta"];
const TAGS: [&str; 3] = ["focus", "deep", "review"];

fn edit(args: &Args) -> Res<()> {
    let db = open_db(args)?;
    let mut rng = Rng(args.get("seed")?.parse::<u64>()?.wrapping_mul(0x9E3779B97F4A7C15) | 1);
    let ops: usize = args.get("ops")?.parse()?;
    let label = format!("rs-{}", args.get("seed")?);
    let mut done = 0usize;

    for n in 0..ops {
        let roll = rng.below(100);
        let todos = db.list_todos(&ListTodosInput::default())?;
        let outcome: lizmeter_db::Result<()> = (|| {
            match roll {
                0..=34 => {
                    let states = db.list_todo_states()?;
                    let projects = db.list_todo_projects()?;
                    let labels = db.list_todo_labels()?;
                    let mut label_ids = Vec::new();
                    if rng.below(3) == 0 {
                        if let Some(l) = rng.pick(&labels) {
                            label_ids.push(l.id);
                        }
                    }
                    db.create_todo(&CreateTodoInput {
                        title: format!("{label}-{n}"),
                        state_id: if rng.below(2) == 0 { rng.pick(&states).map(|x| x.id) } else { None },
                        project_id: if rng.below(3) == 0 { rng.pick(&projects).map(|x| x.id) } else { None },
                        label_ids: if label_ids.is_empty() { None } else { Some(label_ids) },
                        parent_id: if rng.below(5) == 0 { rng.pick(&todos).map(|t| t.id) } else { None },
                        due_date: if rng.below(4) == 0 { Some(format!("2026-0{}-1{}", 1 + rng.below(9), rng.below(9))) } else { None },
                        ..Default::default()
                    })?;
                }
                35..=59 => {
                    if let Some(t) = rng.pick(&todos) {
                        let mut u = UpdateTodoInput { id: t.id, ..Default::default() };
                        match rng.below(6) {
                            0 => u.title = Some(format!("{label}-edit-{n}")),
                            1 => u.notes = Some(Some(format!("note {label} {n}"))),
                            2 => u.priority = Some(rng.below(4) as i64),
                            3 => u.due_date = Some(if rng.below(2) == 0 { None } else { Some("2026-12-24".into()) }),
                            4 => u.state_id = rng.pick(&db.list_todo_states()?).map(|x| x.id),
                            _ => u.label_ids = Some(rng.pick(&db.list_todo_labels()?).map(|l| vec![l.id]).unwrap_or_default()),
                        }
                        db.update_todo(&u)?;
                    }
                }
                60..=67 => {
                    if let Some(t) = rng.pick(&todos) {
                        db.delete_todo(t.id)?;
                    }
                }
                68..=73 => {
                    let name = LABELS[rng.below(LABELS.len())];
                    db.create_todo_label(&CreateTodoLabelInput { name: name.into(), color: Some("#9ece6a".into()) })?;
                }
                74..=78 => {
                    let name = PROJECTS[rng.below(PROJECTS.len())];
                    db.create_todo_project(&CreateTodoProjectInput { name: name.into(), color: None })?;
                }
                79..=82 => {
                    let name = TAGS[rng.below(TAGS.len())];
                    db.create_tag(&CreateTagInput { name: name.into(), color: "#bb9af7".into() })?;
                }
                83..=86 => {
                    let mut ids: Vec<i64> = db.list_todo_projects()?.iter().map(|p| p.id).collect();
                    for i in (1..ids.len()).rev() {
                        ids.swap(i, rng.below(i + 1));
                    }
                    if !ids.is_empty() {
                        db.reorder_todo_projects(&ids)?;
                    }
                }
                87..=89 => {
                    let mut ids: Vec<i64> = db.list_todo_states()?.iter().map(|p| p.id).collect();
                    for i in (1..ids.len()).rev() {
                        ids.swap(i, rng.below(i + 1));
                    }
                    db.reorder_todo_states(&ids)?;
                }
                90..=95 => {
                    let session = db.save_session(&SaveSessionInput {
                        title: format!("{label}-session-{n}"),
                        timer_type: TimerType::Work,
                        planned_duration_seconds: 1500,
                        actual_duration_seconds: 60 + rng.below(1400) as i64,
                        issue_number: None,
                        issue_title: None,
                        issue_url: None,
                        issue_provider: None,
                        issue_id: None,
                    })?;
                    if let Some(tag) = rng.pick(&db.list_tags()?) {
                        db.assign_tag(&AssignTagInput { session_id: session.id, tag_id: tag.id })?;
                    }
                }
                _ => {
                    let listed = db.list_sessions(&Default::default())?;
                    if let Some(s) = rng.pick(&listed.sessions) {
                        db.delete_session(&s.id)?;
                    }
                }
            }
            Ok(())
        })();
        if outcome.is_ok() {
            done += 1;
        }
    }
    println!("{}", json!({ "done": done }));
    Ok(())
}
