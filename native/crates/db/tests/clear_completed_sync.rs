//! "Clear N done" must publish one delete per cleared todo, exactly like `delete_todo`.

use lizmeter_core::{CreateTodoInput, UpdateTodoInput};
use lizmeter_db::{Database, Fields, LinkOp, Result, SyncHook};
use rusqlite::Connection;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Recorder {
    deletes: Arc<Mutex<Vec<(String, String)>>>,
}

impl SyncHook for Recorder {
    fn allocate_todo_id(&self, _: &Connection) -> Result<Option<i64>> {
        Ok(None)
    }
    fn record_upsert(&self, _: &Connection, _: &str, _: &str, _: &Fields) -> Result<()> {
        Ok(())
    }
    fn record_delete(&self, _: &Connection, table: &str, row_uuid: &str) -> Result<()> {
        self.deletes.lock().unwrap().push((table.to_string(), row_uuid.to_string()));
        Ok(())
    }
    fn record_link(&self, _: &Connection, _: &str, _: LinkOp, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
    fn record_reorder(&self, _: &Connection, _: &str, _: &[i64]) -> Result<()> {
        Ok(())
    }
}

fn uuid_of(db: &Database, id: i64) -> String {
    db.conn().query_row("SELECT uuid FROM todos WHERE id = ?", [id], |r| r.get(0)).unwrap()
}

#[test]
fn clear_completed_records_a_delete_per_cleared_todo_and_none_for_open_ones() {
    let mut db = Database::open_in_memory().unwrap();
    let log = Arc::new(Mutex::new(Vec::new()));
    db.set_sync_hook(Box::new(Recorder { deletes: log.clone() }));
    let make = |t: &str| db.create_todo(&CreateTodoInput { title: t.into(), ..Default::default() }).unwrap();
    let (a, b, open) = (make("a"), make("b"), make("open"));
    let done = db.find_todo_state_by_label("Done").unwrap().unwrap();
    for id in [a.id, b.id] {
        db.update_todo(&UpdateTodoInput { id, state_id: Some(done.id), ..Default::default() }).unwrap();
    }
    let (ua, ub, uopen) = (uuid_of(&db, a.id), uuid_of(&db, b.id), uuid_of(&db, open.id));

    assert_eq!(db.clear_completed_todos().unwrap().count, 2);

    let mut got = log.lock().unwrap().clone();
    got.sort();
    let mut want = vec![("todos".to_string(), ua), ("todos".to_string(), ub)];
    want.sort();
    assert_eq!(got, want);
    assert!(!got.iter().any(|(_, u)| *u == uopen));
}
