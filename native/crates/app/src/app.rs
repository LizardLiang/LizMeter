//! The main window view: titlebar, root background, sidebar, and the pages.

use crate::chrome::{self, NAV_ITEMS, NavButton};
use crate::claude_flow::{self, ClaudeState};
use crate::claude_ui::ClaudeSessionSelect;
use crate::engine::{Countdown, Status, Stopwatch};
use crate::modal::IssuePrompt;
use crate::pages::activity::ActivityPage;
use crate::pages::claude::ClaudePage;
use crate::pages::history::HistoryPage;
use crate::pages::settings::SettingsPage;
use crate::pages::stats::StatsPage;
use crate::pages::tags::TagsPage;
use crate::tag_picker::TagPicker;
use crate::ui::*;
use crate::gallery;
use gpui::*;
use lizmeter_core::{IssueRef, StopwatchSettings, Tag};
use lizmeter_services::Services;
use lizmeter_ui::md_editor::{MarkdownEditor, MdEvent, MdMode, MdVariant};
use lizmeter_ui::rich_input::{RichEvent, RichInput, RichMode};
use lizmeter_ui::text_input::TextField;
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Page {
    Timer,
    History,
    Stats,
    Tags,
    Settings,
    Claude,
    Activity,
    Gallery,
    Anim(usize),
    TextSample,
    EmojiSample,
    /// Markdown notes editor: framed, bare or the expanded modal.
    Notes(MdVariant),
    Other(usize),
}

/// What a picked issue is for.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PromptPurpose {
    /// The stopwatch's Start button: a pick or a skip starts the stopwatch.
    StopwatchStart,
    /// A "Link issue" button: a pick links the issue to the timer or the stopwatch.
    LinkTimer,
    LinkStopwatch,
}

/// The click-to-edit minutes and seconds fields of the countdown.
pub struct TimeEdit {
    pub mins: Entity<TextField>,
    pub secs: Entity<TextField>,
    pub subs: Vec<Subscription>,
}

pub struct Root {
    pub svc: Arc<Services>,
    pub page: Page,
    pub pomodoro: bool,
    pub countdown: Countdown,
    pub stopwatch: Stopwatch,
    /// The second counts the screen last showed; a tick repaints only when they change.
    pub shown_cd: i64,
    pub shown_sw: i64,
    /// Bumped by every tick loop start: an older loop sees a newer number and exits.
    pub tick_gen: u64,
    pub sw_settings: StopwatchSettings,
    pub sound_enabled: bool,
    pub hover_nav: Option<usize>,
    pub ever_hovered: HashSet<usize>,
    pub rich: Entity<RichInput>,
    pub sw_rich: Entity<RichInput>,
    pub title_html: String,
    pub sw_title_html: String,
    pub rich_modal: Option<(Entity<RichInput>, bool)>,
    pub notes: Entity<MarkdownEditor>,
    pub notes_modal: Option<Entity<MarkdownEditor>>,
    pub notes_image_base: Option<std::path::PathBuf>,
    pub pending_issue: Option<IssueRef>,
    pub sw_issue: Option<IssueRef>,
    pub pending_tags: Vec<i64>,
    pub all_tags: Vec<Tag>,
    pub tag_picker: Entity<TagPicker>,
    pub save_error: Option<String>,
    pub sw_save_error: Option<String>,
    pub prompt: Option<(Entity<IssuePrompt>, PromptPurpose)>,
    pub edit: Option<TimeEdit>,
    pub history: Entity<HistoryPage>,
    pub stats: Entity<StatsPage>,
    pub tags_page: Entity<TagsPage>,
    pub settings: Entity<SettingsPage>,
    pub cc: ClaudeState,
    pub cc_select_timer: Entity<ClaudeSessionSelect>,
    pub cc_select_sw: Entity<ClaudeSessionSelect>,
    pub activity: Entity<ActivityPage>,
    pub claude_page: Entity<ClaudePage>,
    /// A session was saved while History was not refreshed; the next History render reloads.
    pub history_stale: bool,
}

