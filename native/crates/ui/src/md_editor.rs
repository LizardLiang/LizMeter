//! `MarkdownEditor`: port of `MarkdownEditor.tsx`. A markdown source editor that renders in place
//! (live preview): syntax collapses to styled text, bullets, checkboxes, images and tables, and the
//! raw source of every line the caret or selection touches is shown. Decisions live in
//! `md_preview.rs`, editing rules in `md_edit.rs`, text and IME mechanics in `text_buffer.rs`.

use crate::css::{Spec, hex, rgba};
use crate::md_edit::{self, Edit};
use crate::md_preview::{self, Align, PreviewKind, PreviewRange, PreviewTable, TokenRange};
use crate::text_buffer::{EditKind, TextBuffer};
use crate::text_input as ti;
use crate::ui::*;
use gpui::*;
use std::collections::HashMap;
use std::ops::Range;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

actions!(lizmeter_md_editor, [Submit]);

/// Adds the editor-only binding (shared editing keys come from `text_input::bind_keys`).
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("ctrl-enter", Submit, Some(ti::KEY_CONTEXT))]);
}

/// Hard cap on the note length, the same constant as `NOTES_MAX_LENGTH` in `src/shared/types.ts`.
pub const NOTES_MAX_LENGTH: usize = 32_000;
/// Shown when a file arrives before the todo exists.
pub const CREATE_FIRST_HINT: &str = "Create this todo first, then attach files.";
/// Tallest an image may render, in px (`IMAGE_MAX_HEIGHT_PX`).
const IMAGE_MAX_HEIGHT: f32 = 320.0;

const MONO_FONT: &str = "Consolas";
const TEXT: C = TN_TEXT;
const LIST_STEP_EM: f32 = 1.4;

