//! Issues page (`IssuesPage.tsx`, `ProviderTabs.tsx`): browse GitHub, Linear and Jira issues, open
//! a card for its comments. The provider calls go through `Services` (phase 8 fills them in); with
//! no provider configured the page shows its call to open Settings.

use super::issues_logic::*;
use super::todos_logic::*;
use super::PageEvent;
use crate::controls::{card_glass, field_style, glass_field, page_heading, page_shell, parse_color};
use crate::css::{hex, linear, rgba, Spec, C, TRANSPARENT};
use crate::fmt::{format_date, format_local_time};
use crate::ui::*;
use gpui::*;
use lizmeter_core::{IssueComment, IssueProviderStatus, IssuesListInput};
use lizmeter_services::Services;
use lizmeter_ui::text_input::{TextField, TextFieldEvent, TextInput};
use std::sync::Arc;

/// One provider's list: nothing asked yet, in flight, failed, or here.
#[derive(Clone)]
enum Load {
    Idle,
    Loading,
    Failed(String),
    Ready(Vec<Card>),
}

#[derive(Clone)]
enum CommentState {
    Loading,
    Failed(String),
    Ready(Vec<IssueComment>),
}

pub struct IssuesPage {
    svc: Arc<Services>,
    status: IssueProviderStatus,
    tab: Tab,
    github: Load,
    linear: Load,
    jira: Load,
    search: Entity<TextField>,
    query: String,
    /// The open card and what its comments fetch came back with.
    expanded: Option<(String, CommentState)>,
    generation: u64,
    /// Capture hooks fill the lists with fixtures; a reload then keeps them.
    fixture: bool,
    focus: FocusHandle,
}

impl EventEmitter<PageEvent> for IssuesPage {}

impl IssuesPage {
    pub fn new(svc: Arc<Services>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = TextInput::new(field_style(13.0), "Search issues\u{2026}", window, cx);
        cx.subscribe(&search, |this, s, ev: &TextFieldEvent, cx| {
            if let TextFieldEvent::Changed = ev {
                this.query = s.read(cx).text().to_string();
                cx.notify();
            }
        })
        .detach();
        let none = IssueProviderStatus { configured: false, provider: None, linear_configured: false, linear_team_selected: false, jira_configured: false, jira_domain_set: false };
        Self { svc, status: none, tab: Tab::Github, github: Load::Idle, linear: Load::Idle, jira: Load::Idle, search, query: String::new(), expanded: None, generation: 0, fixture: false, focus: cx.focus_handle() }
    }

    /// The page opens: read which providers are configured and load the tab in view.
    pub fn show(&mut self, cx: &mut Context<Self>) {
        if self.fixture {
            return;
        }
        self.status = self.svc.issue_provider_status().unwrap_or(self.status.clone());
        self.github = Load::Idle;
        self.linear = Load::Idle;
        self.jira = Load::Idle;
        self.expanded = None;
        self.load_current(false, cx);
        cx.notify();
    }

    fn current(&self) -> Option<Tab> {
        effective_tab(&available_tabs(&self.status), self.tab)
    }

    fn slot(&mut self, tab: Tab) -> &mut Load {
        match tab {
            Tab::Github => &mut self.github,
            Tab::Linear => &mut self.linear,
            Tab::Jira => &mut self.jira,
        }
    }

