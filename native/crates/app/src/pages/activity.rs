//! Activity page (`ActivityPage.tsx`, `useNvimActivity.ts`): Neovim file saves of one day, grouped by project.

use crate::controls::*;
use crate::css::{Spec, rgba};
use crate::fmt::format_local_time;
use crate::ui::*;
use chrono::{Datelike, Duration, Local, NaiveDate};
use gpui::*;
use lizmeter_core::{NvimActivity, NvimActivityGroup};
use lizmeter_services::Services;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration as Wait;

use crate::claude_ui::CODE_FONT;

/// Electron polls every 5 s so new saves from Neovim appear by themselves.
const POLL: Wait = Wait::from_secs(5);

/// Records of one project together; the project with the latest first record comes first.
pub fn group_by_project(records: &[NvimActivity]) -> Vec<NvimActivityGroup> {
    let mut groups: Vec<NvimActivityGroup> = vec![];
    for r in records {
        match groups.iter_mut().find(|g| g.project == r.project) {
            Some(g) => g.activities.push(r.clone()),
            None => groups.push(NvimActivityGroup { project: r.project.clone(), activities: vec![r.clone()] }),
        }
    }
    let first = |g: &NvimActivityGroup| g.activities.first().map(|a| a.recorded_at.clone()).unwrap_or_default();
    groups.sort_by(|a, b| first(b).cmp(&first(a)));
    groups
}

pub struct ActivityPage {
    svc: Arc<Services>,
    date: NaiveDate,
    records: Vec<NvimActivity>,
    loading: bool,
    error: Option<String>,
    collapsed: HashSet<String>,
    /// Bumped by every show and hide: an older poll loop sees a newer number and exits.
    poll_gen: u64,
    visible: bool,
}

impl ActivityPage {
    pub fn new(svc: Arc<Services>) -> Self {
        Self { svc, date: Local::now().date_naive(), records: vec![], loading: true, error: None, collapsed: HashSet::new(), poll_gen: 0, visible: false }
    }

    /// Capture hook: `"-1"` opens the day before today.
    pub fn preset(&mut self, spec: &str) {
        if let Ok(days) = spec.parse::<i64>() {
            self.date = Local::now().date_naive() + Duration::days(days);
        }
    }

    fn date_string(&self) -> String {
        self.date.format("%Y-%m-%d").to_string()
    }

    pub fn load(&mut self, cx: &mut Context<Self>) {
        match self.svc.list_nvim_activity_by_date(&self.date_string()) {
            Ok(r) => {
                self.records = r.records;
                self.error = None;
            }
            Err(e) => {
                self.error = Some(e.to_string());
                self.records = vec![];
            }
        }
        self.loading = false;
        cx.notify();
    }

