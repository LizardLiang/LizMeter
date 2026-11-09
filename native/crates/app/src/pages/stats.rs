//! Stats page (`StatsPage.tsx`): summary cards, a By Date column chart, By Tag and By Type bars.

use super::stats_data::{compute, DayBar, HBar, Range, Stats};
use crate::controls::*;
use crate::css::rgba;
use crate::fmt::format_duration_dash;
use crate::ui::*;
use gpui::*;
use lizmeter_core::ListSessionsInput;
use lizmeter_services::Services;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone, Copy, PartialEq, Eq)]
enum GroupBy {
    Date,
    Tag,
    Type,
}

pub struct StatsPage {
    svc: Arc<Services>,
    sessions: Vec<lizmeter_core::Session>,
    loading: bool,
    group_by: GroupBy,
    range: Range,
    /// Bar sizes (0..1) the last range showed, by bar key: a bar present in both ranges grows
    /// from its old size to the new one (`transition: height 0.45s ease`).
    shown: HashMap<String, f32>,
    from: HashMap<String, f32>,
    generation: u32,
}

impl StatsPage {
    pub fn new(svc: Arc<Services>) -> Self {
        Self { svc, sessions: vec![], loading: true, group_by: GroupBy::Date, range: Range::Week, shown: HashMap::new(), from: HashMap::new(), generation: 0 }
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if let Ok(r) = self.svc.list_sessions(&ListSessionsInput { limit: Some(5000), offset: Some(0), tag_id: None }) {
            self.sessions = r.sessions;
        }
        self.loading = false;
        cx.notify();
    }

    /// Capture hook: `"14:tag"` opens the 14-day range on the By Tag tab.
    pub fn preset(&mut self, spec: &str) {
        for part in spec.split(':') {
            match part {
                "14" => self.range = Range::Fortnight,
                "30" => self.range = Range::Month,
                "tag" => self.group_by = GroupBy::Tag,
                "type" => self.group_by = GroupBy::Type,
                _ => {}
            }
        }
    }

    fn set_range(&mut self, range: Range, cx: &mut Context<Self>) {
        if self.range != range {
            self.range = range;
            self.from = std::mem::take(&mut self.shown);
            self.generation += 1;
            cx.notify();
        }
    }

    fn set_group(&mut self, g: GroupBy, cx: &mut Context<Self>) {
        self.group_by = g;
        self.from.clear();
        self.shown.clear();
        cx.notify();
    }

    /// Wraps a bar so it animates from where the previous range left it.
    fn grow(&mut self, key: &str, to: f32, build: impl Fn(f32) -> Div + 'static) -> AnyElement {
        self.shown.insert(key.to_string(), to);
        match self.from.get(key).copied() {
            Some(prev) if (prev - to).abs() > f32::EPSILON => {
                animate(div(), SharedString::from(format!("stat-{key}-{}", self.generation)), 450, false, ease(), 1.0, move |_, t| build(prev + (to - prev) * t))
            }
            _ => build(to).into_any_element(),
        }
    }

    fn range_chip(&self, r: Range, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        soft_button(SharedString::from(format!("range-{}", r.days())), &format!("{}d", r.days()), self.range == r, 8.0, move |_, a| me.update(a, |p, cx| p.set_range(r, cx)))
            .px(px(12.0))
            .py(px(4.0))
            .font_family(BTN_FONT)
            .text_size(px(12.0))
            .line_height(px(14.0))
            .font_weight(FontWeight(500.0))
    }

