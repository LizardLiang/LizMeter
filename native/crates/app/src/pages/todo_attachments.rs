//! `TodoAttachments.tsx`: the attachment strip under the notes, a tile per file with add, open,
//! remove and (for images) insert-into-notes. The files live in the data folder's attachments dir.

use super::todo_widgets::*;
use crate::css::rgba;
use crate::ui::*;
use gpui::*;
use lizmeter_core::{TodoAttachment, TodoAttachmentKind};
use lizmeter_services::Services;
use std::collections::HashSet;
use std::sync::Arc;

pub enum AttachmentsEvent {
    /// The markdown of an image or link to append to the notes.
    Insert(String),
}

impl EventEmitter<AttachmentsEvent> for TodoAttachments {}

pub struct TodoAttachments {
    svc: Arc<Services>,
    /// `None` puts the strip in create mode: there is no row to attach to yet.
    todo_id: Option<i64>,
    attachments: Vec<TodoAttachment>,
    error: Option<String>,
    /// Files that are gone from the data folder show a placeholder.
    missing: HashSet<i64>,
}

/// One decimal for MB, none for KB.
pub fn format_bytes(bytes: i64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// The extension shown on the file glyph; empty when the name has none.
pub fn file_extension(name: &str) -> &str {
    match name.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < name.len() => &name[dot + 1..],
        _ => "",
    }
}

/// Images embed, everything else links; both point at the same app-media URL.
pub fn embed_markdown(a: &TodoAttachment) -> String {
    let prefix = if a.kind == TodoAttachmentKind::Image { "!" } else { "" };
    format!("{prefix}[{}]({})", a.file_name, a.url)
}

impl TodoAttachments {
    pub fn new(svc: Arc<Services>, todo_id: Option<i64>) -> Self {
        let mut s = Self { svc, todo_id, attachments: vec![], error: None, missing: HashSet::new() };
        s.reload();
        s
    }

    pub fn reload(&mut self) {
        let Some(id) = self.todo_id else {
            self.attachments.clear();
            return;
        };
        match self.svc.list_attachments(id) {
            Ok(list) => {
                self.missing = list.iter().filter(|a| self.svc.resolve_attachment_url(&a.url).is_none_or(|p| !p.exists())).map(|a| a.id).collect();
                self.attachments = list;
                self.error = None;
            }
            Err(_) => self.error = Some("Could not load the attachments for this todo.".into()),
        }
    }

    pub fn count(&self) -> usize {
        self.attachments.len()
    }

    fn add(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.todo_id else { return };
        match self.svc.add_attachment(id) {
            Ok(Some(_)) => {
                self.error = None;
                self.reload();
            }
            Ok(None) => self.error = None,
            Err(e) => self.error = Some(e.to_string()),
        }
        cx.notify();
    }

    fn remove(&mut self, id: i64, cx: &mut Context<Self>) {
        match self.svc.delete_attachment(id) {
            Ok(()) => {
                self.error = None;
                self.reload();
            }
            Err(e) => self.error = Some(e.to_string()),
        }
        cx.notify();
    }

    fn open(&mut self, id: i64, cx: &mut Context<Self>) {
        self.error = match self.svc.open_attachment(id) {
            Ok(None) => None,
            Ok(Some(msg)) if !msg.is_empty() => Some(msg),
            Ok(Some(_)) => None,
            Err(e) => Some(e.to_string()),
        };
        cx.notify();
    }

    fn tile(&self, a: &TodoAttachment, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let id = a.id;
        let broken = self.missing.contains(&id);
        let ext = file_extension(&a.file_name).to_string();
        let preview_inner: AnyElement = if broken {
            div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(3.0))
                .text_size(px(10.0))
                .text_color(col(TN_RED))
                .child(div().text_size(px(15.0)).line_height(px(15.0)).child("!"))
                .child("Missing file")
                .into_any_element()
        } else if a.kind == TodoAttachmentKind::Image {
            match self.svc.resolve_attachment_url(&a.url) {
                Some(path) => img(path).w_full().h_full().object_fit(ObjectFit::Cover).into_any_element(),
                None => div().into_any_element(),
            }
        } else {
            div().text_size(px(11.0)).font_weight(FontWeight(700.0)).text_color(col(hex_a3())).child(spaced(&(if ext.is_empty() { "file".to_string() } else { ext }).to_uppercase(), 0.88)).into_any_element()
        };
        let (m_open, m_remove, m_insert) = (me.clone(), me.clone(), me.clone());
        let embed = embed_markdown(a);
        let mut actions = div().flex().flex_row().items_center().justify_between().gap(px(4.0)).pl(px(8.0)).pr(px(4.0)).pb(px(5.0));
        if a.kind == TodoAttachmentKind::Image {
            actions = actions.child(
                div()
                    .id(SharedString::from(format!("att-insert-{id}")))
                    .px(px(6.0))
                    .py(px(2.0))
                    .rounded(px(4.0))
                    .text_size(px(11.0))
                    .text_color(col(hex_a3()))
                    .cursor_pointer()
                    .hover(|s| s.text_color(col(TN_BLUE)))
                    .on_click(move |_, _, app| m_insert.update(app, |_, cx| cx.emit(AttachmentsEvent::Insert(embed.clone()))))
                    .child("Insert"),
            );
        }
        actions = actions.child(
            div()
                .id(SharedString::from(format!("att-remove-{id}")))
                .ml_auto()
                .px(px(7.0))
                .py(px(3.0))
                .rounded(px(4.0))
                .text_size(px(12.0))
                .line_height(px(12.0))
                .text_color(col(hex_a3()))
                .cursor_pointer()
                .hover(|s| s.text_color(col(TN_RED)))
                .on_click(move |_, _, app| m_remove.update(app, |t, cx| t.remove(id, cx)))
                .child("x"),
        );
        div()
            .w(px(136.0))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .rounded(px(10.0))
            .border(px(1.0))
            .border_color(col(rgba(86, 95, 137, 0.28)))
            .bg(col(rgba(12, 13, 24, 0.5)))
            .backdrop_filter(px(8.0), 1.0)
            .overflow_hidden()
            .hover(|s| s.border_color(col(rgba(122, 162, 247, 0.45))))
            .child(
                div()
                    .id(SharedString::from(format!("att-open-{id}")))
                    .w_full()
                    .h(px(72.0))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .overflow_hidden()
                    .border_b_1()
                    .border_color(col(rgba(86, 95, 137, 0.22)))
                    .bg(col(rgba(20, 23, 42, 0.55)))
                    .cursor_pointer()
                    .hover(|s| s.bg(col(rgba(122, 162, 247, 0.12))))
                    .on_click(move |_, _, app| m_open.update(app, |t, cx| t.open(id, cx)))
                    .child(preview_inner),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(1.0))
                    .px(px(8.0))
                    .pt(px(6.0))
                    .pb(px(4.0))
                    .min_w_0()
                    .child(div().truncate().text_size(px(12.0)).line_height(px(16.0)).text_color(col(TN_TEXT)).child(a.file_name.clone()))
                    .child(div().text_size(px(10.0)).line_height(px(13.0)).text_color(col(hex_a3())).child(format_bytes(a.size_bytes))),
            )
            .child(actions)
    }
}

