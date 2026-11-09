//! `TextInput` (single line) and `TextArea` (multi line): editable text on gpui's platform input
//! handler, so Windows IME (candidate window at the caret), clipboard, undo/redo and mouse/keyboard
//! selection behave natively. All editing rules live in `text_buffer.rs`.

use crate::text_buffer::{EditKind, TextBuffer};
use gpui::*;
use std::ops::Range;
use std::time::Duration;

actions!(
    lizmeter_text_field,
    [
        Backspace,
        Delete,
        DeleteWordBackward,
        DeleteWordForward,
        Left,
        Right,
        Up,
        Down,
        WordLeft,
        WordRight,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        SelectWordLeft,
        SelectWordRight,
        SelectAll,
        Home,
        End,
        SelectHome,
        SelectEnd,
        DocStart,
        DocEnd,
        SelectDocStart,
        SelectDocEnd,
        Enter,
        Paste,
        Cut,
        Copy,
        Undo,
        Redo,
        Escape,
    ]
);

pub const KEY_CONTEXT: &str = "LizTextField";

/// Registers the key bindings every text field shares. Call once at startup.
pub fn bind_keys(cx: &mut App) {
    let c = Some(KEY_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, c),
        KeyBinding::new("shift-backspace", Backspace, c),
        KeyBinding::new("delete", Delete, c),
        KeyBinding::new("ctrl-backspace", DeleteWordBackward, c),
        KeyBinding::new("ctrl-delete", DeleteWordForward, c),
        KeyBinding::new("left", Left, c),
        KeyBinding::new("right", Right, c),
        KeyBinding::new("up", Up, c),
        KeyBinding::new("down", Down, c),
        KeyBinding::new("ctrl-left", WordLeft, c),
        KeyBinding::new("ctrl-right", WordRight, c),
        KeyBinding::new("shift-left", SelectLeft, c),
        KeyBinding::new("shift-right", SelectRight, c),
        KeyBinding::new("shift-up", SelectUp, c),
        KeyBinding::new("shift-down", SelectDown, c),
        KeyBinding::new("ctrl-shift-left", SelectWordLeft, c),
        KeyBinding::new("ctrl-shift-right", SelectWordRight, c),
        KeyBinding::new("ctrl-a", SelectAll, c),
        KeyBinding::new("home", Home, c),
        KeyBinding::new("end", End, c),
        KeyBinding::new("shift-home", SelectHome, c),
        KeyBinding::new("shift-end", SelectEnd, c),
        KeyBinding::new("ctrl-home", DocStart, c),
        KeyBinding::new("ctrl-end", DocEnd, c),
        KeyBinding::new("ctrl-shift-home", SelectDocStart, c),
        KeyBinding::new("ctrl-shift-end", SelectDocEnd, c),
        KeyBinding::new("enter", Enter, c),
        KeyBinding::new("ctrl-v", Paste, c),
        KeyBinding::new("shift-insert", Paste, c),
        KeyBinding::new("ctrl-c", Copy, c),
        KeyBinding::new("ctrl-insert", Copy, c),
        KeyBinding::new("ctrl-x", Cut, c),
        KeyBinding::new("shift-delete", Cut, c),
        KeyBinding::new("ctrl-z", Undo, c),
        KeyBinding::new("ctrl-y", Redo, c),
        KeyBinding::new("ctrl-shift-z", Redo, c),
        KeyBinding::new("escape", Escape, c),
    ]);
}

#[derive(Clone)]
pub struct FieldStyle {
    pub family: SharedString,
    pub size: Pixels,
    pub line_height: Pixels,
    pub color: Hsla,
    pub placeholder_color: Hsla,
    pub selection: Hsla,
    pub caret: Hsla,
    pub weight: FontWeight,
}

impl FieldStyle {
    pub fn new(family: &str, size: f32, line_height: f32, color: Hsla) -> Self {
        let mut placeholder = color;
        placeholder.a *= 0.5;
        let mut selection = color;
        selection.a = 0.28;
        Self {
            family: SharedString::from(family.to_string()),
            size: px(size),
            line_height: px(line_height),
            color,
            placeholder_color: placeholder,
            selection,
            caret: color,
            weight: FontWeight::NORMAL,
        }
    }

    fn font(&self) -> Font {
        let mut f = font(self.family.clone());
        f.weight = self.weight;
        f
    }
}

pub enum TextFieldEvent {
    Changed,
    Submit,
    Cancel,
}

