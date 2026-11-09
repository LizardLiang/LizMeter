//! The rules behind the Todos list that need no window: grouping, row order, the keyboard cursor,
//! the quick-menu item sets, the clipboard texts and the windowing of a long list.

use chrono::{Datelike, Duration, Local, NaiveDate};
use lizmeter_core::{Todo, TodoLabel, TodoProject, TodoState, TODO_PRIORITY_LABELS};
use std::collections::{HashMap, HashSet};
use std::ops::Range;

pub const BAND_H: f32 = 34.0;
pub const ROW_H: f32 = 36.0;

pub struct Group {
    pub state: TodoState,
    pub items: Vec<Todo>,
}

/// Todos grouped by state, ordered by the state's position: the list's rendered order.
pub fn group_todos(todos: &[Todo], states: &[TodoState]) -> Vec<Group> {
    let mut by_state: HashMap<i64, Vec<Todo>> = HashMap::new();
    for t in todos {
        by_state.entry(t.state.id).or_default().push(t.clone());
    }
    let mut sorted: Vec<&TodoState> = states.iter().collect();
    sorted.sort_by_key(|s| s.position);
    sorted.into_iter().map(|s| Group { state: s.clone(), items: by_state.remove(&s.id).unwrap_or_default() }).collect()
}

/// Row order as shown, flattened across groups, skipping collapsed ones.
pub fn visible_ids(groups: &[Group], collapsed: &HashSet<i64>) -> Vec<i64> {
    groups.iter().filter(|g| !collapsed.contains(&g.state.id)).flat_map(|g| g.items.iter().map(|t| t.id)).collect()
}

/// The cursor after a step of `delta`: no cursor yet starts at the top (down) or the bottom (up).
pub fn move_focus(visible: &[i64], current: Option<i64>, delta: i32) -> Option<i64> {
    if visible.is_empty() {
        return None;
    }
    let at = current.and_then(|c| visible.iter().position(|&v| v == c));
    match at {
        None => Some(if delta > 0 { visible[0] } else { visible[visible.len() - 1] }),
        Some(i) => {
            let next = (i as i64 + delta as i64).clamp(0, visible.len() as i64 - 1) as usize;
            Some(visible[next])
        }
    }
}

/// The cursor can never point at a row that is not shown: a collapse, a filter or a delete drops it.
pub fn cursor_on_screen(focused: Option<i64>, visible: &[i64]) -> Option<i64> {
    focused.filter(|f| visible.contains(f))
}

/// A selection keeps only todos that still exist.
pub fn prune_selection(selected: &HashSet<i64>, todos: &[Todo]) -> HashSet<i64> {
    let live: HashSet<i64> = todos.iter().map(|t| t.id).collect();
    selected.iter().copied().filter(|id| live.contains(id)).collect()
}

/// A shift-click selects the run between the anchor and the clicked row, a plain click toggles.
pub fn select_range(visible: &[i64], anchor: i64, id: i64) -> Option<Vec<i64>> {
    let from = visible.iter().position(|&v| v == anchor)?;
    let to = visible.iter().position(|&v| v == id)?;
    Some(visible[from.min(to)..=from.max(to)].to_vec())
}

// ---- Windowing ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flat {
    Band(usize),
    Row(usize, usize),
}

/// The list as one run of fixed-height items, so any scroll position maps to the items on screen.
pub struct FlatLayout {
    pub items: Vec<Flat>,
    offsets: Vec<f32>,
}

impl FlatLayout {
    pub fn new(groups: &[Group], collapsed: &HashSet<i64>) -> Self {
        let mut items = vec![];
        for (gi, g) in groups.iter().enumerate() {
            items.push(Flat::Band(gi));
            if !collapsed.contains(&g.state.id) {
                for ri in 0..g.items.len() {
                    items.push(Flat::Row(gi, ri));
                }
            }
        }
        let mut offsets = Vec::with_capacity(items.len() + 1);
        let mut y = 0.0;
        offsets.push(y);
        for it in &items {
            y += match it {
                Flat::Band(_) => BAND_H,
                Flat::Row(..) => ROW_H,
            };
            offsets.push(y);
        }
        Self { items, offsets }
    }

    pub fn height(&self) -> f32 {
        *self.offsets.last().unwrap_or(&0.0)
    }

    pub fn top_of(&self, index: usize) -> f32 {
        self.offsets[index]
    }

