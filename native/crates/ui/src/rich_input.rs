//! `RichInput`: port of `RichTextInput.tsx`. Glass pane with a formatting toolbar, a rich-text
//! editing surface (bold, italic, strike, underline, code, bullet / ordered lists) and an expand
//! button that opens the same editor in a modal. Stored value: TipTap HTML (see `rich_doc.rs`).

use crate::css::{Spec, hex, rgba};
use crate::rich_doc::{Leaf, MarkKind, Marks, StyledText};
use crate::rich_state::{Pos, RichEdit, RichState};
use crate::text_input::{self as ti, LineLayouts, selection_rects};
use crate::ui::*;
use gpui::*;
use std::ops::Range;
use std::time::Duration;

actions!(
    lizmeter_rich_field,
    [ToggleBold, ToggleItalic, ToggleStrike, ToggleUnderline, ToggleCode, ToggleBullet, ToggleOrdered, HardBreak, Indent, Outdent]
);

/// Adds the rich-only bindings (shared editing keys come from `text_input::bind_keys`).
pub fn bind_keys(cx: &mut App) {
    let c = Some(ti::KEY_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("ctrl-b", ToggleBold, c),
        KeyBinding::new("ctrl-i", ToggleItalic, c),
        KeyBinding::new("ctrl-shift-s", ToggleStrike, c),
        KeyBinding::new("ctrl-u", ToggleUnderline, c),
        KeyBinding::new("ctrl-e", ToggleCode, c),
        KeyBinding::new("ctrl-shift-8", ToggleBullet, c),
        KeyBinding::new("ctrl-shift-7", ToggleOrdered, c),
        KeyBinding::new("shift-enter", HardBreak, c),
        KeyBinding::new("tab", Indent, c),
        KeyBinding::new("shift-tab", Outdent, c),
    ]);
}

pub const EDITOR_FONT: &str = UI_FONT;
const CODE_FONT: &str = "Cascadia Code";

pub enum RichEvent {
    /// The document changed; carries the TipTap HTML.
    Changed(String),
    /// The expand button was pressed.
    Expand,
    /// Modal: Done pressed (HTML to keep).
    ModalDone(String),
    /// Modal: closed without saving.
    ModalCancel,
}

impl EventEmitter<RichEvent> for RichInput {}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RichMode {
    Inline,
    Modal,
}

#[derive(Clone)]
struct RichStyle {
    size: Pixels,
    line_height: Pixels,
}

pub struct RichInput {
    focus: FocusHandle,
    state: RichState,
    placeholder: SharedString,
    disabled: bool,
    mode: RichMode,
    style: RichStyle,
    layout: Vec<LeafLayout>,
    bounds: Option<Bounds<Pixels>>,
    selecting: bool,
    goal_x: Option<Pixels>,
    blink_on: bool,
    blinking: bool,
    scroll: ScrollHandle,
    ensure_caret_visible: bool,
}

struct LeafLayout {
    top: Pixels,
    left: Pixels,
    ll: LineLayouts,
    marker: Option<Marker>,
}

enum Marker {
    Bullet(usize),
    Number(ShapedLine),
}

impl RichInput {
    pub fn new(html: &str, placeholder: &str, mode: RichMode, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        cx.on_focus(&focus, window, |this, _w, cx| this.start_blink(cx)).detach();
        cx.on_blur(&focus, window, |this, _w, cx| {
            this.blinking = false;
            this.state.unmark();
            cx.notify();
        })
        .detach();
        Self {
            focus,
            state: RichState::from_html(html),
            placeholder: placeholder.to_string().into(),
            disabled: false,
            mode,
            style: RichStyle { size: px(15.0), line_height: px(24.75) },
            layout: Vec::new(),
            bounds: None,
            selecting: false,
            goal_x: None,
            blink_on: true,
            blinking: false,
            scroll: ScrollHandle::new(),
            ensure_caret_visible: false,
        }
    }

    pub fn html(&self) -> String {
        self.state.to_html()
    }

    pub fn state(&self) -> &RichState {
        &self.state
    }

    /// External value change (reset): keeps history out of it, like TipTap's `setContent`.
    pub fn set_html(&mut self, html: &str, cx: &mut Context<Self>) {
        if self.state.to_html() != html {
            self.state.set_html(html);
            cx.notify();
        }
    }

