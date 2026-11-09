//! Port of the merge half of `src/shared/worklog.ts`: how a set of sessions merges into worklog
//! blocks. The Jira worklog call and the confirm dialog both use it.

use chrono::{DateTime, TimeZone, Utc};
use lizmeter_core::{Session, TimerType};

const BULK_GAP_TOLERANCE_MS: i64 = 1000;

#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub session_ids: Vec<String>,
    pub uploadable_ids: Vec<String>,
    pub break_ids: Vec<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub duration_seconds: i64,
    pub break_seconds: i64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Summary {
    pub blocks: Vec<Block>,
    pub uploadable_ids: Vec<String>,
    pub break_ids: Vec<String>,
    pub total_duration_seconds: i64,
    pub total_break_seconds: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
}

pub fn is_uploadable(s: &Session) -> bool {
    matches!(s.timer_type, TimerType::Work | TimerType::Stopwatch)
}

fn is_break(s: &Session) -> bool {
    matches!(s.timer_type, TimerType::ShortBreak | TimerType::LongBreak)
}

/// `[start, end]` in epoch milliseconds: the session ends at `completedAt` and ran for its actual duration.
pub fn session_times(s: &Session) -> (i64, i64) {
    let end = parse_ms(&s.completed_at).unwrap_or(0);
    (end - s.actual_duration_seconds * 1000, end)
}

pub fn parse_ms(iso: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(iso).ok().map(|d| d.timestamp_millis())
}

pub fn iso_from_ms(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms).single().map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()).unwrap_or_default()
}

struct Timed<'a> {
    s: &'a Session,
    start: i64,
    end: i64,
}

struct Open {
    session_ids: Vec<String>,
    uploadable_ids: Vec<String>,
    break_ids: Vec<String>,
    start: i64,
    end: i64,
    break_seconds: i64,
}

impl Open {
    fn new(t: &Timed) -> Self {
        Self {
            session_ids: vec![t.s.id.clone()],
            uploadable_ids: vec![t.s.id.clone()],
            break_ids: vec![],
            start: t.start,
            end: t.end,
            break_seconds: 0,
        }
    }

    fn add_break(&mut self, t: &Timed) {
        self.session_ids.push(t.s.id.clone());
        self.break_ids.push(t.s.id.clone());
        self.end = self.end.max(t.end);
        self.break_seconds += t.s.actual_duration_seconds;
    }

    fn add_work(&mut self, t: &Timed) {
        self.session_ids.push(t.s.id.clone());
        self.uploadable_ids.push(t.s.id.clone());
        self.end = self.end.max(t.end);
    }

    fn close(self) -> Block {
        Block {
            session_ids: self.session_ids,
            uploadable_ids: self.uploadable_ids,
            break_ids: self.break_ids,
            start_ms: self.start,
            end_ms: self.end,
            duration_seconds: ((self.end - self.start) as f64 / 1000.0).round().max(0.0) as i64,
            break_seconds: self.break_seconds,
        }
    }
}

pub fn merged_blocks(sessions: &[Session]) -> Vec<Block> {
    let mut timed: Vec<Timed> = sessions
        .iter()
        .map(|s| {
            let (start, end) = session_times(s);
            Timed { s, start, end }
        })
        .collect();
    timed.sort_by_key(|t| (t.start, t.end));

    let mut blocks = vec![];
    let mut current: Option<Open> = None;
    let mut pending: Vec<&Timed> = vec![];
    for t in &timed {
        if is_uploadable(t.s) {
            let Some(cur) = current.as_mut() else {
                current = Some(Open::new(t));
                pending.clear();
                continue;
            };
            let continuous = t.start - cur.end <= BULK_GAP_TOLERANCE_MS;
            if pending.is_empty() && !continuous {
                blocks.extend(current.take().map(Open::close));
                current = Some(Open::new(t));
                continue;
            }
            if let Some(cur) = current.as_mut() {
                for b in pending.drain(..) {
                    cur.add_break(b);
                }
                cur.add_work(t);
            }
            continue;
        }
        if is_break(t.s) && current.is_some() {
            pending.push(t);
        }
    }
    blocks.extend(current.map(Open::close));
    blocks
}

pub fn summarize(sessions: &[Session]) -> Summary {
    let blocks = merged_blocks(sessions);
    Summary {
        uploadable_ids: blocks.iter().flat_map(|b| b.uploadable_ids.clone()).collect(),
        break_ids: blocks.iter().flat_map(|b| b.break_ids.clone()).collect(),
        total_duration_seconds: blocks.iter().map(|b| b.duration_seconds).sum(),
        total_break_seconds: blocks.iter().map(|b| b.break_seconds).sum(),
        started_at: blocks.first().map(|b| b.start_ms),
        ended_at: blocks.last().map(|b| b.end_ms),
        blocks,
    }
}