    /// The items that touch `[top, bottom)`, widened by `overscan` items each way.
    pub fn range(&self, top: f32, bottom: f32, overscan: usize) -> Range<usize> {
        let n = self.items.len();
        if n == 0 {
            return 0..0;
        }
        let first = self.offsets.partition_point(|&o| o <= top.max(0.0)).saturating_sub(1).min(n - 1);
        let last = self.offsets.partition_point(|&o| o < bottom).min(n);
        first.saturating_sub(overscan)..(last + overscan).min(n)
    }

    pub fn index_of_row(&self, groups: &[Group], todo_id: i64) -> Option<usize> {
        self.items.iter().position(|it| matches!(it, Flat::Row(g, r) if groups[*g].items[*r].id == todo_id))
    }
}

/// The scroll position that brings `[item_top, item_bottom)` into a viewport of `viewport_h` showing
/// from `scrolled`, moving no further than needed (`scrollIntoView({block: "nearest"})`).
pub fn scroll_nearest(scrolled: f32, viewport_h: f32, item_top: f32, item_bottom: f32) -> f32 {
    if item_top < scrolled {
        item_top
    } else if item_bottom > scrolled + viewport_h {
        item_bottom - viewport_h
    } else {
        scrolled
    }
}

// ---- Dates ----

pub fn today() -> NaiveDate {
    Local::now().date_naive()
}