    fn summary(label: &str, value: String) -> impl IntoElement {
        hover_card()
            .flex_1()
            .px(px(18.0))
            .py(px(16.0))
            .flex()
            .flex_col()
            .child(ui_text(11.0).pt(px(2.0)).mb(px(6.0)).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT_DIM)).child(spaced(&label.to_uppercase(), 1.1)))
            .child(div().font_family(MONO).text_size(px(24.0)).line_height(px(30.0)).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT)).child(value))
    }

    fn tab(&self, id: &'static str, label: &str, g: GroupBy, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let on = self.group_by == g;
        div()
            .id(id)
            .flex_1()
            .flex()
            .justify_center()
            .px(px(12.0))
            .py(px(8.0))
            .mb(px(-1.0))
            .border_b_2()
            .border_color(col(if on { TN_BLUE } else { crate::css::TRANSPARENT }))
            .text_color(col(if on { TN_BLUE } else { TN_TEXT_DIM }))
            .font_family(BTN_FONT)
            .cursor_pointer()
            .on_click(move |_, _, a| me.update(a, |p, cx| p.set_group(g, cx)))
            .child(div().text_size(px(13.0)).line_height(px(15.0)).child(spaced(label, 0.39)))
    }

    fn day_chart(&mut self, days: &[DayBar]) -> Div {
        let max = days.iter().map(|d| d.seconds).max().unwrap_or(0).max(1) as f32;
        let mut chart = div().flex().flex_row().gap(px(3.0)).h(px(180.0));
        for d in days {
            let frac = d.seconds as f32 / max;
            let has = d.seconds > 0;
            let duration = if has { format_duration_dash(d.seconds) } else { String::new() };
            let fill = self.grow(&format!("d:{}", d.date), frac, move |f| {
                let mut b = div().absolute().bottom_0().left(relative(0.15)).right(relative(0.15)).h(relative(f)).rounded_t(px(2.0));
                if has {
                    b = b.bg(col(TN_BLUE));
                }
                b
            });
            chart = chart.child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .items_center()
                    .child(
                        ui_text(10.0)
                            .h(px(16.0))
                            .line_height(px(16.0))
                            .w_full()
                            .flex()
                            .justify_center()
                            .whitespace_nowrap()
                            .text_color(col(TN_TEXT_DIM))
                            .child(duration.clone()),
                    )
                    .child(div().flex_1().w_full().relative().border_b_1().border_color(col(crate::css::hex(0x1e2030))).child(fill))
                    .child(
                        ui_text(10.0)
                            .h(px(22.0))
                            .line_height(px(22.0))
                            .w_full()
                            .flex()
                            .justify_center()
                            .whitespace_nowrap()
                            .font_weight(FontWeight(600.0))
                            .text_color(col(TN_TEXT_DIM))
                            .child(spaced(&d.label, 0.4)),
                    ),
            );
        }
        chart
    }

    fn bar_rows(&mut self, prefix: &str, rows: &[HBar]) -> Div {
        let mut list = div().flex().flex_col().gap(px(12.0));
        for r in rows {
            let frac = r.pct as f32 / 100.0;
            let color = parse_color(&r.color);
            let fill = self.grow(&format!("{prefix}:{}", r.key), frac, move |f| div().h_full().w(relative(f)).min_w(px(2.0)).rounded(px(3.0)).bg(col(color)));
            list = list.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.0))
                    .child(ui_text(13.0).w(px(96.0)).flex_shrink_0().truncate().text_color(col(TN_TEXT_DIM)).child(r.name.clone()))
                    .child(div().flex_1().h(px(6.0)).rounded(px(3.0)).overflow_hidden().bg(col(rgba_c(30, 32, 48, 0.7))).child(fill))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(8.0))
                            .flex_shrink_0()
                            .child(ui_text(12.0).w(px(36.0)).flex().justify_end().text_color(col(TN_TEXT_DIM)).child(format!("{}%", r.pct)))
                            .child(div().font_family(MONO).text_size(px(12.0)).line_height(px(16.0)).w(px(60.0)).flex().justify_end().text_color(col(TN_TEXT_DIM)).child(format_duration_dash(r.seconds))),
                    ),
            );
        }
        list
    }
}

fn rgba_c(r: u8, g: u8, b: u8, a: f32) -> crate::css::C {
    rgba(r, g, b, a)
}

impl Render for StatsPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let stats: Stats = compute(&self.sessions, self.range, chrono::Local::now());
        let mut body = div().flex().flex_col().child(page_heading("Stats").mt(px(8.7)).mb(px(16.0)));
        let mut chips = div().flex().flex_row().gap(px(4.0)).mb(px(20.0));
        for r in Range::ALL {
            chips = chips.child(self.range_chip(r, cx));
        }
        body = body.child(chips);

        if self.loading {
            body = body.child(state_message("Loading\u{2026}", TN_TEXT_DIM, false));
        } else if stats.empty {
            body = body.child(state_message("No sessions in this period.", TN_TEXT_DIM, false));
        } else {
            body = body.child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(10.0))
                    .mb(px(20.0))
                    .child(Self::summary("Work Time", format_duration_dash(stats.work_seconds)))
                    .child(Self::summary("Sessions", stats.work_sessions.to_string()))
                    .child(Self::summary("Total Time", format_duration_dash(stats.total_seconds))),
            );
            body = body.child(
                div()
                    .flex()
                    .flex_row()
                    .border_b_1()
                    .border_color(col(crate::css::hex(0x1e2030)))
                    .mb(px(20.0))
                    .child(self.tab("tab-date", "By Date", GroupBy::Date, cx))
                    .child(self.tab("tab-tag", "By Tag", GroupBy::Tag, cx))
                    .child(self.tab("tab-type", "By Type", GroupBy::Type, cx)),
            );
            let (title, content) = match self.group_by {
                GroupBy::Date => ("Work Focus by Day", self.day_chart(&stats.days).into_any_element()),
                GroupBy::Tag if stats.tags.is_empty() => ("Work Time by Tag", state_message("No work sessions with tags.", TN_TEXT_DIM, false).into_any_element()),
                GroupBy::Tag => ("Work Time by Tag", self.bar_rows("t", &stats.tags).into_any_element()),
                GroupBy::Type => ("Time by Work Type", self.bar_rows("y", &stats.types).into_any_element()),
            };
            // The section's 4px top margin collapses into the tab row's 20px bottom margin.
            body = body.child(div().flex().flex_col().child(section_heading(title).mb(px(14.0))).child(content));
        }
        page_shell("stats-page", 600.0, body)
    }
}