impl EventEmitter<TextFieldEvent> for TextField {}

pub struct TextField {
    focus: FocusHandle,
    buf: TextBuffer,
    placeholder: SharedString,
    style: FieldStyle,
    disabled: bool,
    layout: Option<LineLayouts>,
    bounds: Option<Bounds<Pixels>>,
    scroll_x: Pixels,
    selecting: bool,
    goal_x: Option<Pixels>,
    blink_on: bool,
    blink_epoch: usize,
    blinking: bool,
}

struct LineLayouts {
    lines: Vec<WrappedLine>,
    /// byte offset where each logical line starts in the content
    starts: Vec<usize>,
    line_height: Pixels,
}

impl LineLayouts {
    fn index_of_line(&self, offset: usize) -> usize {
        match self.starts.binary_search(&offset) {
            Ok(i) => i,
            Err(i) => i - 1,
        }
    }

    fn line_top(&self, i: usize) -> Pixels {
        self.lines[..i].iter().fold(px(0.0), |y, l| y + l.size(self.line_height).height)
    }

    fn position_for_offset(&self, offset: usize) -> Point<Pixels> {
        let i = self.index_of_line(offset);
        let local = offset - self.starts[i];
        let p = self.lines[i].position_for_index(local, self.line_height).unwrap_or_default();
        point(p.x, p.y + self.line_top(i))
    }

    fn offset_for_position(&self, p: Point<Pixels>) -> usize {
        let mut top = px(0.0);
        for (i, l) in self.lines.iter().enumerate() {
            let h = l.size(self.line_height).height;
            if p.y < top + h || i == self.lines.len() - 1 {
                let local = point(p.x, (p.y - top).max(px(0.0)));
                let idx = match l.closest_index_for_position(local, self.line_height) {
                    Ok(i) | Err(i) => i,
                };
                return self.starts[i] + idx;
            }
            top += h;
        }
        0
    }

    fn total_height(&self) -> Pixels {
        self.line_top(self.lines.len())
    }
}

impl TextField {
    pub fn new(single_line: bool, style: FieldStyle, placeholder: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        cx.on_focus(&focus, window, |this, _window, cx| this.start_blink(cx)).detach();
        cx.on_blur(&focus, window, |this, _window, cx| {
            this.blinking = false;
            this.buf.unmark();
            cx.notify();
        })
        .detach();
        Self {
            focus,
            buf: TextBuffer::new(single_line),
            placeholder: SharedString::from(placeholder.to_string()),
            style,
            disabled: false,
            layout: None,
            bounds: None,
            scroll_x: px(0.0),
            selecting: false,
            goal_x: None,
            blink_on: true,
            blink_epoch: 0,
            blinking: false,
        }
    }

    pub fn with_max_len(mut self, n: usize) -> Self {
        self.buf = TextBuffer::new(self.buf.is_single_line()).with_max_len(n);
        self
    }