    pub fn set_disabled(&mut self, disabled: bool, cx: &mut Context<Self>) {
        self.disabled = disabled;
        cx.notify();
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    fn start_blink(&mut self, cx: &mut Context<Self>) {
        self.blink_on = true;
        if self.blinking {
            return;
        }
        self.blinking = true;
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(530)).await;
                let keep = this
                    .update(cx, |t, cx| {
                        if !t.blinking {
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
        cx.notify();
    }

    fn changed(&mut self, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.touched(cx);
        cx.emit(RichEvent::Changed(self.state.to_html()));
    }

    // ---- edit actions ----

    fn backspace(&mut self, _: &ti::Backspace, _: &mut Window, cx: &mut Context<Self>) {
        self.state.backspace();
        self.changed(cx);
    }
    fn delete(&mut self, _: &ti::Delete, _: &mut Window, cx: &mut Context<Self>) {
        self.state.delete_forward();
        self.changed(cx);
    }
    fn delete_word_backward(&mut self, _: &ti::DeleteWordBackward, _: &mut Window, cx: &mut Context<Self>) {
        self.state.delete_word_backward();
        self.changed(cx);
    }
    fn delete_word_forward(&mut self, _: &ti::DeleteWordForward, _: &mut Window, cx: &mut Context<Self>) {
        self.state.delete_word_forward();
        self.changed(cx);
    }
    fn enter(&mut self, _: &ti::Enter, _: &mut Window, cx: &mut Context<Self>) {
        self.state.enter();
        self.changed(cx);
    }
    fn hard_break(&mut self, _: &HardBreak, _: &mut Window, cx: &mut Context<Self>) {
        self.state.hard_break();
        self.changed(cx);
    }
    fn escape(&mut self, _: &ti::Escape, _: &mut Window, cx: &mut Context<Self>) {
        if self.mode == RichMode::Modal {
            cx.emit(RichEvent::ModalCancel);
        }
    }
    fn indent(&mut self, _: &Indent, _: &mut Window, cx: &mut Context<Self>) {
        self.state.indent(true);
        self.changed(cx);
    }
    fn outdent(&mut self, _: &Outdent, _: &mut Window, cx: &mut Context<Self>) {
        self.state.indent(false);
        self.changed(cx);
    }
    fn paste(&mut self, _: &ti::Paste, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(t) = cx.read_from_clipboard().and_then(|c| c.text()) {
            self.state.replace(None, &t, RichEdit::Other);
            self.changed(cx);
        }
    }
    fn copy(&mut self, _: &ti::Copy, _: &mut Window, cx: &mut Context<Self>) {
        if self.state.has_selection() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.state.selected_plain()));
        }
    }
    fn cut(&mut self, _: &ti::Cut, _: &mut Window, cx: &mut Context<Self>) {
        if self.state.has_selection() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.state.selected_plain()));
            self.state.replace(None, "", RichEdit::Other);
            self.changed(cx);
        }
    }
    fn undo(&mut self, _: &ti::Undo, _: &mut Window, cx: &mut Context<Self>) {
        if self.state.undo() {
            self.changed(cx);
        }
    }
    fn redo(&mut self, _: &ti::Redo, _: &mut Window, cx: &mut Context<Self>) {
        if self.state.redo() {
            self.changed(cx);
        }
    }

    // ---- formatting ----

    fn mark(&mut self, kind: MarkKind, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        let had_selection = self.state.has_selection();
        self.state.toggle_mark(kind);
        if had_selection {
            self.changed(cx);
        } else {
            self.touched(cx);
        }
    }
    fn list(&mut self, ordered: bool, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        self.state.toggle_list(ordered);
        self.changed(cx);
    }
    fn toggle_bold(&mut self, _: &ToggleBold, _: &mut Window, cx: &mut Context<Self>) {
        self.mark(MarkKind::Bold, cx);
    }
    fn toggle_italic(&mut self, _: &ToggleItalic, _: &mut Window, cx: &mut Context<Self>) {
        self.mark(MarkKind::Italic, cx);
    }
    fn toggle_strike(&mut self, _: &ToggleStrike, _: &mut Window, cx: &mut Context<Self>) {
        self.mark(MarkKind::Strike, cx);
    }
    fn toggle_underline(&mut self, _: &ToggleUnderline, _: &mut Window, cx: &mut Context<Self>) {
        self.mark(MarkKind::Underline, cx);
    }
    fn toggle_code(&mut self, _: &ToggleCode, _: &mut Window, cx: &mut Context<Self>) {
        self.mark(MarkKind::Code, cx);
    }
    fn toggle_bullet(&mut self, _: &ToggleBullet, _: &mut Window, cx: &mut Context<Self>) {
        self.list(false, cx);
    }
    fn toggle_ordered(&mut self, _: &ToggleOrdered, _: &mut Window, cx: &mut Context<Self>) {
        self.list(true, cx);
    }

    // ---- movement ----

    fn move_to(&mut self, p: Pos, extend: bool, cx: &mut Context<Self>) {
        self.state.move_to(p, extend);
        self.goal_x = None;
        self.touched(cx);
    }
    fn left(&mut self, _: &ti::Left, _: &mut Window, cx: &mut Context<Self>) {
        let (s, _) = self.state.selection();
        let p = if self.state.has_selection() { s } else { self.state.prev_pos(self.state.head()) };
        self.move_to(p, false, cx);
    }
    fn right(&mut self, _: &ti::Right, _: &mut Window, cx: &mut Context<Self>) {
        let (_, e) = self.state.selection();
        let p = if self.state.has_selection() { e } else { self.state.next_pos(self.state.head()) };
        self.move_to(p, false, cx);
    }
    fn select_left(&mut self, _: &ti::SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.state.prev_pos(self.state.head()), true, cx);
    }
    fn select_right(&mut self, _: &ti::SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.state.next_pos(self.state.head()), true, cx);
    }
    fn word_left(&mut self, _: &ti::WordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.state.prev_word(self.state.head()), false, cx);
    }
    fn word_right(&mut self, _: &ti::WordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.state.next_word(self.state.head()), false, cx);
    }
    fn select_word_left(&mut self, _: &ti::SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.state.prev_word(self.state.head()), true, cx);
    }
    fn select_word_right(&mut self, _: &ti::SelectWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.state.next_word(self.state.head()), true, cx);
    }
    fn select_all(&mut self, _: &ti::SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.state.select_all();
        self.touched(cx);
    }
    fn home(&mut self, _: &ti::Home, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(Pos { leaf: self.state.head().leaf, off: 0 }, false, cx);
    }
    fn end(&mut self, _: &ti::End, _: &mut Window, cx: &mut Context<Self>) {
        let l = self.state.head().leaf;
        self.move_to(Pos { leaf: l, off: self.state.leaf_text(l).len() }, false, cx);
    }
    fn select_home(&mut self, _: &ti::SelectHome, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(Pos { leaf: self.state.head().leaf, off: 0 }, true, cx);
    }
    fn select_end(&mut self, _: &ti::SelectEnd, _: &mut Window, cx: &mut Context<Self>) {
        let l = self.state.head().leaf;
        self.move_to(Pos { leaf: l, off: self.state.leaf_text(l).len() }, true, cx);
    }
    fn doc_start(&mut self, _: &ti::DocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(Pos::default(), false, cx);
    }
    fn doc_end(&mut self, _: &ti::DocEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.end_pos(), false, cx);
    }
    fn select_doc_start(&mut self, _: &ti::SelectDocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(Pos::default(), true, cx);
    }
    fn select_doc_end(&mut self, _: &ti::SelectDocEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.end_pos(), true, cx);
    }
    fn end_pos(&self) -> Pos {
        let l = self.state.leaves().len() - 1;
        Pos { leaf: l, off: self.state.leaf_text(l).len() }
    }

    fn move_v(&mut self, down: bool, extend: bool, cx: &mut Context<Self>) {
        let Some(p) = self.point_for_pos(self.state.head()) else { return };
        let lh = self.style.line_height;
        let gx = *self.goal_x.get_or_insert(p.x);
        let ty = if down { p.y + lh * 1.5 } else { p.y - lh * 0.5 };
        let total = self.layout.last().map(|l| l.top + l.ll.total_height()).unwrap_or_default();
        let target = if ty < px(0.0) {
            Pos::default()
        } else if ty >= total {
            self.end_pos()
        } else {
            self.pos_for_point(point(gx, ty))
        };
        self.state.move_to(target, extend);
        self.touched(cx);
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

    // ---- geometry (content-local coordinates: origin at the editing surface's top-left) ----

    fn point_for_pos(&self, p: Pos) -> Option<Point<Pixels>> {
        let l = self.layout.get(p.leaf)?;
        let q = l.ll.position_for_offset(p.off);
        Some(point(l.left + q.x, l.top + q.y))
    }

    fn pos_for_point(&self, p: Point<Pixels>) -> Pos {
        for (i, l) in self.layout.iter().enumerate() {
            if p.y < l.top + l.ll.total_height() || i == self.layout.len() - 1 {
                let off = l.ll.offset_for_position(point(p.x - l.left, (p.y - l.top).max(px(0.0))));
                return self.state.clamp(Pos { leaf: i, off });
            }
        }
        Pos::default()
    }

    fn local(&self, p: Point<Pixels>) -> Point<Pixels> {
        let b = self.bounds.unwrap_or_default();
        point(p.x - b.left(), p.y - b.top())
    }

    fn on_mouse_down(&mut self, e: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        window.focus(&self.focus);
        self.selecting = true;
        let p = self.pos_for_point(self.local(e.position));
        match e.click_count {
            2 => {
                let s = self.state.prev_word(self.state.next_word(p));
                let en = self.state.next_word(p);
                self.state.set_selection(s, en);
            }
            3 => {
                let len = self.state.leaf_text(p.leaf).len();
                self.state.set_selection(Pos { leaf: p.leaf, off: 0 }, Pos { leaf: p.leaf, off: len });
            }
            _ => {
                if e.modifiers.shift {
                    self.state.move_to(p, true);
                } else {
                    self.state.set_selection(p, p);
                }
            }
        }
        self.goal_x = None;
        self.touched(cx);
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.selecting = false;
    }

    fn on_mouse_move(&mut self, e: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.selecting {
            let p = self.pos_for_point(self.local(e.position));
            self.state.move_to(p, true);
            self.touched(cx);
        }
    }
}

