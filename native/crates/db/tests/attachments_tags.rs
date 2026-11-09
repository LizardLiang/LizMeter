//! Port of `todo-attachments-database.test.ts` and `tags-database.test.ts`.

use lizmeter_core::{
    AssignTagInput, CreateTagInput, CreateTodoInput, ListSessionsInput, ListTodosInput, SaveSessionInput, TimerType,
    TodoAttachmentKind, UpdateTagInput, UpdateTodoInput,
};
use lizmeter_db::{CreateTodoAttachmentInput, Database};

const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn db() -> Database {
    Database::open_in_memory().unwrap()
}

fn todo(db: &Database, title: &str) -> lizmeter_core::Todo {
    db.create_todo(&CreateTodoInput { title: title.into(), ..Default::default() }).unwrap()
}

fn attach(db: &Database, todo_id: i64, sha: &str, file: &str) -> lizmeter_core::TodoAttachment {
    db.create_todo_attachment(&CreateTodoAttachmentInput {
        todo_id,
        sha256: sha.into(),
        file_name: file.into(),
        mime_type: "image/png".into(),
        size_bytes: 1024,
        kind: None,
    })
    .unwrap()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

// --- attachments ---

#[test]
fn create_inserts_and_lists_back() {
    let db = db();
    let t = todo(&db, "with a screenshot");
    let created = attach(&db, t.id, SHA_A, "Design.PNG");
    assert_eq!((created.todo_id, created.sha256.as_str(), created.file_name.as_str()), (t.id, SHA_A, "Design.PNG"));
    assert_eq!((created.mime_type.as_str(), created.size_bytes, created.kind), ("image/png", 1024, TodoAttachmentKind::Image));
    assert_eq!(created.url, format!("app-media://attachments/{SHA_A}.png"));
    assert_eq!(db.list_todo_attachments(t.id).unwrap(), [created]);
}

#[test]
fn non_image_extension_is_a_document() {
    let db = db();
    let t = todo(&db, "pdf");
    let created = db
        .create_todo_attachment(&CreateTodoAttachmentInput {
            todo_id: t.id,
            sha256: SHA_B.into(),
            file_name: "spec.pdf".into(),
            mime_type: "application/pdf".into(),
            size_bytes: 42,
            kind: None,
        })
        .unwrap();
    assert_eq!(created.kind, TodoAttachmentKind::File);
    assert_eq!(created.url, format!("app-media://attachments/{SHA_B}.pdf"));
}

#[test]
fn same_file_twice_is_a_no_op_and_blobs_are_shared() {
    let db = db();
    let t = todo(&db, "double paste");
    let first = attach(&db, t.id, SHA_A, "shot.png");
    let second = attach(&db, t.id, SHA_A, "a-different-display-name.png");
    assert_eq!(second.id, first.id);
    assert_eq!(second.file_name, "shot.png");
    assert_eq!(db.list_todo_attachments(t.id).unwrap().len(), 1);
    assert_eq!(db.count_attachments_by_sha(SHA_A).unwrap(), 1);

    let two = todo(&db, "two");
    attach(&db, two.id, SHA_A, "shot.png");
    assert_eq!(db.count_attachments_by_sha(SHA_A).unwrap(), 2);
    assert_eq!(db.list_all_attachment_shas().unwrap(), [SHA_A]);
}

#[test]
fn rejects_unknown_todo() {
    let db = db();
    let r = db.create_todo_attachment(&CreateTodoAttachmentInput {
        todo_id: 9999,
        sha256: SHA_A.into(),
        file_name: "x.png".into(),
        mime_type: "image/png".into(),
        size_bytes: 1,
        kind: None,
    });
    assert!(r.unwrap_err().to_string().to_lowercase().contains("todo"));
}

#[test]
fn get_and_delete_attachment() {
    let db = db();
    let t = todo(&db, "get me");
    let created = attach(&db, t.id, SHA_A, "shot.png");
    assert_eq!(db.get_todo_attachment(created.id).unwrap(), Some(created.clone()));
    assert_eq!(db.get_todo_attachment(9999).unwrap(), None);
    assert_eq!(db.delete_todo_attachment(created.id).unwrap(), Some(created));
    assert!(db.list_todo_attachments(t.id).unwrap().is_empty());
    assert_eq!(db.count_attachments_by_sha(SHA_A).unwrap(), 0);
    assert_eq!(db.delete_todo_attachment(9999).unwrap(), None);
}

#[test]
fn refcount_reaches_zero_only_after_last_row() {
    let db = db();
    let (one, two) = (todo(&db, "one"), todo(&db, "two"));
    let a = attach(&db, one.id, SHA_A, "shot.png");
    let b = attach(&db, two.id, SHA_A, "shot.png");
    assert_eq!(db.count_attachments_by_sha(SHA_A).unwrap(), 2);
    db.delete_todo_attachment(a.id).unwrap();
    assert_eq!(db.count_attachments_by_sha(SHA_A).unwrap(), 1);
    db.delete_todo_attachment(b.id).unwrap();
    assert_eq!(db.count_attachments_by_sha(SHA_A).unwrap(), 0);
    assert_eq!(db.count_attachments_by_sha(SHA_B).unwrap(), 0);
}

#[test]
fn delete_todo_returns_shas_and_leaves_shared_blob_counted() {
    let db = db();
    let t = todo(&db, "doomed");
    attach(&db, t.id, SHA_A, "shot.png");
    attach(&db, t.id, SHA_B, "spec.pdf");
    assert_eq!(sorted(db.delete_todo(t.id).unwrap()), [SHA_A, SHA_B]);
    assert!(db.list_todo_attachments(t.id).unwrap().is_empty());
    assert!(db.list_all_attachment_shas().unwrap().is_empty());
    assert!(db.delete_todo(todo(&db, "plain").id).unwrap().is_empty());

    let (doomed, keeper) = (todo(&db, "doomed"), todo(&db, "keeper"));
    attach(&db, doomed.id, SHA_A, "shot.png");
    attach(&db, keeper.id, SHA_A, "shot.png");
    assert_eq!(db.delete_todo(doomed.id).unwrap(), [SHA_A]);
    assert_eq!(db.count_attachments_by_sha(SHA_A).unwrap(), 1);
}

#[test]
fn deleting_a_parent_keeps_child_attachments() {
    let db = db();
    let parent = todo(&db, "parent");
    let child = db.create_todo(&CreateTodoInput { title: "child".into(), parent_id: Some(parent.id), ..Default::default() }).unwrap();
    attach(&db, parent.id, SHA_A, "shot.png");
    attach(&db, child.id, SHA_B, "spec.pdf");
    assert_eq!(db.delete_todo(parent.id).unwrap(), [SHA_A]);
    assert_eq!(db.list_todo_attachments(child.id).unwrap().len(), 1);
}

#[test]
fn clear_completed_reports_count_and_swept_shas() {
    let db = db();
    let done = db.find_todo_state_by_label("Done").unwrap().unwrap();
    let (a, b, open) = (todo(&db, "a"), todo(&db, "b"), todo(&db, "still open"));
    attach(&db, a.id, SHA_A, "shot.png");
    attach(&db, b.id, SHA_B, "spec.pdf");
    attach(&db, open.id, SHA_A, "shot.png");
    for id in [a.id, b.id] {
        db.update_todo(&UpdateTodoInput { id, state_id: Some(done.id), ..Default::default() }).unwrap();
    }
    let r = db.clear_completed_todos().unwrap();
    assert_eq!(r.count, 2);
    assert_eq!(sorted(r.deleted_shas), [SHA_A, SHA_B]);
    assert_eq!(db.count_attachments_by_sha(SHA_A).unwrap(), 1);
    assert_eq!(db.count_attachments_by_sha(SHA_B).unwrap(), 0);
    assert_eq!(db.list_todos(&ListTodosInput::default()).unwrap().len(), 1);
}

// --- tags ---

fn session(db: &Database, title: &str) -> lizmeter_core::Session {
    db.save_session(&SaveSessionInput {
        title: title.into(),
        timer_type: TimerType::Work,
        planned_duration_seconds: 1500,
        actual_duration_seconds: 1450,
        issue_number: None,
        issue_title: None,
        issue_url: None,
        issue_provider: None,
        issue_id: None,
    })
    .unwrap()
}

fn tag(db: &Database, name: &str, color: &str) -> lizmeter_core::Tag {
    db.create_tag(&CreateTagInput { name: name.into(), color: color.into() }).unwrap()
}

#[test]
fn create_tag_and_validation() {
    let db = db();
    let t = tag(&db, "Work", "#7aa2f7");
    assert_eq!((t.name.as_str(), t.color.as_str()), ("Work", "#7aa2f7"));
    assert!(!t.created_at.is_empty());
    assert!(db.create_tag(&CreateTagInput { name: "work".into(), color: "#9ece6a".into() }).is_err());
    assert!(db.create_tag(&CreateTagInput { name: "X".into(), color: "#ffffff".into() }).is_err());
    // The muted grey is a todo colour, not a tag colour.
    assert!(db.create_tag(&CreateTagInput { name: "Y".into(), color: "#565f89".into() }).is_err());
    assert!(db.create_tag(&CreateTagInput { name: "   ".into(), color: "#7aa2f7".into() }).is_err());
    assert!(db.create_tag(&CreateTagInput { name: "n".repeat(33), color: "#7aa2f7".into() }).is_err());
}

#[test]
fn list_tags_alphabetically() {
    let db = db();
    assert!(db.list_tags().unwrap().is_empty());
    tag(&db, "Zzz", "#7aa2f7");
    tag(&db, "Aaa", "#9ece6a");
    let names: Vec<_> = db.list_tags().unwrap().into_iter().map(|t| t.name).collect();
    assert_eq!(names, ["Aaa", "Zzz"]);
}

#[test]
fn update_and_delete_tag() {
    let db = db();
    let t = tag(&db, "Work", "#7aa2f7");
    let u = db.update_tag(&UpdateTagInput { id: t.id, name: "Focus".into(), color: "#bb9af7".into() }).unwrap();
    assert_eq!((u.name.as_str(), u.color.as_str(), u.id), ("Focus", "#bb9af7", t.id));
    assert!(db.update_tag(&UpdateTagInput { id: 99999, name: "X".into(), color: "#7aa2f7".into() }).is_err());
    db.delete_tag(t.id).unwrap();
    assert!(db.list_tags().unwrap().is_empty());
    db.delete_tag(99999).unwrap();
}

#[test]
fn assignment_is_idempotent_and_reversible() {
    let db = db();
    let s = session(&db, "Test session");
    let t = tag(&db, "Work", "#7aa2f7");
    assert!(db.list_tags_for_session(&s.id).unwrap().is_empty());
    let input = AssignTagInput { session_id: s.id.clone(), tag_id: t.id };
    db.assign_tag(&input).unwrap();
    db.assign_tag(&input).unwrap();
    let tags = db.list_tags_for_session(&s.id).unwrap();
    assert_eq!((tags.len(), tags[0].name.as_str()), (1, "Work"));
    db.unassign_tag(&input).unwrap();
    assert!(db.list_tags_for_session(&s.id).unwrap().is_empty());
}

#[test]
fn deletes_cascade_to_session_tags() {
    let db = db();
    let (s, t) = (session(&db, "a"), tag(&db, "Work", "#7aa2f7"));
    db.assign_tag(&AssignTagInput { session_id: s.id.clone(), tag_id: t.id }).unwrap();
    db.delete_tag(t.id).unwrap();
    assert!(db.list_tags_for_session(&s.id).unwrap().is_empty());

    let t2 = tag(&db, "Study", "#9ece6a");
    db.assign_tag(&AssignTagInput { session_id: s.id.clone(), tag_id: t2.id }).unwrap();
    db.delete_session(&s.id).unwrap();
    assert!(db.list_tags_for_session(&s.id).unwrap().is_empty());
    let rows: i64 = db.conn().query_row("SELECT COUNT(*) FROM session_tags", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0);
}

#[test]
fn list_sessions_populates_and_filters_by_tag() {
    let db = db();
    let plain = session(&db, "Untagged");
    assert!(db.list_sessions(&ListSessionsInput::default()).unwrap().sessions.iter().all(|s| s.tags.is_empty()));

    let (s1, blue, green) = (session(&db, "Tagged"), tag(&db, "Work", "#7aa2f7"), tag(&db, "Study", "#9ece6a"));
    db.assign_tag(&AssignTagInput { session_id: s1.id.clone(), tag_id: blue.id }).unwrap();
    db.assign_tag(&AssignTagInput { session_id: plain.id.clone(), tag_id: green.id }).unwrap();
    let all = db.list_sessions(&ListSessionsInput::default()).unwrap();
    assert_eq!(all.sessions.iter().find(|s| s.id == s1.id).unwrap().tags[0].name, "Work");

    let filtered = db.list_sessions(&ListSessionsInput { tag_id: Some(blue.id), ..Default::default() }).unwrap();
    assert_eq!((filtered.total, filtered.sessions[0].title.as_str()), (1, "Tagged"));
}

#[test]
fn filtered_total_counts_only_matching_sessions() {
    let db = db();
    let t = tag(&db, "Work", "#7aa2f7");
    for i in 0..3 {
        let s = session(&db, "s");
        if i < 2 {
            db.assign_tag(&AssignTagInput { session_id: s.id, tag_id: t.id }).unwrap();
        }
    }
    assert_eq!(db.list_sessions(&ListSessionsInput { tag_id: Some(t.id), ..Default::default() }).unwrap().total, 2);
    assert_eq!(db.list_sessions(&ListSessionsInput::default()).unwrap().total, 3);
}