    pub fn text(&self) -> &str {
        self.buf.content()
    }

    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.buf.set_content(text);
        cx.notify();
    }

    pub fn set_disabled(&mut self, disabled: bool, cx: &mut Context<Self>) {
        self.disabled = disabled;
        cx.notify();
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    pub fn buffer(&self) -> &TextBuffer {
        &self.buf
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
        self.blink_epoch += 1;
        cx.notify();
    }

    fn changed(&mut self, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.touched(cx);
        cx.emit(TextFieldEvent::Changed);
    }

    fn moved(&mut self, cx: &mut Context<Self>) {
        self.touched(cx);
    }

    // ---- actions ----

    fn backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.backspace();
        self.changed(cx);
    }
    fn delete(&mut self, _: &Delete, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.delete_forward();
        self.changed(cx);
    }
    fn delete_word_backward(&mut self, _: &DeleteWordBackward, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.delete_word_backward();
        self.changed(cx);
    }
    fn delete_word_forward(&mut self, _: &DeleteWordForward, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.delete_word_forward();
        self.changed(cx);
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

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        self.move_h(false, false, cx);
    }
    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        self.move_h(true, false, cx);
    }
    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_h(false, true, cx);
    }
    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_h(true, true, cx);
    }
    fn word_left(&mut self, _: &WordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.prev_word_boundary(self.buf.head()), false);
        self.moved(cx);
    }
    fn word_right(&mut self, _: &WordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.next_word_boundary(self.buf.head()), false);
        self.moved(cx);
    }
    fn select_word_left(&mut self, _: &SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.prev_word_boundary(self.buf.head()), true);
        self.moved(cx);
    }
    fn select_word_right(&mut self, _: &SelectWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.next_word_boundary(self.buf.head()), true);
        self.moved(cx);
    }

    fn move_v(&mut self, down: bool, extend: bool, cx: &mut Context<Self>) {
        if self.buf.is_single_line() {
            let t = if down { self.buf.content().len() } else { 0 };
            self.buf.move_to(t, extend);
            self.moved(cx);
            return;
        }
        let Some(layout) = &self.layout else { return };
        let head = self.buf.head();
        let p = layout.position_for_offset(head);
        let gx = *self.goal_x.get_or_insert(p.x);
        let ty = if down { p.y + layout.line_height * 1.5 } else { p.y - layout.line_height * 0.5 };
        let target = if ty < px(0.0) {
            0
        } else if ty >= layout.total_height() {
            self.buf.content().len()
        } else {
            layout.offset_for_position(point(gx, ty))
        };
        self.buf.move_to(target, extend);
        self.moved(cx);
    }

    fn up(&mut self, _: &Up, _: &mut Window, cx: &mut Context<Self>) {
        self.move_v(false, false, cx);
    }
    fn down(&mut self, _: &Down, _: &mut Window, cx: &mut Context<Self>) {
        self.move_v(true, false, cx);
    }
    fn select_up(&mut self, _: &SelectUp, _: &mut Window, cx: &mut Context<Self>) {
        self.move_v(false, true, cx);
    }
    fn select_down(&mut self, _: &SelectDown, _: &mut Window, cx: &mut Context<Self>) {
        self.move_v(true, true, cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.select_all();
        self.moved(cx);
    }
    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.line_start(self.buf.head()), false);
        self.moved(cx);
    }
    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.line_end(self.buf.head()), false);
        self.moved(cx);
    }
    fn select_home(&mut self, _: &SelectHome, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.line_start(self.buf.head()), true);
        self.moved(cx);
    }
    fn select_end(&mut self, _: &SelectEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.line_end(self.buf.head()), true);
        self.moved(cx);
    }
    fn doc_start(&mut self, _: &DocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(0, false);
        self.moved(cx);
    }
    fn doc_end(&mut self, _: &DocEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.content().len(), false);
        self.moved(cx);
    }
    fn select_doc_start(&mut self, _: &SelectDocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(0, true);
        self.moved(cx);
    }
    fn select_doc_end(&mut self, _: &SelectDocEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.buf.move_to(self.buf.content().len(), true);
        self.moved(cx);
    }

    fn enter(&mut self, _: &Enter, _: &mut Window, cx: &mut Context<Self>) {
        if self.buf.is_single_line() {
            cx.emit(TextFieldEvent::Submit);
        } else {
            self.buf.replace(None, "\n", EditKind::Other);
            self.changed(cx);
        }
    }

    fn escape(&mut self, _: &Escape, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(TextFieldEvent::Cancel);
    }

    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
            self.buf.replace(None, &text, EditKind::Other);
            self.changed(cx);
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if self.buf.has_selection() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.buf.selected_text().to_string()));
        }
    }

    fn cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
        if self.buf.has_selection() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.buf.selected_text().to_string()));
            self.buf.replace(None, "", EditKind::Other);
            self.changed(cx);
        }
    }

    fn undo(&mut self, _: &Undo, _: &mut Window, cx: &mut Context<Self>) {
        if self.buf.undo() {
            self.changed(cx);
        }
    }

    fn redo(&mut self, _: &Redo, _: &mut Window, cx: &mut Context<Self>) {
        if self.buf.redo() {
            self.changed(cx);
        }
    }

    // ---- mouse ----

    fn offset_for_mouse(&self, p: Point<Pixels>) -> usize {
        let (Some(layout), Some(bounds)) = (&self.layout, self.bounds) else { return 0 };
        layout.offset_for_position(point(p.x - bounds.left() + self.scroll_x, p.y - bounds.top()))
    }

    fn on_mouse_down(&mut self, e: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        window.focus(&self.focus);
        self.selecting = true;
        let offset = self.offset_for_mouse(e.position);
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
            let o = self.offset_for_mouse(e.position);
            self.buf.move_to(o, true);
            self.moved(cx);
        }
    }
}