use crate::css::C;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MdVariant {
    /// Glass input surface with a capped height and inner scroll.
    Framed,
    /// Page body text: no chrome, no height cap, no inner scroll.
    Bare,
    /// Fills its container (the expanded modal).
    Fill,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum MdMode {
    Inline,
    Modal,
}

pub enum FileSource {
    Path(PathBuf),
    Bytes { data: Vec<u8>, mime: String },
}

/// A file the user pasted or dropped. The host stores it, then calls `settle_upload`.
pub struct AttachRequest {
    pub upload: u64,
    pub name: String,
    pub source: FileSource,
}

pub enum MdEvent {
    Changed(String),
    /// Ctrl+Enter: the host submits its form; the editor inserts nothing.
    Submit,
    Escape,
    Expand,
    ModalDone(String),
    ModalCancel,
    Attach(AttachRequest),
}

impl EventEmitter<MdEvent> for MarkdownEditor {}

#[derive(Clone, Copy)]
struct Metrics {
    size: f32,
    pad_x: f32,
    pad_y: f32,
}

impl Metrics {
    fn of(v: MdVariant) -> Self {
        match v {
            MdVariant::Framed => Self { size: 13.0, pad_x: 12.0, pad_y: 9.0 },
            MdVariant::Bare => Self { size: 13.0, pad_x: 0.0, pad_y: 4.0 },
            MdVariant::Fill => Self { size: 14.0, pad_x: 20.0, pad_y: 14.0 },
        }
    }
    fn line_height(&self) -> f32 {
        self.size * 1.6
    }
}

#[derive(Clone)]
enum ImgState {
    Ready { img: Arc<RenderImage>, w: f32, h: f32 },
    Missing,
}

/// Everything layout needs, computed when text or selection changes and shared with the measure
/// closure.
struct DocModel {
    rev: u64,
    text: String,
    previews: Vec<PreviewRange>,
    tokens: Vec<TokenRange>,
    images: HashMap<String, ImgState>,
    metrics: Metrics,
}

struct UploadMark {
    id: u64,
    from: usize,
    to: usize,
}

pub struct MarkdownEditor {
    focus: FocusHandle,
    buf: TextBuffer,
    placeholder: SharedString,
    variant: MdVariant,
    mode: MdMode,
    disabled: bool,
    expandable: bool,
    title: SharedString,
    todo_id: Option<i64>,
    model: Option<Arc<DocModel>>,
    rev: u64,
    images: HashMap<String, ImgState>,
    image_base: Option<PathBuf>,
    resolver: Option<Rc<dyn Fn(&str) -> Option<PathBuf>>>,
    layout: Option<Arc<MdLayout>>,
    bounds: Option<Bounds<Pixels>>,
    selecting: bool,
    goal_x: Option<Pixels>,
    blink_on: bool,
    blinking: bool,
    blink_gen: usize,
    scroll: crate::scrollbar::Scroll,
    ensure_caret_visible: bool,
    uploads: Vec<UploadMark>,
    next_upload: u64,
    hint: Option<(String, u64)>,
    hint_seq: u64,
}

impl MarkdownEditor {
    pub fn new(text: &str, placeholder: &str, variant: MdVariant, mode: MdMode, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        cx.on_focus(&focus, window, |this, _w, cx| this.start_blink(cx)).detach();
        cx.on_blur(&focus, window, |this, _w, cx| {
            this.blinking = false;
            this.buf.unmark();
            this.rev += 1;
            cx.notify();
        })
        .detach();
        let mut buf = TextBuffer::new(false).with_max_len(NOTES_MAX_LENGTH);
        buf.set_content(text);
        buf.set_selection(0, 0);
        Self {
            focus,
            buf,
            placeholder: placeholder.to_string().into(),
            variant,
            mode,
            disabled: false,
            expandable: false,
            title: "Edit Notes".into(),
            todo_id: None,
            model: None,
            rev: 0,
            images: HashMap::new(),
            image_base: None,
            resolver: None,
            layout: None,
            bounds: None,
            selecting: false,
            goal_x: None,
            blink_on: true,
            blinking: false,
            blink_gen: 0,
            scroll: crate::scrollbar::Scroll::new(crate::scrollbar::BarStyle::Global),
            ensure_caret_visible: false,
            uploads: Vec::new(),
            next_upload: 1,
            hint: None,
            hint_seq: 0,
        }
    }

    pub fn text(&self) -> &str {
        self.buf.content()
    }

    pub fn buffer(&self) -> &TextBuffer {
        &self.buf
    }

    /// External value change (reset): clears history, like a CodeMirror `value` reconcile.
    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        if self.buf.content() != text {
            self.buf.set_content(text);
            self.rev += 1;
            cx.notify();
        }
    }

    pub fn set_selection(&mut self, anchor: usize, head: usize, cx: &mut Context<Self>) {
        self.buf.set_selection(anchor, head);
        self.moved(cx);
    }

    pub fn set_disabled(&mut self, disabled: bool, cx: &mut Context<Self>) {
        self.disabled = disabled;
        cx.notify();
    }

    pub fn set_expandable(&mut self, expandable: bool, cx: &mut Context<Self>) {
        self.expandable = expandable;
        cx.notify();
    }

    pub fn set_title(&mut self, title: &str, cx: &mut Context<Self>) {
        self.title = title.to_string().into();
        cx.notify();
    }

    /// `None` is create mode: a dropped file is refused with a hint (there is no row to attach to).
    pub fn set_todo_id(&mut self, todo_id: Option<i64>) {
        self.todo_id = todo_id;
    }

    /// Resolves relative image destinations against `base`.
    pub fn set_image_base(&mut self, base: PathBuf) {
        self.image_base = Some(base);
        self.reset_images();
    }

    /// Maps an image destination (for example `app-media://...`) to a file to draw.
    pub fn set_image_resolver(&mut self, resolver: Rc<dyn Fn(&str) -> Option<PathBuf>>) {
        self.resolver = Some(resolver);
        self.reset_images();
    }

    /// Forgets decoded images (and failed loads) so the next layout reads them again.
    pub fn reset_images(&mut self) {
        self.images.clear();
        self.rev += 1;
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    /// Focuses the editor with the caret at the very start of the document.
    pub fn focus_start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.buf.set_selection(0, 0);
        window.focus(&self.focus);
        self.moved(cx);
    }

    fn start_blink(&mut self, cx: &mut Context<Self>) {
        self.blink_on = true;
        if self.blinking {
            return;
        }
        self.blinking = true;
        self.blink_gen += 1;
        let my_gen = self.blink_gen;
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(530)).await;
                let keep = this
                    .update(cx, |t, cx| {
                        if !t.blinking || t.blink_gen != my_gen {
                            return false;
                        }
                        t.blink_on = !t.blink_on;
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
        })
        .detach();
    }

    fn touched(&mut self, cx: &mut Context<Self>) {
        self.blink_on = true;
        self.ensure_caret_visible = true;
        self.rev += 1;
        cx.notify();
    }

    fn changed(&mut self, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.touched(cx);
        cx.emit(MdEvent::Changed(self.buf.content().to_string()));
    }

    fn moved(&mut self, cx: &mut Context<Self>) {
        self.touched(cx);
    }

    /// Runs one buffer edit and keeps the upload placeholders attached to the text around them.
    fn edit(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut TextBuffer)) {
        if self.disabled {
            return;
        }
        let old = (!self.uploads.is_empty()).then(|| self.buf.content().to_string());
        f(&mut self.buf);
        if let Some(old) = old {
            self.map_uploads(&old);
        }
        self.changed(cx);
    }

    fn map_uploads(&mut self, old: &str) {
        let (start, removed, inserted) = md_edit::diff_span(old, self.buf.content());
        for u in &mut self.uploads {
            u.from = md_edit::map_pos(u.from, start, removed, inserted, 1);
            u.to = md_edit::map_pos(u.to, start, removed, inserted, -1);
        }
    }

    fn apply_edit(&mut self, e: Edit, cx: &mut Context<Self>) {
        self.edit(cx, |b| {
            b.replace(Some(e.range), &e.insert, EditKind::Other);
            b.set_selection(e.caret, e.caret);
        });
    }

    // ---- uploads ----

    fn show_hint(&mut self, msg: &str, cx: &mut Context<Self>) {
        self.hint_seq += 1;
        let seq = self.hint_seq;
        self.hint = Some((msg.to_string(), seq));
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(5)).await;
            let _ = this.update(cx, |t, cx| {
                if t.hint.as_ref().is_some_and(|h| h.1 == seq) {
                    t.hint = None;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// Writes one placeholder per file at `at`, then asks the host to store each file.
    pub fn begin_uploads(&mut self, files: Vec<(String, FileSource)>, at: usize, cx: &mut Context<Self>) {
        if files.is_empty() || self.disabled {
            return;
        }
        let Some(_) = self.todo_id else {
            self.show_hint(CREATE_FIRST_HINT, cx);
            return;
        };
        let at = at.min(self.buf.content().len());
        let mut insert = String::new();
        let mut marks = Vec::new();
        for (name, _) in &files {
            if !insert.is_empty() {
                insert.push('\n');
            }
            let from = at + insert.len();
            insert.push_str(&md_edit::upload_placeholder(name));
            marks.push((from, at + insert.len()));
        }
        self.edit(cx, |b| b.replace(Some(at..at), &insert, EditKind::Other));
        let mut requests = Vec::new();
        for ((name, source), (from, to)) in files.into_iter().zip(marks) {
            let id = self.next_upload;
            self.next_upload += 1;
            self.uploads.push(UploadMark { id, from, to });
            requests.push(AttachRequest { upload: id, name, source });
        }
        for r in requests {
            cx.emit(MdEvent::Attach(r));
        }
    }

    /// Replaces a finished upload's placeholder with `insert`, or removes it when `insert` is empty.
    pub fn settle_upload(&mut self, id: u64, insert: &str, cx: &mut Context<Self>) {
        let Some(i) = self.uploads.iter().position(|u| u.id == id) else { return };
        let mark = self.uploads.remove(i);
        let (anchor, head) = (self.buf.anchor(), self.buf.head());
        let text = self.buf.content().to_string();
        let intact = text.get(mark.from..mark.to).is_some_and(|t| t.starts_with(md_edit::PLACEHOLDER_PREFIX));
        let (start, removed, new_text) = if intact {
            (mark.from, mark.to - mark.from, insert.to_string())
        } else if insert.is_empty() {
            return;
        } else {
            // The placeholder was edited away; the bytes are stored, so append the link.
            let prefix = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
            (text.len(), 0, format!("{prefix}{insert}"))
        };
        let old = text;
        self.buf.replace(Some(start..start + removed), &new_text, EditKind::Other);
        self.map_uploads(&old);
        let remap = |p: usize| md_edit::map_pos(p, start, removed, new_text.len(), 1);
        self.buf.set_selection(remap(anchor), remap(head));
        self.changed(cx);
    }

    fn files_at(&mut self, files: Vec<(String, FileSource)>, at: usize, cx: &mut Context<Self>) {
        self.begin_uploads(files, at, cx);
    }

    // ---- model ----

    fn model(&mut self) -> Arc<DocModel> {
        if let Some(m) = &self.model {
            if m.rev == self.rev {
                return m.clone();
            }
        }
        let text = self.buf.content().to_string();
        let sel = self.buf.selection();
        let previews = md_preview::live_preview_ranges(&text, &[sel], None);
        let tokens = md_preview::token_ranges(&text);
        for p in &previews {
            if let Some(src) = &p.widget_src {
                if !self.images.contains_key(src) {
                    let state = self.load_image(src);
                    self.images.insert(src.clone(), state);
                }
            }
        }
        let m = Arc::new(DocModel { rev: self.rev, text, previews, tokens, images: self.images.clone(), metrics: Metrics::of(self.variant) });
        self.model = Some(m.clone());
        m
    }

    fn load_image(&self, src: &str) -> ImgState {
        let path = match &self.resolver {
            Some(r) => r(src),
            None => None,
        }
        .or_else(|| {
            let lower = src.to_ascii_lowercase();
            if let Some(rest) = lower.strip_prefix("file:///") {
                let _ = rest;
                return Some(PathBuf::from(src["file:///".len()..].replace('/', "\\")));
            }
            let has_scheme = src.find(':').is_some_and(|i| i > 1);
            if has_scheme {
                return None;
            }
            let p = PathBuf::from(src);
            Some(if p.is_absolute() { p } else { self.image_base.clone()?.join(p) })
        });
        let Some(path) = path else { return ImgState::Missing };
        let Ok(bytes) = std::fs::read(&path) else { return ImgState::Missing };
        let Ok(img) = image::load_from_memory(&bytes) else { return ImgState::Missing };
        let mut rgba = img.to_rgba8();
        let (w, h) = (rgba.width() as f32, rgba.height() as f32);
        for px in rgba.pixels_mut() {
            px.0.swap(0, 2);
        }
        ImgState::Ready { img: Arc::new(RenderImage::new(vec![image::Frame::new(rgba)])), w, h }
    }

    // ---- actions ----

    fn backspace(&mut self, _: &ti::Backspace, _: &mut Window, cx: &mut Context<Self>) {
        if !self.buf.has_selection() && self.buf.marked_range().is_none() {
            if let Some(e) = md_edit::delete_markup_backward(self.buf.content(), self.buf.head()) {
                self.apply_edit(e, cx);
                return;
            }
        }
        self.edit(cx, |b| b.backspace());
    }
    fn delete(&mut self, _: &ti::Delete, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |b| b.delete_forward());
    }
    fn delete_word_backward(&mut self, _: &ti::DeleteWordBackward, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |b| b.delete_word_backward());
    }
    fn delete_word_forward(&mut self, _: &ti::DeleteWordForward, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |b| b.delete_word_forward());
    }

    fn enter(&mut self, _: &ti::Enter, _: &mut Window, cx: &mut Context<Self>) {
        if !self.buf.has_selection() && self.buf.marked_range().is_none() {
            if let Some(e) = md_edit::continue_markup(self.buf.content(), self.buf.head()) {
                self.apply_edit(e, cx);
                return;
            }
        }
        self.edit(cx, |b| b.replace(None, "\n", EditKind::Other));
    }

    fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(MdEvent::Submit);
    }

    fn escape(&mut self, _: &ti::Escape, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(if self.mode == MdMode::Modal { MdEvent::ModalCancel } else { MdEvent::Escape });
    }

    fn paste(&mut self, _: &ti::Paste, _: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = cx.read_from_clipboard() else { return };
        if let Some(text) = item.text() {
            self.edit(cx, |b| b.replace(None, &text, EditKind::Other));
            return;
        }
        let images: Vec<(String, FileSource)> = item
            .into_entries()
            .into_iter()
            .filter_map(|e| match e {
                ClipboardEntry::Image(i) => {
                    let (ext, mime) = match i.format {
                        ImageFormat::Jpeg => ("jpg", "image/jpeg"),
                        ImageFormat::Gif => ("gif", "image/gif"),
                        ImageFormat::Webp => ("webp", "image/webp"),
                        _ => ("png", "image/png"),
                    };
                    Some((format!("image.{ext}"), FileSource::Bytes { data: i.bytes, mime: mime.to_string() }))
                }
                _ => None,
            })
            .collect();
        let head = self.buf.head();
        self.files_at(images, head, cx);
    }

    fn copy(&mut self, _: &ti::Copy, _: &mut Window, cx: &mut Context<Self>) {
        if self.buf.has_selection() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.buf.selected_text().to_string()));
        }
    }

    fn cut(&mut self, _: &ti::Cut, _: &mut Window, cx: &mut Context<Self>) {
        if self.buf.has_selection() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.buf.selected_text().to_string()));
            self.edit(cx, |b| b.replace(None, "", EditKind::Other));
        }
    }

    fn undo(&mut self, _: &ti::Undo, _: &mut Window, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        let old = (!self.uploads.is_empty()).then(|| self.buf.content().to_string());
        if self.buf.undo() {
            if let Some(old) = old {
                self.map_uploads(&old);
            }
            self.changed(cx);
        }
    }

    fn redo(&mut self, _: &ti::Redo, _: &mut Window, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        let old = (!self.uploads.is_empty()).then(|| self.buf.content().to_string());
        if self.buf.redo() {
            if let Some(old) = old {
                self.map_uploads(&old);
            }
            self.changed(cx);
        }
    }

    fn move_h(&mut self, forward: bool, extend: bool, cx: &mut Context<Self>) {
        let sel = self.buf.selection();
        let target = if !extend && self.buf.has_selection() {
            if forward { sel.end } else { sel.start }
        } else if forward {
            self.buf.next_boundary(self.buf.head())
        } else {
            self.buf.prev_boundary(self.buf.head())
        };
        self.buf.move_to(target, extend);
        self.goal_x = None;
        self.moved(cx);
    }
    fn left(&mut self, _: &ti::Left, _: &mut Window, cx: &mut Context<Self>) {
        self.move_h(false, false, cx);
    }
    fn right(&mut self, _: &ti::Right, _: &mut Window, cx: &mut Context<Self>) {
        self.move_h(true, false, cx);
    }
    fn select_left(&mut self, _: &ti::SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_h(false, true, cx);
    }
    fn select_right(&mut self, _: &ti::SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_h(true, true, cx);
    }
    fn word_left(&mut self, _: &ti::WordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.prev_word_boundary(self.buf.head()), false);
        self.moved(cx);
    }
    fn word_right(&mut self, _: &ti::WordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.next_word_boundary(self.buf.head()), false);
        self.moved(cx);
    }
    fn select_word_left(&mut self, _: &ti::SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.prev_word_boundary(self.buf.head()), true);
        self.moved(cx);
    }
    fn select_word_right(&mut self, _: &ti::SelectWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.next_word_boundary(self.buf.head()), true);
        self.moved(cx);
    }

    fn move_v(&mut self, down: bool, extend: bool, cx: &mut Context<Self>) {
        let Some(layout) = self.layout.clone() else { return };
        let head = self.buf.head();
        let (p, lh) = layout.caret_geometry(head);
        let gx = *self.goal_x.get_or_insert(p.x);
        let ty = if down { p.y + lh * 1.5 } else { p.y - lh * 0.5 };
        let target = if ty < px(0.0) {
            0
        } else if ty >= layout.total {
            self.buf.content().len()
        } else {
            match layout.hit(point(gx, ty)) {
                Hit::Offset(o) => o,
                Hit::Checkbox(r) => r.start,
            }
        };
        self.buf.move_to(target, extend);
        self.moved(cx);
    }
    fn up(&mut self, _: &ti::Up, _: &mut Window, cx: &mut Context<Self>) {
        self.move_v(false, false, cx);
    }
    fn down(&mut self, _: &ti::Down, _: &mut Window, cx: &mut Context<Self>) {
        self.move_v(true, false, cx);
    }
    fn select_up(&mut self, _: &ti::SelectUp, _: &mut Window, cx: &mut Context<Self>) {
        self.move_v(false, true, cx);
    }
    fn select_down(&mut self, _: &ti::SelectDown, _: &mut Window, cx: &mut Context<Self>) {
        self.move_v(true, true, cx);
    }

    fn select_all(&mut self, _: &ti::SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.select_all();
        self.moved(cx);
    }
    fn home(&mut self, _: &ti::Home, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.line_start(self.buf.head()), false);
        self.moved(cx);
    }
    fn end(&mut self, _: &ti::End, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.line_end(self.buf.head()), false);
        self.moved(cx);
    }
    fn select_home(&mut self, _: &ti::SelectHome, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.line_start(self.buf.head()), true);
        self.moved(cx);
    }
    fn select_end(&mut self, _: &ti::SelectEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.line_end(self.buf.head()), true);
        self.moved(cx);
    }
    fn doc_start(&mut self, _: &ti::DocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(0, false);
        self.moved(cx);
    }
    fn doc_end(&mut self, _: &ti::DocEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.content().len(), false);
        self.moved(cx);
    }
    fn select_doc_start(&mut self, _: &ti::SelectDocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(0, true);
        self.moved(cx);
    }
    fn select_doc_end(&mut self, _: &ti::SelectDocEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.content().len(), true);
        self.moved(cx);
    }

    // ---- mouse ----

    fn local(&self, p: Point<Pixels>) -> Point<Pixels> {
        match self.bounds {
            Some(b) => p - b.origin,
            None => p,
        }
    }

    fn hit_at(&self, p: Point<Pixels>) -> Hit {
        match &self.layout {
            Some(l) => l.hit(self.local(p)),
            None => Hit::Offset(0),
        }
    }

    fn toggle_task(&mut self, marker: Range<usize>, cx: &mut Context<Self>) {
        let checked = self.buf.content().as_bytes().get(marker.start + 1) == Some(&b' ');
        let (anchor, head) = (self.buf.anchor(), self.buf.head());
        self.edit(cx, |b| {
            b.replace(Some(marker.start + 1..marker.start + 2), if checked { "x" } else { " " }, EditKind::Other);
            b.set_selection(anchor, head);
        });
    }

    fn on_mouse_down(&mut self, e: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        window.focus(&self.focus);
        let offset = match self.hit_at(e.position) {
            Hit::Checkbox(r) => {
                self.toggle_task(r, cx);
                return;
            }
            Hit::Offset(o) => o,
        };
        self.selecting = true;
        match e.click_count {
            2 => {
                let s = self.buf.prev_word_boundary(self.buf.next_word_boundary(offset));
                let en = self.buf.next_word_boundary(offset);
                self.buf.set_selection(s, en);
            }
            3 => {
                let s = self.buf.line_start(offset);
                let en = self.buf.line_end(offset);
                self.buf.set_selection(s, en);
            }
            _ => {
                if e.modifiers.shift {
                    self.buf.move_to(offset, true);
                } else {
                    self.buf.set_selection(offset, offset);
                }
            }
        }
        self.goal_x = None;
        self.moved(cx);
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
    }

    fn on_mouse_move(&mut self, e: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.selecting {
            if let Hit::Offset(o) = self.hit_at(e.position) {
                self.buf.move_to(o, true);
                self.moved(cx);
            }
        }
    }

    fn on_drop_paths(&mut self, paths: &ExternalPaths, window: &mut Window, cx: &mut Context<Self>) {
        let at = match self.hit_at(window.mouse_position()) {
            Hit::Offset(o) => o,
            Hit::Checkbox(r) => r.start,
        };
        let files = paths
            .paths()
            .iter()
            .filter(|p| p.is_file())
            .map(|p| (p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into()), FileSource::Path(p.clone())))
            .collect();
        self.files_at(files, at, cx);
    }
}

