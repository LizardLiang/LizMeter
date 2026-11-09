//! Display formatting and session grouping (`utils/format.ts`, `utils/groupSessions.ts`,
//! `hooks/useGroupExpand.ts`). Dates are shown in the machine's local time zone, in the en-US shape
//! `toLocaleDateString(undefined, ...)` gives.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone};
use lizmeter_core::{IssueProviderKind, Session, TimerType};

pub fn format_time(seconds: i64) -> String {
    let s = seconds.max(0);
    format!("{:02}:{:02}", s / 60, s % 60)
}

pub fn format_elapsed(seconds: i64) -> String {
    let s = seconds.max(0);
    format!("{:02}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
}

/// "5m", "1h 23m", "2h 0m", "0m".
pub fn format_duration(seconds: i64) -> String {
    let m = seconds.max(0) / 60;
    if m >= 60 {
        format!("{}h {}m", m / 60, m % 60)
    } else {
        format!("{m}m")
    }
}

/// The Stats page variant: "—" below one minute.
pub fn format_duration_dash(seconds: i64) -> String {
    if seconds.max(0) / 60 == 0 {
        "\u{2014}".to_string()
    } else {
        format_duration(seconds)
    }
}

pub fn timer_type_label(t: TimerType) -> &'static str {
    match t {
        TimerType::Work => "Work",
        TimerType::ShortBreak => "Short Break",
        TimerType::LongBreak => "Long Break",
        TimerType::Stopwatch => "Stopwatch",
    }
}

pub fn timer_type_color(t: TimerType) -> u32 {
    match t {
        TimerType::Work => 0x7aa2f7,
        TimerType::ShortBreak => 0x9ece6a,
        TimerType::Stopwatch => 0x7dcfff,
        TimerType::LongBreak => 0xbb9af7,
    }
}

/// Parses the ISO timestamp the database stores into local time.
pub fn local(iso: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(iso).ok().map(|d| d.with_timezone(&Local))
}