    /// The page is on screen: load now and keep loading every 5 s.
    pub fn show(&mut self, cx: &mut Context<Self>) {
        self.visible = true;
        self.poll_gen += 1;
        let generation = self.poll_gen;
        self.load(cx);
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(POLL).await;
            let keep = this
                .update(cx, |p, cx| {
                    if p.poll_gen != generation || !p.visible {
                        return false;
                    }
                    p.load(cx);
                    true
                })
                .unwrap_or(false);
            if !keep {
                break;
            }
        })
        .detach();
    }

    pub fn hide(&mut self) {
        self.visible = false;
        self.poll_gen += 1;
    }

    fn go_to(&mut self, date: NaiveDate, cx: &mut Context<Self>) {
        self.date = date;
        self.loading = true;
        self.load(cx);
    }

    fn is_today(&self) -> bool {
        self.date == Local::now().date_naive()
    }

    fn nav_button(id: &'static str, icon: &'static str, on_click: impl Fn(&mut Window, &mut App) + 'static) -> impl IntoElement {
        let glass = Glass::new(8.0, 8.0, 1.0, Spec::rrect(8.0).solid(rgba(16, 18, 36, 0.35)).border(1.0, rgba(41, 46, 66, 0.8)));
        glass
            .el()
            .id(id)
            .size(px(32.0))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .text_color(col(TN_TEXT_DIM))
            .hover(|s| s.text_color(col(TN_TEXT)).bg(col(rgba(122, 162, 247, 0.06))))
            .on_click(move |_, w, a| on_click(w, a))
            .child(svg().path(icon).size(px(16.0)).text_color(col(TN_TEXT_DIM)))
    }

    fn group_card(&self, g: &NvimActivityGroup, cx: &mut Context<Self>) -> impl IntoElement {
        let collapsed = self.collapsed.contains(&g.project);
        let me = cx.entity();
        let project = g.project.clone();
        let header = div()
            .id(SharedString::from(format!("act-head-{}", g.project)))
            .w_full()
            .px(px(16.0))
            .py(px(12.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .cursor_pointer()
            .on_click(move |_, _, app| {
                let project = project.clone();
                me.update(app, |p, cx| {
                    if !p.collapsed.remove(&project) {
                        p.collapsed.insert(project);
                    }
                    cx.notify();
                })
            })
            .child(svg().path(if collapsed { "icons/chevron-right.svg" } else { "icons/chevron-down.svg" }).size(px(14.0)).flex_shrink_0().text_color(col(ICON_DIM)))
            .child(ui_text(13.0).flex_1().min_w_0().truncate().font_weight(FontWeight(600.0)).text_color(col(TN_BLUE)).child(g.project.clone()))
            .child(
                ui_text(11.0)
                    .px(px(8.0))
                    .py(px(2.0))
                    .rounded(px(10.0))
                    .bg(col(rgba(122, 162, 247, 0.1)))
                    .font_weight(FontWeight(700.0))
                    .text_color(col(TN_TEXT_DIM))
                    .child(g.activities.len().to_string()),
            );
        let mut card = hover_card().w_full().flex().flex_col().overflow_hidden().child(header);
        if !collapsed {
            let mut list = div().w_full().py(px(4.0)).border_t_1().border_color(col(rgba(41, 46, 66, 0.5))).flex().flex_col();
            for a in &g.activities {
                list = list.child(
                    div()
                        .id(SharedString::from(format!("act-row-{}", a.id)))
                        .w_full()
                        .pl(px(38.0))
                        .pr(px(16.0))
                        .py(px(6.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .hover(|s| s.bg(col(rgba(122, 162, 247, 0.04))))
                        .child(div().flex_1().min_w_0().mr(px(12.0)).truncate().font_family(CODE_FONT).text_size(px(12.0)).line_height(px(14.4)).text_color(col(TN_TEXT_DIM)).child(a.file.clone()))
                        .child(ui_text(11.0).flex_shrink_0().text_color(col(TN_TEXT_DIM)).child(format_local_time(&a.recorded_at))),
                );
            }
            card = card.child(list);
        }
        card
    }

    fn empty(icon: bool, text: String) -> Div {
        let mut d = div().w_full().py(px(48.0)).px(px(16.0)).flex().flex_col().items_center().justify_center().gap(px(12.0));
        if icon {
            d = d.child(svg().path("icons/file.svg").size(px(32.0)).text_color(col(rgba(122, 129, 148, 0.7))));
        }
        d.child(ui_text(13.0).text_color(col(TN_TEXT_DIM)).child(text))
    }
}

impl Render for ActivityPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let (m_prev, m_next, m_today) = (me.clone(), me.clone(), me.clone());
        let date = self.date;
        let mut date_display = div().flex_1().flex().flex_row().items_center().gap(px(10.0)).child(
            ui_text(14.0).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child(crate::locale::long_date(date.year(), date.month(), date.day())),
        );
        if !self.is_today() {
            date_display = date_display.child(
                Glass::new(6.0, 0.0, 1.0, Spec::rrect(6.0).solid(rgba(122, 162, 247, 0.12)).border(1.0, rgba(122, 162, 247, 0.3)))
                    .el()
                    .id("act-today")
                    .px(px(10.0))
                    .py(px(2.0))
                    .cursor_pointer()
                    .text_color(col(TN_BLUE))
                    .hover(|s| s.bg(col(rgba(122, 162, 247, 0.08))))
                    .on_click(move |_, _, app| m_today.update(app, |p, cx| p.go_to(Local::now().date_naive(), cx)))
                    .child(ui_text(11.0).font_weight(FontWeight(600.0)).child("Today")),
            );
        }
        let nav = div()
            .mb(px(20.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.0))
            .child(Self::nav_button("act-prev", "icons/chevron-left.svg", move |_, app| m_prev.update(app, |p, cx| p.go_to(p.date - Duration::days(1), cx))))
            .child(date_display)
            .child(Self::nav_button("act-next", "icons/chevron-right.svg", move |_, app| m_next.update(app, |p, cx| p.go_to(p.date + Duration::days(1), cx))));

        let mut body = div().flex().flex_col().child(page_heading("Activity").mt(px(8.7)).mb(px(16.0))).child(nav);
        if self.loading {
            body = body.child(Self::empty(false, "Loading...".into()));
        } else if let Some(e) = &self.error {
            body = body.child(Self::empty(false, e.clone()));
        } else if self.records.is_empty() {
            body = body.child(Self::empty(true, "No activity recorded for this day".into()));
        } else {
            let mut list = div().flex().flex_col().gap(px(10.0));
            for g in group_by_project(&self.records) {
                list = list.child(self.group_card(&g, cx));
            }
            body = body.child(list);
        }
        page_shell("activity-page", 600.0, body)
    }
}

#[cfg(test)]
mod tests {
    use super::group_by_project;
    use lizmeter_core::NvimActivity;

    fn rec(id: i64, project: &str, file: &str, at: &str) -> NvimActivity {
        NvimActivity { id, project: project.into(), file: file.into(), recorded_at: at.into() }
    }

    #[test]
    fn groups_keep_record_order_and_the_latest_project_comes_first() {
        let records = vec![
            rec(1, "alpha", "a.rs", "2026-11-09T08:00:00Z"),
            rec(2, "beta", "b.rs", "2026-11-09T09:00:00Z"),
            rec(3, "alpha", "c.rs", "2026-11-09T10:00:00Z"),
        ];
        let groups = group_by_project(&records);
        assert_eq!(groups.iter().map(|g| g.project.as_str()).collect::<Vec<_>>(), ["beta", "alpha"]);
        assert_eq!(groups[1].activities.iter().map(|a| a.file.as_str()).collect::<Vec<_>>(), ["a.rs", "c.rs"]);
    }

    #[test]
    fn no_records_make_no_groups() {
        assert!(group_by_project(&[]).is_empty());
    }
}