impl EntityInputHandler for MarkdownEditor {
    fn text_for_range(&mut self, r: Range<usize>, adjusted: &mut Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        let r = self.buf.range_from_utf16(&r);
        *adjusted = Some(self.buf.range_to_utf16(&r));
        Some(self.buf.content()[r].to_string())
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        let range = self.buf.range_to_utf16(&self.buf.selection());
        Some(UTF16Selection { range, reversed: self.buf.head() < self.buf.anchor() })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.buf.marked_range().map(|r| self.buf.range_to_utf16(&r))
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.unmark();
        self.rev += 1;
        cx.notify();
    }

    fn replace_text_in_range(&mut self, range: Option<Range<usize>>, text: &str, _: &mut Window, cx: &mut Context<Self>) {
        let r = range.map(|r| self.buf.range_from_utf16(&r));
        let text = text.to_string();
        self.edit(cx, |b| b.replace(r, &text, EditKind::Typing));
    }

    fn replace_and_mark_text_in_range(&mut self, range: Option<Range<usize>>, new_text: &str, new_selected: Option<Range<usize>>, _: &mut Window, cx: &mut Context<Self>) {
        let r = range.map(|r| self.buf.range_from_utf16(&r));
        let sel = new_selected.map(|s| {
            let to_byte = |u: usize| {
                let mut acc = 0;
                for (i, c) in new_text.char_indices() {
                    if acc >= u {
                        return i;
                    }
                    acc += c.len_utf16();
                }
                new_text.len()
            };
            to_byte(s.start)..to_byte(s.end)
        });
        let text = new_text.to_string();
        self.edit(cx, |b| b.replace_and_mark(r, &text, sel));
    }

