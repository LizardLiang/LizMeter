//! The numbers behind the Stats page (`StatsPage.tsx` `useMemo` blocks), computed from the
//! session list: no stats service exists, the renderer derives them the same way.

use chrono::{DateTime, Datelike, Duration, Local, TimeZone};
use lizmeter_core::{Session, TimerType};
use std::collections::HashMap;

pub const UNTAGGED_COLOR: &str = "#3b4261";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Range {
    Week,
    Fortnight,
    Month,
}

impl Range {
    pub const ALL: [Range; 3] = [Range::Week, Range::Fortnight, Range::Month];

    pub fn days(self) -> i64 {
        match self {
            Range::Week => 7,
            Range::Fortnight => 14,
            Range::Month => 30,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DayBar {
    pub date: String,
    pub label: String,
    pub seconds: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HBar {
    pub key: String,
    pub name: String,
    pub color: String,
    pub seconds: i64,
    pub pct: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stats {
    pub empty: bool,
    pub work_seconds: i64,
    pub work_sessions: usize,
    pub total_seconds: i64,
    pub days: Vec<DayBar>,
    pub tags: Vec<HBar>,
    pub types: Vec<HBar>,
}

fn pct(part: i64, total: i64) -> i64 {
    if total > 0 {
        ((part as f64 / total as f64) * 100.0).round() as i64
    } else {
        0
    }
}

fn day_key(d: &DateTime<Local>) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// Local midnight `days` days before `now`.
fn cutoff(now: DateTime<Local>, days: i64) -> DateTime<Local> {
    let day = now.date_naive() - Duration::days(days);
    Local.from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap()).earliest().unwrap_or(now)
}

pub fn compute(sessions: &[Session], range: Range, now: DateTime<Local>) -> Stats {
    let n = range.days();
    let cut = cutoff(now, n);
    let parsed: Vec<(&Session, DateTime<Local>)> = sessions
        .iter()
        .filter_map(|s| DateTime::parse_from_rfc3339(&s.completed_at).ok().map(|d| (s, d.with_timezone(&Local))))
        .filter(|(_, d)| *d >= cut)
        .collect();

    let mut days = Vec::new();
    for i in (0..n).rev() {
        let d = now.date_naive() - Duration::days(i);
        let key = d.format("%Y-%m-%d").to_string();
        let label = if n <= 7 { crate::locale::weekday_short(d.year(), d.month(), d.day()) } else { format!("{}/{}", d.month(), d.day()) };
        let seconds = parsed.iter().filter(|(s, at)| s.timer_type == TimerType::Work && day_key(at) == key).map(|(s, _)| s.actual_duration_seconds).sum();
        days.push(DayBar { date: key, label, seconds });
    }

    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, HBar> = HashMap::new();
    for (s, _) in parsed.iter().filter(|(s, _)| s.timer_type == TimerType::Work) {
        if s.tags.is_empty() {
            let e = map.entry("__untagged__".into()).or_insert_with(|| {
                order.push("__untagged__".into());
                HBar { key: "__untagged__".into(), name: "Untagged".into(), color: UNTAGGED_COLOR.into(), seconds: 0, pct: 0 }
            });
            e.seconds += s.actual_duration_seconds;
        } else {
            for t in &s.tags {
                let key = t.id.to_string();
                let e = map.entry(key.clone()).or_insert_with(|| {
                    order.push(key.clone());
                    HBar { key: key.clone(), name: t.name.clone(), color: t.color.clone(), seconds: 0, pct: 0 }
                });
                e.seconds += s.actual_duration_seconds;
            }
        }
    }
    let mut tags: Vec<HBar> = order.into_iter().filter_map(|k| map.remove(&k)).collect();
    tags.sort_by(|a, b| b.seconds.cmp(&a.seconds));
    let tag_total: i64 = tags.iter().map(|t| t.seconds).sum();
    for t in &mut tags {
        t.pct = pct(t.seconds, tag_total);
    }

    let sum = |ty: TimerType| -> i64 { parsed.iter().filter(|(s, _)| s.timer_type == ty).map(|(s, _)| s.actual_duration_seconds).sum() };
    let (work, short, long) = (sum(TimerType::Work), sum(TimerType::ShortBreak), sum(TimerType::LongBreak));
    let all = work + short + long;
    let bar = |key: &str, name: &str, color: &str, seconds: i64| HBar { key: key.into(), name: name.into(), color: color.into(), seconds, pct: pct(seconds, all) };
    let types = vec![bar("work", "Work", "#7aa2f7", work), bar("short_break", "Short Break", "#9ece6a", short), bar("long_break", "Long Break", "#bb9af7", long)];

    Stats {
        empty: parsed.is_empty(),
        work_seconds: work,
        work_sessions: parsed.iter().filter(|(s, _)| s.timer_type == TimerType::Work).count(),
        total_seconds: parsed.iter().map(|(s, _)| s.actual_duration_seconds).sum(),
        days,
        tags,
        types,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lizmeter_core::Tag;

    fn now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 3, 10, 15, 0, 0).unwrap()
    }

    fn session(day: u32, hour: u32, ty: TimerType, secs: i64, tags: &[(i64, &str)]) -> Session {
        Session {
            id: String::new(),
            title: String::new(),
            timer_type: ty,
            planned_duration_seconds: secs,
            actual_duration_seconds: secs,
            completed_at: Local.with_ymd_and_hms(2026, 3, day, hour, 0, 0).unwrap().to_rfc3339(),
            tags: tags.iter().map(|(id, n)| Tag { id: *id, name: n.to_string(), color: "#7aa2f7".into(), created_at: String::new() }).collect(),
            issue_number: None,
            issue_title: None,
            issue_url: None,
            issue_provider: None,
            issue_id: None,
            worklog_status: lizmeter_core::WorklogStatus::NotLogged,
            worklog_id: None,
        }
    }

    #[test]
    fn buckets_work_time_by_local_day_oldest_first() {
        let s = vec![session(10, 9, TimerType::Work, 1500, &[]), session(10, 11, TimerType::Work, 900, &[]), session(9, 9, TimerType::ShortBreak, 300, &[])];
        let st = compute(&s, Range::Week, now());
        assert_eq!(st.days.len(), 7);
        assert_eq!(st.days[0].date, "2026-03-04");
        assert_eq!(st.days[6].date, "2026-03-10");
        assert_eq!(st.days[6].seconds, 2400);
        assert_eq!(st.days[5].seconds, 0);
        assert_eq!((st.work_seconds, st.work_sessions, st.total_seconds), (2400, 2, 2700));
    }

    #[test]
    fn wide_ranges_label_days_month_slash_day() {
        let st = compute(&[], Range::Month, now());
        assert_eq!(st.days.len(), 30);
        assert_eq!(st.days[29].label, "3/10");
        assert!(st.empty);
    }

    #[test]
    fn sessions_before_the_cutoff_are_left_out() {
        let s = vec![session(2, 9, TimerType::Work, 600, &[]), session(3, 0, TimerType::Work, 600, &[])];
        let st = compute(&s, Range::Week, now());
        assert_eq!(st.work_sessions, 1);
    }

    #[test]
    fn tags_rank_by_time_and_untagged_gets_its_own_row() {
        let s = vec![
            session(10, 9, TimerType::Work, 3000, &[(1, "a")]),
            session(10, 10, TimerType::Work, 1000, &[(1, "a"), (2, "b")]),
            session(10, 11, TimerType::Work, 1000, &[]),
            session(10, 12, TimerType::ShortBreak, 1000, &[(2, "b")]),
        ];
        let st = compute(&s, Range::Week, now());
        let names: Vec<_> = st.tags.iter().map(|t| (t.name.as_str(), t.seconds, t.pct)).collect();
        assert_eq!(names, vec![("a", 4000, 67), ("b", 1000, 17), ("Untagged", 1000, 17)]);
        assert_eq!(st.tags[2].color, UNTAGGED_COLOR);
    }

    #[test]
    fn work_types_split_by_share() {
        let s = vec![session(10, 9, TimerType::Work, 3000, &[]), session(10, 10, TimerType::ShortBreak, 600, &[]), session(10, 11, TimerType::LongBreak, 600, &[])];
        let st = compute(&s, Range::Week, now());
        let p: Vec<_> = st.types.iter().map(|t| t.pct).collect();
        assert_eq!(p, vec![71, 14, 14]);
    }
}