    fn load_current(&mut self, force: bool, cx: &mut Context<Self>) {
        let Some(tab) = self.current() else { return };
        if !force && !matches!(self.slot(tab), Load::Idle) {
            return;
        }
        *self.slot(tab) = Load::Loading;
        let svc = self.svc.clone();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { fetch(&svc, tab, force) }).await;
            let _ = this.update(cx, |p, cx| {
                *p.slot(tab) = match result {
                    Ok(cards) => Load::Ready(cards),
                    Err(e) => Load::Failed(e),
                };
                cx.notify();
            });
        })
        .detach();
    }

    fn switch_tab(&mut self, tab: Tab, cx: &mut Context<Self>) {
        self.tab = tab;
        self.query.clear();
        self.search.update(cx, |s, cx| s.set_text("", cx));
        self.expanded = None;
        self.load_current(false, cx);
        cx.notify();
    }

    /// A click on a card: close it when open, else open it and fetch its comments.
    fn toggle_card(&mut self, card: &Card, cx: &mut Context<Self>) {
        if self.expanded.as_ref().is_some_and(|(id, _)| *id == card.id) {
            self.expanded = None;
            cx.notify();
            return;
        }
        self.expanded = Some((card.id.clone(), CommentState::Loading));
        self.generation += 1;
        let (generation, id, of, svc) = (self.generation, card.id.clone(), card.comments.clone(), self.svc.clone());
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { fetch_comments(&svc, &of) }).await;
            let _ = this.update(cx, |p, cx| {
                if p.generation == generation {
                    p.expanded = Some((id, match result {
                        Ok(list) => CommentState::Ready(list),
                        Err(e) => CommentState::Failed(e),
                    }));
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    // ---- Capture hooks ----

    /// `fixture:<provider>:<state>`: the page as it looks once that provider answers. The data is made
    /// up here (no provider can be reached before phase 8) and only the capture hooks use it.
    pub fn capture(&mut self, op: &str, cx: &mut Context<Self>) {
        let parts: Vec<&str> = op.split(':').collect();
        match parts.as_slice() {
            ["fixture", provider, state] => {
                let tab = match *provider {
                    "linear" => Tab::Linear,
                    "jira" => Tab::Jira,
                    _ => Tab::Github,
                };
                self.fixture = true;
                self.status = IssueProviderStatus {
                    configured: true,
                    provider: Some("github".into()),
                    linear_configured: true,
                    linear_team_selected: true,
                    jira_configured: true,
                    jira_domain_set: true,
                };
                self.tab = tab;
                let cards = fixture_cards(tab);
                *self.slot(tab) = match *state {
                    "loading" => Load::Loading,
                    "error" => Load::Failed("Request failed: 401 Unauthorized".into()),
                    "empty" => Load::Ready(vec![]),
                    _ => Load::Ready(cards.clone()),
                };
                self.expanded = match *state {
                    "open" => cards.first().map(|c| (c.id.clone(), CommentState::Ready(fixture_comments()))),
                    "open-empty" => cards.first().map(|c| (c.id.clone(), CommentState::Ready(vec![]))),
                    "open-error" => cards.first().map(|c| (c.id.clone(), CommentState::Failed("Failed to load comments".into()))),
                    "open-loading" => cards.first().map(|c| (c.id.clone(), CommentState::Loading)),
                    _ => None,
                };
                if *state == "nomatch" {
                    self.query = "zzz".into();
                    self.search.update(cx, |s, cx| s.set_text("zzz", cx));
                }
            }
            ["tab", name] => {
                self.tab = match *name {
                    "linear" => Tab::Linear,
                    "jira" => Tab::Jira,
                    _ => Tab::Github,
                };
            }
            _ => {}
        }
        cx.notify();
    }

    // ---- Elements ----

    fn heading(&self) -> Div {
        page_heading("Issues").mt(px(8.7))
    }

    fn not_configured(&self, cx: &mut Context<Self>) -> Div {
        let me = cx.entity();
        div()
            .flex()
            .flex_col()
            .child(self.heading().mb(px(8.7)))
            .child(
                div()
                    .py(px(48.0))
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(8.0))
                    .text_center()
                    .child(div().h(px(45.2)).child(svg().path("gen/issues-empty.svg").w(px(32.0)).h(px(32.0)).text_color(col(hex(0x7a8194)))))
                    .child(ui_text(14.0).line_height(px(17.0)).font_weight(FontWeight(500.0)).text_color(col(TN_TEXT)).child("No issue tracker configured"))
                    .child(ui_text(12.0).line_height(px(14.8)).text_color(col(TN_TEXT_DIM)).child("Connect GitHub, Linear, or Jira in Settings to browse and link issues to sessions."))
                    .child(
                        div()
                            .id("issues-cta")
                            .mt(px(11.0))
                            .px(px(18.0))
                            .py(px(7.0))
                            .rounded(px(6.0))
                            .bg(col(TN_BLUE))
                            .hover(|s| s.bg(col(hex(0x89b4fa))))
                            .cursor_pointer()
                            .font_family(BTN_FONT)
                            .text_size(px(12.0))
                            .line_height(px(14.0))
                            .font_weight(FontWeight(700.0))
                            .text_color(col(hex(0x1a1b26)))
                            .on_click(move |_, _, app| me.update(app, |_, cx| cx.emit(PageEvent::OpenSettings)))
                            .child("Configure in Settings"),
                    ),
            )
    }

    fn tabs(&self, available: &[Tab], active: Tab, cx: &mut Context<Self>) -> Div {
        let mut row = div().flex().flex_row().mb(px(16.0)).relative().child(layer(Spec::rrect(0.0).border_sides(0.0, 0.0, 1.0, 0.0, hex_a(0x292e42))));
        for tab in available {
            let (me, tab, on) = (cx.entity(), *tab, *tab == active);
            let mut b = div()
                .id(SharedString::from(format!("issues-tab-{}", tab.label())))
                .px(px(16.0))
                .py(px(7.0))
                .border_b_2()
                .border_color(col(if on { TN_BLUE } else { TRANSPARENT }))
                .text_size(px(12.0))
                .line_height(px(15.0))
                .font_weight(FontWeight(600.0))
                .text_color(col(if on { TN_BLUE } else { TN_TEXT_DIM }))
                .cursor_pointer()
                .on_click(move |_, _, app| me.update(app, |p, cx| p.switch_tab(tab, cx)))
                .child(spaced(tab.label(), 0.36));
            b = b.font_family(BTN_FONT);
            row = row.child(b);
        }
        row
    }

    fn refresh_button(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let me = cx.entity();
        div()
            .id("issues-refresh")
            .flex_shrink_0()
            .px(px(10.0))
            .py(px(5.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(5.0))
            .rounded(px(6.0))
            .border(px(1.0))
            .border_color(col(hex(0x292e42)))
            .text_color(col(TN_TEXT_DIM))
            .font_family(BTN_FONT)
            .text_size(px(12.0))
            .line_height(px(14.0))
            .cursor_pointer()
            .hover(|s| s.border_color(col(hex(0x3b4261))))
            .on_click(move |_, _, app| {
                me.update(app, |p, cx| {
                    if !p.fixture {
                        p.expanded = None;
                        p.load_current(true, cx);
                    }
                    cx.notify();
                })
            })
            .child(svg().path("gen/refresh.svg").w(px(14.0)).h(px(14.0)).text_color(col(TN_TEXT_DIM)))
            .child("Refresh")
    }

    fn badge(text: &str, color: C) -> Div {
        div()
            .flex_shrink_0()
            .px(px(8.0))
            .py(px(2.0))
            .rounded(px(4.0))
            .border(px(1.0))
            .border_color(col(c_alpha(color, 0.25)))
            .bg(col(c_alpha(color, 0.094)))
            .text_color(col(color))
            .text_size(px(11.0))
            .line_height(px(14.0))
            .font_weight(FontWeight(600.0))
            .child(text.to_string())
    }

    fn comments(&self, state: &CommentState) -> Div {
        match state {
            CommentState::Loading => ui_text(12.0).py(px(8.0)).text_color(col(TN_TEXT_DIM)).child("Loading comments\u{2026}"),
            CommentState::Failed(e) => ui_text(12.0).py(px(8.0)).text_color(col(TN_RED)).child(e.clone()),
            CommentState::Ready(list) if list.is_empty() => ui_text(12.0).py(px(8.0)).italic().text_color(col(TN_TEXT_DIM)).child("No comments yet"),
            CommentState::Ready(list) => {
                let mut col_el = div().flex().flex_col().gap(px(10.0));
                for c in list {
                    col_el = col_el.child(
                        Glass::new(10.0, 8.0, 1.0, Spec::rrect(10.0).solid(rgba(12, 13, 24, 0.5)).border(1.0, rgba(41, 46, 66, 0.8)))
                            .el()
                            .px(px(12.0))
                            .py(px(10.0))
                            .flex()
                            .flex_col()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(8.0))
                                    .child(div().text_size(px(12.0)).line_height(px(16.0)).font_weight(FontWeight(600.0)).text_color(col(TN_BLUE)).child(c.author.clone()))
                                    .child(div().flex_1())
                                    .child(div().text_size(px(11.0)).text_color(col(TN_TEXT_DIM)).child(format!("{} {}", format_date(&c.created_at), format_local_time(&c.created_at)))),
                            )
                            .child(ui_text(13.0).line_height(px(19.5)).text_color(col(TN_TEXT)).child(c.body.clone())),
                    );
                }
                col_el.max_h(px(320.0))
            }
        }
    }

    fn card_el(&self, card: &Card, cx: &mut Context<Self>) -> Stateful<Div> {
        let open = self.expanded.as_ref().filter(|(id, _)| *id == card.id).map(|(_, s)| s.clone());
        let (me, picked) = (cx.entity(), card.clone());
        let state_color = match card.state_kind {
            StateKind::Started => TN_BLUE,
            _ => TN_TEXT_DIM,
        };
        let mut top = div().flex().flex_row().items_center().gap(px(10.0)).mb(px(8.0)).child(div().text_size(px(13.0)).line_height(px(17.0)).font_weight(FontWeight(700.0)).text_color(col(TN_BLUE)).child(card.number.clone()));
        top = top.child(div().flex_1()).child(Self::badge(&card.state, state_color));

        let spec = if open.is_some() {
            Spec::rrect(14.0)
                .fill(linear(135.0, &[(0.0, wh(0.05)), (0.3, wh(0.01)), (0.55, TRANSPARENT)]))
                .solid(rgba(20, 22, 44, 0.6))
                .border(1.0, rgba(122, 162, 247, 0.2))
                .inset(0.0, 1.0, wh(0.04))
        } else {
            return self.collapsed_card(card, top, me, picked);
        };
        let mut body = Glass::new(14.0, 24.0, 1.5, spec).shadows(&[sh(0.0, 6.0, 24.0, bk(0.3))]).el().id(SharedString::from(format!("issue-{}", card.id))).px(px(18.0)).py(px(16.0)).cursor_pointer().child(top);
        body = self.card_body(body, card);
        let url = card.url.clone();
        let svc = self.svc.clone();
        let state = open.unwrap_or(CommentState::Loading);
        body.on_click(move |_, _, app| me.update(app, |p, cx| p.toggle_card(&picked, cx)))
            .child(
                div()
                    .id(SharedString::from(format!("issue-x-{}", card.id)))
                    .on_click(|_, _, app| app.stop_propagation())
                    .mt(px(14.0))
                    .pt(px(14.0))
                    .relative()
                    .child(layer(Spec::rrect(0.0).border_sides(1.0, 0.0, 0.0, 0.0, hex_a(0x292e42))))
                    .child(
                        div().mb(px(12.0)).flex().flex_row().child(
                            div()
                                .id(SharedString::from(format!("issue-open-{}", card.id)))
                                .px(px(12.0))
                                .py(px(4.0))
                                .rounded(px(5.0))
                                .border(px(1.0))
                                .border_color(col(hex(0x292e42)))
                                .text_color(col(TN_BLUE))
                                .font_family(BTN_FONT)
                                .text_size(px(11.0))
                                .line_height(px(13.0))
                                .font_weight(FontWeight(600.0))
                                .cursor_pointer()
                                .hover(|s| s.bg(col(rgba(122, 162, 247, 0.063))).border_color(col(rgba(122, 162, 247, 0.25))))
                                .on_click(move |_, _, app| svc.open_external(&url))
                                .child("Open in browser"),
                        ),
                    )
                    .child(self.comments(&state)),
            )
    }

    fn collapsed_card(&self, card: &Card, top: Div, me: Entity<Self>, picked: Card) -> Stateful<Div> {
        let mut body = card_glass(false).el().id(SharedString::from(format!("issue-{}", card.id))).px(px(18.0)).py(px(16.0)).cursor_pointer().child(top);
        body = self.card_body(body, card);
        body.child(div().absolute().top_0().left_0().size_full().rounded(px(14.0)).border(px(1.0)).border_color(col(TRANSPARENT)).hover(|s| s.border_color(col(rgba(122, 162, 247, 0.2)))))
            .on_click(move |_, _, app| me.update(app, |p, cx| p.toggle_card(&picked, cx)))
    }

    /// Title, repo, priority and label chips: the part of a card that does not change when it opens.
    fn card_body(&self, mut body: Stateful<Div>, card: &Card) -> Stateful<Div> {
        let mut inner = div().flex().flex_col();
        if let Some(repo) = &card.repo {
            inner = inner.child(
                div().mb(px(8.0)).flex().flex_row().child(
                    div().px(px(8.0)).py(px(2.0)).rounded(px(4.0)).bg(col(hex(0x292e42))).text_color(col(TN_TEXT_DIM)).text_size(px(12.0)).line_height(px(16.0)).font_weight(FontWeight(500.0)).child(repo.clone()),
                ),
            );
        }
        let has_chips = card.priority.is_some() || card.assignee.is_some() || !card.labels.is_empty();
        inner = inner.child(ui_text(15.0).mb(px(if has_chips { 10.0 } else { 10.0 })).line_height(px(22.5)).font_weight(FontWeight(500.0)).text_color(col(TN_TEXT)).child(card.title.clone()));
        let mut chips = div().flex().flex_row().flex_wrap().gap(px(6.0));
        if let Some((label, level)) = &card.priority {
            chips = chips.child(Self::badge(label, priority_color(*level)));
        }
        if let Some(a) = &card.assignee {
            chips = chips.child(chip_pill(a, TN_BLUE));
        }
        for (name, color) in &card.labels {
            chips = chips.child(chip_pill(name, parse_color(&format!("#{color}"))));
        }
        if has_chips {
            inner = inner.child(chips);
        }
        body = body.child(inner);
        body
    }

    fn list(&self, tab: Tab, window: &Window, cx: &mut Context<Self>) -> Div {
        let load = match tab {
            Tab::Github => &self.github,
            Tab::Linear => &self.linear,
            Tab::Jira => &self.jira,
        };
        let message = |text: &str| ui_text(13.0).py(px(24.0)).flex().justify_center().text_color(col(TN_TEXT_DIM)).child(text.to_string());
        match load {
            Load::Idle | Load::Loading => message("Loading issues\u{2026}"),
            Load::Failed(e) => {
                let me = cx.entity();
                div().py(px(24.0)).flex().flex_col().items_center().child(ui_text(13.0).mb(px(12.0)).text_color(col(TN_RED)).child(e.clone())).child(
                    div()
                        .id("issues-retry")
                        .px(px(16.0))
                        .py(px(6.0))
                        .rounded(px(6.0))
                        .border(px(1.0))
                        .border_color(col(rgba(247, 118, 142, 0.25)))
                        .bg(col(rgba(247, 118, 142, 0.063)))
                        .text_color(col(TN_RED))
                        .font_family(BTN_FONT)
                        .text_size(px(12.0))
                        .line_height(px(14.0))
                        .cursor_pointer()
                        .hover(|s| s.bg(col(rgba(247, 118, 142, 0.125))))
                        .on_click(move |_, _, app| me.update(app, |p, cx| p.load_current(true, cx)))
                        .child("Retry"),
                )
            }
            Load::Ready(cards) => {
                let shown = filter_cards(cards, &self.query);
                let mut out = div().flex().flex_col().child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.0))
                        .mb(px(14.0))
                        .child(div().flex_1().min_w_0().child(glass_field(&self.search, self.search.read(cx).focus_handle().is_focused(window), 10.0, 7.0)))
                        .child(self.refresh_button(cx)),
                );
                let empty = |title: String, desc: Option<&str>| {
                    let mut d = div().py(px(48.0)).flex().flex_col().items_center().gap(px(8.0)).text_center().child(ui_text(14.0).line_height(px(21.0)).font_weight(FontWeight(500.0)).text_color(col(TN_TEXT)).child(title));
                    if let Some(desc) = desc {
                        d = d.child(ui_text(12.0).line_height(px(18.0)).text_color(col(TN_TEXT_DIM)).child(desc.to_string()));
                    }
                    d
                };
                if cards.is_empty() {
                    let (title, desc) = empty_text(tab);
                    out = out.child(empty(title.to_string(), Some(desc)));
                } else if shown.is_empty() {
                    out = out.child(empty(format!("No issues match \"{}\"", self.query), None));
                } else {
                    let mut list = div().flex().flex_col().gap(px(10.0));
                    for c in shown {
                        list = list.child(self.card_el(c, cx));
                    }
                    out = out.child(list);
                }
                out
            }
        }
    }
}

