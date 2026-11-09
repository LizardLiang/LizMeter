//! Port of `electron/main/__tests__/database.test.ts` (sessions, settings, migrations idempotence).
//! Invalid enum values (`timerType`, `issueProvider`) cannot reach the typed API, so those cases
//! assert the deserialisation boundary that replaces the runtime validation.

use lizmeter_core::{
    IssueProviderKind, ListSessionsInput, SaveSessionInput, TimerSettings, TimerType, WorklogStatus, DEFAULT_SETTINGS,
    MAX_DURATION, MAX_TITLE_LENGTH, MIN_DURATION,
};
use lizmeter_db::Database;

fn db() -> Database {
    Database::open_in_memory().unwrap()
}

fn input(title: &str) -> SaveSessionInput {
    SaveSessionInput {
        title: title.into(),
        timer_type: TimerType::Work,
        planned_duration_seconds: 1500,
        actual_duration_seconds: 1500,
        issue_number: None,
        issue_title: None,
        issue_url: None,
        issue_provider: None,
        issue_id: None,
    }
}

fn is_uuid_v4(s: &str) -> bool {
    let b = s.as_bytes();
    s.len() == 36
        && b[8] == b'-'
        && b[13] == b'-'
        && b[18] == b'-'
        && b[23] == b'-'
        && b[14] == b'4'
        && matches!(b[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
}

fn is_iso(s: &str) -> bool {
    // 2026-11-09T05:22:39.123Z
    let b = s.as_bytes();
    s.len() == 24 && b[4] == b'-' && b[7] == b'-' && b[10] == b'T' && b[13] == b':' && b[16] == b':' && b[19] == b'.' && b[23] == b'Z'
}

#[test]
fn tc301_fresh_database_creates_schema() {
    let db = db();
    let result = db.list_sessions(&ListSessionsInput::default()).unwrap();
    assert!(result.sessions.is_empty());
    assert_eq!(result.total, 0);
    assert_eq!(db.get_settings().unwrap().work_duration, 1500);
}

#[test]
fn tc302_save_session_returns_session_with_generated_id() {
    let db = db();
    let mut i = input("Test session");
    i.actual_duration_seconds = 1498;
    let s = db.save_session(&i).unwrap();
    assert!(is_uuid_v4(&s.id));
    assert!(is_iso(&s.completed_at));
    assert_eq!(s.title, "Test session");
    assert_eq!(s.timer_type, TimerType::Work);
    assert_eq!(s.planned_duration_seconds, 1500);
    assert_eq!(s.actual_duration_seconds, 1498);
    let list = db.list_sessions(&ListSessionsInput::default()).unwrap();
    assert_eq!(list.sessions.len(), 1);
    assert_eq!(list.total, 1);
}

#[test]
fn tc303_ids_are_unique() {
    let db = db();
    let ids: std::collections::HashSet<_> = (0..5).map(|i| db.save_session(&input(&format!("Session {i}"))).unwrap().id).collect();
    assert_eq!(ids.len(), 5);
}

#[test]
fn tc304_list_returns_all_sessions() {
    let db = db();
    let ids: Vec<_> = ["Oldest", "Middle", "Newest"].iter().map(|t| db.save_session(&input(t)).unwrap().id).collect();
    let r = db.list_sessions(&ListSessionsInput { limit: Some(50), offset: Some(0), tag_id: None }).unwrap();
    assert_eq!(r.total, 3);
    let got: Vec<_> = r.sessions.iter().map(|s| s.id.clone()).collect();
    for id in ids {
        assert!(got.contains(&id));
    }
}

#[test]
fn list_orders_by_completed_at_desc() {
    let db = db();
    for (id, at) in [("a", "2026-01-01T00:00:00.000Z"), ("b", "2026-03-01T00:00:00.000Z"), ("c", "2026-02-01T00:00:00.000Z")] {
        db.conn()
            .execute(
                "INSERT INTO sessions (id, title, timer_type, planned_duration_seconds, actual_duration_seconds, completed_at) VALUES (?, '', 'work', 1, 1, ?)",
                rusqlite::params![id, at],
            )
            .unwrap();
    }
    let ids: Vec<_> = db.list_sessions(&ListSessionsInput::default()).unwrap().sessions.into_iter().map(|s| s.id).collect();
    assert_eq!(ids, ["b", "c", "a"]);
}

#[test]
fn tc305_pagination() {
    let db = db();
    for i in 0..10 {
        db.save_session(&input(&format!("Session {i}"))).unwrap();
    }
    let page = |limit, offset| db.list_sessions(&ListSessionsInput { limit: Some(limit), offset: Some(offset), tag_id: None }).unwrap();
    let (p1, p2, p4) = (page(3, 0), page(3, 3), page(3, 9));
    assert_eq!((p1.sessions.len(), p1.total), (3, 10));
    assert_eq!((p2.sessions.len(), p2.total), (3, 10));
    assert_eq!((p4.sessions.len(), p4.total), (1, 10));
    let all: std::collections::HashSet<_> =
        p1.sessions.iter().chain(&p2.sessions).chain(&p4.sessions).map(|s| s.id.clone()).collect();
    assert_eq!(all.len(), 7);
}

#[test]
fn tc306_default_limit_is_50() {
    let db = db();
    for i in 0..60 {
        db.save_session(&input(&format!("S{i}"))).unwrap();
    }
    let r = db.list_sessions(&ListSessionsInput::default()).unwrap();
    assert_eq!(r.sessions.len(), 50);
    assert_eq!(r.total, 60);
}

#[test]
fn tc307_delete_removes_row_and_tc308_is_noop_for_unknown() {
    let db = db();
    let s = db.save_session(&input("To Delete")).unwrap();
    db.delete_session(&s.id).unwrap();
    let r = db.list_sessions(&ListSessionsInput::default()).unwrap();
    assert!(r.sessions.is_empty());
    assert_eq!(r.total, 0);
    db.delete_session("non-existent-id-that-does-not-exist").unwrap();
}

#[test]
fn tc309_default_settings() {
    assert_eq!(db().get_settings().unwrap(), DEFAULT_SETTINGS);
}

#[test]
fn tc310_311_settings_round_trip_and_upsert() {
    let db = db();
    db.save_settings(&TimerSettings { work_duration: 1800, short_break_duration: 600, long_break_duration: 1200 }).unwrap();
    let s = db.get_settings().unwrap();
    assert_eq!((s.work_duration, s.short_break_duration, s.long_break_duration), (1800, 600, 1200));
    db.save_settings(&TimerSettings { work_duration: 2100, short_break_duration: 300, long_break_duration: 900 }).unwrap();
    assert_eq!(db.get_settings().unwrap().work_duration, 2100);
}

#[test]
fn tc312_invalid_enum_values_fail_at_the_typed_boundary() {
    let bad_timer = serde_json::json!({"title":"t","timerType":"invalid_type","plannedDurationSeconds":1500,"actualDurationSeconds":1500});
    assert!(serde_json::from_value::<SaveSessionInput>(bad_timer).is_err());
    // TC-153
    let bad_provider = serde_json::json!({"title":"t","timerType":"work","plannedDurationSeconds":1,"actualDurationSeconds":1,"issueProvider":"bitbucket"});
    assert!(serde_json::from_value::<SaveSessionInput>(bad_provider).is_err());
}

#[test]
fn tc313_settings_range_validation() {
    let db = db();
    let mut s = DEFAULT_SETTINGS;
    s.work_duration = MIN_DURATION - 1;
    assert!(db.save_settings(&s).is_err());
    s.work_duration = MAX_DURATION + 1;
    let e = db.save_settings(&s).unwrap_err();
    assert_eq!(e.to_string(), "Invalid workDuration: 7201 is out of range [1, 7200]");
    db.save_settings(&TimerSettings { work_duration: 30, short_break_duration: 5, long_break_duration: 90 }).unwrap();
    let got = db.get_settings().unwrap();
    assert_eq!((got.work_duration, got.short_break_duration, got.long_break_duration), (30, 5, 90));
}

#[test]
fn tc314_title_trimmed_and_capped() {
    let db = db();
    assert_eq!(db.save_session(&input("  padded  ")).unwrap().title, "padded");
    let long = "a".repeat(MAX_TITLE_LENGTH + 1);
    assert_eq!(db.save_session(&input(&long)).unwrap().title.len(), MAX_TITLE_LENGTH);
}

#[test]
fn duration_validation_matches_stopwatch_rules() {
    let db = db();
    let mut i = input("x");
    i.planned_duration_seconds = 0;
    assert_eq!(db.save_session(&i).unwrap_err().to_string(), "Invalid plannedDurationSeconds: 0");
    i.timer_type = TimerType::Stopwatch;
    db.save_session(&i).unwrap();
    i.planned_duration_seconds = -1;
    assert!(db.save_session(&i).is_err());
    i.planned_duration_seconds = 10;
    i.actual_duration_seconds = -1;
    assert_eq!(db.save_session(&i).unwrap_err().to_string(), "Invalid actualDurationSeconds: -1");
}

#[test]
fn tc316_init_is_idempotent_on_a_file_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lizmeter.db");
    let first = Database::open(&path).unwrap();
    first.save_session(&input("Existing")).unwrap();
    first.close().unwrap();
    let second = Database::open(&path).unwrap();
    assert_eq!(second.list_sessions(&ListSessionsInput::default()).unwrap().total, 1);
}

#[test]
fn tc141_151_152_provider_columns_round_trip() {
    let db = db();
    let mut i = input("Linear work");
    i.issue_provider = Some(IssueProviderKind::Linear);
    i.issue_id = Some("LIN-42".into());
    i.issue_title = Some("Fix auth timeout".into());
    i.issue_url = Some("https://linear.app/team/LIN-42".into());
    let s = db.save_session(&i).unwrap();
    assert_eq!(s.issue_provider, Some(IssueProviderKind::Linear));
    let listed = &db.list_sessions(&ListSessionsInput::default()).unwrap().sessions[0];
    assert_eq!(listed.issue_id.as_deref(), Some("LIN-42"));
    assert_eq!(listed.issue_url.as_deref(), Some("https://linear.app/team/LIN-42"));

    let db = self::db();
    let mut g = input("GitHub work");
    g.issue_number = Some(42);
    g.issue_provider = Some(IssueProviderKind::Github);
    g.issue_id = Some("42".into());
    db.save_session(&g).unwrap();
    let listed = &db.list_sessions(&ListSessionsInput::default()).unwrap().sessions[0];
    assert_eq!(listed.issue_number, Some(42));
    assert_eq!(listed.issue_provider, Some(IssueProviderKind::Github));
}

#[test]
fn tc156_todo_provider_and_tc155_legacy_nulls() {
    let db = db();
    let mut t = input("Linked to a todo");
    t.issue_provider = Some(IssueProviderKind::Todo);
    t.issue_id = Some("42".into());
    t.issue_title = Some("Buy milk".into());
    let s = db.save_session(&t).unwrap();
    assert_eq!(s.issue_provider, Some(IssueProviderKind::Todo));
    assert_eq!(s.issue_url, None);

    let db = self::db();
    let mut legacy = input("Legacy session");
    legacy.issue_number = Some(5);
    db.save_session(&legacy).unwrap();
    let s = &db.list_sessions(&ListSessionsInput::default()).unwrap().sessions[0];
    assert_eq!(s.issue_number, Some(5));
    assert_eq!(s.issue_provider, None);
    assert_eq!(s.issue_id, None);
}

#[test]
fn tc501_503_worklog_defaults_and_get_by_id() {
    let db = db();
    let s = db.save_session(&input("Worklog test")).unwrap();
    assert_eq!(s.worklog_status, WorklogStatus::NotLogged);
    assert_eq!(s.worklog_id, None);
    let found = db.get_session_by_id(&s.id).unwrap().unwrap();
    assert_eq!(found.id, s.id);
    assert_eq!(found.worklog_status, WorklogStatus::NotLogged);
    assert!(db.get_session_by_id("non-existent-uuid").unwrap().is_none());
}

#[test]
fn tc504_505_506_update_worklog_status() {
    let db = db();
    let s = db.save_session(&input("Update worklog test")).unwrap();
    db.update_worklog_status(&s.id, WorklogStatus::Logged, Some("10042")).unwrap();
    let u = db.get_session_by_id(&s.id).unwrap().unwrap();
    assert_eq!((u.worklog_status, u.worklog_id.as_deref()), (WorklogStatus::Logged, Some("10042")));

    let f = db.save_session(&input("Failed worklog test")).unwrap();
    db.update_worklog_status(&f.id, WorklogStatus::Failed, None).unwrap();
    let u = db.get_session_by_id(&f.id).unwrap().unwrap();
    assert_eq!((u.worklog_status, u.worklog_id), (WorklogStatus::Failed, None));

    let listed = db.list_sessions(&ListSessionsInput::default()).unwrap();
    let found = listed.sessions.iter().find(|x| x.id == s.id).unwrap();
    assert_eq!(found.worklog_id.as_deref(), Some("10042"));
}

#[test]
fn update_session_duration_and_missing_row() {
    let db = db();
    let s = db.save_session(&input("dur")).unwrap();
    assert_eq!(db.update_session_duration(&s.id, 99).unwrap().actual_duration_seconds, 99);
    assert_eq!(
        db.update_session_duration("nope", 1).unwrap_err().to_string(),
        "Session not found after update: nope"
    );
}

#[test]
fn tc405_listing_1000_sessions_is_fast() {
    let db = db();
    for i in 0..1000 {
        db.save_session(&input(&format!("Perf session {i}"))).unwrap();
    }
    let start = std::time::Instant::now();
    let r = db.list_sessions(&ListSessionsInput { limit: Some(50), offset: Some(0), tag_id: None }).unwrap();
    assert_eq!(r.sessions.len(), 50);
    assert_eq!(r.total, 1000);
    assert!(start.elapsed().as_millis() < 500);
}