/// `YYYY-MM-DD` of an ISO timestamp, in local time.
pub fn date_key(iso: &str) -> String {
    local(iso).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

/// "Mar 5, 2026".
pub fn format_date(iso: &str) -> String {
    local(iso).map(|d| d.format("%b %-d, %Y").to_string()).unwrap_or_default()
}

/// "09:05 AM".
pub fn format_local_time(iso: &str) -> String {
    local(iso).map(|d| d.format("%I:%M %p").to_string()).unwrap_or_default()
}

/// "Today", "Yesterday", "Mar 5" (this year) or "Mar 5, 2025".
pub fn date_label(date_key: &str, now: DateTime<Local>) -> String {
    let today = now.format("%Y-%m-%d").to_string();
    let yesterday = (now - Duration::days(1)).format("%Y-%m-%d").to_string();
    if date_key == today {
        return "Today".into();
    }
    if date_key == yesterday {
        return "Yesterday".into();
    }
    match NaiveDate::parse_from_str(date_key, "%Y-%m-%d") {
        Ok(d) if d.year() == now.year() => d.format("%b %-d").to_string(),
        Ok(d) => d.format("%b %-d, %Y").to_string(),
        Err(_) => date_key.to_string(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssueGroupKey {
    pub key: String,
    pub display_id: String,
    pub title: Option<String>,
    pub url: Option<String>,
}

#[derive(Clone, Debug)]
pub struct DateSubGroup {
    pub date_key: String,
    pub date_label: String,
    pub total_seconds: i64,
    pub sessions: Vec<Session>,
}

#[derive(Clone, Debug)]
pub struct IssueGroup {
    pub key: IssueGroupKey,
    pub total_seconds: i64,
    pub session_count: usize,
    pub date_sub_groups: Vec<DateSubGroup>,
    pub latest_completed_at: String,
}

#[derive(Clone, Debug)]
pub struct DayGroup {
    pub date_key: String,
    pub date_label: String,
    pub sessions: Vec<Session>,
}

#[derive(Clone, Debug, Default)]
pub struct Grouped {
    pub issue_groups: Vec<IssueGroup>,
    pub ungrouped: Vec<Session>,
}

pub fn has_linked_issue(s: &Session) -> bool {
    (s.issue_provider.is_some() && s.issue_id.is_some()) || (s.issue_provider.is_none() && s.issue_number.is_some())
}

pub fn issue_group_key(s: &Session) -> IssueGroupKey {
    if let (Some(p), Some(id)) = (s.issue_provider, &s.issue_id) {
        let display_id = if matches!(p, IssueProviderKind::Github | IssueProviderKind::Todo) { format!("#{id}") } else { id.clone() };
        return IssueGroupKey { key: format!("{}:{id}", p.as_str()), display_id, title: s.issue_title.clone(), url: s.issue_url.clone() };
    }
    let key = match &s.issue_url {
        Some(u) => format!("legacy-github-url:{u}"),
        None => format!("legacy-github-num:{}", s.issue_number.unwrap_or(0)),
    };
    IssueGroupKey { key, display_id: format!("#{}", s.issue_number.unwrap_or(0)), title: s.issue_title.clone(), url: s.issue_url.clone() }
}

fn sort_desc(sessions: &mut [Session]) {
    sessions.sort_by(|a, b| b.completed_at.cmp(&a.completed_at));
}

pub fn group_by_day(sessions: &[Session], now: DateTime<Local>) -> Vec<DayGroup> {
    let mut days: Vec<(String, Vec<Session>)> = Vec::new();
    for s in sessions {
        let k = date_key(&s.completed_at);
        match days.iter_mut().find(|(d, _)| *d == k) {
            Some((_, v)) => v.push(s.clone()),
            None => days.push((k, vec![s.clone()])),
        }
    }
    let mut out: Vec<DayGroup> = days
        .into_iter()
        .map(|(k, mut v)| {
            sort_desc(&mut v);
            DayGroup { date_label: date_label(&k, now), date_key: k, sessions: v }
        })
        .collect();
    out.sort_by(|a, b| b.date_key.cmp(&a.date_key));
    out
}

pub fn group_by_issue(sessions: &[Session], now: DateTime<Local>) -> Grouped {
    let mut groups: Vec<IssueGroup> = Vec::new();
    let mut ungrouped = Vec::new();
    for s in sessions {
        if !has_linked_issue(s) {
            ungrouped.push(s.clone());
            continue;
        }
        let key = issue_group_key(s);
        let dk = date_key(&s.completed_at);
        let gi = match groups.iter().position(|g| g.key.key == key.key) {
            Some(i) => i,
            None => {
                groups.push(IssueGroup { key, total_seconds: 0, session_count: 0, date_sub_groups: vec![], latest_completed_at: s.completed_at.clone() });
                groups.len() - 1
            }
        };
        let g = &mut groups[gi];
        g.total_seconds += s.actual_duration_seconds;
        g.session_count += 1;
        if s.completed_at > g.latest_completed_at {
            g.latest_completed_at = s.completed_at.clone();
        }
        match g.date_sub_groups.iter_mut().find(|d| d.date_key == dk) {
            Some(d) => {
                d.total_seconds += s.actual_duration_seconds;
                d.sessions.push(s.clone());
            }
            None => g.date_sub_groups.push(DateSubGroup { date_label: date_label(&dk, now), date_key: dk, total_seconds: s.actual_duration_seconds, sessions: vec![s.clone()] }),
        }
    }
    for g in &mut groups {
        for d in &mut g.date_sub_groups {
            sort_desc(&mut d.sessions);
        }
        g.date_sub_groups.sort_by(|a, b| b.date_key.cmp(&a.date_key));
    }
    groups.sort_by(|a, b| b.latest_completed_at.cmp(&a.latest_completed_at));
    Grouped { issue_groups: groups, ungrouped }
}

/// The day group that starts expanded: the most recent day among the ungrouped sessions.
pub fn seed_day_group(ungrouped: &[Session]) -> Option<String> {
    ungrouped.iter().max_by(|a, b| a.completed_at.cmp(&b.completed_at)).map(|s| date_key(&s.completed_at))
}

/// Local midnight `days` days before `now`.
pub fn start_of_day_minus(now: DateTime<Local>, days: i64) -> DateTime<Local> {
    let d = (now - Duration::days(days)).date_naive();
    Local.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap()).earliest().unwrap_or(now)
}

/// `stripHtml`: the text between tags, trimmed.
pub fn strip_html(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&").trim().to_string()
}

/// The text shown for an issue link: `#12`, `ENG-4`, `PROJ-7`.
pub fn issue_ref_id(issue: &lizmeter_core::IssueRef) -> String {
    use lizmeter_core::IssueRef::*;
    match issue {
        Github { number, .. } => format!("#{number}"),
        Linear { identifier, .. } => identifier.clone(),
        Jira { key, .. } => key.clone(),
        Todo { id, .. } => format!("#{id}"),
    }
}

pub fn issue_ref_title(issue: &lizmeter_core::IssueRef) -> &str {
    use lizmeter_core::IssueRef::*;
    match issue {
        Github { title, .. } | Linear { title, .. } | Jira { title, .. } | Todo { title, .. } => title,
    }
}

/// `reconstructIssueRef`: the link a saved session carries, if it has a usable one.
pub fn reconstruct_issue(s: &Session) -> Option<lizmeter_core::IssueRef> {
    use lizmeter_core::IssueRef;
    let id = s.issue_id.as_ref()?;
    let provider = s.issue_provider?;
    let title = s.issue_title.clone().unwrap_or_default();
    let url = s.issue_url.clone().unwrap_or_default();
    match provider {
        IssueProviderKind::Linear => Some(IssueRef::Linear { identifier: id.clone(), title, url }),
        IssueProviderKind::Jira => Some(IssueRef::Jira { key: id.clone(), title, url }),
        IssueProviderKind::Github => {
            let number = s.issue_number.or_else(|| id.trim().parse().ok()).filter(|n| *n != 0)?;
            Some(IssueRef::Github { number, title, url })
        }
        IssueProviderKind::Todo => Some(IssueRef::Todo { id: id.trim().parse().ok()?, title }),
    }
}

/// The `SaveSessionInput` issue columns for a link.
pub fn issue_columns(issue: &lizmeter_core::IssueRef) -> (Option<i64>, Option<String>, Option<String>, IssueProviderKind, String) {
    use lizmeter_core::IssueRef::*;
    match issue {
        Github { number, title, url } => (Some(*number), Some(title.clone()), Some(url.clone()), IssueProviderKind::Github, number.to_string()),
        Linear { identifier, title, url } => (None, Some(title.clone()), Some(url.clone()), IssueProviderKind::Linear, identifier.clone()),
        Jira { key, title, url } => (None, Some(title.clone()), Some(url.clone()), IssueProviderKind::Jira, key.clone()),
        Todo { id, title } => (None, Some(title.clone()), None, IssueProviderKind::Todo, id.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lizmeter_core::WorklogStatus;

    fn session(id: &str, completed_at: &str, secs: i64, provider: Option<IssueProviderKind>, issue: Option<&str>) -> Session {
        Session {
            id: id.into(),
            title: String::new(),
            timer_type: TimerType::Work,
            planned_duration_seconds: 1500,
            actual_duration_seconds: secs,
            completed_at: completed_at.into(),
            tags: vec![],
            issue_number: None,
            issue_title: issue.map(|i| format!("title {i}")),
            issue_url: None,
            issue_provider: provider,
            issue_id: issue.map(String::from),
            worklog_status: WorklogStatus::NotLogged,
            worklog_id: None,
        }
    }

    fn noon(day: u32) -> String {
        Local.with_ymd_and_hms(2026, 3, day, 12, 0, 0).unwrap().to_rfc3339()
    }

    fn now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 3, 10, 15, 0, 0).unwrap()
    }

    #[test]
    fn formats_durations_like_the_renderer() {
        assert_eq!(format_time(1500), "25:00");
        assert_eq!(format_time(-5), "00:00");
        assert_eq!(format_elapsed(3725), "01:02:05");
        assert_eq!(format_duration(59), "0m");
        assert_eq!(format_duration(5 * 60), "5m");
        assert_eq!(format_duration(83 * 60), "1h 23m");
        assert_eq!(format_duration(120 * 60), "2h 0m");
        assert_eq!(format_duration_dash(30), "\u{2014}");
    }

    #[test]
    fn labels_dates_relative_to_today() {
        assert_eq!(date_label("2026-03-10", now()), "Today");
        assert_eq!(date_label("2026-03-09", now()), "Yesterday");
        assert_eq!(date_label("2026-02-22", now()), "Feb 22");
        assert_eq!(date_label("2025-12-01", now()), "Dec 1, 2025");
    }

    #[test]
    fn groups_ungrouped_sessions_by_day_newest_first() {
        let s = vec![session("a", &noon(8), 60, None, None), session("b", &noon(9), 60, None, None), session("c", &noon(8), 60, None, None)];
        let days = group_by_day(&s, now());
        assert_eq!(days.iter().map(|d| d.date_key.as_str()).collect::<Vec<_>>(), ["2026-03-09", "2026-03-08"]);
        assert_eq!(days[1].sessions.len(), 2);
        assert_eq!(days[0].date_label, "Yesterday");
    }

    #[test]
    fn groups_linked_sessions_by_issue_then_date() {
        let t = Some(IssueProviderKind::Todo);
        let l = Some(IssueProviderKind::Linear);
        let s = vec![
            session("a", &noon(8), 600, t, Some("7")),
            session("b", &noon(9), 300, t, Some("7")),
            session("c", &noon(9), 100, l, Some("LIN-1")),
            session("d", &noon(8), 50, None, None),
        ];
        let g = group_by_issue(&s, now());
        assert_eq!(g.ungrouped.len(), 1);
        assert_eq!(g.issue_groups.len(), 2);
        let todo = g.issue_groups.iter().find(|x| x.key.key == "todo:7").unwrap();
        assert_eq!(todo.key.display_id, "#7");
        assert_eq!((todo.total_seconds, todo.session_count), (900, 2));
        assert_eq!(todo.date_sub_groups[0].date_key, "2026-03-09");
        assert_eq!(g.issue_groups[0].key.display_id, "#7", "groups sort by latest activity, ties keep order");
        assert_eq!(seed_day_group(&g.ungrouped).as_deref(), Some("2026-03-08"));
    }

    #[test]
    fn legacy_github_sessions_group_by_number() {
        let mut s = session("a", &noon(8), 60, None, None);
        s.issue_number = Some(42);
        assert!(has_linked_issue(&s));
        let k = issue_group_key(&s);
        assert_eq!((k.key.as_str(), k.display_id.as_str()), ("legacy-github-num:42", "#42"));
    }

    #[test]
    fn strip_html_keeps_the_text() {
        assert_eq!(strip_html("<p>Hello <strong>world</strong></p>"), "Hello world");
        assert_eq!(strip_html("<p></p>"), "");
        assert_eq!(strip_html("  plain  "), "plain");
        assert_eq!(strip_html("<p>A &amp; B</p>"), "A & B");
        assert_eq!(strip_html("<p>&nbsp;</p>"), "");
    }

    #[test]
    fn issue_links_map_to_session_columns() {
        use lizmeter_core::IssueRef;
        let r = IssueRef::Todo { id: 12, title: "x".into() };
        let (n, t, u, p, id) = issue_columns(&r);
        assert_eq!((n, t.as_deref(), u, p, id.as_str()), (None, Some("x"), None, IssueProviderKind::Todo, "12"));
        assert_eq!(issue_ref_id(&r), "#12");
    }
}
