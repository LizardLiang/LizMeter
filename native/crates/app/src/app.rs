//! The main window view: titlebar, root background, sidebar, and the pages.

use crate::chrome::{self, NAV_ITEMS, NavButton};
use crate::css::{Spec, TRANSPARENT, hex, linear, rgba};
use crate::timer::{self, Status, TimerType};
use crate::ui::*;
use crate::{gallery, modal};
use gpui::*;
use lizmeter_ui::md_editor::{MarkdownEditor, MdEvent, MdMode, MdVariant};
use lizmeter_ui::rich_input::{RichEvent, RichInput, RichMode};
use std::collections::HashSet;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Page {
    Timer,
    Gallery,
    Anim(usize),
    TextSample,
    EmojiSample,
    /// Markdown notes editor: framed, bare or the expanded modal.
    Notes(MdVariant),
    Other(usize),
}

pub struct Root {
    pub page: Page,
    pub pomodoro: bool,
    pub ttype: TimerType,
    pub status: Status,
    pub remaining: i32,
    base_remaining: i32,
    started: Option<Instant>,
    pub hover_nav: Option<usize>,
    ever_hovered: HashSet<usize>,
    pub modal_open: bool,
    pub rich: Entity<RichInput>,
    rich_modal: Option<Entity<RichInput>>,
    pub notes: Entity<MarkdownEditor>,
    notes_modal: Option<Entity<MarkdownEditor>>,
    pub notes_image_base: Option<std::path::PathBuf>,
}

impl Root {
    pub fn new(page: Page, pomodoro: bool, modal_open: bool, hover_nav: Option<usize>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let rich = cx.new(|cx| RichInput::new("", "Describe what you\u{2019}ll be working on\u{2026}", RichMode::Inline, window, cx));
        cx.subscribe_in(&rich, window, Self::on_rich_event).detach();
        let variant = match page {
            Page::Notes(v) => v,
            _ => MdVariant::Framed,
        };
        let notes = cx.new(|cx| {
            let mut e = MarkdownEditor::new("", "Add notes\u{2026}", variant, MdMode::Inline, window, cx);
            e.set_expandable(true, cx);
            e
        });
        cx.subscribe_in(&notes, window, Self::on_notes_event).detach();
        let ttype = TimerType::Work;
        Self {
            page,
            pomodoro,
            ttype,
            status: Status::Idle,
            remaining: ttype.seconds(),
            base_remaining: ttype.seconds(),
            started: None,
            hover_nav,
            ever_hovered: hover_nav.into_iter().collect(),
            modal_open,
            rich,
            rich_modal: None,
            notes,
            notes_modal: None,
            notes_image_base: None,
        }
    }

