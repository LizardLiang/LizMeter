//! Port of `claude-code-tracker.test.ts`, against a temporary projects folder.

use lizmeter_services::claude_tracker::*;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

fn user_line(ts: &str) -> String {
    json!({"type": "user", "timestamp": ts, "message": {"role": "user", "content": "hello"}}).to_string()
}

fn user_text(ts: &str, text: &str) -> String {
    json!({"type": "user", "timestamp": ts, "message": {"role": "user", "content": [{"type": "text", "text": text}]}}).to_string()
}

fn assistant(ts: &str, edits: &[&str]) -> String {
    let blocks: Vec<_> = edits.iter().map(|p| json!({"type": "tool_use", "name": "Write", "input": {"file_path": p}})).collect();
    json!({"type": "assistant", "timestamp": ts, "message": {"role": "assistant", "content": blocks}}).to_string()
}

fn assistant_tools(ts: &str, tools: &[&str]) -> String {
    let blocks: Vec<_> = tools.iter().map(|n| json!({"type": "tool_use", "name": n, "input": {}})).collect();
    json!({"type": "assistant", "timestamp": ts, "message": {"role": "assistant", "content": blocks}}).to_string()
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn line(s: &str) -> JsonlLine {
    parse_jsonl_line(s).unwrap()
}

fn state() -> SessionState {
    SessionState::default()
}

fn write(path: &Path, lines: &[String]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, lines.join("\n") + "\n").unwrap();
}

#[test]
fn validate_project_dir_name_rejects_bad_names() {
    let root = PathBuf::from("C:\\Users\\x\\.claude\\projects");
    assert_eq!(validate_project_dir_name(&root, ""), Err("Project directory name cannot be empty".into()));
    assert_eq!(validate_project_dir_name(&root, "   "), Err("Project directory name cannot be empty".into()));
    for bad in ["a/b", "a\\b", "..", "a..b"] {
        assert_eq!(
            validate_project_dir_name(&root, bad),
            Err("Invalid project directory name: contains path separators".into()),
            "{bad}"
        );
    }
    for bad in ["C:x", "a b", "a@b"] {
        assert_eq!(
            validate_project_dir_name(&root, bad),
            Err("Invalid project directory name: contains disallowed characters".into()),
            "{bad}"
        );
    }
    let ok = validate_project_dir_name(&root, "C--Users-me").unwrap();
    assert!(ok.starts_with(&root) && ok != root);
}

#[test]
fn decode_project_path_handles_drive_letters_and_fallback() {
    assert_eq!(decode_project_path("C--Users-lizard-liang-personal-PersonalTool-LizMeter"), "C:\\Users\\lizard\\liang\\personal\\PersonalTool\\LizMeter");
    assert_eq!(decode_project_path("D--code-app"), "D:\\code\\app");
    assert_eq!(decode_project_path("home-user-project"), "/home/user/project");
}

#[test]
fn parse_jsonl_line_accepts_objects_only() {
    assert_eq!(line(r#"  {"type":"user","timestamp":"t"}  "#).kind, "user");
    assert!(parse_jsonl_line("").is_none());
    assert!(parse_jsonl_line("   ").is_none());
    assert!(parse_jsonl_line("{not json").is_none());
}

#[test]
fn extract_file_edits_takes_write_and_edit_paths_only() {
    let l = line(&assistant("2026-01-01T00:00:00Z", &["a.rs", "b.rs"]));
    assert_eq!(extract_file_edits_from_line(&l), vec!["a.rs", "b.rs"]);
    let edit = line(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"e.rs"}}]}}).to_string());
    assert_eq!(extract_file_edits_from_line(&edit), vec!["e.rs"]);
    let other = line(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"file_path":"x"}},{"type":"tool_use","name":"Read","input":{"file_path":"y"}}]}}).to_string());
    assert!(extract_file_edits_from_line(&other).is_empty());
    assert!(extract_file_edits_from_line(&line(&user_line("t"))).is_empty());
    let string_content = line(r#"{"type":"assistant","message":{"content":"text"}}"#);
    assert!(extract_file_edits_from_line(&string_content).is_empty());
    let empty_path = line(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"  "}}]}}).to_string());
    assert!(extract_file_edits_from_line(&empty_path).is_empty());
    let no_path = line(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{}}]}}).to_string());
    assert!(extract_file_edits_from_line(&no_path).is_empty());
}