impl EntityInputHandler for TextField {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let r = self.buf.range_from_utf16(&range_utf16);
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

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.buf.unmark();
    }

    fn replace_text_in_range(&mut self, range: Option<Range<usize>>, text: &str, _: &mut Window, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        let r = range.map(|r| self.buf.range_from_utf16(&r));
        self.buf.replace(r, text, EditKind::Typing);
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
        let r = range.map(|r| self.buf.range_from_utf16(&r));
        // the selected range is relative to the preedit text, in UTF-16 units
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
        self.buf.replace_and_mark(r, new_text, sel);
        self.changed(cx);
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let layout = self.layout.as_ref()?;
        let r = self.buf.range_from_utf16(&range_utf16);
        let a = layout.position_for_offset(r.start);
        let b = layout.position_for_offset(r.end);
        let x0 = element_bounds.left() + a.x - self.scroll_x;
        let x1 = if b.y == a.y { element_bounds.left() + b.x - self.scroll_x } else { x0 };
        Some(Bounds::new(
            point(x0, element_bounds.top() + a.y),
            size((x1 - x0).max(px(1.0)), layout.line_height),
        ))
    }

    fn character_index_for_point(&mut self, p: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        let bounds = self.bounds?;
        let layout = self.layout.as_ref()?;
        let o = layout.offset_for_position(point(p.x - bounds.left() + self.scroll_x, p.y - bounds.top()));
        Some(self.buf.offset_to_utf16(o))
    }
}

impl Focusable for TextField {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for TextField {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .cursor(CursorStyle::IBeam)
            .w_full()
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
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::undo))
            .on_action(cx.listener(Self::redo))
            .on_action(cx.listener(Self::escape))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .child(FieldElement { field: cx.entity() })
    }
}

fn shape(text: &str, style: &FieldStyle, runs: Vec<TextRun>, wrap: Option<Pixels>, window: &Window) -> Vec<WrappedLine> {
    window
        .text_system()
        .shape_text(SharedString::from(text.to_string()), style.size, &runs, wrap, None)
        .map(|l| l.into_vec())
        .unwrap_or_default()
}

fn run(len: usize, style: &FieldStyle, color: Hsla, underline: bool) -> TextRun {
    TextRun {
        len,
        font: style.font(),
        color,
        background_color: None,
        underline: underline.then(|| UnderlineStyle { thickness: px(1.0), color: Some(color), wavy: false }),
        strikethrough: None,
    }
}

/// Splits the content into styled runs: marked (IME) text is underlined.
fn runs_for(text: &str, style: &FieldStyle, marked: Option<Range<usize>>) -> Vec<TextRun> {
    match marked {
        Some(m) if m.start < m.end && m.end <= text.len() => [
            (m.start > 0).then(|| run(m.start, style, style.color, false)),
            Some(run(m.end - m.start, style, style.color, true)),
            (m.end < text.len()).then(|| run(text.len() - m.end, style, style.color, false)),
        ]
        .into_iter()
        .flatten()
        .collect(),
        _ => vec![run(text.len(), style, style.color, false)],
    }
}

struct FieldElement {
    field: Entity<TextField>,
}

struct Prepaint {
    layout: LineLayouts,
    placeholder: Vec<WrappedLine>,
    cursor: Option<PaintQuad>,
    selections: Vec<PaintQuad>,
    scroll_x: Pixels,
}

fn build_layout(text: &str, style: &FieldStyle, marked: Option<Range<usize>>, wrap: Option<Pixels>, window: &Window) -> LineLayouts {
    let lines = shape(text, style, runs_for(text, style, marked), wrap, window);
    let mut starts = Vec::with_capacity(lines.len());
    let mut pos = 0;
    for l in &lines {
        starts.push(pos);
        pos += l.len() + 1;
    }
    if lines.is_empty() {
        starts.push(0);
    }
    LineLayouts { lines, starts, line_height: style.line_height }
}