    fn bounds_for_range(&mut self, range_utf16: Range<usize>, element_bounds: Bounds<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        let layout = self.layout.as_ref()?;
        let r = self.buf.range_from_utf16(&range_utf16);
        let (a, lh) = layout.caret_geometry(r.start);
        let (b, _) = layout.caret_geometry(r.end);
        let x1 = if b.y == a.y { b.x } else { a.x };
        let pad = px(Metrics::of(self.variant).pad_y);
        Some(Bounds::new(element_bounds.origin + a + point(px(0.0), pad), size((x1 - a.x).max(px(1.0)), lh)))
    }

    fn character_index_for_point(&mut self, p: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        let layout = self.layout.as_ref()?;
        let o = match layout.hit(self.local(p)) {
            Hit::Offset(o) => o,
            Hit::Checkbox(r) => r.start,
        };
        Some(self.buf.offset_to_utf16(o))
    }
}

impl Focusable for MarkdownEditor {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

// ------------------------------------------------------------------------------------------------
// Layout
// ------------------------------------------------------------------------------------------------

enum Hit {
    Offset(usize),
    Checkbox(Range<usize>),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SegKind {
    Keep,
    Hidden,
    Replaced,
}

struct Seg {
    src: Range<usize>,
    disp: Range<usize>,
    kind: SegKind,
}

struct CheckDeco {
    marker: Range<usize>,
    disp: Range<usize>,
    checked: bool,
}

struct TextBlock {
    wl: Option<WrappedLine>,
    segs: Vec<Seg>,
    disp_len: usize,
    lh: Pixels,
    left: Pixels,
    wrap: Pixels,
    quote: bool,
    hr: bool,
    checks: Vec<CheckDeco>,
}

struct ImageItem {
    img: Option<Arc<RenderImage>>,
    w: Pixels,
    h: Pixels,
    missing: Option<ShapedLine>,
}

struct ImageBlock {
    items: Vec<ImageItem>,
    left: Pixels,
    lead: Option<ShapedLine>,
}

struct TableBlock {
    cols: Vec<Pixels>,
    align: Vec<Align>,
    cells: Vec<Vec<ShapedLine>>,
    row_h: Pixels,
    left: Pixels,
}

enum BlockKind {
    Text(TextBlock),
    Image(ImageBlock),
    Table(TableBlock),
}

struct Block {
    src: Range<usize>,
    top: Pixels,
    height: Pixels,
    kind: BlockKind,
}

pub(crate) struct MdLayout {
    blocks: Vec<Block>,
    total: Pixels,
    base_lh: Pixels,
}

impl TextBlock {
    fn src_to_disp(&self, off: usize) -> usize {
        for s in &self.segs {
            if off < s.src.end || (off == s.src.end && s.src.is_empty()) {
                return match s.kind {
                    SegKind::Keep => s.disp.start + off.saturating_sub(s.src.start),
                    _ => s.disp.start,
                };
            }
        }
        self.disp_len
    }

    fn disp_to_src(&self, d: usize) -> usize {
        for s in &self.segs {
            if s.disp.is_empty() {
                continue;
            }
            if d < s.disp.end {
                return match s.kind {
                    SegKind::Keep => s.src.start + (d - s.disp.start),
                    _ => {
                        if d - s.disp.start < s.disp.len() / 2 { s.src.start } else { s.src.end }
                    }
                };
            }
        }
        self.segs.last().map_or(0, |s| s.src.end)
    }

    fn pos(&self, disp: usize) -> Point<Pixels> {
        match &self.wl {
            Some(wl) => wl.position_for_index(disp.min(wl.len()), self.lh).unwrap_or_default(),
            None => point(px(0.0), px(0.0)),
        }
    }
}

impl MdLayout {
    fn block_for_offset(&self, off: usize) -> usize {
        let i = self.blocks.partition_point(|b| b.src.start <= off);
        i.saturating_sub(1)
    }

    /// Caret position (relative to the content origin) and the height of its line.
    pub(crate) fn caret_geometry(&self, off: usize) -> (Point<Pixels>, Pixels) {
        let Some(b) = self.blocks.get(self.block_for_offset(off)) else { return (point(px(0.0), px(0.0)), self.base_lh) };
        match &b.kind {
            BlockKind::Text(t) => {
                let p = t.pos(t.src_to_disp(off));
                (point(t.left + p.x, b.top + p.y), t.lh)
            }
            BlockKind::Image(i) => (point(i.left, b.top), b.height),
            BlockKind::Table(t) => (point(t.left, b.top), b.height),
        }
    }

    fn hit(&self, p: Point<Pixels>) -> Hit {
        if self.blocks.is_empty() {
            return Hit::Offset(0);
        }
        let i = self.blocks.partition_point(|b| b.top + b.height <= p.y).min(self.blocks.len() - 1);
        let b = &self.blocks[i];
        match &b.kind {
            BlockKind::Text(t) => {
                for c in &t.checks {
                    let a = t.pos(c.disp.start);
                    let e = t.pos(c.disp.end);
                    let x0 = t.left + a.x;
                    let y0 = b.top + a.y;
                    if p.x >= x0 && p.x <= t.left + e.x && p.y >= y0 && p.y <= y0 + t.lh {
                        return Hit::Checkbox(c.marker.clone());
                    }
                }
                let Some(wl) = &t.wl else { return Hit::Offset(b.src.start) };
                let local = point((p.x - t.left).max(px(0.0)), (p.y - b.top).max(px(0.0)));
                let idx = match wl.closest_index_for_position(local, t.lh) {
                    Ok(i) | Err(i) => i,
                };
                Hit::Offset(t.disp_to_src(idx).min(b.src.end))
            }
            _ => Hit::Offset(b.src.start),
        }
    }
}

#[derive(Clone)]
struct St {
    color: Hsla,
    bold: bool,
    italic: bool,
    mono: bool,
    underline: bool,
    strike: bool,
    bg: Option<Hsla>,
    upper: bool,
}

impl St {
    fn base() -> Self {
        Self { color: col(TEXT), bold: false, italic: false, mono: false, underline: false, strike: false, bg: None, upper: false }
    }

    fn apply(&mut self, class: &str) {
        match class {
            "tok-heading" => {
                self.color = col(TN_PURPLE);
                self.bold = true;
            }
            "tok-strong" | "cm-md-strong" => {
                self.color = col(TEXT);
                self.bold = true;
            }
            "tok-emphasis" => {
                self.color = col(TEXT);
                self.italic = true;
            }
            "cm-md-em" => self.italic = true,
            // The highlighter styles these two nothing: revealed `~~x~~` and `code` read as plain text.
            "tok-strikethrough" | "tok-monospace" => {}
            "tok-link" | "tok-url" | "tok-list" => self.color = col(TN_BLUE),
            "tok-quote" | "cm-md-quote" => {
                self.color = col(TN_TEXT_DIM);
                self.italic = true;
            }
            "tok-meta" => self.color = col(TN_MUTED),
            "tok-keyword" => self.color = col(TN_PURPLE),
            "tok-string" => self.color = col(TN_GREEN),
            "tok-comment" => {
                self.color = col(TN_MUTED);
                self.italic = true;
            }
            "tok-number" => self.color = col(hex(0xff9e64)),
            "tok-property" => self.color = col(TN_BLUE),
            "tok-type" => self.color = col(TN_YELLOW),
            "tok-operator" => self.color = col(TN_TEXT_DIM),
            "cm-md-strike" => {
                self.color = col(TN_MUTED);
                self.strike = true;
            }
            "cm-md-code" => {
                self.color = col(TN_GREEN);
                self.mono = true;
                self.bg = Some(col(rgba(158, 206, 106, 0.08)));
            }
            "cm-md-link" => {
                self.color = col(TN_BLUE);
                self.underline = true;
            }
            "cm-md-fence" => {
                self.mono = true;
                self.bg = Some(col(rgba(122, 162, 247, 0.07)));
            }
            "cm-md-list-mark" | "cm-md-bullet" => {
                self.color = col(TN_BLUE);
                self.bold = true;
            }
            "cm-md-task-done" => {
                self.color = col(TN_MUTED);
                self.strike = true;
            }
            c if c.starts_with("cm-md-h") && c.len() == 8 => {
                self.color = col(TN_PURPLE);
                self.bold = true;
                self.upper = c.ends_with('5') || c.ends_with('6');
            }
            _ => {}
        }
    }