#[test]
fn extract_tool_names_lists_every_tool_on_assistant_lines() {
    assert_eq!(extract_tool_names_from_line(&line(&assistant_tools("t", &["Read", "Bash"]))), vec!["Read", "Bash"]);
    assert!(extract_tool_names_from_line(&line(&user_line("t"))).is_empty());
    assert!(extract_tool_names_from_line(&line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#)).is_empty());
}

#[test]
fn process_lines_tracks_first_and_last_activity() {
    let mut s = state();
    process_lines(&mut s, &[line(&user_line("2026-01-01T00:00:00.000Z")), line(&user_line("2026-01-01T00:01:00.000Z"))], 300_000);
    assert_eq!(s.first_activity_at.as_deref(), Some("2026-01-01T00:00:00.000Z"));
    assert_eq!(s.last_activity_at.as_deref(), Some("2026-01-01T00:01:00.000Z"));
    let mut s = state();
    process_lines(&mut s, &[line(r#"{"type":"user"}"#)], 300_000);
    assert_eq!(s.first_activity_at, None);
}

#[test]
fn process_lines_records_idle_periods_at_or_over_the_threshold() {
    let mut s = state();
    process_lines(
        &mut s,
        &[
            line(&user_line("2026-01-01T00:00:00.000Z")),
            line(&user_line("2026-01-01T00:10:00.000Z")),
            line(&user_line("2026-01-01T00:12:00.000Z")),
            line(&user_line("2026-01-01T00:30:00.500Z")),
        ],
        5 * 60_000,
    );
    assert_eq!(s.idle_periods.len(), 2);
    assert_eq!(s.idle_periods[0].duration_seconds, 600);
    assert_eq!(s.idle_periods[0].start_at, "2026-01-01T00:00:00.000Z");
    assert_eq!(s.idle_periods[1].duration_seconds, 1081, "Math.round(1080.5) rounds half up");

    let mut s = state();
    process_lines(&mut s, &[line(&user_line("2026-01-01T00:00:00Z")), line(&user_line("2026-01-01T00:02:00Z"))], 5 * 60_000);
    assert!(s.idle_periods.is_empty(), "a short gap is not idle");
    let mut s = state();
    process_lines(&mut s, &[line(&user_line("2026-01-01T00:00:00Z")), line(&user_line("2026-01-01T00:01:00Z"))], 60_000);
    assert_eq!(s.idle_periods.len(), 1, "a gap equal to the threshold counts");
}

#[test]
fn process_lines_deduplicates_edits_and_skips_other_tools() {
    let mut s = state();
    process_lines(
        &mut s,
        &[
            line(&assistant("2026-01-01T00:00:00Z", &["a.rs", "b.rs"])),
            line(&assistant("2026-01-01T00:00:01Z", &["a.rs"])),
            line(&assistant_tools("2026-01-01T00:00:02Z", &["Bash", "Read"])),
        ],
        300_000,
    );
    assert_eq!(s.files_edited, vec!["a.rs", "b.rs"]);
}

#[test]
fn process_lines_follows_the_last_line_type_and_tools() {
    let mut s = state();
    process_lines(&mut s, &[line(&user_line("2026-01-01T00:00:00Z"))], 300_000);
    assert_eq!(s.last_line_type.as_deref(), Some("user"));
    process_lines(&mut s, &[line(&assistant_tools("2026-01-01T00:00:01Z", &["Read", "Edit"]))], 300_000);
    assert_eq!((s.last_line_type.as_deref(), s.last_tool_names.clone()), (Some("assistant"), vec!["Read".to_string(), "Edit".to_string()]));
    process_lines(&mut s, &[line(&user_line("2026-01-01T00:00:02Z"))], 300_000);
    assert!(s.last_tool_names.is_empty(), "a user line clears the tools");
    process_lines(&mut s, &[line(r#"{"type":"assistant","timestamp":"2026-01-01T00:00:03Z","message":{"content":[{"type":"text","text":"x"}]}}"#)], 300_000);
    assert!(s.last_tool_names.is_empty());
}

#[test]
fn read_new_lines_reads_from_an_offset_and_keeps_the_partial_tail() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("s.jsonl");
    let a = user_line("2026-01-01T00:00:00Z");
    let b = user_line("2026-01-01T00:00:01Z");
    fs::write(&p, format!("{a}\n{b}\n")).unwrap();
    let all = read_new_lines(&p, 0, "").unwrap();
    assert_eq!(all.lines.len(), 2);
    assert_eq!(all.new_offset, (a.len() + b.len() + 2) as u64);

    let none = read_new_lines(&p, all.new_offset, "").unwrap();
    assert!(none.lines.is_empty());
    assert_eq!(none.new_offset, all.new_offset);

    let from = read_new_lines(&p, (a.len() + 1) as u64, "").unwrap();
    assert_eq!(from.lines.len(), 1);

    fs::write(&p, format!("{a}\n{{\"type\":\"user\",\"time")).unwrap();
    let partial = read_new_lines(&p, 0, "").unwrap();
    assert_eq!(partial.lines.len(), 1);
    assert_eq!(partial.new_partial_line, "{\"type\":\"user\",\"time");

    fs::write(&p, format!("{a}\nnot json\n{b}\n")).unwrap();
    assert_eq!(read_new_lines(&p, 0, "").unwrap().lines.len(), 2, "malformed lines are skipped");
    assert!(read_new_lines(&dir.path().join("missing.jsonl"), 0, "").is_err());
}

#[test]
fn read_new_lines_rejoins_a_line_split_across_reads() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("s.jsonl");
    let full = user_line("2026-01-01T00:00:00Z");
    let (head, tail) = full.split_at(10);
    fs::write(&p, head).unwrap();
    let first = read_new_lines(&p, 0, "").unwrap();
    assert!(first.lines.is_empty());
    fs::write(&p, format!("{head}{tail}\n")).unwrap();
    let second = read_new_lines(&p, first.new_offset, &first.new_partial_line).unwrap();
    assert_eq!(second.lines.len(), 1);
}

#[test]
fn first_user_message_rules() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("s.jsonl");
    write(&p, &[user_text("2026-01-01T00:00:00Z", "Fix the login bug")]);
    assert_eq!(extract_first_user_message(&p).as_deref(), Some("Fix the login bug"));

    let long = "x".repeat(80);
    write(&p, &[user_text("t", &long)]);
    assert_eq!(extract_first_user_message(&p).unwrap(), format!("{}\u{2026}", "x".repeat(59)));

    let exact = "y".repeat(60);
    write(&p, &[user_text("t", &exact)]);
    assert_eq!(extract_first_user_message(&p).unwrap(), exact);

    write(&p, &[user_line("t")]);
    assert_eq!(extract_first_user_message(&p).as_deref(), Some("hello"), "string content");

    write(&p, &[assistant("t", &[]), user_text("t", "later")]);
    assert_eq!(extract_first_user_message(&p).as_deref(), Some("later"));

    write(&p, &[user_text("t", "<local-command-caveat>x</local-command-caveat>"), user_text("t", "<command-name>/clear</command-name>")]);
    assert_eq!(extract_first_user_message(&p), None, "system-injected text is skipped");

    let filler: Vec<String> = (0..100).map(|_| assistant("t", &[])).collect();
    let mut lines = filler;
    lines.push(user_text("t", "too late"));
    write(&p, &lines);
    assert_eq!(extract_first_user_message(&p), None, "only the first 100 lines are scanned");

    fs::write(&p, "").unwrap();
    assert_eq!(extract_first_user_message(&p), None);
    assert_eq!(extract_first_user_message(&dir.path().join("nope.jsonl")), None);
    fs::write(&p, "{broken").unwrap();
    assert_eq!(extract_first_user_message(&p), None);
}

struct Project {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    dir: PathBuf,
}

fn project() -> Project {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let dir = root.join("proj");
    fs::create_dir_all(&dir).unwrap();
    Project { _tmp: tmp, root, dir }
}

#[test]
fn scan_returns_only_sessions_inside_the_two_minute_buffer() {
    let p = project();
    write(&p.dir.join("fresh.jsonl"), &[user_text(&now_iso(), "fresh")]);
    let old = (chrono::Utc::now() - chrono::Duration::minutes(10)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    write(&p.dir.join("old.jsonl"), &[user_line(&old)]);
    let future = (chrono::Utc::now() + chrono::Duration::minutes(10)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    write(&p.dir.join("future.jsonl"), &[user_line(&future)]);
    fs::write(p.dir.join("empty.jsonl"), "").unwrap();
    fs::write(p.dir.join("notes.txt"), "x").unwrap();

    let mut t = ClaudeTracker::new(&p.root);
    let r = t.scan_sessions("proj", Some(5));
    assert!(r.success);
    assert_eq!(r.sessions.len(), 1);
    assert_eq!(r.sessions[0].cc_session_uuid, "fresh");
    assert_eq!(r.sessions[0].first_user_message.as_deref(), Some("fresh"));
}

#[test]
fn scan_reports_bad_and_missing_projects() {
    let p = project();
    let mut t = ClaudeTracker::new(&p.root);
    assert!(t.scan_sessions("proj", None).sessions.is_empty());
    let bad = t.scan_sessions("a/b", None);
    assert_eq!((bad.success, bad.error.as_deref()), (false, Some("Invalid project directory name: contains path separators")));
    let gone = t.scan_sessions("missing", None);
    assert_eq!((gone.success, gone.error.as_deref()), (false, Some("Project not found")));
    t.destroy();
    t.destroy();
}

#[test]
fn tracking_an_unknown_session_or_none_tracks_nothing() {
    let p = project();
    let mut t = ClaudeTracker::new(&p.root);
    t.scan_sessions("proj", None);
    assert_eq!(t.track_selected_sessions(&[], false), 0);
    assert_eq!(t.track_selected_sessions(&["ghost".to_string()], false), 0);
    assert!(t.stop_and_get_data().is_empty());
    assert!(t.stop_and_get_data().is_empty(), "stop twice is safe");
}

#[test]
fn tracking_reads_only_new_content_and_stop_returns_the_totals() {
    let p = project();
    let file = p.dir.join("s1.jsonl");
    write(&file, &[user_line(&now_iso()), assistant(&now_iso(), &["old.rs"])]);
    let mut t = ClaudeTracker::new(&p.root);
    t.scan_sessions("proj", Some(5));
    assert_eq!(t.track_selected_sessions(&["s1".to_string()], false), 1);

    let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
    use std::io::Write;
    writeln!(f, "{}", assistant(&now_iso(), &["new.rs"])).unwrap();
    drop(f);

    let polled = t.poll();
    let stats = polled.stats.expect("a poll reports the change");
    assert_eq!(stats.active_sessions, 1);
    assert_eq!(stats.files_edited_list, vec!["new.rs"], "history before tracking began is not counted");
    assert_eq!(stats.session_activity.unwrap().tool_names, Some(vec!["Write".to_string()]));
    assert!(t.poll().stats.is_none(), "nothing changed since the last poll");

    let data = t.stop_and_get_data();
    assert_eq!(data.len(), 1);
    assert_eq!((data[0].cc_session_uuid.as_str(), data[0].file_edit_count), ("s1", 1));
    assert!(t.aggregate_stats().active_sessions == 0);
}

#[test]
fn pause_holds_back_new_content_until_resume() {
    let p = project();
    let file = p.dir.join("s1.jsonl");
    write(&file, &[user_line(&now_iso())]);
    let mut t = ClaudeTracker::new(&p.root);
    t.scan_sessions("proj", None);
    t.track_selected_sessions(&["s1".to_string()], false);
    t.poll();
    t.pause();
    let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
    use std::io::Write;
    writeln!(f, "{}", assistant(&now_iso(), &["x.rs"])).unwrap();
    drop(f);
    assert!(t.poll().stats.is_none());
    t.resume();
    assert_eq!(t.poll().stats.unwrap().total_files_edited, 1);
}

#[test]
fn dropping_a_session_from_the_selection_freezes_its_data() {
    let p = project();
    write(&p.dir.join("s1.jsonl"), &[user_line(&now_iso())]);
    write(&p.dir.join("s2.jsonl"), &[user_line(&now_iso())]);
    let mut t = ClaudeTracker::new(&p.root);
    t.scan_sessions("proj", None);
    t.track_selected_sessions(&["s1".to_string(), "s2".to_string()], true);
    t.poll();
    assert_eq!(t.track_selected_sessions(&["s2".to_string()], false), 1);
    let data = t.stop_and_get_data();
    let ids: Vec<_> = data.iter().map(|d| d.cc_session_uuid.as_str()).collect();
    assert_eq!(ids, vec!["s2", "s1"], "active sessions first, then frozen ones");
}

#[test]
fn sub_agent_files_are_tracked_with_their_parent() {
    let p = project();
    let now = now_iso();
    write(&p.dir.join("parent.jsonl"), &[user_line(&now)]);
    let sub = p.dir.join("parent").join("subagents");
    write(&sub.join("agent-abc123def456.jsonl"), &[assistant(&now, &["src/index.ts"])]);
    write(&sub.join("notes.txt").with_extension("jsonl"), &[assistant(&now, &["ignored.ts"])]);

    let mut t = ClaudeTracker::new(&p.root);
    t.scan_sessions("proj", None);
    assert_eq!(t.track_selected_sessions(&["parent".to_string()], false), 1);
    let data = t.stop_and_get_data();
    let agent = data.iter().find(|d| d.cc_session_uuid == "subagent:parent/agent-abc123def456.jsonl").expect("sub-agent");
    assert_eq!(agent.file_edit_count, 1);
    assert_eq!(agent.files_edited, vec!["src/index.ts"]);
    assert_eq!(data.len(), 2, "a jsonl that is not named agent-* is not a sub-agent");
}

#[test]
fn a_sub_agent_that_appears_later_is_picked_up_by_a_poll() {
    let p = project();
    let now = now_iso();
    write(&p.dir.join("parent.jsonl"), &[user_line(&now)]);
    let mut t = ClaudeTracker::new(&p.root);
    t.scan_sessions("proj", None);
    t.track_selected_sessions(&["parent".to_string()], false);
    assert_eq!(t.poll().stats.map(|s| s.active_sessions), Some(1));
    write(&p.dir.join("parent").join("subagents").join("agent-late.jsonl"), &[assistant(&now, &["late.rs"])]);
    let stats = t.poll().stats.unwrap();
    assert_eq!((stats.active_sessions, stats.total_files_edited), (2, 1));
}

#[test]
fn a_new_session_file_is_announced_once_when_nothing_is_tracked() {
    let p = project();
    let mut t = ClaudeTracker::new(&p.root);
    t.scan_sessions("proj", None);
    write(&p.dir.join("brand-new.jsonl"), &[user_text(&now_iso(), "start here")]);
    let out = t.poll();
    assert_eq!(out.new_sessions.len(), 1);
    assert_eq!(out.new_sessions[0].cc_session_uuid, "brand-new");
    assert_eq!(out.new_sessions[0].first_user_message.as_deref(), Some("start here"));
    assert!(t.poll().new_sessions.is_empty(), "announced once");
}

#[test]
fn a_new_session_file_is_tracked_silently_when_tracking_is_on() {
    let p = project();
    write(&p.dir.join("s1.jsonl"), &[user_line(&now_iso())]);
    let mut t = ClaudeTracker::new(&p.root);
    t.scan_sessions("proj", None);
    t.track_selected_sessions(&["s1".to_string()], false);
    t.poll();
    write(&p.dir.join("s2.jsonl"), &[assistant(&now_iso(), &["z.rs"])]);
    let out = t.poll();
    assert!(out.new_sessions.is_empty());
    let stats = out.stats.unwrap();
    assert_eq!((stats.active_sessions, stats.files_edited_list), (2, vec!["z.rs".to_string()]));
}

#[test]
fn projects_and_all_project_scan() {
    let p = project();
    fs::create_dir_all(p.root.join("C--Users-me-zeta")).unwrap();
    fs::create_dir_all(p.root.join("C--Users-me-alpha")).unwrap();
    fs::create_dir_all(p.root.join("C--Users-me-Beta")).unwrap();
    fs::write(p.root.join("stray-file.txt"), "x").unwrap();
    write(&p.root.join("C--Users-me-alpha").join("a.jsonl"), &[user_text(&now_iso(), "hi")]);
    let t = ClaudeTracker::new(&p.root);
    let projects = t.get_projects();
    let names: Vec<_> = projects.iter().map(|p| p.dir_name.as_str()).collect();
    assert_eq!(names, vec!["proj", "C--Users-me-alpha", "C--Users-me-Beta", "C--Users-me-zeta"], "sorted like localeCompare: case-insensitive");
    let all = t.scan_all_projects();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].project_dir_name, "C--Users-me-alpha");
    assert_eq!(all[0].project_display_path, "C:\\Users\\me\\alpha");
    assert_eq!(ClaudeTracker::new(p.root.join("nowhere")).get_projects(), vec![]);
}

#[test]
fn reselecting_a_deselected_session_restores_it_instead_of_duplicating_it() {
    let p = project();
    write(&p.dir.join("s1.jsonl"), &[user_line(&now_iso())]);
    write(&p.dir.join("s2.jsonl"), &[user_line(&now_iso())]);
    let mut t = ClaudeTracker::new(&p.root);
    t.scan_sessions("proj", None);
    t.track_selected_sessions(&["s1".to_string(), "s2".to_string()], true);
    t.track_selected_sessions(&["s2".to_string()], false);
    assert_eq!(t.track_selected_sessions(&["s1".to_string(), "s2".to_string()], false), 2);
    let ids: Vec<String> = t.stop_and_get_data().into_iter().map(|d| d.cc_session_uuid).collect();
    assert_eq!(ids.iter().filter(|i| *i == "s1").count(), 1, "{ids:?}");
}
