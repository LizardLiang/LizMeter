//! Port of `src/shared/worklog.ts`: how a set of sessions merges into worklog blocks, and the
//! validation and default values behind `WorklogConfirmDialog`.

use chrono::{Local, NaiveDateTime, TimeZone, Utc};
use lizmeter_core::Session;
pub use lizmeter_services::worklog_merge::{is_uploadable, iso_from_ms, merged_blocks, parse_ms, session_times, summarize, Block, Summary};

/// `3600 -> "1h"`, `5400 -> "1h 30m"`, `45 -> "45s"` (`formatDuration` of the dialog).
pub fn format_duration(seconds: i64) -> String {
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let (h, m) = (seconds / 3600, (seconds % 3600) / 60);
    match (h > 0, m > 0) {
        (true, true) => format!("{h}h {m}m"),
        (true, false) => format!("{h}h"),
        _ => format!("{m}m"),
    }
}

/// An epoch ms as the local `YYYY-MM-DDTHH:MM` a `datetime-local` input holds.
pub fn to_local_value(ms: i64) -> String {
    Local.timestamp_millis_opt(ms).single().map(|d| d.format("%Y-%m-%dT%H:%M").to_string()).unwrap_or_default()
}

/// The local `YYYY-MM-DDTHH:MM` (a space is accepted for the T) back to epoch ms.
pub fn from_local_value(value: &str) -> Option<i64> {
    let v = value.trim().replace(' ', "T");
    let naive = NaiveDateTime::parse_from_str(&v, "%Y-%m-%dT%H:%M").ok()?;
    Local.from_local_datetime(&naive).earliest().map(|d| d.timestamp_millis())
}