impl Root {
    pub fn new(svc: Arc<Services>, page: Page, pomodoro: bool, hover_nav: Option<usize>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let settings = svc.get_settings().unwrap_or(lizmeter_core::DEFAULT_SETTINGS);
        let sound_enabled = svc.get_setting_value("notification_sound_enabled").ok().flatten().as_deref() != Some("false");
        let placeholder = "Describe what you\u{2019}ll be working on\u{2026}";
        let rich = cx.new(|cx| RichInput::new("", placeholder, RichMode::Inline, window, cx));
        cx.subscribe_in(&rich, window, |this, _, ev, window, cx| this.on_rich_event(false, ev, window, cx)).detach();
        let sw_rich = cx.new(|cx| RichInput::new("", placeholder, RichMode::Inline, window, cx));
        cx.subscribe_in(&sw_rich, window, |this, _, ev, window, cx| this.on_rich_event(true, ev, window, cx)).detach();

        let variant = match page {
            Page::Notes(v) => v,
            _ => MdVariant::Framed,
        };
        let notes = cx.new(|cx| {
            let mut e = MarkdownEditor::new("", "Add notes\u{2026}", variant, MdMode::Inline, window, cx);
            e.set_expandable(true, cx);
            e.set_image_resolver(image_resolver(&svc));
            e
        });
        cx.subscribe_in(&notes, window, Self::on_notes_event).detach();

        let tag_picker = cx.new(|cx| TagPicker::new("session-tags", window, cx));
        cx.subscribe(&tag_picker, Self::on_tag_event).detach();

        let history = cx.new(|_| HistoryPage::new(svc.clone()));
        cx.subscribe_in(&history, window, Self::on_page_event::<HistoryPage>).detach();

        let stats = cx.new(|_| StatsPage::new(svc.clone()));
        let tags_page = cx.new(|cx| TagsPage::new(svc.clone(), window, cx));
        cx.subscribe_in(&tags_page, window, Self::on_page_event::<TagsPage>).detach();
        let settings_page = cx.new(|cx| SettingsPage::new(svc.clone(), window, cx));
        cx.subscribe_in(&settings_page, window, Self::on_page_event::<SettingsPage>).detach();

        let activity = cx.new(|_| ActivityPage::new(svc.clone()));
        let claude_page = cx.new(|_| ClaudePage::new(svc.clone()));

        let idle = claude_flow::idle_minutes_from(svc.get_setting_value("claude_tracker.idle_threshold_minutes").ok().flatten().as_deref());
        let cc_select_timer = cx.new(|_| ClaudeSessionSelect::new(svc.clone(), "cc-timer"));
        cx.subscribe(&cc_select_timer, |this, _, ev, cx| this.on_claude_select(false, ev, cx)).detach();
        let cc_select_sw = cx.new(|_| ClaudeSessionSelect::new(svc.clone(), "cc-sw"));
        cx.subscribe(&cc_select_sw, |this, _, ev, cx| this.on_claude_select(true, ev, cx)).detach();

        let mut root = Self {
            svc,
            page,
            pomodoro,
            countdown: Countdown::new(settings),
            stopwatch: Stopwatch::new(),
            shown_cd: settings.work_duration,
            shown_sw: 0,
            tick_gen: 0,
            sw_settings: StopwatchSettings { max_duration_seconds: 28800, prompt_for_issue: true },
            sound_enabled,
            hover_nav,
            ever_hovered: hover_nav.into_iter().collect(),
            rich,
            sw_rich,
            title_html: String::new(),
            sw_title_html: String::new(),
            rich_modal: None,
            notes,
            notes_modal: None,
            notes_image_base: None,
            pending_issue: None,
            sw_issue: None,
            pending_tags: vec![],
            all_tags: vec![],
            tag_picker,
            save_error: None,
            sw_save_error: None,
            prompt: None,
            edit: None,
            history,
            stats,
            tags_page,
            settings: settings_page,
            cc: ClaudeState::new(idle),
            cc_select_timer,
            cc_select_sw,
            activity,
            claude_page,
            history_stale: false,
        };
        root.reload_tags(cx);
        if page == Page::History {
            root.show_history(window, cx);
        }
        if page == Page::Stats {
            root.show_stats(cx);
        }
        if page == Page::Tags {
            root.show_tags(cx);
        }
        if page == Page::Settings {
            root.show_settings(cx);
        }
        if page == Page::Activity {
            root.show_activity(cx);
        }
        if page == Page::Claude {
            root.show_claude(cx);
        }
        root
    }

    fn on_rich_event(&mut self, stopwatch: bool, ev: &RichEvent, window: &mut Window, cx: &mut Context<Self>) {
        match ev {
            RichEvent::Expand => self.open_rich_modal(window, cx),
            RichEvent::ModalDone(html) => {
                let target = self.rich_modal.as_ref().map(|(_, sw)| *sw).unwrap_or(stopwatch);
                let editor = if target { self.sw_rich.clone() } else { self.rich.clone() };
                editor.update(cx, |r, cx| r.set_html(html, cx));
                self.set_title(target, html.clone());
                self.close_rich_modal(window, cx);
            }
            RichEvent::ModalCancel => self.close_rich_modal(window, cx),
            RichEvent::Changed(html) => {
                if self.rich_modal.is_none() {
                    self.set_title(stopwatch, html.clone());
                }
                cx.notify();
            }
        }
    }