impl EntityInputHandler for RichInput {
    fn text_for_range(&mut self, r: Range<usize>, adjusted: &mut Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        let flat = self.state.flat_text();
        let (a, b) = (self.state.flat_from_utf16(r.start), self.state.flat_from_utf16(r.end));
        *adjusted = Some(self.state.flat_to_utf16(a)..self.state.flat_to_utf16(b));
        Some(flat[a..b.max(a)].to_string())
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        let (s, e) = self.state.selection();
        let (a, b) = (self.state.flat_offset(s), self.state.flat_offset(e));
        Some(UTF16Selection {
            range: self.state.flat_to_utf16(a)..self.state.flat_to_utf16(b),
            reversed: self.state.head() < self.state.anchor(),
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        let (leaf, r) = self.state.marked()?;
        let a = self.state.flat_offset(Pos { leaf, off: r.start });
        let b = self.state.flat_offset(Pos { leaf, off: r.end });
        Some(self.state.flat_to_utf16(a)..self.state.flat_to_utf16(b))
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.state.unmark();
    }

    fn replace_text_in_range(&mut self, range: Option<Range<usize>>, text: &str, _: &mut Window, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        let r = range.map(|r| {
            (
                self.state.pos_from_flat(self.state.flat_from_utf16(r.start)),
                self.state.pos_from_flat(self.state.flat_from_utf16(r.end)),
            )
        });
        self.state.replace(r, text, RichEdit::Typing);
        self.changed(cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        new_text: &str,
        new_selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.disabled {
            return;
        }
        let r = range.map(|r| {
            (
                self.state.pos_from_flat(self.state.flat_from_utf16(r.start)),
                self.state.pos_from_flat(self.state.flat_from_utf16(r.end)),
            )
        });
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
        self.state.replace_and_mark(r, new_text, sel);
        self.changed(cx);
    }

    fn bounds_for_range(&mut self, range: Range<usize>, element_bounds: Bounds<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        let a = self.state.pos_from_flat(self.state.flat_from_utf16(range.start));
        let b = self.state.pos_from_flat(self.state.flat_from_utf16(range.end));
        let pa = self.point_for_pos(a)?;
        let pb = self.point_for_pos(b)?;
        let x1 = if pb.y == pa.y { pb.x } else { pa.x };
        Some(Bounds::new(
            point(element_bounds.left() + pa.x, element_bounds.top() + pa.y),
            size((x1 - pa.x).max(px(1.0)), self.style.line_height),
        ))
    }

    fn character_index_for_point(&mut self, p: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        let pos = self.pos_for_point(self.local(p));
        Some(self.state.flat_to_utf16(self.state.flat_offset(pos)))
    }
}

impl Focusable for RichInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

// ------------------------------------------------------------------ layout

const TEXT: C = TN_TEXT;
const CODE_COLOR: C = hex(0x7dcfff);
const STRIKE_COLOR: C = hex(0xa9b1d6);
const MARKER_COLOR: C = hex(0x7a8194);
const INDENT: f32 = 21.0;

use crate::css::C;

fn leaf_gap(prev: Option<&Leaf>, cur: &Leaf) -> f32 {
    let Some(prev) = prev else { return 0.0 };
    match (prev.list, cur.list) {
        (Some(p), Some(c)) if p.depth == c.depth && p.ordered == c.ordered => 2.0,
        _ => 4.0,
    }
}

fn text_run(len: usize, marks: &Marks, underline: bool) -> TextRun {
    let (family, color) = if marks.code {
        (CODE_FONT, col(CODE_COLOR))
    } else if marks.link.is_some() {
        (EDITOR_FONT, col(TN_BLUE))
    } else if marks.strike {
        (EDITOR_FONT, col(STRIKE_COLOR))
    } else if marks.italic {
        (EDITOR_FONT, col(TN_TEXT_DIM))
    } else {
        (EDITOR_FONT, col(TEXT))
    };
    let mut f = font(family);
    if marks.bold {
        f.weight = FontWeight::BOLD;
    }
    if marks.italic {
        f.style = FontStyle::Italic;
    }
    TextRun {
        len,
        font: f,
        color,
        background_color: marks.code.then(|| col(rgba(26, 27, 46, 0.8))),
        underline: (marks.underline || marks.link.is_some() || underline)
            .then(|| UnderlineStyle { thickness: px(1.0), color: Some(color), wavy: false }),
        strikethrough: marks.strike.then(|| StrikethroughStyle { thickness: px(1.0), color: Some(color) }),
    }
}

fn runs_for(text: &StyledText, marked: Option<Range<usize>>) -> Vec<TextRun> {
    let mut out = Vec::new();
    let mut pos = 0;
    for r in text.runs() {
        let (rs, re) = (pos, pos + r.text.len());
        pos = re;
        match &marked {
            Some(m) if m.start < re && m.end > rs => {
                let a = m.start.max(rs);
                let b = m.end.min(re);
                if a > rs {
                    out.push(text_run(a - rs, &r.marks, false));
                }
                out.push(text_run(b - a, &r.marks, true));
                if b < re {
                    out.push(text_run(re - b, &r.marks, false));
                }
            }
            _ => out.push(text_run(r.text.len(), &r.marks, false)),
        }
    }
    out
}

fn layout_leaves(
    leaves: &[Leaf],
    numbers: &[Option<u32>],
    marked: Option<(usize, Range<usize>)>,
    st: &RichStyle,
    width: Pixels,
    window: &Window,
) -> Vec<LeafLayout> {
    let mut out = Vec::with_capacity(leaves.len());
    let mut top = px(0.0);
    for (i, leaf) in leaves.iter().enumerate() {
        top += px(leaf_gap(i.checked_sub(1).map(|j| &leaves[j]), leaf));
        let left = leaf.list.map(|l| px(INDENT * (l.depth as f32 + 1.0))).unwrap_or_default();
        let text = leaf.text.text();
        let runs = runs_for(&leaf.text, marked.as_ref().filter(|(l, _)| *l == i).map(|(_, r)| r.clone()));
        let lines = if text.is_empty() {
            let r = vec![text_run(0, &Marks::default(), false)];
            ti_shape(&text, st, r, width - left, window)
        } else {
            ti_shape(&text, st, runs, width - left, window)
        };
        let mut starts = Vec::new();
        let mut p = 0;
        for l in &lines {
            starts.push(p);
            p += l.len() + 1;
        }
        if lines.is_empty() {
            starts.push(0);
        }
        let ll = LineLayouts { lines, starts, line_height: st.line_height };
        let marker = leaf.list.map(|l| {
            if l.ordered {
                let txt = format!("{}.", numbers[i].unwrap_or(1));
                let runs = [TextRun {
                    len: txt.len(),
                    font: font(EDITOR_FONT),
                    color: col(MARKER_COLOR),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                }];
                Marker::Number(window.text_system().shape_line(txt.into(), st.size, &runs, None))
            } else {
                Marker::Bullet(l.depth)
            }
        });
        let h = ll.total_height().max(st.line_height);
        out.push(LeafLayout { top, left, ll, marker });
        top += h;
    }
    out
}

fn ti_shape(text: &str, st: &RichStyle, runs: Vec<TextRun>, wrap: Pixels, window: &Window) -> Vec<WrappedLine> {
    let fs = ti::FieldStyle {
        family: EDITOR_FONT.into(),
        size: st.size,
        line_height: st.line_height,
        color: col(TEXT),
        placeholder_color: col(TEXT),
        selection: col(TEXT),
        caret: col(TEXT),
        weight: FontWeight::NORMAL,
    };
    ti::shape(text, &fs, runs, Some(wrap), window)
}

struct EditorElement {
    view: Entity<RichInput>,
}

struct Prepaint {
    layout: Vec<LeafLayout>,
    selections: Vec<PaintQuad>,
    caret: Option<PaintQuad>,
    placeholder: Vec<WrappedLine>,
    placeholder_opacity: f32,
}

impl IntoElement for EditorElement {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
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
        let v = self.view.read(cx);
        let leaves: Vec<Leaf> = v.state.leaves().to_vec();
        let numbers: Vec<Option<u32>> = (0..leaves.len()).map(|i| v.state.list_number(i)).collect();
        let st = v.style.clone();
        let mut s = Style::default();
        s.size.width = relative(1.0).into();
        let id = window.request_measured_layout(s, move |known, avail, window, _| {
            let w = known.width.or(match avail.width {
                AvailableSpace::Definite(w) => Some(w),
                _ => None,
            });
            let w = w.unwrap_or(px(300.0));
            let l = layout_leaves(&leaves, &numbers, None, &st, w, window);
            let h = l.last().map(|l| l.top + l.ll.total_height().max(st.line_height)).unwrap_or(st.line_height);
            size(w, h)
        });
        (id, ())
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), window: &mut Window, cx: &mut App) -> Prepaint {
        let v = self.view.read(cx);
        let numbers: Vec<Option<u32>> = (0..v.state.leaves().len()).map(|i| v.state.list_number(i)).collect();
        let layout = layout_leaves(v.state.leaves(), &numbers, v.state.marked(), &v.style, bounds.size.width, window);
        let focused = v.focus.is_focused(window);
        let (s, e) = v.state.selection();
        let sel_color = col(rgba(122, 162, 247, 0.28));
        let mut selections = Vec::new();
        if s != e {
            for i in s.leaf..=e.leaf {
                let Some(l) = layout.get(i) else { continue };
                let len = v.state.leaf_text(i).len();
                let a = if i == s.leaf { s.off } else { 0 };
                let b = if i == e.leaf { e.off } else { len };
                let width = bounds.size.width - l.left;
                let rects = if b > a {
                    selection_rects(&l.ll, a..b, width, false)
                } else if i != e.leaf {
                    vec![Bounds::new(point(px(0.0), px(0.0)), size(px(4.0), v.style.line_height))]
                } else {
                    vec![]
                };
                for r in rects {
                    let o = bounds.origin + point(l.left, l.top);
                    selections.push(fill(Bounds::new(o + r.origin, r.size), sel_color));
                }
            }
        }
        let head = v.state.head();
        let caret = (focused && s == e && v.blink_on).then(|| {
            let l = &layout[head.leaf];
            let q = l.ll.position_for_offset(head.off);
            let o = bounds.origin + point(l.left + q.x, l.top + q.y);
            fill(Bounds::new(o, size(px(1.0), v.style.line_height)), col(TEXT))
        });
        let (placeholder, placeholder_opacity) = if v.state.is_empty() {
            let txt = v.placeholder.to_string();
            let runs = vec![TextRun {
                len: txt.len(),
                font: font(EDITOR_FONT),
                color: col(hex(0x7a8194)),
                background_color: None,
                underline: None,
                strikethrough: None,
            }];
            let lines = ti_shape(&txt, &v.style, runs, bounds.size.width, window);
            let t = match anim_time() {
                Some(ms) => ms,
                None if frozen() => FREEZE_T * 4000.0,
                None => {
                    window.request_animation_frame();
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f32).unwrap_or(0.0)
                }
            };
            // placeholderBreath: 4s ease-in-out infinite, opacity .55 <-> .85
            let ph = (t % 4000.0) / 4000.0;
            let wave = 0.5 - 0.5 * (ph * std::f32::consts::TAU).cos();
            (lines, 0.55 + 0.30 * wave)
        } else {
            (Vec::new(), 1.0)
        };
        Prepaint { layout, selections, caret, placeholder, placeholder_opacity }
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), pre: &mut Prepaint, window: &mut Window, cx: &mut App) {
        let focus = self.view.read(cx).focus.clone();
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.view.clone()), cx);
        let lh = self.view.read(cx).style.line_height;
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for q in pre.selections.drain(..) {
                window.paint_quad(q);
            }
            for l in &pre.layout {
                let origin = bounds.origin + point(l.left, l.top);
                let mut y = px(0.0);
                for line in &l.ll.lines {
                    let _ = line.paint(origin + point(px(0.0), y), lh, TextAlign::Left, None, window, cx);
                    y += line.size(lh).height;
                }
                match &l.marker {
                    Some(Marker::Bullet(depth)) => {
                        let d = px(5.0);
                        let x = origin.x - px(14.0);
                        let cy = origin.y + lh / 2.0 - d / 2.0;
                        let c = col(MARKER_COLOR);
                        let b = Bounds::new(point(x, cy), size(d, d));
                        window.paint_quad(match depth {
                            0 => fill(b, c).corner_radii(d / 2.0),
                            1 => outline(b, c, BorderStyle::Solid).corner_radii(d / 2.0),
                            _ => fill(b, c),
                        });
                    }
                    Some(Marker::Number(shaped)) => {
                        let x = origin.x - shaped.width - px(5.0);
                        let _ = shaped.paint(point(x, origin.y), lh, window, cx);
                    }
                    None => {}
                }
            }
            if !pre.placeholder.is_empty() {
                let mut y = px(0.0);
                for line in &pre.placeholder {
                    let _ = line.paint(bounds.origin + point(px(0.0), y), lh, TextAlign::Left, None, window, cx);
                    y += line.size(lh).height;
                }
            }
            if let Some(c) = pre.caret.take() {
                window.paint_quad(c);
            }
        });
        let _ = pre.placeholder_opacity;
        let layout = std::mem::take(&mut pre.layout);
        self.view.update(cx, |v, cx| {
            v.layout = layout;
            v.bounds = Some(bounds);
            if v.ensure_caret_visible {
                v.ensure_caret_visible = false;
                if let Some(p) = v.point_for_pos(v.state.head()) {
                    let view = v.scroll.bounds();
                    let off = v.scroll.offset();
                    let abs_y = bounds.top() + p.y + off.y - view.top() + px(0.0);
                    let _ = abs_y;
                    let caret_top = bounds.top() + p.y;
                    let caret_bottom = caret_top + v.style.line_height;
                    if caret_bottom > view.bottom() - px(24.0) {
                        v.scroll.set_offset(point(off.x, off.y - (caret_bottom - view.bottom() + px(24.0))));
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

// ------------------------------------------------------------------ chrome

fn icon_btn(
    id: &'static str,
    icon: &'static str,
    title: &'static str,
    active: bool,
    cx: &mut Context<RichInput>,
    on_click: impl Fn(&mut RichInput, &mut Window, &mut Context<RichInput>) + 'static,
) -> impl IntoElement {
    let _ = title;
    let mut b = div()
        .id(id)
        .w(px(28.0))
        .h(px(26.0))
        .rounded(px(5.0))
        .border_1()
        .border_color(rgba_h(0.0))
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .text_color(col(TN_TEXT_DIM));
    if active {
        b = b
            .text_color(col(TN_BLUE))
            .bg(col(rgba(122, 162, 247, 0.10)))
            .border_color(col(rgba(122, 162, 247, 0.18)))
            .hover(|s| s.bg(col(rgba(122, 162, 247, 0.16))).border_color(col(rgba(122, 162, 247, 0.28))));
    } else {
        b = b.hover(|s| s.text_color(col(TN_TEXT)).bg(col(rgba(192, 202, 245, 0.06))));
    }
    b.on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
        .on_click(cx.listener(move |this, _, window, cx| {
            on_click(this, window, cx);
            window.focus(&this.focus);
        }))
        .child(svg().path(icon).size(px(14.0)).text_color(if active { col(TN_BLUE) } else { col(TN_TEXT_DIM) }))
}

fn rgba_h(a: f32) -> Hsla {
    col(rgba(0, 0, 0, a))
}

fn toolbar_sep() -> impl IntoElement {
    div().w(px(1.0)).h(px(14.0)).mx(px(5.0)).flex_shrink_0().bg(col(rgba(86, 95, 137, 0.5)))
}

impl RichInput {
    fn toolbar(&self, cx: &mut Context<Self>) -> Div {
        let st = &self.state;
        let (b, i, s, c) = (
            st.is_active(MarkKind::Bold),
            st.is_active(MarkKind::Italic),
            st.is_active(MarkKind::Strike),
            st.is_active(MarkKind::Code),
        );
        let (ul, ol) = (st.is_list_active(false), st.is_list_active(true));
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(2.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(1.0))
                    .child(icon_btn("tb-bold", "icons/bold.svg", "Bold (Ctrl+B)", b, cx, |t, _, cx| t.mark(MarkKind::Bold, cx)))
                    .child(icon_btn("tb-italic", "icons/italic.svg", "Italic (Ctrl+I)", i, cx, |t, _, cx| t.mark(MarkKind::Italic, cx)))
                    .child(icon_btn("tb-strike", "icons/strike.svg", "Strikethrough", s, cx, |t, _, cx| t.mark(MarkKind::Strike, cx))),
            )
            .child(toolbar_sep())
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(1.0))
                    .child(icon_btn("tb-bullets", "icons/bullets.svg", "Bullet list", ul, cx, |t, _, cx| t.list(false, cx)))
                    .child(icon_btn("tb-numbered", "icons/numbered.svg", "Numbered list", ol, cx, |t, _, cx| t.list(true, cx))),
            )
            .child(toolbar_sep())
            .child(div().flex().flex_row().child(icon_btn("tb-code", "icons/code.svg", "Inline code", c, cx, |t, _, cx| t.mark(MarkKind::Code, cx))))
    }

    fn with_actions(&self, el: Stateful<Div>, cx: &mut Context<Self>) -> Stateful<Div> {
        el.key_context(ti::KEY_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::delete_word_backward))
            .on_action(cx.listener(Self::delete_word_forward))
            .on_action(cx.listener(Self::enter))
            .on_action(cx.listener(Self::hard_break))
            .on_action(cx.listener(Self::escape))
            .on_action(cx.listener(Self::indent))
            .on_action(cx.listener(Self::outdent))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::undo))
            .on_action(cx.listener(Self::redo))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::word_left))
            .on_action(cx.listener(Self::word_right))
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
            .on_action(cx.listener(Self::toggle_bold))
            .on_action(cx.listener(Self::toggle_italic))
            .on_action(cx.listener(Self::toggle_strike))
            .on_action(cx.listener(Self::toggle_underline))
            .on_action(cx.listener(Self::toggle_code))
            .on_action(cx.listener(Self::toggle_bullet))
            .on_action(cx.listener(Self::toggle_ordered))
    }

    fn surface(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let view = cx.entity();
        div()
            .id(match self.mode {
                RichMode::Inline => "rich-surface",
                RichMode::Modal => "rich-surface-modal",
            })
            .cursor(CursorStyle::IBeam)
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .child(EditorElement { view })
    }

    fn render_inline(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Stateful<Div> {
        let focused = self.focus.contains_focused(window, cx);
        let border = if focused { rgba(122, 162, 247, 0.4) } else { rgba(59, 66, 97, 0.7) };
        let mut glass = Glass::new(10.0, 12.0, 1.0, Spec::rrect(10.0).solid(rgba(16, 17, 32, 0.72)).border(1.0, border));
        if focused {
            glass = glass.shadows(&[
                Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 1.0, color: rgba(122, 162, 247, 0.12) },
                Sh { dx: 0.0, dy: 4.0, blur: 24.0, spread: -4.0, color: rgba(122, 162, 247, 0.08) },
            ]);
        }
        let toolbar = div()
            .relative()
            .px(px(8.0))
            .pt(px(4.0))
            .pb(px(5.0))
            .opacity(if focused { 1.0 } else { 0.65 })
            .child(layer(Spec::rrect(0.0).border_sides(0.0, 0.0, 1.0, 0.0, rgba(59, 66, 97, 0.6))))
            .child(self.toolbar(cx));
        let surface = self.surface(cx);
        let editor = div()
            .id("rich-scroll")
            .track_scroll(&self.scroll)
            .min_h(px(56.0))
            .max_h(px(120.0))
            .overflow_y_scroll()
            .child(div().px(px(12.0)).pt(px(10.0)).pb(px(24.0)).child(surface));
        let expand = div()
            .id("rich-expand")
            .absolute()
            .right(px(0.0))
            .bottom(px(0.0))
            .w(px(20.0))
            .h(px(16.0))
            .rounded_tl(px(4.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .bg(lin(90.0, rgba(16, 17, 32, 0.0), rgba(16, 17, 32, 0.9)))
            .on_click(cx.listener(|_, _, _, cx| cx.emit(RichEvent::Expand)))
            .child(svg().path("icons/expand.svg").size(px(14.0)).text_color(col(hex(0x7a8194))));
        let pane = glass
            .el()
            .w_full()
            .flex()
            .flex_row()
            .overflow_hidden()
            .child(div().ml(px(1.0)).mt(px(1.0)).mb(px(1.0)).w(px(2.0)).flex_shrink_0().bg(col(if focused { TN_BLUE } else { hex(0x292e42) })))
            .child(div().flex_1().min_w(px(0.0)).flex().flex_col().mt(px(1.0)).mb(px(1.0)).child(toolbar).child(editor))
            .child(expand);
        let host = div().id("rich-input").w_full().opacity(if self.disabled { 0.4 } else { 1.0 }).child(pane);
        self.with_actions(host, cx)
    }

    fn render_modal(&mut self, cx: &mut Context<Self>) -> Stateful<Div> {
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
        let header = div()
            .relative()
            .flex_shrink_0()
            .px(px(16.0))
            .pt(px(14.0))
            .pb(px(10.0))
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .child(layer(Spec::rrect(0.0).border_sides(0.0, 0.0, 1.0, 0.0, hex_a(0x292e42))))
            .child(ui_text(14.0).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child("Edit Description"))
            .child(
                div()
                    .id("modal-close")
                    .w(px(26.0))
                    .h(px(26.0))
                    .rounded(px(5.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(|s| s.bg(col(rgba(192, 202, 245, 0.08))))
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(RichEvent::ModalCancel)))
                    .child(svg().path("icons/win-close.svg").size(px(14.0)).text_color(col(TN_TEXT_DIM))),
            );
        let toolbar = div()
            .relative()
            .flex_shrink_0()
            .px(px(12.0))
            .py(px(8.0))
            .child(layer(Spec::rrect(0.0).border_sides(0.0, 0.0, 1.0, 0.0, hex_a(0x292e42))))
            .child(self.toolbar(cx));
        let surface = self.surface(cx);
        let body = div()
            .id("rich-modal-scroll")
            .track_scroll(&self.scroll)
            .flex_1()
            .min_h(px(0.0))
            .overflow_y_scroll()
            .child(div().px(px(20.0)).py(px(16.0)).min_h(px(200.0)).child(surface));
        let btn = |id: &'static str, label: &'static str, primary: bool| {
            let mut b = ui_text(13.0)
                .id(id)
                .h(px(29.0))
                .px(px(17.0))
                .rounded(px(6.0))
                .flex()
                .items_center()
                .cursor_pointer();
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
            .child(layer(Spec::rrect(0.0).border_sides(1.0, 0.0, 0.0, 0.0, hex_a(0x292e42))))
            .child(btn("modal-cancel", "Cancel", false).on_click(cx.listener(|_, _, _, cx| cx.emit(RichEvent::ModalCancel))))
            .child(btn("modal-done", "Done", true).on_click(cx.listener(|this, _, _, cx| cx.emit(RichEvent::ModalDone(this.state.to_html())))));
        let dialog = Glass::new(18.0, 36.0, 1.7, spec)
            .shadows(&shd)
            .el()
            .w(px(600.0))
            .h(px(520.0))
            .flex()
            .flex_col()
            .overflow_hidden()
            .child(header)
            .child(toolbar)
            .child(body)
            .child(footer);
        let overlay = Glass::new(0.0, 28.0, 1.25, Spec::rrect(0.0).solid(rgba(192, 202, 245, 0.10)))
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
        let host = div().id("rich-modal").absolute().top(px(0.0)).left(px(0.0)).size_full().child(overlay);
        self.with_actions(host, cx)
    }
}

fn hex_a(h: u32) -> C {
    hex(h)
}

impl Render for RichInput {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        match self.mode {
            RichMode::Inline => self.render_inline(window, cx),
            RichMode::Modal => self.render_modal(cx),
        }
    }
}