fn hex_a(v: u32) -> C {
    hex(v)
}

fn chip_pill(text: &str, color: C) -> Div {
    div()
        .px(px(10.0))
        .py(px(2.0))
        .rounded(px(10.0))
        .border(px(1.0))
        .border_color(col(c_alpha(color, 0.25)))
        .bg(col(c_alpha(color, 0.094)))
        .text_color(col(color))
        .text_size(px(11.0))
        .line_height(px(14.0))
        .font_weight(FontWeight(600.0))
        .child(text.to_string())
}

fn priority_color(level: i64) -> C {
    match level {
        1 => hex(0xf7768e),
        2 => hex(0xff9e64),
        3 => hex(0xe0af68),
        4 => hex(0xa9b1d6),
        _ => hex(0xe0af68),
    }
}

/// The provider call for one tab, as plain text errors.
fn fetch(svc: &Services, tab: Tab, force: bool) -> Result<Vec<Card>, String> {
    match tab {
        Tab::Github => svc.github_issues(&IssuesListInput { repo: None, force_refresh: Some(force) }).map(|v| v.iter().map(github_card).collect()),
        Tab::Linear => svc.linear_issues(force).map(|v| v.iter().map(linear_card).collect()),
        Tab::Jira => svc.jira_issues(force).map(|v| v.iter().map(jira_card).collect()),
    }
    .map_err(|e| e.to_string())
}