    /// Sets a title from outside the editor (captures, restores).
    pub fn set_title_html(&mut self, stopwatch: bool, html: &str, cx: &mut Context<Self>) {
        let editor = if stopwatch { self.sw_rich.clone() } else { self.rich.clone() };
        editor.update(cx, |r, cx| r.set_html(html, cx));
        self.set_title(stopwatch, html.to_string());
    }

    pub fn set_title(&mut self, stopwatch: bool, html: String) {
        let html: String = html.chars().take(lizmeter_core::MAX_TITLE_LENGTH).collect();
        if stopwatch {
            self.sw_title_html = html;
        } else {
            self.title_html = html;
        }
    }

    fn on_notes_event(&mut self, _: &Entity<MarkdownEditor>, ev: &MdEvent, window: &mut Window, cx: &mut Context<Self>) {
        match ev {
            MdEvent::Expand => self.open_notes_modal(window, cx),
            MdEvent::ModalDone(text) => {
                self.notes.update(cx, |n, cx| n.set_text(text, cx));
                self.close_notes_modal(window, cx);
            }
            MdEvent::ModalCancel => self.close_notes_modal(window, cx),
            _ => {}
        }
    }

    pub fn open_notes_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.notes.read(cx).text().to_string();
        let base = self.notes_image_base.clone();
        let resolver = image_resolver(&self.svc);
        let modal = cx.new(|cx| {
            let mut e = MarkdownEditor::new(&text, "Add notes\u{2026}", MdVariant::Fill, MdMode::Modal, window, cx);
            e.set_image_resolver(resolver);
            if let Some(base) = base {
                e.set_image_base(base);
            }
            e
        });
        cx.subscribe_in(&modal, window, Self::on_notes_event).detach();
        let focus = modal.read(cx).focus_handle().clone();
        window.focus(&focus);
        self.notes_modal = Some(modal);
        cx.notify();
    }

    fn close_notes_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.notes_modal = None;
        let focus = self.notes.read(cx).focus_handle().clone();
        window.focus(&focus);
        cx.notify();
    }

    /// The notes editor that has focus (the modal copy while it is open).
    pub fn focused_notes(&self) -> &Entity<MarkdownEditor> {
        self.notes_modal.as_ref().unwrap_or(&self.notes)
    }

    /// The title editor the user is typing in (the modal copy while it is open).
    pub fn focused_rich(&self) -> &Entity<RichInput> {
        if let Some((m, _)) = &self.rich_modal {
            m
        } else if self.pomodoro {
            &self.rich
        } else {
            &self.sw_rich
        }
    }

    pub fn open_rich_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let stopwatch = !self.pomodoro;
        let html = if stopwatch { self.sw_rich.read(cx).html() } else { self.rich.read(cx).html() };
        let modal = cx.new(|cx| RichInput::new(&html, "Describe what you\u{2019}ll be working on\u{2026}", RichMode::Modal, window, cx));
        cx.subscribe_in(&modal, window, move |this, _, ev, window, cx| this.on_rich_event(stopwatch, ev, window, cx)).detach();
        let focus = modal.read(cx).focus_handle().clone();
        window.focus(&focus);
        self.rich_modal = Some((modal, stopwatch));
        cx.notify();
    }

    fn close_rich_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let stopwatch = self.rich_modal.take().map(|(_, sw)| sw).unwrap_or(!self.pomodoro);
        let focus = if stopwatch { self.sw_rich.read(cx).focus_handle().clone() } else { self.rich.read(cx).focus_handle().clone() };
        window.focus(&focus);
        cx.notify();
    }

    pub fn timer_active(&self) -> bool {
        matches!(self.countdown.status, Status::Running | Status::Paused)
    }

    pub fn stopwatch_active(&self) -> bool {
        matches!(self.stopwatch.status, Status::Running | Status::Paused)
    }

    pub fn show_history(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let active = self.countdown.status != Status::Idle || self.stopwatch_active();
        self.history.update(cx, |h, cx| {
            h.timer_active = active;
            h.refresh(window, cx);
        });
        self.page = Page::History;
        cx.notify();
    }

    pub fn show_stats(&mut self, cx: &mut Context<Self>) {
        self.stats.update(cx, |s, cx| s.refresh(cx));
        self.page = Page::Stats;
        cx.notify();
    }

    pub fn show_tags(&mut self, cx: &mut Context<Self>) {
        self.tags_page.update(cx, |t, cx| t.refresh(cx));
        self.page = Page::Tags;
        cx.notify();
    }

    pub fn show_settings(&mut self, cx: &mut Context<Self>) {
        let (sound, sw) = (self.sound_enabled, self.sw_settings);
        self.settings.update(cx, |s, cx| s.show(sound, sw, cx));
        self.page = Page::Settings;
        cx.notify();
    }

    pub fn show_activity(&mut self, cx: &mut Context<Self>) {
        self.activity.update(cx, |a, cx| a.show(cx));
        self.page = Page::Activity;
        cx.notify();
    }

    pub fn show_claude(&mut self, cx: &mut Context<Self>) {
        self.claude_page.update(cx, |c, cx| c.show(cx));
        self.page = Page::Claude;
        cx.notify();
    }

    fn sidebar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let mut col_el = chrome::sidebar_glass()
            .el()
            .w(px(64.0))
            .h_full()
            .flex_shrink_0()
            .flex()
            .flex_col()
            .items_center()
            .pt(px(20.0))
            .pb(px(16.0))
            .gap(px(4.0));
        let active_idx = match self.page {
            Page::Timer => Some(0),
            Page::History => Some(1),
            Page::Claude => Some(4),
            Page::Activity => Some(5),
            Page::Stats => Some(7),
            Page::Tags => Some(8),
            Page::Settings => Some(9),
            Page::Other(i) => Some(i),
            Page::Notes(_) => Some(2),
            Page::Gallery | Page::Anim(_) | Page::TextSample | Page::EmojiSample => None,
        };
        let running_dot = match (self.countdown.status, self.stopwatch.status) {
            (Status::Running, _) | (_, Status::Running) => Some(true),
            (Status::Paused, _) | (_, Status::Paused) => Some(false),
            _ => None,
        };
        for (i, (label, icon)) in NAV_ITEMS.iter().enumerate() {
            let hover_me = me.clone();
            let click_me = me.clone();
            let b = NavButton {
                index: i,
                active: active_idx == Some(i),
                hovered: self.hover_nav == Some(i),
                ever_hovered: self.ever_hovered.contains(&i),
                running_dot: if i == 0 { running_dot } else { None },
                icon,
                label,
            };
            col_el = col_el.child(chrome::nav_button(
                b,
                move |hovered, _, app| {
                    hover_me.update(app, |t, cx| {
                        if hovered {
                            t.hover_nav = Some(i);
                            t.ever_hovered.insert(i);
                        } else if t.hover_nav == Some(i) {
                            t.hover_nav = None;
                        }
                        cx.notify();
                    })
                },
                move |window, app| {
                    click_me.update(app, |t, cx| t.navigate(i, window, cx));
                },
            ));
        }
        // The effects gallery stays pinned to the bottom of the rail.
        let hover_me = me.clone();
        let click_me = me.clone();
        col_el = col_el.child(div().flex_1()).child(chrome::nav_button(
            NavButton {
                index: 99,
                active: self.page == Page::Gallery,
                hovered: self.hover_nav == Some(99),
                ever_hovered: self.ever_hovered.contains(&99),
                running_dot: None,
                icon: "icons/spark.svg",
                label: "Effects gallery",
            },
            move |hovered, _, app| {
                hover_me.update(app, |t, cx| {
                    if hovered {
                        t.hover_nav = Some(99);
                        t.ever_hovered.insert(99);
                    } else if t.hover_nav == Some(99) {
                        t.hover_nav = None;
                    }
                    cx.notify();
                })
            },
            move |_, app| {
                click_me.update(app, |t, cx| {
                    t.page = Page::Gallery;
                    cx.notify();
                })
            },
        ));
        col_el
    }

    /// The page a nav rail button opens.
    pub fn page_for(index: usize) -> Page {
        match index {
            0 => Page::Timer,
            1 => Page::History,
            4 => Page::Claude,
            5 => Page::Activity,
            7 => Page::Stats,
            8 => Page::Tags,
            9 => Page::Settings,
            i => Page::Other(i),
        }
    }

    pub fn navigate(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.settings.update(cx, |s, _| s.hide());
        self.activity.update(cx, |a, _| a.hide());
        if self.page != Self::page_for(index) {
            lizmeter_ui::scrollbar::reset_all();
        }
        match index {
            0 => {
                self.page = Page::Timer;
                cx.notify();
            }
            1 => self.show_history(window, cx),
            4 => self.show_claude(cx),
            5 => self.show_activity(cx),
            7 => self.show_stats(cx),
            8 => self.show_tags(cx),
            9 => self.show_settings(cx),
            i => {
                self.page = Page::Other(i);
                cx.notify();
            }
        }
    }
}