    fn run(&self, len: usize, underline_ime: bool) -> TextRun {
        let mut f = font(if self.mono { MONO_FONT } else { UI_FONT });
        if self.bold {
            f.weight = FontWeight::BOLD;
        }
        if self.italic {
            f.style = FontStyle::Italic;
        }
        let ul = self.underline || underline_ime;
        TextRun {
            len,
            font: f,
            color: self.color,
            background_color: self.bg,
            underline: ul.then(|| UnderlineStyle { thickness: px(1.0), color: Some(self.color), wavy: false }),
            strikethrough: self.strike.then(|| StrikethroughStyle { thickness: px(1.0), color: Some(self.color) }),
        }
    }
}

fn heading_scale(class: &str) -> Option<f32> {
    match class {
        "cm-md-h1" => Some(1.5),
        "cm-md-h2" => Some(1.3),
        "cm-md-h3" => Some(1.15),
        "cm-md-h4" => Some(1.05),
        "cm-md-h5" | "cm-md-h6" => Some(1.0),
        _ => None,
    }
}

fn shape_one(text: &str, size: Pixels, runs: &[TextRun], wrap: Option<Pixels>, window: &Window) -> Option<WrappedLine> {
    window.text_system().shape_text(SharedString::from(text.to_string()), size, runs, wrap, None).ok().and_then(|l| l.into_vec().into_iter().next())
}

fn shape_inline(text: &str, size: Pixels, st: &St, window: &Window) -> ShapedLine {
    let runs = [st.run(text.len(), false)];
    window.text_system().shape_line(SharedString::from(text.to_string()), size, &runs, None)
}

fn build_layout(m: &DocModel, width: Pixels, marked: Option<Range<usize>>, window: &Window) -> MdLayout {
    let mt = m.metrics;
    let base_size = px(mt.size);
    let base_lh = px(mt.line_height());
    let text = m.text.as_str();
    let em = mt.size;

    // line starts
    let mut starts = vec![0usize];
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            starts.push(i + 1);
        }
    }
    let line_of = |off: usize| starts.partition_point(|s| *s <= off.min(text.len())) - 1;
    let line_end = |l: usize| if l + 1 < starts.len() { starts[l + 1] - 1 } else { text.len() };

    // per-line ranges
    let mut per_line: Vec<Vec<usize>> = vec![Vec::new(); starts.len()];
    let mut line_classes: Vec<Vec<&str>> = vec![Vec::new(); starts.len()];
    let mut tables: Vec<usize> = Vec::new();
    for (i, p) in m.previews.iter().enumerate() {
        match p.kind {
            PreviewKind::Line => {
                if let Some(c) = &p.mark_class {
                    line_classes[line_of(p.from)].push(c.as_str());
                }
            }
            _ if p.widget_table.is_some() => tables.push(i),
            _ => {
                let (a, b) = (line_of(p.from), line_of(p.to.saturating_sub(1).max(p.from)));
                for l in a..=b {
                    per_line[l].push(i);
                }
            }
        }
    }
    let mut tok_line: Vec<Vec<usize>> = vec![Vec::new(); starts.len()];
    for (i, t) in m.tokens.iter().enumerate() {
        let (a, b) = (line_of(t.from), line_of(t.to.saturating_sub(1).max(t.from)));
        for l in a..=b {
            tok_line[l].push(i);
        }
    }

    let mut blocks: Vec<Block> = Vec::new();
    let mut top = px(0.0);
    let mut l = 0usize;
    let mut table_i = 0usize;
    while l < starts.len() {
        let (ls, le) = (starts[l], line_end(l));
        // a table starting on this line replaces it and every line it covers
        while table_i < tables.len() && line_of(m.previews[tables[table_i]].from) < l {
            table_i += 1;
        }
        if table_i < tables.len() && line_of(m.previews[tables[table_i]].from) == l {
            let p = &m.previews[tables[table_i]];
            let tb = build_table(p.widget_table.as_ref().unwrap(), mt, width, window);
            let margin = px(em * 0.2);
            let height = tb.row_h * (tb.cells.len() as f32) + px(1.0);
            let src = ls..p.to.max(ls);
            blocks.push(Block { src, top: top + margin, height, kind: BlockKind::Table(tb) });
            top += height + margin * 2.0;
            l = line_of(p.to.saturating_sub(1).max(p.from)) + 1;
            table_i += 1;
            continue;
        }

        // classes covering this line, outer constructs first
        let mut tok: Vec<&TokenRange> = tok_line[l].iter().map(|i| &m.tokens[*i]).collect();
        tok.sort_by(|a, b| a.from.cmp(&b.from).then(b.to.cmp(&a.to)));
        let mut prv: Vec<&PreviewRange> = per_line[l].iter().map(|i| &m.previews[*i]).collect();
        prv.sort_by(|a, b| a.from.cmp(&b.from).then(b.to.cmp(&a.to)));

        let mut bounds: Vec<usize> = vec![ls, le];
        for t in &tok {
            bounds.extend([t.from, t.to]);
        }
        for p in &prv {
            bounds.extend([p.from, p.to]);
        }
        bounds.retain(|b| *b >= ls && *b <= le);
        bounds.sort_unstable();
        bounds.dedup();

        let mut disp = String::new();
        let mut runs: Vec<TextRun> = Vec::new();
        let mut segs: Vec<Seg> = Vec::new();
        let mut checks: Vec<CheckDeco> = Vec::new();
        let mut scale = 1.0f32;
        let mut quote = false;
        let mut hr = false;
        let mut shift = false;
        let mut image_items: Vec<(String, String)> = Vec::new();
        let mut only_images = true;
        let mut lead_bullet = false;
        let mut done_widgets: Vec<usize> = Vec::new();

        for pair in bounds.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if b <= a {
                continue;
            }
            // a widget covering this interval
            if let Some((wi, w)) = prv.iter().enumerate().find(|(_, p)| p.kind == PreviewKind::Widget && p.from <= a && b <= p.to) {
                if done_widgets.contains(&wi) {
                    continue;
                }
                done_widgets.push(wi);
                let class = w.mark_class.as_deref().unwrap_or("");
                let d0 = disp.len();
                let mut st = St::base();
                match class {
                    "cm-md-bullet" => {
                        st.apply("cm-md-bullet");
                        disp.push_str(w.widget_text.as_deref().unwrap_or("\u{2022}"));
                        shift = true;
                        lead_bullet = true;
                    }
                    "cm-md-task" => {
                        // room for the box (13px) and its 0.4em margin
                        disp.push_str("\u{2003}\u{2002}");
                        checks.push(CheckDeco { marker: w.from..w.to, disp: d0..disp.len(), checked: w.widget_checked.unwrap_or(false) });
                        only_images = false;
                    }
                    "cm-md-hr" => {
                        hr = true;
                        only_images = false;
                    }
                    "cm-md-image" => {
                        let alt = w.widget_text.clone().unwrap_or_default();
                        image_items.push((w.widget_src.clone().unwrap_or_default(), alt.clone()));
                        st.apply("cm-md-link");
                        disp.push_str(if alt.trim().is_empty() { "image" } else { &alt });
                    }
                    _ => {
                        disp.push_str(w.widget_text.as_deref().unwrap_or(""));
                        only_images = false;
                    }
                }
                if class != "cm-md-bullet" && class != "cm-md-image" {
                    // other widgets keep the base style
                }
                if disp.len() > d0 {
                    runs.push(st.run(disp.len() - d0, false));
                }
                segs.push(Seg { src: w.from..w.to, disp: d0..disp.len(), kind: SegKind::Replaced });
                continue;
            }
            // hidden syntax
            if prv.iter().any(|p| p.kind == PreviewKind::Hide && p.from <= a && b <= p.to) {
                if prv.iter().any(|p| p.mark_class.as_deref() == Some("cm-md-quote")) {
                    quote = true;
                }
                segs.push(Seg { src: a..b, disp: disp.len()..disp.len(), kind: SegKind::Hidden });
                continue;
            }
            // visible source
            let mut st = St::base();
            for p in &prv {
                if p.kind == PreviewKind::Mark && p.from <= a && b <= p.to {
                    let class = p.mark_class.as_deref().unwrap_or("");
                    st.apply(class);
                    if let Some(s) = heading_scale(class) {
                        scale = s;
                    }
                    if class == "cm-md-fence" {
                        scale = scale.min(0.92);
                    }
                    if class == "cm-md-quote" {
                        quote = true;
                    }
                    if class == "cm-md-list-mark" {
                        shift = true;
                    }
                }
            }
            // The highlighter's span sits inside the preview mark's span, so its colour wins.
            for t in &tok {
                if t.from <= a && b <= t.to {
                    st.apply(t.class);
                }
            }
            let slice = &text[a..b];
            if !slice.trim().is_empty() {
                only_images = false;
            }
            let d0 = disp.len();
            let upper = st.upper && slice.to_uppercase().len() == slice.len();
            if upper {
                disp.push_str(&slice.to_uppercase());
            } else {
                disp.push_str(slice);
            }
            let ime = marked.as_ref().map(|r| (r.start.max(a), r.end.min(b))).filter(|(s, e)| s < e);
            match ime {
                Some((s, e)) => {
                    if s > a {
                        runs.push(st.run(s - a, false));
                    }
                    runs.push(st.run(e - s, true));
                    if e < b {
                        runs.push(st.run(b - e, false));
                    }
                }
                None => runs.push(st.run(b - a, false)),
            }
            segs.push(Seg { src: a..b, disp: d0..disp.len(), kind: SegKind::Keep });
        }