impl IntoElement for FieldElement {
    type Element = Self;
    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for FieldElement {
    type RequestLayoutState = ();
    type PrepaintState = Prepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let field = self.field.read(cx);
        let style = field.style.clone();
        let single = field.buf.is_single_line();
        let text = field.buf.content().to_string();
        let mut s = Style::default();
        s.size.width = relative(1.0).into();
        if single {
            s.size.height = style.line_height.into();
            return (window.request_layout(s, [], cx), ());
        }
        let id = window.request_measured_layout(s, move |known, avail, window, _| {
            let w = known.width.or(match avail.width {
                AvailableSpace::Definite(w) => Some(w),
                _ => None,
            });
            let layout = build_layout(&text, &style, None, w, window);
            size(w.unwrap_or(px(0.0)), layout.total_height().max(style.line_height))
        });
        (id, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Prepaint {
        let field = self.field.read(cx);
        let style = field.style.clone();
        let single = field.buf.is_single_line();
        let wrap = (!single).then_some(bounds.size.width);
        let content = field.buf.content().to_string();
        let layout = build_layout(&content, &style, field.buf.marked_range(), wrap, window);
        let placeholder = if content.is_empty() {
            let txt = field.placeholder.to_string();
            let runs = vec![run(txt.len(), &style, style.placeholder_color, false)];
            shape(&txt, &style, runs, wrap, window)
        } else {
            Vec::new()
        };
        let sel = field.buf.selection();
        let focused = field.focus.is_focused(window);
        let caret_pos = layout.position_for_offset(field.buf.head());

        let mut scroll_x = field.scroll_x;
        if single {
            let right = scroll_x + bounds.size.width;
            if caret_pos.x < scroll_x {
                scroll_x = caret_pos.x;
            } else if caret_pos.x + px(2.0) > right {
                scroll_x = caret_pos.x + px(2.0) - bounds.size.width;
            }
            scroll_x = scroll_x.max(px(0.0));
        }
        let origin = bounds.origin - point(scroll_x, px(0.0));

        let mut selections = Vec::new();
        if sel.start != sel.end {
            let a = layout.position_for_offset(sel.start);
            let b = layout.position_for_offset(sel.end);
            let lh = style.line_height;
            let wrap_w = bounds.size.width;
            let rows = ((b.y - a.y) / lh).round() as i32;
            for r in 0..=rows {
                let y = a.y + lh * r as f32;
                let x0 = if r == 0 { a.x } else { px(0.0) };
                let x1 = if r == rows { b.x } else if single { b.x } else { wrap_w };
                if x1 > x0 || (r != rows) {
                    let x1 = if r != rows { x1.max(x0 + px(4.0)) } else { x1 };
                    selections.push(fill(
                        Bounds::new(origin + point(x0, y), size(x1 - x0, lh)),
                        style.selection,
                    ));
                }
            }
        }
        let show_caret = focused && sel.start == sel.end && field.blink_on;
        let cursor = show_caret.then(|| {
            fill(Bounds::new(origin + point(caret_pos.x, caret_pos.y), size(px(1.5), style.line_height)), style.caret)
        });
        Prepaint { layout, placeholder, cursor, selections, scroll_x }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        pre: &mut Prepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.field.read(cx).focus.clone();
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.field.clone()), cx);
        let lh = pre.layout.line_height;
        let origin = bounds.origin - point(pre.scroll_x, px(0.0));
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for q in pre.selections.drain(..) {
                window.paint_quad(q);
            }
            let mut y = px(0.0);
            let lines = if pre.placeholder.is_empty() { &pre.layout.lines } else { &pre.placeholder };
            for l in lines {
                let _ = l.paint(origin + point(px(0.0), y), lh, TextAlign::Left, Some(bounds), window, cx);
                y += l.size(lh).height;
            }
            if let Some(c) = pre.cursor.take() {
                window.paint_quad(c);
            }
        });
        let layout = std::mem::replace(&mut pre.layout, LineLayouts { lines: Vec::new(), starts: vec![0], line_height: lh });
        let scroll_x = pre.scroll_x;
        self.field.update(cx, |f, _| {
            f.layout = Some(layout);
            f.bounds = Some(bounds);
            f.scroll_x = scroll_x;
        });
    }
}

/// Single-line text field.
pub struct TextInput;

impl TextInput {
    pub fn new(style: FieldStyle, placeholder: &str, window: &mut Window, cx: &mut App) -> Entity<TextField> {
        let placeholder = placeholder.to_string();
        cx.new(|cx| TextField::new(true, style, &placeholder, window, cx))
    }
}

/// Multi-line, wrapping text field. Height follows the content; scrolling belongs to the parent.
pub struct TextArea;

impl TextArea {
    pub fn new(style: FieldStyle, placeholder: &str, window: &mut Window, cx: &mut App) -> Entity<TextField> {
        let placeholder = placeholder.to_string();
        cx.new(|cx| TextField::new(false, style, &placeholder, window, cx))
    }
}