pub fn image_resolver(svc: &Arc<Services>) -> Rc<dyn Fn(&str) -> Option<std::path::PathBuf>> {
    let resolve = svc.image_resolver();
    Rc::new(move |url| resolve(url))
}

impl Render for Root {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.page == Page::EmojiSample {
            return gallery::emoji_sample().into_any_element();
        }
        if self.page == Page::TextSample {
            return gallery::text_sample().into_any_element();
        }
        if let Page::Anim(i) = self.page {
            return gallery::anim_page(i).into_any_element();
        }
        let page = match self.page {
            Page::Timer => div().flex_1().h_full().flex().justify_center().overflow_hidden().child(self.timer_page(window, cx)).into_any_element(),
            Page::History => {
                let active = self.countdown.status != Status::Idle || self.stopwatch_active();
                if self.history_stale {
                    self.history_stale = false;
                    self.history.update(cx, |h, cx| {
                        h.timer_active = active;
                        h.refresh(window, cx);
                    });
                } else if self.history.read(cx).timer_active != active {
                    self.history.update(cx, |h, cx| {
                        h.timer_active = active;
                        cx.notify();
                    });
                }
                self.history.clone().into_any_element()
            }
            Page::Stats => self.stats.clone().into_any_element(),
            Page::Tags => self.tags_page.clone().into_any_element(),
            Page::Settings => self.settings.clone().into_any_element(),
            Page::Claude => self.claude_page.clone().into_any_element(),
            Page::Activity => self.activity.clone().into_any_element(),
            Page::Gallery => div().flex_1().h_full().overflow_hidden().child(gallery::page()).into_any_element(),
            Page::Notes(v) => {
                let width = if v == MdVariant::Framed { 640.0 } else { 720.0 };
                div()
                    .flex_1()
                    .h_full()
                    .flex()
                    .justify_center()
                    .overflow_hidden()
                    .child({
                        let scroll = lizmeter_ui::scrollbar::keyed("notes-page", lizmeter_ui::scrollbar::BarStyle::Global);
                        div()
                            .w(px(width))
                            .h_full()
                            .child(
                                div()
                                    .id("notes-page")
                                    .track_scroll(scroll.handle())
                                    .size_full()
                                    .pt(px(32.0))
                                    .px(px(24.0))
                                    .overflow_y_scroll()
                                    .child(self.notes.clone()),
                            )
                            .child(scroll.bar())
                    })
                    .into_any_element()
            }
            Page::Anim(_) | Page::TextSample | Page::EmojiSample => unreachable!(),
            Page::Other(i) => div()
                .flex_1()
                .h_full()
                .flex()
                .items_center()
                .justify_center()
                .child(ui_text(13.0).text_color(col(TN_MUTED)).child(format!("{} (coming in a later phase)", NAV_ITEMS[i].0)))
                .into_any_element(),
        };
        let sidebar = self.sidebar(cx);
        div()
            .size_full()
            .relative()
            .bg(col(TN_BG))
            .font_family(UI_FONT)
            .text_color(col(TN_TEXT))
            .child(
                div()
                    .absolute()
                    .top(px(32.0))
                    .left_0()
                    .w_full()
                    .bottom(px(0.0))
                    .flex()
                    .flex_row()
                    .child(layer(chrome::root_background()))
                    .child(sidebar)
                    .child(page),
            )
            .children(self.notes_modal.clone().map(|m| deferred(div().absolute().top(px(32.0)).left_0().right_0().bottom_0().child(m)).with_priority(5)))
            .children(self.rich_modal.clone().map(|(m, _)| deferred(div().absolute().top(px(32.0)).left_0().right_0().bottom_0().child(m)).with_priority(5)))
            .children(self.prompt.clone().map(|(p, _)| deferred(div().absolute().top(px(32.0)).left_0().right_0().bottom_0().child(p)).with_priority(6)))
            .child(deferred(chrome::titlebar(None)).with_priority(9))
            .into_any_element()
    }
}