        let depth = line_classes[l]
            .iter()
            .filter_map(|c| c.strip_prefix("cm-md-li-depth-").and_then(|n| n.parse::<f32>().ok()))
            .fold(0.0f32, f32::max);
        let mut left = px(mt.pad_x + depth * LIST_STEP_EM * em);
        if shift {
            left -= px(LIST_STEP_EM * em);
        }

        // a line that is only images (and a bullet) lays the images out as a block
        if !image_items.is_empty() && only_images {
            let avail = (width - left - px(mt.pad_x)).max(px(40.0));
            let mut items = Vec::new();
            for (src, alt) in &image_items {
                match m.images.get(src) {
                    Some(ImgState::Ready { img, w, h }) => {
                        let s = (f32::from(avail) / w).min(IMAGE_MAX_HEIGHT / h).min(1.0);
                        items.push(ImageItem { img: Some(img.clone()), w: px(w * s), h: px(h * s), missing: None });
                    }
                    _ => {
                        let label = if alt.trim().is_empty() { "Missing image".to_string() } else { format!("Missing image: {alt}") };
                        let mut st = St::base();
                        st.color = col(hex(0x565f89));
                        let sl = shape_inline(&label, px(em * 0.85), &st, window);
                        let w = sl.width + px(22.0);
                        items.push(ImageItem { img: None, w, h: px(em * 0.85 * 1.6 + 14.0), missing: Some(sl) });
                    }
                }
            }
            let height = items.iter().fold(base_lh, |h, i| h.max(i.h));
            let lead = lead_bullet.then(|| {
                let mut st = St::base();
                st.apply("cm-md-bullet");
                shape_inline("\u{2022}", base_size, &st, window)
            });
            blocks.push(Block { src: ls..le, top, height, kind: BlockKind::Image(ImageBlock { items, left, lead }) });
            top += height;
            l += 1;
            continue;
        }

        let size = px(em * scale);
        let heading = scale > 1.0;
        let lh = if heading { px(em * scale * 1.35 + 2.0).max(base_lh) } else { base_lh };
        if quote {
            left += px(12.0);
        }
        let wrap = (width - left - px(mt.pad_x)).max(px(20.0));
        if runs.is_empty() {
            runs.push(St::base().run(0, false));
        }
        let wl = shape_one(&disp, size, &runs, Some(wrap), window);
        let height = wl.as_ref().map_or(lh, |w| w.size(lh).height).max(lh);
        blocks.push(Block {
            src: ls..le,
            top,
            height,
            kind: BlockKind::Text(TextBlock { wl, segs, disp_len: disp.len(), lh, left, wrap, quote, hr, checks }),
        });
        top += height;
        l += 1;
    }
    MdLayout { blocks, total: top, base_lh }
}

fn build_table(t: &PreviewTable, mt: Metrics, width: Pixels, window: &Window) -> TableBlock {
    let size = px(mt.size * 0.92);
    let mut cells: Vec<Vec<ShapedLine>> = Vec::new();
    let mut head = St::base();
    head.bold = true;
    cells.push(t.header.iter().map(|c| shape_inline(c, size, &head, window)).collect());
    let body = St::base();
    for r in &t.rows {
        cells.push(r.iter().map(|c| shape_inline(c, size, &body, window)).collect());
    }
    let n = t.header.len();
    let mut cols = vec![px(0.0); n];
    for row in &cells {
        for (i, c) in row.iter().enumerate().take(n) {
            cols[i] = cols[i].max(c.width);
        }
    }
    let cols: Vec<Pixels> = cols.into_iter().map(|w| w + px(21.0)).collect();
    let _ = width;
    TableBlock {
        cols,
        align: t.align.clone(),
        cells,
        row_h: px(mt.size * 0.92 * 1.6 + 9.0),
        left: px(mt.pad_x),
    }
}

// ------------------------------------------------------------------------------------------------
// Element
// ------------------------------------------------------------------------------------------------

struct EditorElement {
    view: Entity<MarkdownEditor>,
}

struct Prepaint {
    layout: Arc<MdLayout>,
    selections: Vec<PaintQuad>,
    caret: Option<PaintQuad>,
    placeholder: Option<WrappedLine>,
}