fn fetch_comments(svc: &Services, of: &CommentsOf) -> Result<Vec<IssueComment>, String> {
    match of {
        CommentsOf::Github { repo, number } => svc.github_comments(repo, *number),
        CommentsOf::Linear { id } => svc.linear_comments(id),
        CommentsOf::Jira { key } => svc.jira_comments(key),
    }
    .map_err(|e| e.to_string())
}

/// Made-up issues for the capture hooks.
fn fixture_cards(tab: Tab) -> Vec<Card> {
    use lizmeter_core::{Issue, IssueLabel, JiraIssue, LinearIssue, LinearIssueState};
    match tab {
        Tab::Github => vec![
            Issue { number: 128, title: "Timer drifts after resuming from sleep".into(), url: "https://github.com/lizard/lizmeter/issues/128".into(), repo: "lizard/lizmeter".into(), state: "open".into(), labels: vec![IssueLabel { name: "bug".into(), color: "d73a4a".into() }, IssueLabel { name: "timer".into(), color: "7aa2f7".into() }], updated_at: String::new() },
            Issue { number: 97, title: "Add a weekly summary to the Stats page".into(), url: "https://github.com/lizard/lizmeter/issues/97".into(), repo: "lizard/lizmeter".into(), state: "closed".into(), labels: vec![], updated_at: String::new() },
        ]
        .iter()
        .map(github_card)
        .collect(),
        Tab::Linear => vec![
            LinearIssue { id: "a".into(), identifier: "LIZ-14".into(), title: "Sync the oplog on resume".into(), url: "https://linear.app/x".into(), priority: 2, state: LinearIssueState { name: "In Progress".into(), kind: "started".into() }, updated_at: String::new() },
            LinearIssue { id: "b".into(), identifier: "LIZ-21".into(), title: "Widget avatar slots".into(), url: "https://linear.app/y".into(), priority: 0, state: LinearIssueState { name: "Backlog".into(), kind: "backlog".into() }, updated_at: String::new() },
            LinearIssue { id: "c".into(), identifier: "LIZ-22".into(), title: "Installer swap step".into(), url: "https://linear.app/z".into(), priority: 1, state: LinearIssueState { name: "Todo".into(), kind: "unstarted".into() }, updated_at: String::new() },
        ]
        .iter()
        .map(linear_card)
        .collect(),
        Tab::Jira => vec![JiraIssue { id: "1".into(), key: "PROJ-12".into(), title: "Wire the worklog dialog".into(), url: "https://example.atlassian.net/browse/PROJ-12".into(), status: "In Progress".into(), priority: Some("High".into()), assignee: Some("Liz".into()), issue_type: None, labels: vec![] }].iter().map(jira_card).collect(),
    }
}

fn fixture_comments() -> Vec<IssueComment> {
    vec![
        IssueComment { id: "1".into(), author: "lizard".into(), body: "Reproduced on Windows 11. The wall-clock tick skips the sleep gap.".into(), created_at: "2026-11-09T07:25:00.000Z".into() },
        IssueComment { id: "2".into(), author: "reviewer".into(), body: "Fixed in the next build.\nPlease re-check after updating.".into(), created_at: "2026-11-10T02:10:00.000Z".into() },
    ]
}

impl Render for IssuesPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body = match self.current() {
            None => self.not_configured(cx),
            Some(tab) => {
                let available = available_tabs(&self.status);
                let mut page = div().flex().flex_col().child(self.heading().mb(px(28.7)));
                if available.len() > 1 {
                    page = page.child(self.tabs(&available, tab, cx));
                }
                page.child(self.list(tab, window, cx))
            }
        };
        page_shell("issues-page", 600.0, body)
    }
}