fn hex_a3() -> crate::css::C {
    crate::css::hex(0xa3abc9)
}

impl Render for TodoAttachments {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let creating = self.todo_id.is_none();
        let label = format!("Attachments{}", if self.attachments.is_empty() { String::new() } else { format!(" ({})", self.attachments.len()) });
        let mut add = div()
            .id("att-add")
            .px(px(9.0))
            .py(px(4.0))
            .rounded(px(6.0))
            .border(px(1.0))
            .border_color(col(rgba(86, 95, 137, 0.5)))
            .text_size(px(12.0))
            .text_color(col(hex_a3()))
            .child("Attach file");
        add = if creating {
            add.opacity(0.4)
        } else {
            add.cursor_pointer().hover(|s| s.text_color(col(TN_BLUE)).border_color(col(rgba(122, 162, 247, 0.5)))).on_click(move |_, _, app| me.update(app, |t, cx| t.add(cx)))
        };
        let hint = |text: &str| div().mt(px(8.0)).text_size(px(11.0)).line_height(px(16.5)).text_color(col(dim())).child(text.to_string());
        let mut section = div()
            .mt(px(18.0))
            .pt(px(14.0))
            .border_t_1()
            .border_color(col(rgba(86, 95, 137, 0.22)))
            .child(div().flex().flex_row().items_center().justify_between().mb(px(8.0)).child(ui_text(11.0).line_height(px(14.0)).font_weight(FontWeight(700.0)).text_color(col(hex_a3())).child(spaced(&label.to_uppercase(), 1.1))).child(add));
        if creating {
            section = section.child(hint("Create this todo first, then attach files."));
        } else {
            if !self.attachments.is_empty() {
                let mut list = div().flex().flex_row().flex_wrap().gap(px(10.0));
                for a in self.attachments.clone() {
                    list = list.child(self.tile(&a, cx));
                }
                section = section.child(list);
            } else if self.error.is_none() {
                section = section.child(hint("No attachments yet. Images embed into the notes; other files open in the OS."));
            }
        }
        if let Some(e) = &self.error {
            section = section.child(div().mt(px(8.0)).text_size(px(12.0)).text_color(col(TN_RED)).child(e.clone()));
        }
        section
    }
}

#[cfg(test)]
mod tests {
    use super::{embed_markdown, file_extension, format_bytes};
    use lizmeter_core::{TodoAttachment, TodoAttachmentKind};

    fn attachment(kind: TodoAttachmentKind) -> TodoAttachment {
        TodoAttachment { id: 1, todo_id: 2, sha256: "ab".into(), file_name: "shot.png".into(), mime_type: "image/png".into(), size_bytes: 10, kind, url: "app-media://attachments/ab.png".into(), created_at: String::new() }
    }

    #[test]
    fn sizes_use_bytes_kilobytes_and_one_decimal_of_megabytes() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(2048), "2 KB");
        assert_eq!(format_bytes(3 * 1024 * 1024 + 512 * 1024), "3.5 MB");
    }

    #[test]
    fn the_extension_is_empty_for_dotfiles_and_trailing_dots() {
        assert_eq!(file_extension("a.tar.gz"), "gz");
        assert_eq!(file_extension(".env"), "");
        assert_eq!(file_extension("name."), "");
        assert_eq!(file_extension("README"), "");
    }

    #[test]
    fn images_embed_and_files_link() {
        assert_eq!(embed_markdown(&attachment(TodoAttachmentKind::Image)), "![shot.png](app-media://attachments/ab.png)");
        assert_eq!(embed_markdown(&attachment(TodoAttachmentKind::File)), "[shot.png](app-media://attachments/ab.png)");
    }
}