impl IntoElement for EditorElement {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

fn row_rects(t: &TextBlock, top: Pixels, a: usize, b: usize) -> Vec<Bounds<Pixels>> {
    let lh = t.lh;
    let pa = t.pos(a);
    let pb = t.pos(b);
    let rows = ((pb.y - pa.y) / lh).round() as i32;
    let mut out = Vec::new();
    for r in 0..=rows {
        let y = pa.y + lh * r as f32;
        let x0 = if r == 0 { pa.x } else { px(0.0) };
        let x1 = if r == rows { pb.x } else { t.wrap };
        if x1 > x0 {
            out.push(Bounds::new(point(t.left + x0, top + y), size(x1 - x0, lh)));
        }
    }
    out
}

impl Element for EditorElement {
    type RequestLayoutState = ();
    type PrepaintState = Prepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        let model = self.view.update(cx, |v, _| v.model());
        let min_h = px(model.metrics.line_height());
        let pad = px(model.metrics.pad_y);
        let mut s = Style::default();
        s.size.width = relative(1.0).into();
        let id = window.request_measured_layout(s, move |known, avail, window, _| {
            let w = known.width.or(match avail.width {
                AvailableSpace::Definite(w) => Some(w),
                _ => None,
            });
            let w = w.unwrap_or(px(300.0));
            let l = build_layout(&model, w, None, window);
            size(w, l.total.max(min_h) + pad * 2.0)
        });
        (id, ())
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), window: &mut Window, cx: &mut App) -> Prepaint {
        let model = self.view.update(cx, |v, _| v.model());
        let v = self.view.read(cx);
        let pad = px(model.metrics.pad_y);
        let layout = Arc::new(build_layout(&model, bounds.size.width, v.buf.marked_range(), window));
        let origin = bounds.origin + point(px(0.0), pad);
        let focused = v.focus.is_focused(window);
        let sel = v.buf.selection();
        let sel_color = col(rgba(122, 162, 247, if focused { 0.30 } else { 0.22 }));
        let mut selections = Vec::new();
        if sel.start != sel.end {
            for b in &layout.blocks {
                if b.src.end < sel.start || b.src.start > sel.end {
                    continue;
                }
                match &b.kind {
                    BlockKind::Text(t) => {
                        let a = t.src_to_disp(sel.start.max(b.src.start));
                        let e = if sel.end > b.src.end { t.disp_len } else { t.src_to_disp(sel.end) };
                        let mut rects = row_rects(t, b.top, a, e);
                        if sel.end > b.src.end {
                            // the selection runs on past this line's end: show the newline
                            let last = rects.pop();
                            if let Some(r) = last {
                                rects.push(Bounds::new(r.origin, size(r.size.width.max(px(4.0)), r.size.height)));
                            } else {
                                rects.push(Bounds::new(point(t.left, b.top), size(px(4.0), t.lh)));
                            }
                        }
                        for r in rects {
                            selections.push(fill(Bounds::new(origin + r.origin, r.size), sel_color));
                        }
                    }
                    _ => selections.push(fill(Bounds::new(origin + point(px(0.0), b.top), size(bounds.size.width, b.height)), sel_color)),
                }
            }
        }
        let caret = (focused && sel.start == sel.end && (v.blink_on || frozen())).then(|| {
            let (p, lh) = layout.caret_geometry(v.buf.head());
            fill(Bounds::new(origin + p, size(px(2.0), lh)), col(TN_BLUE))
        });
        let placeholder = if v.buf.is_empty() {
            let txt = v.placeholder.to_string();
            let mut st = St::base();
            st.color = col(hex(0x565f89));
            let runs = vec![st.run(txt.len(), false)];
            shape_one(&txt, px(model.metrics.size), &runs, Some(bounds.size.width - px(model.metrics.pad_x * 2.0)), window)
        } else {
            None
        };
        Prepaint { layout, selections, caret, placeholder }
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), pre: &mut Prepaint, window: &mut Window, cx: &mut App) {
        let focus = self.view.read(cx).focus.clone();
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.view.clone()), cx);
        let (mt, accent) = {
            let v = self.view.read(cx);
            (Metrics::of(v.variant), v.blink_on)
        };
        let _ = accent;
        let pad = px(mt.pad_y);
        let origin = bounds.origin + point(px(0.0), pad);
        let layout = pre.layout.clone();
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for q in pre.selections.drain(..) {
                window.paint_quad(q);
            }
            for b in &layout.blocks {
                let o = origin + point(px(0.0), b.top);
                match &b.kind {
                    BlockKind::Text(t) => {
                        if t.quote {
                            let bar = Bounds::new(origin + point(t.left - px(12.0), b.top + px(1.0)), size(px(2.0), b.height - px(2.0)));
                            window.paint_quad(fill(bar, col(rgba(122, 162, 247, 0.45))));
                        }
                        if t.hr {
                            let y = o.y + t.lh / 2.0;
                            let r = Bounds::new(point(bounds.left() + px(mt.pad_x), y), size(bounds.size.width - px(mt.pad_x * 2.0), px(1.0)));
                            window.paint_quad(fill(r, col(rgba(86, 95, 137, 0.7))));
                        }
                        if let Some(wl) = &t.wl {
                            let _ = wl.paint_background(o + point(t.left, px(0.0)), t.lh, TextAlign::Left, None, window, cx);
                            let _ = wl.paint(o + point(t.left, px(0.0)), t.lh, TextAlign::Left, None, window, cx);
                        }
                        for c in &t.checks {
                            let p = t.pos(c.disp.start);
                            let side = px(13.0);
                            let bx = Bounds::new(o + point(t.left + p.x, p.y + (t.lh - side) / 2.0 + px(0.5)), size(side, side));
                            if c.checked {
                                window.paint_quad(fill(bx, col(TN_BLUE)).corner_radii(px(2.0)));
                                let (x, y) = (bx.left(), bx.top());
                                for (dx, dy) in [(2.5, 6.0), (3.5, 7.0), (4.5, 8.0), (5.5, 7.0), (6.5, 6.0), (7.5, 5.0), (8.5, 4.0)] {
                                    window.paint_quad(fill(Bounds::new(point(x + px(dx), y + px(dy - 0.5)), size(px(1.8), px(1.8))), col(hex(0xffffff))));
                                }
                            } else {
                                window.paint_quad(fill(bx, col(hex(0xffffff))).corner_radii(px(2.0)));
                                window.paint_quad(outline(bx, col(hex(0x767676)), BorderStyle::Solid).corner_radii(px(2.0)));
                            }
                        }
                    }
                    BlockKind::Image(ib) => {
                        let mut x = ib.left;
                        if let Some(lead) = &ib.lead {
                            let _ = lead.paint(o + point(ib.left, px(0.0)), px(mt.line_height()), window, cx);
                            x += lead.width + px(4.0);
                        }
                        for it in &ib.items {
                            let r = Bounds::new(o + point(x, px(0.0)), size(it.w, it.h));
                            match (&it.img, &it.missing) {
                                (Some(img), _) => {
                                    let _ = window.paint_image(r, Corners::all(px(8.0)), img.clone(), 0, false);
                                }
                                (None, Some(sl)) => {
                                    window.paint_quad(outline(r, col(TN_RED), BorderStyle::Dashed).corner_radii(px(8.0)));
                                    let _ = sl.paint(r.origin + point(px(11.0), (it.h - px(mt.size * 0.85 * 1.6)) / 2.0), px(mt.size * 0.85 * 1.6), window, cx);
                                }
                                _ => {}
                            }
                            x += it.w + px(6.0);
                        }
                    }
                    BlockKind::Table(tb) => {
                        let ncols = tb.cols.len();
                        let total_w = tb.cols.iter().fold(px(1.0), |a, w| a + *w);
                        let border = col(rgba(41, 46, 66, 0.8));
                        let left = bounds.left() + tb.left;
                        for (ri, row) in tb.cells.iter().enumerate() {
                            let ry = o.y + tb.row_h * ri as f32;
                            if ri == 0 {
                                window.paint_quad(fill(Bounds::new(point(left, ry), size(total_w, tb.row_h)), col(rgba(122, 162, 247, 0.10))));
                            } else if ri % 2 == 0 {
                                window.paint_quad(fill(Bounds::new(point(left, ry), size(total_w, tb.row_h)), col(rgba(122, 162, 247, 0.04))));
                            }
                            let mut cx0 = left + px(1.0);
                            for (ci, cell) in row.iter().enumerate().take(ncols) {
                                let cw = tb.cols[ci];
                                let inner = cw - px(21.0);
                                let dx = match tb.align.get(ci).copied().unwrap_or(Align::None) {
                                    Align::Center => (inner - cell.width) / 2.0,
                                    Align::Right => inner - cell.width,
                                    _ => px(0.0),
                                };
                                let _ = cell.paint(point(cx0 + px(10.0) + dx, ry + px(4.5)), px(mt.size * 0.92 * 1.6), window, cx);
                                cx0 += cw;
                            }
                        }
                        for ri in 0..=tb.cells.len() {
                            window.paint_quad(fill(Bounds::new(point(left, o.y + tb.row_h * ri as f32), size(total_w, px(1.0))), border));
                        }
                        let mut x = left;
                        window.paint_quad(fill(Bounds::new(point(x, o.y), size(px(1.0), tb.row_h * tb.cells.len() as f32)), border));
                        for w in &tb.cols {
                            x += *w;
                            window.paint_quad(fill(Bounds::new(point(x, o.y), size(px(1.0), tb.row_h * tb.cells.len() as f32)), border));
                        }
                    }
                }
            }
            if let Some(wl) = &pre.placeholder {
                let _ = wl.paint(origin + point(px(mt.pad_x), px(0.0)), px(mt.line_height()), TextAlign::Left, None, window, cx);
            }
            if let Some(c) = pre.caret.take() {
                window.paint_quad(c);
            }
        });
        self.view.update(cx, |v, cx| {
            v.layout = Some(layout.clone());
            v.bounds = Some(Bounds::new(origin, size(bounds.size.width, bounds.size.height - pad * 2.0)));
            if v.ensure_caret_visible {
                v.ensure_caret_visible = false;
                let (p, lh) = layout.caret_geometry(v.buf.head());
                let view = v.scroll.bounds();
                let off = v.scroll.offset();
                let caret_top = origin.y + p.y;
                let caret_bottom = caret_top + lh;
                let margin = px(24.0);
                if view.size.height > px(0.0) {
                    if caret_bottom > view.bottom() - margin {
                        v.scroll.set_offset(point(off.x, off.y - (caret_bottom - view.bottom() + margin)));
                        cx.notify();
                    } else if caret_top < view.top() + px(10.0) {
                        v.scroll.set_offset(point(off.x, (off.y + (view.top() + px(10.0) - caret_top)).min(px(0.0))));
                        cx.notify();
                    }
                }
            }
        });
    }
}

// ------------------------------------------------------------------------------------------------
// Chrome
// ------------------------------------------------------------------------------------------------