/// The start, end and description a dialog opens with for `uploadable` sessions.
pub fn defaults(summary: &Summary, uploadable: &[&Session]) -> (i64, i64, String) {
    let now = Utc::now().timestamp_millis();
    let (Some(start), Some(end)) = (summary.started_at, summary.ended_at) else { return (now, now, String::new()) };
    match uploadable {
        [] => (now, now, String::new()),
        [one] => {
            let end = parse_ms(&one.completed_at).unwrap_or(end);
            (end - one.actual_duration_seconds * 1000, end, one.title.clone())
        }
        many => {
            let lines: Vec<&str> = many.iter().map(|s| if s.title.is_empty() { "Work session" } else { s.title.as_str() }).collect();
            (start, end, lines.join("\n"))
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Checked {
    pub duration_seconds: i64,
    pub break_seconds: i64,
    pub error: Option<&'static str>,
}

/// The duration shown and the error that blocks Confirm, in the order the dialog checks them.
pub fn check(uploadable_count: usize, start: &str, end: &str, summary: &Summary) -> Checked {
    let fail = |e| Checked { duration_seconds: 0, break_seconds: 0, error: Some(e) };
    if uploadable_count == 0 {
        return fail("Select at least one work or stopwatch session.");
    }
    if start.trim().is_empty() || end.trim().is_empty() {
        return fail("Start and end time are required.");
    }
    let (Some(s), Some(e)) = (from_local_value(start), from_local_value(end)) else { return fail("Invalid date/time.") };
    let kept = |error| Checked { duration_seconds: summary.total_duration_seconds, break_seconds: summary.total_break_seconds, error };
    if e <= s {
        return kept(Some("End time must be after start time."));
    }
    if summary.total_duration_seconds < 60 {
        return kept(Some("Merged worklog duration must be at least 60 seconds."));
    }
    kept(None)
}

#[cfg(test)]
mod tests {
    use super::{check, defaults, format_duration, from_local_value, iso_from_ms, merged_blocks, summarize, to_local_value};
    use lizmeter_core::{Session, TimerType, WorklogStatus};

    fn session(id: &str, timer_type: TimerType, secs: i64, completed: &str) -> Session {
        Session {
            id: id.into(),
            title: id.into(),
            timer_type,
            planned_duration_seconds: 1500,
            actual_duration_seconds: secs,
            completed_at: completed.into(),
            tags: vec![],
            issue_number: None,
            issue_title: Some("Jira task".into()),
            issue_url: None,
            issue_provider: None,
            issue_id: Some("PROJ-1".into()),
            worklog_status: WorklogStatus::NotLogged,
            worklog_id: None,
        }
    }

    #[test]
    fn a_break_between_uploadable_sessions_merges_into_one_block() {
        let w1 = session("work-1", TimerType::Work, 1500, "2026-02-24T10:25:00.000Z");
        let b1 = session("break-1", TimerType::ShortBreak, 300, "2026-02-24T10:30:00.000Z");
        let w2 = session("work-2", TimerType::Work, 1200, "2026-02-24T10:50:00.000Z");
        let s = summarize(&[w1, b1, w2]);
        assert_eq!(s.blocks.len(), 1);
        assert_eq!(s.total_duration_seconds, 3000);
        assert_eq!(s.total_break_seconds, 300);
        assert_eq!(s.uploadable_ids, ["work-1", "work-2"]);
        assert_eq!(s.break_ids, ["break-1"]);
    }

    #[test]
    fn a_trailing_break_is_not_merged() {
        let w = session("work-1", TimerType::Work, 1500, "2026-02-24T10:25:00.000Z");
        let b = session("break-1", TimerType::LongBreak, 900, "2026-02-24T10:40:00.000Z");
        let blocks = merged_blocks(&[w, b]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].duration_seconds, 1500);
        assert_eq!(blocks[0].break_seconds, 0);
        assert!(blocks[0].break_ids.is_empty());
    }

    #[test]
    fn sessions_with_a_gap_and_no_break_between_stay_separate_blocks() {
        let w1 = session("a", TimerType::Work, 600, "2026-02-24T10:10:00.000Z");
        let w2 = session("b", TimerType::Stopwatch, 600, "2026-02-24T12:10:00.000Z");
        assert_eq!(merged_blocks(&[w2, w1]).len(), 2);
    }

    #[test]
    fn durations_read_like_the_dialog() {
        assert_eq!(format_duration(45), "45s");
        assert_eq!(format_duration(3600), "1h");
        assert_eq!(format_duration(5400), "1h 30m");
        assert_eq!(format_duration(1500), "25m");
    }

    #[test]
    fn the_dialog_checks_run_in_the_electron_order() {
        let w = session("a", TimerType::Work, 1500, "2026-02-24T10:25:00.000Z");
        let s = summarize(std::slice::from_ref(&w));
        assert_eq!(check(0, "", "", &s).error, Some("Select at least one work or stopwatch session."));
        assert_eq!(check(1, "", "2026-02-24T10:25", &s).error, Some("Start and end time are required."));
        assert_eq!(check(1, "nope", "2026-02-24T10:25", &s).error, Some("Invalid date/time."));
        assert_eq!(check(1, "2026-02-24T10:25", "2026-02-24T10:25", &s).error, Some("End time must be after start time."));
        assert_eq!(check(1, "2026-02-24T10:00", "2026-02-24T10:25", &s).error, None);
        let short = summarize(&[session("s", TimerType::Work, 30, "2026-02-24T10:25:00.000Z")]);
        assert_eq!(check(1, "2026-02-24T10:00", "2026-02-24T10:25", &short).error, Some("Merged worklog duration must be at least 60 seconds."));
    }

    #[test]
    fn a_single_session_opens_with_its_own_times_and_title() {
        let w = session("title", TimerType::Work, 1500, "2026-02-24T10:25:00.000Z");
        let s = summarize(std::slice::from_ref(&w));
        let (start, end, desc) = defaults(&s, &[&w]);
        assert_eq!(iso_from_ms(start), "2026-02-24T10:00:00.000Z");
        assert_eq!(iso_from_ms(end), "2026-02-24T10:25:00.000Z");
        assert_eq!(desc, "title");
        assert_eq!(from_local_value(&to_local_value(start)), Some(start));
    }
}