pub fn iso(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

pub fn iso_plus_days(base: NaiveDate, days: i64) -> String {
    iso(base + Duration::days(days))
}

/// Well-formed is not enough: 2026-02-30 has the shape but is no day.
pub fn is_real_iso_date(value: &str) -> bool {
    let b = value.as_bytes();
    let shaped = b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    shaped && NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

/// "Nov 9" in the system's own pattern; the date is read as a calendar day, with no zone shift.
pub fn format_day(iso_date: &str) -> String {
    match NaiveDate::parse_from_str(iso_date.get(..10).unwrap_or(iso_date), "%Y-%m-%d") {
        Ok(d) => crate::locale::month_day(d.year(), d.month(), d.day(), false),
        Err(_) => iso_date.to_string(),
    }
}

pub fn is_overdue(todo: &Todo, today_iso: &str) -> bool {
    todo.due_date.as_deref().is_some_and(|d| !todo.state.is_completed && d < today_iso)
}

/// The date a row shows: the due date, else the day it was created.
pub fn row_date(todo: &Todo) -> &str {
    todo.due_date.as_deref().unwrap_or_else(|| todo.created_at.get(..10).unwrap_or(&todo.created_at))
}

// ---- Quick menus ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuickKind {
    State,
    Priority,
    Due,
    Project,
    Label,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuickItem {
    pub value: String,
    pub label: String,
    pub color: Option<String>,
    pub hint: Option<String>,
    pub current: bool,
}

impl QuickItem {
    fn new(value: impl Into<String>, label: impl Into<String>) -> Self {
        Self { value: value.into(), label: label.into(), color: None, hint: None, current: false }
    }
    fn color(mut self, c: &str) -> Self {
        self.color = Some(c.to_string());
        self
    }
    fn hint(mut self, h: impl Into<String>) -> Self {
        self.hint = Some(h.into());
        self
    }
    fn current(mut self, on: bool) -> Self {
        self.current = on;
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Accept {
    /// Only the listed rows can be picked.
    Nothing,
    /// A typed YYYY-MM-DD that no shortcut covers.
    Date,
    /// An unlisted name creates the project or label.
    NewName,
}

pub struct QuickConfig {
    pub heading: &'static str,
    pub placeholder: &'static str,
    pub items: Vec<QuickItem>,
    pub accept: Accept,
    /// Only the label menu: several can be toggled without reopening.
    pub multi: bool,
}

/// What a picked row does to the todo.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QuickPick {
    State(i64),
    Priority(i64),
    Due(Option<String>),
    Project(Option<i64>),
    NewProject(String),
    ToggleLabel(i64),
    NewLabel(String),
}

pub fn quick_config(kind: QuickKind, todo: &Todo, states: &[TodoState], projects: &[TodoProject], labels: &[TodoLabel], today: NaiveDate) -> QuickConfig {
    match kind {
        QuickKind::State => QuickConfig {
            heading: "Move to state",
            placeholder: "Change state to...",
            items: states.iter().map(|s| QuickItem::new(s.id.to_string(), &s.label).color(&s.color).current(s.id == todo.state.id)).collect(),
            accept: Accept::Nothing,
            multi: false,
        },
        QuickKind::Priority => QuickConfig {
            heading: "Set priority",
            placeholder: "Set priority to...",
            items: TODO_PRIORITY_LABELS.iter().enumerate().map(|(v, l)| QuickItem::new(v.to_string(), *l).current(v as i64 == todo.priority)).collect(),
            accept: Accept::Nothing,
            multi: false,
        },
        QuickKind::Due => {
            let mut items: Vec<QuickItem> = [("Today", 0), ("Tomorrow", 1), ("Next week", 7)]
                .into_iter()
                .map(|(label, days)| {
                    let day = iso_plus_days(today, days);
                    let on = todo.due_date.as_deref() == Some(day.as_str());
                    QuickItem::new(day.clone(), label).hint(format_day(&day)).current(on)
                })
                .collect();
            items.push(QuickItem::new("", "No due date").current(todo.due_date.is_none()));
            QuickConfig { heading: "Set due date", placeholder: "Or type YYYY-MM-DD", items, accept: Accept::Date, multi: false }
        }
        QuickKind::Label => QuickConfig {
            heading: "Toggle labels",
            placeholder: "Filter, or name a new one",
            items: labels.iter().map(|l| QuickItem::new(l.id.to_string(), &l.name).color(&l.color).current(todo.labels.iter().any(|a| a.id == l.id))).collect(),
            accept: Accept::NewName,
            multi: true,
        },
        QuickKind::Project => {
            let mut items: Vec<QuickItem> = projects.iter().map(|p| QuickItem::new(p.id.to_string(), &p.name).color(&p.color).current(todo.project.as_ref().is_some_and(|c| c.id == p.id))).collect();
            items.push(QuickItem::new("", "No project").current(todo.project.is_none()));
            QuickConfig { heading: "Set project", placeholder: "Filter, or name a new one", items, accept: Accept::NewName, multi: false }
        }
    }
}

/// The item a typed query offers as its own row, if the menu takes one.
pub fn accept_query(accept: Accept, query: &str) -> Option<QuickItem> {
    match accept {
        Accept::Nothing => None,
        Accept::Date => is_real_iso_date(query).then(|| QuickItem::new(query, query).hint(format_day(query))),
        Accept::NewName => Some(QuickItem::new(format!("new:{query}"), format!("Create \"{query}\"")).hint("New")),
    }
}

/// The rows a menu shows for a query: the typed value first when nothing listed matches it exactly.
pub fn quick_rows(items: &[QuickItem], accept: Accept, query: &str) -> Vec<QuickItem> {
    let needle = query.trim().to_lowercase();
    let matches: Vec<QuickItem> = if needle.is_empty() { items.to_vec() } else { items.iter().filter(|i| i.label.to_lowercase().contains(&needle)).cloned().collect() };
    let trimmed = query.trim();
    let typed = if trimmed.is_empty() || matches.iter().any(|i| i.label.to_lowercase() == trimmed.to_lowercase()) { None } else { accept_query(accept, trimmed) };
    typed.into_iter().chain(matches).collect()
}

/// Where the highlight starts: the current value, or the top in toggle mode.
pub fn initial_active(items: &[QuickItem], multi: bool) -> usize {
    if multi {
        0
    } else {
        items.iter().position(|i| i.current).unwrap_or(0)
    }
}

pub fn resolve_pick(kind: QuickKind, value: &str) -> Option<QuickPick> {
    Some(match kind {
        QuickKind::State => QuickPick::State(value.parse().ok()?),
        QuickKind::Priority => QuickPick::Priority(value.parse().ok()?),
        QuickKind::Due => QuickPick::Due((!value.is_empty()).then(|| value.to_string())),
        QuickKind::Project => match value.strip_prefix("new:") {
            Some(name) => QuickPick::NewProject(name.to_string()),
            None => QuickPick::Project(if value.is_empty() { None } else { Some(value.parse().ok()?) }),
        },
        QuickKind::Label => match value.strip_prefix("new:") {
            Some(name) => QuickPick::NewLabel(name.to_string()),
            None => QuickPick::ToggleLabel(value.parse().ok()?),
        },
    })
}

/// A label set with `label` added or removed, the rest left alone.
pub fn toggled_labels(todo: &Todo, label_id: i64) -> Vec<i64> {
    let current: Vec<i64> = todo.labels.iter().map(|l| l.id).collect();
    if current.contains(&label_id) {
        current.into_iter().filter(|&i| i != label_id).collect()
    } else {
        current.into_iter().chain([label_id]).collect()
    }
}

// ---- Clipboard ----

pub fn format_todo_id(id: i64) -> String {
    format!("#{id}")
}

/// Every run of whitespace that holds a line break becomes one space.
pub fn collapse_line_breaks(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut run = String::new();
    let mut flush = |run: &mut String, out: &mut String| {
        if run.contains(['\n', '\r']) {
            out.push(' ');
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for ch in value.chars() {
        if ch.is_whitespace() {
            run.push(ch);
        } else {
            flush(&mut run, &mut out);
            out.push(ch);
        }
    }
    flush(&mut run, &mut out);
    out
}

fn has_unbalanced_fence(text: &str) -> bool {
    let fences = text
        .split(['\n', '\r'])
        .filter(|line| {
            let spaces = line.bytes().take_while(|&b| b == b' ').count();
            spaces <= 3 && line[spaces..].starts_with("```")
        })
        .count();
    fences % 2 != 0
}

pub struct ChildRef {
    pub id: i64,
    pub title: String,
    pub state_label: String,
    pub is_completed: bool,
}

/// The markdown "Copy agent prompt" puts on the clipboard.
pub fn format_agent_prompt(todo: &Todo, parent: Option<(i64, String)>, children: &[ChildRef]) -> String {
    let mut sections = vec![format!("# {}", collapse_line_breaks(&todo.title))];
    let notes = todo.notes.as_deref().map(str::trim).unwrap_or("");
    if !notes.is_empty() {
        sections.push(if has_unbalanced_fence(notes) { format!("{notes}\n```") } else { notes.to_string() });
    }
    if let Some((id, title)) = parent {
        sections.push(format!("## Parent\n{} {title}", format_todo_id(id)));
    }
    if !children.is_empty() {
        let rows: Vec<String> = children.iter().map(|c| format!("- [{}] {} {} ({})", if c.is_completed { "x" } else { " " }, format_todo_id(c.id), c.title, c.state_label)).collect();
        sections.push(format!("## Sub-issues\n{}", rows.join("\n")));
    }
    sections.push(
        [
            "---".to_string(),
            format!("This task is LizMeter todo {}. Re-read it with the lizmeter-todo MCP server:", format_todo_id(todo.id)),
            format!("`todo_list` with `id: {}`. List its sub-issues with `todo_list` and `parentId: {}`.", todo.id, todo.id),
            "Mark it done with `todo_complete`, or update it with `todo_update`.".to_string(),
        ]
        .join("\n"),
    );
    sections.join("\n\n")
}

/// The page width: `clamp(40rem, 78vw, 96rem)`.
pub fn page_max_width(window_w: f32) -> f32 {
    (window_w * 0.78).clamp(640.0, 1536.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lizmeter_core::TodoSource;

    fn state(id: i64, position: i64, done: bool) -> TodoState {
        TodoState { id, label: format!("S{id}"), color: "#7aa2f7".into(), position, is_completed: done, is_default: id == 1, created_at: String::new() }
    }

    fn todo(id: i64, st: &TodoState) -> Todo {
        Todo {
            id,
            title: format!("Todo {id}"),
            notes: None,
            state: st.clone(),
            project: None,
            labels: vec![],
            milestone: None,
            priority: 0,
            start_date: None,
            due_date: None,
            source: TodoSource::User,
            source_label: None,
            parent_id: None,
            parent_title: None,
            child_count: 0,
            completed_child_count: 0,
            created_at: "2026-11-01T00:00:00.000Z".into(),
            completed_at: None,
        }
    }

    fn sample() -> (Vec<TodoState>, Vec<Todo>) {
        let states = vec![state(2, 1, true), state(1, 0, false)];
        let todos = vec![todo(10, &states[0]), todo(11, &states[1]), todo(12, &states[1])];
        (states, todos)
    }

    #[test]
    fn groups_follow_state_position_and_keep_empty_states() {
        let (mut states, todos) = sample();
        states.push(state(3, 2, false));
        let groups = group_todos(&todos, &states);
        assert_eq!(groups.iter().map(|g| g.state.id).collect::<Vec<_>>(), vec![1, 2, 3]);
        assert_eq!(groups[0].items.len(), 2);
        assert!(groups[2].items.is_empty());
    }

    #[test]
    fn collapsed_groups_leave_the_row_order() {
        let (states, todos) = sample();
        let groups = group_todos(&todos, &states);
        assert_eq!(visible_ids(&groups, &HashSet::new()), vec![11, 12, 10]);
        assert_eq!(visible_ids(&groups, &HashSet::from([1])), vec![10]);
    }

    #[test]
    fn the_cursor_reads_the_order_it_is_given_at_the_moment_of_the_key() {
        let before = [11, 12, 10];
        assert_eq!(move_focus(&before, None, 1), Some(11));
        assert_eq!(move_focus(&before, None, -1), Some(10));
        assert_eq!(move_focus(&before, Some(12), 1), Some(10));
        assert_eq!(move_focus(&before, Some(10), 1), Some(10));
        // A list that changed between two keys: the cursor row left, so a step starts over.
        let after = [20, 21];
        assert_eq!(move_focus(&after, Some(12), 1), Some(20));
        assert_eq!(move_focus(&[], Some(12), 1), None);
    }

    #[test]
    fn the_cursor_drops_when_its_row_is_hidden() {
        assert_eq!(cursor_on_screen(Some(5), &[1, 2]), None);
        assert_eq!(cursor_on_screen(Some(2), &[1, 2]), Some(2));
    }

    #[test]
    fn a_shift_range_runs_both_ways() {
        let v = [1, 2, 3, 4, 5];
        assert_eq!(select_range(&v, 2, 4), Some(vec![2, 3, 4]));
        assert_eq!(select_range(&v, 4, 2), Some(vec![2, 3, 4]));
        assert_eq!(select_range(&v, 9, 2), None);
    }

    #[test]
    fn a_long_list_windows_to_the_rows_on_screen() {
        let st = state(1, 0, false);
        let todos: Vec<Todo> = (0..50_000).map(|i| todo(i, &st)).collect();
        let groups = group_todos(&todos, std::slice::from_ref(&st));
        let layout = FlatLayout::new(&groups, &HashSet::new());
        assert_eq!(layout.items.len(), 50_001);
        assert!((layout.height() - (BAND_H + 50_000.0 * ROW_H)).abs() < 1.0);
        let r = layout.range(0.0, 800.0, 0);
        assert_eq!(r.start, 0);
        assert!(r.len() < 30);
        let mid = layout.range(900_000.0, 900_800.0, 4);
        assert!(mid.len() < 40);
        assert!(layout.top_of(mid.start) <= 900_000.0);
        assert!(layout.top_of(mid.end - 1) + ROW_H >= 900_800.0);
        assert_eq!(layout.range(layout.height() + 10_000.0, layout.height() + 11_000.0, 0).end, layout.items.len());
    }

    #[test]
    fn a_collapsed_group_has_only_its_band() {
        let (states, todos) = sample();
        let groups = group_todos(&todos, &states);
        let layout = FlatLayout::new(&groups, &HashSet::from([1]));
        assert_eq!(layout.items, vec![Flat::Band(0), Flat::Band(1), Flat::Row(1, 0)]);
        assert_eq!(layout.index_of_row(&groups, 10), Some(2));
        assert_eq!(layout.index_of_row(&groups, 11), None);
    }

    #[test]
    fn scrolling_to_a_row_moves_no_further_than_needed() {
        assert_eq!(scroll_nearest(100.0, 400.0, 150.0, 186.0), 100.0);
        assert_eq!(scroll_nearest(100.0, 400.0, 60.0, 96.0), 60.0);
        assert_eq!(scroll_nearest(100.0, 400.0, 480.0, 516.0), 116.0);
    }

    #[test]
    fn typed_dates_must_be_real_days() {
        assert!(is_real_iso_date("2026-02-28"));
        assert!(!is_real_iso_date("2026-02-30"));
        assert!(!is_real_iso_date("2026-2-3"));
        assert!(!is_real_iso_date("tomorrow"));
    }

    #[test]
    fn due_menu_offers_three_shortcuts_a_clear_row_and_a_typed_date() {
        let (states, todos) = sample();
        let today = NaiveDate::from_ymd_opt(2026, 11, 9).unwrap();
        let cfg = quick_config(QuickKind::Due, &todos[0], &states, &[], &[], today);
        let values: Vec<&str> = cfg.items.iter().map(|i| i.value.as_str()).collect();
        assert_eq!(values, vec!["2026-11-09", "2026-11-10", "2026-11-16", ""]);
        assert!(cfg.items[3].current);
        let rows = quick_rows(&cfg.items, cfg.accept, "2026-12-24");
        assert_eq!(rows[0].value, "2026-12-24");
        assert!(quick_rows(&cfg.items, cfg.accept, "2026-12-34").is_empty());
        assert_eq!(resolve_pick(QuickKind::Due, ""), Some(QuickPick::Due(None)));
        assert_eq!(resolve_pick(QuickKind::Due, "2026-12-24"), Some(QuickPick::Due(Some("2026-12-24".into()))));
    }

    #[test]
    fn an_unlisted_name_creates_a_label_and_a_listed_one_does_not() {
        let (states, todos) = sample();
        let labels = vec![TodoLabel { id: 7, name: "Bug".into(), color: "#f7768e".into(), created_at: String::new() }];
        let today = NaiveDate::from_ymd_opt(2026, 11, 9).unwrap();
        let cfg = quick_config(QuickKind::Label, &todos[0], &states, &[], &labels, today);
        assert!(cfg.multi);
        assert_eq!(quick_rows(&cfg.items, cfg.accept, "bug").len(), 1);
        let rows = quick_rows(&cfg.items, cfg.accept, "chore");
        assert_eq!(rows[0].value, "new:chore");
        assert_eq!(resolve_pick(QuickKind::Label, "new:chore"), Some(QuickPick::NewLabel("chore".into())));
        assert_eq!(resolve_pick(QuickKind::Label, "7"), Some(QuickPick::ToggleLabel(7)));
    }

    #[test]
    fn the_highlight_starts_on_the_current_value_except_in_toggle_mode() {
        let (states, todos) = sample();
        let today = NaiveDate::from_ymd_opt(2026, 11, 9).unwrap();
        let cfg = quick_config(QuickKind::State, &todos[1], &states, &[], &[], today);
        assert_eq!(initial_active(&cfg.items, false), 1);
        assert_eq!(initial_active(&cfg.items, true), 0);
    }

    #[test]
    fn toggling_a_label_keeps_the_others() {
        let st = state(1, 0, false);
        let mut t = todo(1, &st);
        t.labels = vec![TodoLabel { id: 1, name: "a".into(), color: "#fff".into(), created_at: String::new() }, TodoLabel { id: 2, name: "b".into(), color: "#fff".into(), created_at: String::new() }];
        assert_eq!(toggled_labels(&t, 1), vec![2]);
        assert_eq!(toggled_labels(&t, 3), vec![1, 2, 3]);
    }

    #[test]
    fn overdue_needs_an_open_state_and_a_past_day() {
        let (states, mut todos) = sample();
        todos[1].due_date = Some("2026-11-01".into());
        assert!(is_overdue(&todos[1], "2026-11-09"));
        assert!(!is_overdue(&todos[1], "2026-11-01"));
        todos[0].due_date = Some("2026-11-01".into());
        assert!(!is_overdue(&todos[0], "2026-11-09"), "a completed state is never overdue");
        let _ = states;
        assert_eq!(row_date(&todos[2]), "2026-11-01");
    }

    #[test]
    fn line_breaks_collapse_to_one_space() {
        assert_eq!(collapse_line_breaks("a \r\n\n  b\tc"), "a b\tc");
        assert_eq!(collapse_line_breaks("one  two"), "one  two");
    }

    #[test]
    fn the_agent_prompt_matches_the_electron_text() {
        let st = state(1, 0, false);
        let mut t = todo(42, &st);
        t.title = "Fix\nlogin".into();
        t.notes = Some("  Steps:\n```js\nlet a;\n".into());
        let kids = [ChildRef { id: 43, title: "Child".into(), state_label: "Done".into(), is_completed: true }];
        let text = format_agent_prompt(&t, Some((7, "Epic".into())), &kids);
        let expected = "# Fix login\n\nSteps:\n```js\nlet a;\n```\n\n## Parent\n#7 Epic\n\n## Sub-issues\n- [x] #43 Child (Done)\n\n---\nThis task is LizMeter todo #42. Re-read it with the lizmeter-todo MCP server:\n`todo_list` with `id: 42`. List its sub-issues with `todo_list` and `parentId: 42`.\nMark it done with `todo_complete`, or update it with `todo_update`.";
        assert_eq!(text, expected);
    }

    #[test]
    fn page_width_clamps_between_40_and_96_rem() {
        assert!((page_max_width(1200.0) - 936.0).abs() < 0.01);
        assert_eq!(page_max_width(600.0), 640.0);
        assert_eq!(page_max_width(3000.0), 1536.0);
    }
}