    fn on_rich_event(&mut self, _: &Entity<RichInput>, ev: &RichEvent, window: &mut Window, cx: &mut Context<Self>) {
        match ev {
            RichEvent::Expand => self.open_rich_modal(window, cx),
            RichEvent::ModalDone(html) => {
                self.rich.update(cx, |r, cx| r.set_html(html, cx));
                self.close_rich_modal(window, cx);
            }
            RichEvent::ModalCancel => self.close_rich_modal(window, cx),
            RichEvent::Changed(_) => {}
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
        let modal = cx.new(|cx| {
            let mut e = MarkdownEditor::new(&text, "Add notes\u{2026}", MdVariant::Fill, MdMode::Modal, window, cx);
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

    pub fn open_rich_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let html = self.rich.read(cx).html();
        let modal = cx.new(|cx| RichInput::new(&html, "Describe what you\u{2019}ll be working on\u{2026}", RichMode::Modal, window, cx));
        cx.subscribe_in(&modal, window, Self::on_rich_event).detach();
        let focus = modal.read(cx).focus_handle().clone();
        window.focus(&focus);
        self.rich_modal = Some(modal);
        cx.notify();
    }

    fn close_rich_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.rich_modal = None;
        let focus = self.rich.read(cx).focus_handle().clone();
        window.focus(&focus);
        cx.notify();
    }

    pub fn start(&mut self, cx: &mut Context<Self>) {
        self.status = Status::Running;
        self.base_remaining = self.remaining;
        self.started = Some(Instant::now());
        self.run_ticks(cx);
        cx.notify();
    }

    fn pause(&mut self, cx: &mut Context<Self>) {
        self.sync_remaining();
        self.status = Status::Paused;
        self.started = None;
        cx.notify();
    }

    fn resume(&mut self, cx: &mut Context<Self>) {
        self.start(cx);
    }

    fn reset(&mut self, cx: &mut Context<Self>) {
        self.status = Status::Idle;
        self.started = None;
        self.remaining = self.ttype.seconds();
        cx.notify();
    }

    fn sync_remaining(&mut self) {
        if let Some(t0) = self.started {
            self.remaining = (self.base_remaining - t0.elapsed().as_secs() as i32).max(0);
        }
    }

    /// Wakes once per second boundary while running and stops itself afterwards, so an idle
    /// timer costs no CPU.
    pub fn focused_rich(&self) -> &Entity<RichInput> {
        self.rich_modal.as_ref().unwrap_or(&self.rich)
    }

    fn run_ticks(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                let wait = this
                    .update(cx, |t, _| {
                        let el = t.started.map(|s| s.elapsed()).unwrap_or_default();
                        Duration::from_millis(1000 - (el.as_millis() % 1000) as u64 + 5)
                    })
                    .unwrap_or(Duration::from_secs(1));
                cx.background_executor().timer(wait).await;
                let keep = this
                    .update(cx, |t, cx| {
                        if t.status != Status::Running {
                            return false;
                        }
                        let before = t.remaining;
                        t.sync_remaining();
                        if t.remaining == 0 {
                            t.status = Status::Completed;
                            t.started = None;
                        }
                        if t.remaining != before {
                            cx.notify();
                        }
                        t.status == Status::Running
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
        })
        .detach();
    }

    fn timer_page(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let m1 = me.clone();
        let toggle = timer::mode_toggle(self.pomodoro, matches!(self.status, Status::Running | Status::Paused), move |pomodoro, _, app| {
            m1.update(app, |t, cx| {
                if !matches!(t.status, Status::Running | Status::Paused) {
                    t.pomodoro = pomodoro;
                    cx.notify();
                }
            })
        });
        let card = if self.pomodoro { self.pomodoro_card(cx).into_any_element() } else { self.stopwatch_card(cx).into_any_element() };
        div()
            .w(px(480.0))
            .pt(px(32.0))
            .px(px(24.0))
            .pb(px(24.0))
            .flex()
            .flex_col()
            .child(div().mb(px(16.0)).child(toggle))
            .child(card)
    }

    fn pomodoro_card(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let idle = self.status == Status::Idle;
        let (m_type, m_start, m_pause, m_resume, m_reset) = (me.clone(), me.clone(), me.clone(), me.clone(), me.clone());
        let card = timer::card_glass(self.status, self.ttype, 0.12).el().w_full().pt(px(25.0)).px(px(23.0)).pb(px(23.0)).flex().flex_col();
        card.child(timer::section_label("Timer"))
            .child(div().mt(px(8.0)).child(timer::type_selector(self.ttype, idle, move |ty, _, app| {
                m_type.update(app, |t, cx| {
                    if t.status == Status::Idle {
                        t.ttype = ty;
                        t.remaining = ty.seconds();
                        cx.notify();
                    }
                })
            })))
            .child(timer::timer_display(self.status, self.remaining, idle))
            .child(
                div()
                    .py(px(6.0))
                    .flex()
                    .flex_col()
                    .child(
                        ui_text(11.0)
                            .h(px(14.0))
                            .line_height(px(14.0))
                            .mb(px(8.0))
                            .font_weight(FontWeight(700.0))
                            .text_color(col(TN_TEXT_DIM))
                            .child(spaced("SESSION DESCRIPTION", 1.32)),
                    )
                    .child(self.rich.clone()),
            )
            .child(div().mt(px(10.0)).flex().flex_row().child(timer::link_issue_button()))
            .child(timer::controls(
                self.status,
                move |_, app| m_start.update(app, |t, cx| t.start(cx)),
                move |_, app| m_pause.update(app, |t, cx| t.pause(cx)),
                move |_, app| m_resume.update(app, |t, cx| t.resume(cx)),
                move |_, app| m_reset.update(app, |t, cx| t.reset(cx)),
            ))
    }

    fn stopwatch_card(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let m_start = me.clone();
        let glass = Glass::new(
            18.0,
            32.0,
            1.6,
            Spec::rrect(18.0)
                .fill(linear(135.0, &[(0.0, wh(0.08)), (0.35, wh(0.02)), (0.58, TRANSPARENT)]))
                .fill(linear(315.0, &[(0.0, bk(0.08)), (0.38, TRANSPARENT)]))
                .solid(rgba(16, 18, 36, 0.52))
                .border(1.0, rgba(122, 162, 247, 0.14))
                .inset(0.0, 1.0, wh(0.12))
                .inset(1.0, 0.0, wh(0.06))
                .inset(0.0, -1.0, bk(0.18))
                .inset(-1.0, 0.0, bk(0.06)),
        )
        .shadows(&[sh(0.0, 12.0, 40.0, bk(0.40)), sh(0.0, 4.0, 12.0, bk(0.25))]);
        let select = Glass::new(8.0, 0.0, 1.0, Spec::rrect(8.0).solid(rgba(16, 17, 32, 0.6)).border(1.0, rgba(59, 66, 97, 0.7)))
            .el()
            .w_full()
            .h(px(33.0))
            .px(px(13.0))
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .text_color(col(TN_TEXT_DIM))
            .child(btn_like("Link Claude Code session\u{2026}", 14.0))
            .child(svg().path("icons/caret.svg").size(px(12.0)).text_color(col(TN_TEXT_DIM)));
        let mut el = glass.el().w_full().p(px(25.0)).flex().flex_col().gap(px(16.0));
        el = el
            .child(ui_text(11.0).h(px(14.0)).line_height(px(14.0)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child(spaced("STOPWATCH", 1.5)))
            .child(self.rich.clone())
            .child(select)
            .child(div().flex().flex_row().child(timer::link_issue_button()))
            .child(
                ui_text(56.0)
                    .py(px(16.0))
                    .h(px(88.0))
                    .line_height(px(56.0))
                    .flex()
                    .justify_center()
                    .font_weight(FontWeight(700.0))
                    .text_color(col(TN_BLUE))
                    .child(spaced("00:00:00", 2.0)),
            )
            .child(div().flex().flex_row().justify_center().child(
                div()
                    .id("sw-start")
                    .h(px(36.0))
                    .px(px(28.0))
                    .flex()
                    .items_center()
                    .rounded(px(8.0))
                    .bg(col(TN_BLUE))
                    .text_color(col(hex(0x1a1b26)))
                    .cursor_pointer()
                    .on_click(move |_, _, app| {
                        m_start.update(app, |t, cx| {
                            t.modal_open = true;
                            cx.notify();
                        })
                    })
                    .child(btn_like_w("Start", 14.0, 600.0)),
            ));
        if self.modal_open {
            let m_close = me.clone();
            el = el.child(modal::overlay_and_dialog(move |_, app| {
                m_close.update(app, |t, cx| {
                    t.modal_open = false;
                    cx.notify();
                })
            }));
        }
        el
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
            Page::Other(i) => Some(i),
            Page::Notes(_) => Some(2),
            Page::Gallery | Page::Anim(_) | Page::TextSample | Page::EmojiSample => None,
        };
        let running_dot = match self.status {
            Status::Running => Some(true),
            Status::Paused => Some(false),
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
                move |_, app| {
                    click_me.update(app, |t, cx| {
                        t.page = if i == 0 { Page::Timer } else { Page::Other(i) };
                        cx.notify();
                    })
                },
            ));
        }
        // Spike-only entry: the effects gallery, pinned to the bottom of the rail.
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
}

fn btn_like(text: &str, size: f32) -> Div {
    btn_like_w(text, size, 400.0)
}

fn btn_like_w(text: &str, size: f32, weight: f32) -> Div {
    div().font_family(BTN_FONT).text_size(px(size)).line_height(px((size * 1.15).round())).font_weight(FontWeight(weight)).child(text.to_string())
}

impl Render for Root {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
            Page::Timer => div().flex_1().h_full().flex().justify_center().overflow_hidden().child(self.timer_page(cx)).into_any_element(),
            Page::Gallery => div().flex_1().h_full().overflow_hidden().child(gallery::page()).into_any_element(),
            Page::Notes(v) => {
                let width = if v == MdVariant::Framed { 640.0 } else { 720.0 };
                div()
                    .flex_1()
                    .h_full()
                    .flex()
                    .justify_center()
                    .overflow_hidden()
                    .child(div().id("notes-page").w(px(width)).h_full().pt(px(32.0)).px(px(24.0)).overflow_y_scroll().child(self.notes.clone()))
                    .into_any_element()
            }
            Page::Anim(_) | Page::TextSample | Page::EmojiSample => unreachable!(),
            Page::Other(i) => div()
                .flex_1()
                .h_full()
                .flex()
                .items_center()
                .justify_center()
                .child(ui_text(13.0).text_color(col(TN_MUTED)).child(format!("{} (not part of the spike)", NAV_ITEMS[i].0)))
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
            .children(self.rich_modal.clone().map(|m| deferred(div().absolute().top(px(32.0)).left_0().right_0().bottom_0().child(m)).with_priority(5)))
            .child(deferred(chrome::titlebar(None)).with_priority(9))
            .into_any_element()
    }
}
