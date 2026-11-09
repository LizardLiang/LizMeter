//! Claude page (`ClaudePage.tsx`): the Claude Code projects found under `~/.claude/projects`.

use crate::css::{hex, rgba};
use crate::ui::*;
use gpui::*;
use lizmeter_core::ClaudeCodeProject;
use lizmeter_services::Services;
use lizmeter_ui::scrollbar::{self, BarStyle};
use std::sync::Arc;

const BLUE: crate::css::C = hex(0x7aa2f7);

pub struct ClaudePage {
    svc: Arc<Services>,
    projects: Vec<ClaudeCodeProject>,
    loading: bool,
}

impl ClaudePage {
    pub fn new(svc: Arc<Services>) -> Self {
        Self { svc, projects: vec![], loading: true }
    }

    /// The page opens: list the projects again.
    pub fn show(&mut self, cx: &mut Context<Self>) {
        self.projects = self.svc.claude_projects();
        self.loading = false;
        cx.notify();
    }

    fn heading(text: &str, size: f32) -> Div {
        div().text_size(px(size)).line_height(px((size * 1.2).round())).font_weight(FontWeight(700.0)).child(text.to_string())
    }

    /// The empty-state sentence, with the folder name in the monospace of `<code>`.
    fn empty_text(window: &Window) -> StyledText {
        const HEAD: &str = "No Claude Code projects found. Make sure Claude Code has been used at least once so that project directories exist in ";
        const CODE: &str = "~/.claude/projects/";
        const TAIL: &str = ".";
        let base = window.text_style().font();
        let run = |len: usize, font: Font| TextRun { len, font, color: col(TN_TEXT_DIM), background_color: None, underline: None, strikethrough: None };
        let mono = Font { family: MONO.into(), ..base.clone() };
        StyledText::new(format!("{HEAD}{CODE}{TAIL}")).with_runs(vec![run(HEAD.len(), base.clone()), run(CODE.len(), mono), run(TAIL.len(), base)])
    }
}

impl Render for ClaudePage {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let scroll = scrollbar::keyed("claude-page", BarStyle::Global);
        let mut body = div()
            .w_full()
            .max_w(px(640.0))
            .px(px(28.0))
            .py(px(24.0))
            .flex()
            .flex_col()
            .child(Self::heading("Claude Code", 22.0).text_color(col(BLUE)).mb(px(8.0)))
            .child(
                ui_text(13.0)
                    .text_color(col(TN_TEXT_DIM))
                    .mb(px(24.0))
                    .child("Tracks Claude Code AI coding sessions during your LizMeter timer sessions. Select a project in Settings to enable tracking."),
            )
            .child(Self::heading("Available Projects", 15.0).text_color(col(TN_TEXT)).mb(px(12.0)));
        if self.loading {
            body = body.child(ui_text(13.0).py(px(20.0)).text_color(col(TN_TEXT_DIM)).child("Loading projects\u{2026}"));
        } else if self.projects.is_empty() {
            body = body.child(ui_text(13.0).py(px(20.0)).text_color(col(TN_TEXT_DIM)).child(Self::empty_text(window)));
        }
        for p in &self.projects {
            body = body.child(
                div()
                    .mb(px(10.0))
                    .px(px(18.0))
                    .py(px(14.0))
                    .rounded(px(10.0))
                    .border(px(1.0))
                    .border_color(col(rgba(122, 162, 247, 0.18)))
                    .bg(col(rgba(122, 162, 247, 0.06)))
                    .flex()
                    .flex_col()
                    .child(div().mb(px(4.0)).font_family(MONO).text_size(px(14.0)).line_height(px(18.0)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child(p.display_path.clone()))
                    .child(div().font_family(MONO).text_size(px(11.0)).line_height(px(14.0)).text_color(col(TN_TEXT_DIM)).child(p.dir_name.clone())),
            );
        }
        div()
            .flex_1()
            .h_full()
            .child(div().id("claude-page").track_scroll(scroll.handle()).size_full().overflow_y_scroll().child(scroll.pad(body)))
            .child(scroll.bar())
    }
}