impl MarkdownEditor {
    fn with_actions(&self, el: Stateful<Div>, cx: &mut Context<Self>) -> Stateful<Div> {
        el.key_context(ti::KEY_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::delete_word_backward))
            .on_action(cx.listener(Self::delete_word_forward))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::word_left))
            .on_action(cx.listener(Self::word_right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::select_word_left))
            .on_action(cx.listener(Self::select_word_right))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::select_home))
            .on_action(cx.listener(Self::select_end))
            .on_action(cx.listener(Self::doc_start))
            .on_action(cx.listener(Self::doc_end))
            .on_action(cx.listener(Self::select_doc_start))
            .on_action(cx.listener(Self::select_doc_end))
            .on_action(cx.listener(Self::enter))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::undo))
            .on_action(cx.listener(Self::redo))
            .on_action(cx.listener(Self::escape))
    }

    fn surface(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let view = cx.entity();
        div()
            .id(match self.mode {
                MdMode::Inline => "md-surface",
                MdMode::Modal => "md-surface-modal",
            })
            .w_full()
            .cursor(CursorStyle::IBeam)
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                this.on_drop_paths(paths, window, cx);
            }))
            .child(EditorElement { view })
    }

    fn hint_el(&self) -> Option<Div> {
        let (msg, _) = self.hint.as_ref()?;
        Some(
            Glass::new(6.0, 8.0, 1.0, Spec::rrect(6.0).solid(rgba(20, 16, 28, 0.92)).border(1.0, rgba(224, 175, 104, 0.35)))
                .shadows(&[sh(0.0, 4.0, 14.0, rgba(0, 0, 0, 0.35))])
                .el()
                .absolute()
                .left(px(8.0))
                .right(px(30.0))
                .bottom(px(8.0))
                .px(px(10.0))
                .py(px(6.0))
                .font_family(UI_FONT)
                .text_size(px(12.0))
                .text_color(col(TN_YELLOW))
                .child(msg.clone()),
        )
    }

    fn render_inline(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Stateful<Div> {
        let surface = self.surface(cx);
        let body: AnyElement = match self.variant {
            MdVariant::Bare => div().id("md-body").w_full().min_h(px(48.0)).child(surface).into_any_element(),
            MdVariant::Fill => div()
                .size_full()
                .child(
                    div().id("md-scroll").track_scroll(self.scroll.handle()).size_full().overflow_y_scroll().child(self.scroll.pad(surface)),
                )
                .child(self.scroll.bar())
                .into_any_element(),
            MdVariant::Framed => {
                let focused = self.focus.contains_focused(window, cx);
                let border = if focused { rgba(122, 162, 247, 0.5) } else { rgba(41, 46, 66, 0.8) };
                let mut glass = Glass::new(8.0, 8.0, 1.0, Spec::rrect(8.0).solid(rgba(12, 13, 24, 0.55)).border(1.0, border));
                if focused {
                    glass = glass.shadows(&[Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 3.0, color: rgba(122, 162, 247, 0.08) }]);
                }
                let scroller = div()
                    .id("md-scroll")
                    .track_scroll(self.scroll.handle())
                    .min_h(px(160.0))
                    .max_h(px(320.0))
                    .overflow_y_scroll()
                    .child(self.scroll.pad(surface));
                let mut pane = glass.el().w_full().overflow_hidden().child(div().m(px(1.0)).child(scroller).child(self.scroll.bar()));
                if self.expandable && !self.disabled {
                    pane = pane.child(
                        div()
                            .id("md-expand")
                            .absolute()
                            .right(px(0.0))
                            .bottom(px(0.0))
                            .w(px(22.0))
                            .h(px(18.0))
                            .rounded_tl(px(4.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .cursor_pointer()
                            .bg(lin(90.0, rgba(16, 17, 32, 0.0), rgba(16, 17, 32, 0.9)))
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(MdEvent::Expand)))
                            .child(svg().path("icons/expand.svg").size(px(14.0)).text_color(col(hex(0x7a8194)))),
                    );
                }
                pane.into_any_element()
            }
        };
        let mut host = div().id("md-editor").relative().w_full().opacity(if self.disabled { 0.4 } else { 1.0 });
        if self.variant == MdVariant::Fill {
            host = host.h_full();
        }
        let host = host.child(body).children(self.hint_el());
        self.with_actions(host, cx)
    }

    fn render_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Stateful<Div> {
        let _ = window;
        let spec = Spec::rrect(18.0)
            .fill(crate::css::linear(135.0, &[(0.0, wh(0.07)), (0.32, wh(0.01)), (0.55, crate::css::TRANSPARENT)]))
            .fill(crate::css::linear(315.0, &[(0.0, bk(0.08)), (0.40, crate::css::TRANSPARENT)]))
            .solid(rgba(20, 23, 42, 0.86))
            .border(1.0, rgba(122, 162, 247, 0.4))
            .inset(0.0, 1.0, wh(0.12))
            .inset(1.0, 0.0, wh(0.05))
            .inset(0.0, -1.0, bk(0.15))
            .inset(-1.0, 0.0, bk(0.05));
        let shd = [Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 1.0, color: bk(0.3) }, sh(0.0, 16.0, 40.0, bk(0.28))];
        let rule = |top: bool| layer(Spec::rrect(0.0).border_sides(if top { 1.0 } else { 0.0 }, 0.0, if top { 0.0 } else { 1.0 }, 0.0, hex(0x292e42)));
        let header = div()
            .relative()
            .flex_shrink_0()
            .px(px(18.0))
            .pt(px(14.0))
            .pb(px(10.0))
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .child(rule(false))
            .child(spaced(&self.title.to_uppercase(), 1.54).font_family(UI_FONT).text_size(px(11.0)).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT)))
            .child(
                div()
                    .id("md-modal-close")
                    .w(px(26.0))
                    .h(px(26.0))
                    .rounded(px(5.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(|s| s.bg(col(rgba(192, 202, 245, 0.08))))
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(MdEvent::ModalCancel)))
                    .child(svg().path("icons/win-close.svg").size(px(14.0)).text_color(col(TN_TEXT_DIM))),
            );
        let surface = self.surface(cx);
        let body = div().flex_1().min_h(px(0.0)).flex().flex_col().child(
            div()
                .id("md-modal-scroll")
                .track_scroll(self.scroll.handle())
                .flex_1()
                .min_h(px(0.0))
                .overflow_y_scroll()
                .child(self.scroll.pad(surface)),
        ).child(self.scroll.bar());
        let btn = |id: &'static str, label: &'static str, primary: bool| {
            let mut b = ui_text(13.0).id(id).h(px(32.0)).px(px(14.0)).rounded(px(6.0)).flex().items_center().cursor_pointer();
            b = if primary {
                b.bg(col(TN_BLUE)).text_color(col(TN_BG)).font_weight(FontWeight(600.0)).hover(|s| s.bg(col(hex(0x89b4f8))))
            } else {
                b.border_1().border_color(col(TN_MUTED)).text_color(col(TN_TEXT)).hover(|s| s.bg(col(rgba(192, 202, 245, 0.06))))
            };
            b.child(label)
        };
        let footer = div()
            .relative()
            .flex_shrink_0()
            .px(px(16.0))
            .py(px(12.0))
            .flex()
            .flex_row()
            .justify_end()
            .gap(px(8.0))
            .child(rule(true))
            .child(btn("md-modal-cancel", "Cancel", false).on_click(cx.listener(|_, _, _, cx| cx.emit(MdEvent::ModalCancel))))
            .child(btn("md-modal-done", "Done", true).on_click(cx.listener(|this, _, _, cx| cx.emit(MdEvent::ModalDone(this.buf.content().to_string())))));
        let dialog = Glass::new(18.0, 36.0, 1.7, spec)
            .shadows(&shd)
            .el()
            .w(relative(0.62))
            .min_w(px(480.0))
            .max_w(px(864.0))
            .h(relative(0.78))
            .max_h(px(704.0))
            .flex()
            .flex_col()
            .overflow_hidden()
            .child(header)
            .child(body)
            .child(footer);
        let overlay = Glass::new(0.0, 16.0, 1.25, Spec::rrect(0.0).solid(rgba(192, 202, 245, 0.06)))
            .el()
            .absolute()
            .top(px(0.0))
            .left(px(0.0))
            .right(px(0.0))
            .bottom(px(0.0))
            .flex()
            .items_center()
            .justify_center()
            .child(dialog);
        let host = div().id("md-modal").absolute().top(px(0.0)).left(px(0.0)).size_full().child(overlay).children(self.hint_el());
        self.with_actions(host, cx)
    }
}

impl Render for MarkdownEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        match self.mode {
            MdMode::Inline => self.render_inline(window, cx),
            MdMode::Modal => self.render_modal(window, cx),
        }
    }
}
