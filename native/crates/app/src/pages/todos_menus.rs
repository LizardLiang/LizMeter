//! The overlays of the Todos page: the single-key quick menu (`TodoQuickMenu.tsx`), the right-click
//! action menu (`TodoRowMenu.tsx`) and the `?` cheat sheet (`TodoShortcutsOverlay.tsx`).

use super::todos_logic::*;
use crate::controls::parse_color;
use crate::css::{linear, rgba, Spec, TRANSPARENT};
use crate::ui::*;
use gpui::*;
use lizmeter_core::{Todo, TodoState};
use lizmeter_ui::scrollbar::{self, BarStyle};
use lizmeter_ui::text_input::{TextField, TextFieldEvent, TextInput};
use std::rc::Rc;

/// The modifier key the user presses for Copy and sub-issue.
pub const MOD: &str = "Ctrl";

const QUICK_W: f32 = 244.0;
const QUICK_MAX_H: f32 = 320.0;
const QUICK_CHROME_H: f32 = 82.0;
const QUICK_ROW_H: f32 = 30.0;
const MENU_W: f32 = 216.0;
const MENU_ROW_H: f32 = 26.0;
const MENU_FIXED_ROWS: f32 = 20.0;

/// A window-sized, see-through layer that takes the click which dismisses an overlay, so the
/// click never reaches the page beneath.
pub fn backdrop(window: &Window, tint: Option<Hsla>, on_close: impl Fn(&mut Window, &mut App) + 'static) -> impl IntoElement {
    let vp = window.viewport_size();
    let mut d = div().w(vp.width).h(vp.height).occlude().on_mouse_down(MouseButton::Left, move |_, w, a| on_close(w, a));
    if let Some(t) = tint {
        d = d.bg(t);
    }
    deferred(anchored().position(point(px(0.0), px(0.0))).anchor(Corner::TopLeft).child(d)).with_priority(6)
}

/// `rgba(20,23,42,.72)` glass with the diagonal sheen of the Electron menus.
fn menu_glass(radius: f32, base_alpha: f32, border_alpha: f32) -> Glass {
    let spec = Spec::rrect(radius)
        .fill(linear(135.0, &[(0.0, wh(0.07)), (0.32, wh(0.02)), (0.58, TRANSPARENT)]))
        .solid(rgba(20, 23, 42, base_alpha))
        .border(1.0, rgba(122, 162, 247, border_alpha))
        .inset(0.0, 1.0, wh(0.12));
    Glass::new(radius, 36.0, 1.7, spec).shadows(&[Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 1.0, color: bk(0.3) }, sh(0.0, 16.0, 40.0, bk(0.32))])
}

fn placed(pos: Point<Pixels>, child: impl IntoElement) -> impl IntoElement {
    deferred(anchored().position(pos).anchor(Corner::TopLeft).snap_to_window_with_margin(px(8.0)).child(child)).with_priority(7)
}

/// Where a menu of `height` hangs: under the anchor, or above it when there is no room below.
fn menu_pos(anchor: (f32, f32, f32), width: f32, height: f32, gap: f32, window: &Window) -> Point<Pixels> {
    let vp = window.viewport_size();
    let (vw, vh) = (f32::from(vp.width), f32::from(vp.height));
    let (top, bottom, left) = anchor;
    let x = left.min(vw - width - 8.0).max(8.0);
    let y = if bottom + gap + height > vh { (top - height - gap).max(8.0) } else { bottom + gap };
    point(px(x), px(y))
}

pub fn kbd_cap(text: &str, size: f32, pad_x: f32, line_factor: f32) -> Div {
    div()
        .flex()
        .items_center()
        .justify_center()
        .px(px(pad_x))
        .py(px(1.0))
        .rounded(px(4.0))
        .border(px(1.0))
        .bg(col(rgba(12, 13, 24, 0.5)))
        .text_size(px(size))
        .line_height(px(size * line_factor))
        .child(text.to_string())
}

// ---- Quick menu ----

pub enum QuickEvent {
    Pick(String),
    Close,
}

impl EventEmitter<QuickEvent> for QuickMenu {}

pub struct QuickMenu {
    pub kind: QuickKind,
    pub todo_id: i64,
    heading: &'static str,
    items: Vec<QuickItem>,
    accept: Accept,
    multi: bool,
    query: String,
    active: usize,
    search: Entity<TextField>,
    anchor: (f32, f32, f32),
    scroll: gpui::ScrollHandle,
}

impl QuickMenu {
    pub fn new(kind: QuickKind, todo_id: i64, cfg: QuickConfig, anchor: (f32, f32, f32), window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = TextInput::new(crate::controls::field_style(12.0), cfg.placeholder, window, cx);
        cx.subscribe(&search, |this, s, ev: &TextFieldEvent, cx| match ev {
            TextFieldEvent::Changed => {
                this.query = s.read(cx).text().to_string();
                this.active = 0;
                cx.notify();
            }
            TextFieldEvent::Submit => this.pick_active(cx),
            TextFieldEvent::Cancel => cx.emit(QuickEvent::Close),
        })
        .detach();
        let focus = search.read(cx).focus_handle().clone();
        window.focus(&focus);
        let active = initial_active(&cfg.items, cfg.multi);
        Self { kind, todo_id, heading: cfg.heading, items: cfg.items, accept: cfg.accept, multi: cfg.multi, query: String::new(), active, search, anchor, scroll: gpui::ScrollHandle::new() }
    }

    /// The rows after a write: the label menu stays open, so its marks must follow the todo.
    pub fn set_items(&mut self, items: Vec<QuickItem>, cx: &mut Context<Self>) {
        self.items = items;
        cx.notify();
    }

    fn rows(&self) -> Vec<QuickItem> {
        quick_rows(&self.items, self.accept, &self.query)
    }

    fn pick_active(&mut self, cx: &mut Context<Self>) {
        if let Some(item) = self.rows().get(self.active) {
            self.pick(item.value.clone(), cx);
        }
    }

    fn pick(&mut self, value: String, cx: &mut Context<Self>) {
        cx.emit(QuickEvent::Pick(value));
        if self.multi {
            self.query.clear();
            self.search.update(cx, |s, cx| s.set_text("", cx));
            cx.notify();
        } else {
            cx.emit(QuickEvent::Close);
        }
    }
}

impl Render for QuickMenu {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let rows = self.rows();
        self.active = self.active.min(rows.len().saturating_sub(1));
        let height = (QUICK_CHROME_H + rows.len() as f32 * QUICK_ROW_H).min(QUICK_MAX_H);
        let pos = menu_pos(self.anchor, QUICK_W, height, 4.0, window);

        let mut list = div().flex().flex_col();
        for (i, item) in rows.iter().enumerate() {
            let m = me.clone();
            let value = item.value.clone();
            let mut row = div()
                .id(SharedString::from(format!("quick-{i}")))
                .w_full()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .px(px(8.0))
                .py(px(6.0))
                .rounded(px(7.0))
                .text_size(px(12.0))
                .line_height(px(15.2))
                .text_color(col(TN_TEXT))
                .cursor_pointer()
                .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                    if *hovered && this.active != i {
                        this.active = i;
                        cx.notify();
                    }
                }))
                .on_click(move |_, _, app| {
                    let v = value.clone();
                    m.update(app, |q, cx| q.pick(v, cx))
                });
            if i == self.active {
                row = row.bg(col(rgba(122, 162, 247, 0.18)));
            }
            if let Some(c) = &item.color {
                let c = parse_color(c);
                row = row.child(div().flex_shrink_0().size(px(9.0)).rounded(px(4.5)).bg(col(c)));
            }
            row = row.child(div().flex_1().min_w_0().truncate().child(item.label.clone()));
            if let Some(h) = &item.hint {
                row = row.child(div().flex_shrink_0().text_size(px(10.5)).text_color(col(hex8b())).child(h.clone()));
            }
            if item.current {
                row = row.child(div().flex_shrink_0().text_size(px(11.0)).text_color(col(TN_BLUE)).child("\u{2713}"));
            }
            list = list.child(row);
        }

        let focused = self.search.read(cx).focus_handle().is_focused(window);
        let mut search = div()
            .w_full()
            .px(px(9.0))
            .py(px(6.0))
            .rounded(px(8.0))
            .border(px(1.0))
            .border_color(col(if focused { rgba(122, 162, 247, 0.7) } else { rgba(41, 46, 66, 0.8) }))
            .bg(col(rgba(12, 13, 24, 0.55)))
            .child(self.search.clone());
        if focused {
            search = search.shadow(shadows(&[Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 2.0, color: rgba(122, 162, 247, 0.18) }]));
        }

        let body = if rows.is_empty() {
            div().mt(px(10.0)).mx(px(4.0)).mb(px(4.0)).text_size(px(11.5)).text_color(col(hex8b())).child("Nothing matches that.").into_any_element()
        } else {
            let scroll = scrollbar::keyed("todo-quick-list", BarStyle::Global);
            let _ = &scroll;
            div()
                .mt(px(6.0))
                .max_h(px(QUICK_MAX_H - QUICK_CHROME_H))
                .child(div().id("todo-quick-list").track_scroll(&self.scroll).max_h(px(QUICK_MAX_H - QUICK_CHROME_H)).overflow_y_scroll().child(list))
                .into_any_element()
        };

        let menu = menu_glass(14.0, 0.72, 0.4)
            .el()
            .id("todo-quick-menu")
            .w(px(QUICK_W))
            .max_h(px(QUICK_MAX_H))
            .flex()
            .flex_col()
            .pt(px(10.0))
            .px(px(10.0))
            .pb(px(8.0))
            .font_family(UI_FONT)
            .occlude()
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| {
                let n = this.rows().len();
                match ev.keystroke.key.as_str() {
                    "down" if n > 0 => this.active = (this.active + 1).min(n - 1),
                    "up" => this.active = this.active.saturating_sub(1),
                    _ => return,
                }
                this.scroll.scroll_to_item(this.active);
                cx.stop_propagation();
                cx.notify();
            }))
            .child(div().mb(px(8.0)).text_size(px(10.0)).line_height(px(13.0)).font_weight(FontWeight(700.0)).text_color(col(hex_a3())).child(spaced(&self.heading.to_uppercase(), 1.2)))
            .child(search)
            .child(body);
        let m_close = me.clone();
        div()
            .child(backdrop(window, None, move |_, app| m_close.update(app, |_, cx| cx.emit(QuickEvent::Close))))
            .child(placed(pos, menu))
    }
}

fn hex8b() -> crate::css::C {
    crate::css::hex(0x8b93b8)
}

fn hex_a3() -> crate::css::C {
    crate::css::hex(0xa3abc9)
}

// ---- Row action menu ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionChoice {
    Edit,
    CopyId,
    CopyPrompt,
    Quick(QuickKind),
    AddSubIssue,
    LinkChild,
    SetParent,
    ClearParent,
    SetState(i64),
    Delete,
    Close,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CopyAction {
    Id,
    Prompt,
}

pub struct ActionMenuProps<'a> {
    pub todo: &'a Todo,
    pub states: &'a [TodoState],
    /// Which copy item reads "Copied" or "Copy failed" right now.
    pub copy: Option<(CopyAction, bool)>,
    pub prompt_pending: bool,
    /// Pointer (or trigger) the menu hangs off: top, bottom, left.
    pub anchor: (f32, f32, f32),
}

fn hint(keys: &[&str]) -> Div {
    let mut h = div().flex().flex_row().items_center().gap(px(2.0)).ml_auto().pl(px(12.0));
    for k in keys {
        h = h.child(kbd_cap(k, 9.0, 4.0, 1.4).min_w(px(15.0)).font_weight(FontWeight(600.0)).text_color(col(hex8b())).border_color(col(rgba(86, 95, 137, 0.5))));
    }
    h
}

fn section_label(text: &str, keys: &[&str]) -> Div {
    let mut d = div().flex().flex_row().items_center().justify_between().px(px(10.0)).pt(px(4.0)).pb(px(2.0)).text_size(px(10.0)).line_height(px(13.0)).font_weight(FontWeight(700.0)).text_color(col(hex8b())).child(spaced(&text.to_uppercase(), 1.0));
    if !keys.is_empty() {
        d = d.child(hint(keys));
    }
    d
}

fn divider() -> Div {
    div().h(px(1.0)).mx(px(6.0)).my(px(4.0)).bg(col(rgba(86, 95, 137, 0.25)))
}

/// The panel of the right-click menu. `on_choice` runs for every item and for a click outside the panel.
pub fn action_menu(window: &Window, p: ActionMenuProps, on_choice: Rc<dyn Fn(ActionChoice, &mut Window, &mut App)>) -> impl IntoElement {
    let has_parent = p.todo.parent_id.is_some();
    let est = (p.states.len() as f32 + MENU_FIXED_ROWS + if has_parent { 1.0 } else { 0.0 }) * MENU_ROW_H;
    let pos = menu_pos(p.anchor, MENU_W, est, 2.0, window);
    let vh = f32::from(window.viewport_size().height);

    let item = |id: &str, label: String, choice: ActionChoice, close_first: bool, keys: &[&str], color: crate::css::C, hover: Hsla, disabled: bool| {
        let cb = on_choice.clone();
        let mut d = div()
            .id(SharedString::from(format!("am-{id}")))
            .w_full()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .px(px(10.0))
            .py(px(6.0))
            .rounded(px(6.0))
            .text_size(px(12.0))
            .line_height(px(15.2))
            .text_color(col(color))
            .child(label);
        if !keys.is_empty() {
            d = d.child(hint(keys));
        }
        if disabled {
            return d;
        }
        d.cursor_pointer().hover(move |s| s.bg(hover)).on_mouse_down(MouseButton::Left, |_, _, app| app.stop_propagation()).on_click(move |_, w, a| {
            if close_first {
                cb(ActionChoice::Close, w, a);
            }
            cb(choice, w, a);
        })
    };
    let hover_blue = col(rgba(122, 162, 247, 0.14));
    let hover_red = col(rgba(247, 118, 142, 0.14));
    let text = TN_TEXT;
    let red = TN_RED;

    let copy_label = |action: CopyAction, normal: &str| match p.copy {
        Some((a, failed)) if a == action => (if failed { "Copy failed".to_string() } else { "Copied \u{2713}".to_string() }, failed),
        _ => (normal.to_string(), false),
    };
    let (id_label, id_failed) = copy_label(CopyAction::Id, "Copy id");
    let (prompt_label, prompt_failed) = copy_label(CopyAction::Prompt, "Copy agent prompt");

    let mut col_el = div().flex().flex_col();
    col_el = col_el.child(item("edit", "Edit".into(), ActionChoice::Edit, true, &["Enter"], text, hover_blue, false));
    col_el = col_el.child(divider()).child(section_label("Copy", &[]));
    col_el = col_el.child(item("copy-id", id_label, ActionChoice::CopyId, false, &[MOD, "C"], if id_failed { red } else { text }, if id_failed { hover_red } else { hover_blue }, false));
    col_el = col_el.child(item("copy-prompt", prompt_label, ActionChoice::CopyPrompt, false, &["\u{21e7}", "C"], if prompt_failed { red } else { text }, if prompt_failed { hover_red } else { hover_blue }, p.prompt_pending));
    col_el = col_el.child(divider()).child(section_label("Properties", &[]));
    col_el = col_el.child(item("priority", "Priority...".into(), ActionChoice::Quick(QuickKind::Priority), true, &["P"], text, hover_blue, false));
    col_el = col_el.child(item("due", "Due date...".into(), ActionChoice::Quick(QuickKind::Due), true, &["D"], text, hover_blue, false));
    col_el = col_el.child(item("project", "Project...".into(), ActionChoice::Quick(QuickKind::Project), true, &["\u{21e7}", "P"], text, hover_blue, false));
    col_el = col_el.child(item("labels", "Labels...".into(), ActionChoice::Quick(QuickKind::Label), true, &["T"], text, hover_blue, false));
    col_el = col_el.child(divider()).child(section_label("Nesting", &[]));
    col_el = col_el.child(item("sub", "Add sub-issue".into(), ActionChoice::AddSubIssue, true, &[MOD, "\u{21e7}", "O"], text, hover_blue, false));
    col_el = col_el.child(item("link", "Add existing sub-issue...".into(), ActionChoice::LinkChild, true, &["L"], text, hover_blue, false));
    col_el = col_el.child(item("parent", (if has_parent { "Change parent..." } else { "Make sub-issue of..." }).into(), ActionChoice::SetParent, true, &["\u{21e7}", "L"], text, hover_blue, false));
    if has_parent {
        col_el = col_el.child(item("unparent", "Remove from parent".into(), ActionChoice::ClearParent, true, &[], text, hover_blue, false));
    }
    col_el = col_el.child(divider()).child(section_label("Move to", &["S"]));
    for s in p.states {
        let current = s.id == p.todo.state.id;
        let color = parse_color(&s.color);
        let it = item(&format!("state-{}", s.id), s.label.clone(), ActionChoice::SetState(s.id), true, &[], if current { TN_BLUE } else { text }, hover_blue, current);
        // The state's dot leads the label.
        let it = it.child(div().absolute().left(px(10.0)).top(px(9.0)).size(px(8.0)).rounded(px(4.0)).border(px(1.0)).border_color(col(color)).bg(col(color)));
        col_el = col_el.child(it.relative().pl(px(26.0)));
    }
    col_el = col_el.child(divider());
    col_el = col_el.child(item("delete", "Delete".into(), ActionChoice::Delete, true, &[], red, hover_red, false));

    let scroll = scrollbar::keyed("todo-action-menu", BarStyle::Global);
    let panel = menu_glass(10.0, 0.9, 0.4)
        .el()
        .id("todo-action-menu-panel")
        .w(px(MENU_W))
        .max_h(px(vh * 0.7))
        .p(px(4.0))
        .font_family(UI_FONT)
        .occlude()
        .on_mouse_down(MouseButton::Right, |_, _, app| app.stop_propagation())
        .child(div().id("todo-action-menu").track_scroll(scroll.handle()).max_h(px(vh * 0.7 - 8.0)).overflow_y_scroll().child(scroll.pad(col_el)))
        .child(scroll.bar());

    let cb = on_choice.clone();
    div().child(backdrop(window, None, move |w, a| cb(ActionChoice::Close, w, a))).child(placed(pos, panel))
}

// ---- Shortcuts overlay ----

struct Shortcut {
    keys: Vec<&'static str>,
    label: &'static str,
}

fn sections() -> Vec<(&'static str, Vec<Shortcut>)> {
    let s = |keys: &[&'static str], label| Shortcut { keys: keys.to_vec(), label };
    vec![
        (
            "Move around",
            vec![s(&["\u{2191}"], "Move the cursor up"), s(&["\u{2193}"], "Move the cursor down"), s(&["Enter"], "Open the todo under the cursor"), s(&["Esc"], "Clear the selection, then the cursor")],
        ),
        (
            "Change the todo under the cursor",
            vec![
                s(&["S"], "Set state"),
                s(&["P"], "Set priority"),
                s(&["D"], "Set due date"),
                s(&["Shift", "P"], "Set project"),
                s(&["T"], "Toggle labels"),
                s(&["L"], "Link an existing todo as a sub-issue"),
                s(&["Shift", "L"], "Link a parent"),
                s(&[MOD, "C"], "Copy id"),
                s(&["Shift", "C"], "Copy agent prompt"),
            ],
        ),
        ("Create", vec![s(&["C"], "New todo"), s(&[MOD, "Shift", "O"], "New sub-issue of the todo under the cursor")]),
    ]
}

/// Number of grid columns of `repeat(auto-fit, minmax(17rem, 1fr))` with a 28px gap.
pub fn shortcut_columns(inner_w: f32) -> usize {
    (((inner_w + 28.0) / (272.0 + 28.0)).floor() as usize).clamp(1, 3)
}

pub fn shortcuts_overlay(window: &Window, on_close: Rc<dyn Fn(&mut Window, &mut App)>) -> impl IntoElement {
    let vp = window.viewport_size();
    let (vw, vh) = (f32::from(vp.width), f32::from(vp.height));
    let dialog_w = (vw - 48.0).min((vw * 0.58).clamp(384.0, 736.0));
    let inner_w = dialog_w - 40.0 - 2.0;
    let cols = shortcut_columns(inner_w);
    let col_w = (inner_w - 28.0 * (cols as f32 - 1.0)) / cols as f32;

    let mut grid = div().flex().flex_row().flex_wrap().gap_x(px(28.0)).gap_y(px(18.0));
    for (title, list) in sections() {
        let mut rows = div().flex().flex_col();
        for sc in list {
            let mut keys = div().flex_shrink_0().w(px(120.0)).flex().flex_row().flex_wrap().gap(px(3.0));
            for k in &sc.keys {
                keys = keys.child(kbd_cap(k, 10.5, 6.0, 1.5).text_color(col(TN_TEXT_DIM)).border_color(col(rgba(122, 162, 247, 0.3))));
            }
            rows = rows.child(div().flex().flex_row().items_start().gap(px(10.0)).py(px(4.0)).child(keys).child(div().min_w_0().pt(px(1.4)).text_size(px(12.5)).line_height(px(17.0)).text_color(col(TN_TEXT)).child(sc.label)));
        }
        grid = grid.child(div().w(px(col_w)).flex_shrink_0().child(div().mb(px(8.0)).text_size(px(10.0)).line_height(px(13.0)).font_weight(FontWeight(700.0)).text_color(col(hex_a3())).child(spaced(&title.to_uppercase(), 1.2))).child(rows));
    }

    let close = on_close.clone();
    let header = div()
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .mb(px(16.0))
        .child(div().text_size(px(14.0)).line_height(px(18.0)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child("Keyboard shortcuts"))
        .child(
            div()
                .id("shortcuts-close")
                .size(px(24.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.0))
                .text_size(px(13.0))
                .text_color(col(hex8b()))
                .cursor_pointer()
                .hover(|s| s.bg(col(rgba(122, 162, 247, 0.14))).text_color(col(TN_TEXT)))
                .on_click(move |_, w, a| close(w, a))
                .child("x"),
        );

    let mut footer = div().flex().flex_row().flex_wrap().items_center().mt(px(18.0)).pt(px(12.0)).border_t_1().border_color(col(rgba(41, 46, 66, 0.7))).text_size(px(11.5)).line_height(px(16.0)).text_color(col(hex8b()));
    let words = |d: Div, text: &str| text.split(' ').fold(d, |d, w| d.child(div().mr(px(3.0)).child(w.to_string())));
    footer = words(footer, "Shortcuts other than");
    footer = footer.child(kbd_cap("C", 10.5, 6.0, 1.5).mr(px(3.0)).text_color(col(TN_TEXT_DIM)).border_color(col(rgba(122, 162, 247, 0.3))));
    footer = words(footer, "need a cursor. Press");
    footer = footer.child(kbd_cap("\u{2193}", 10.5, 6.0, 1.5).mr(px(3.0)).text_color(col(TN_TEXT_DIM)).border_color(col(rgba(122, 162, 247, 0.3))));
    footer = words(footer, "to place one, or right-click a row to reach the same actions from a menu.");

    let dialog = menu_glass(18.0, 0.72, 0.4)
        .el()
        .id("shortcuts-dialog")
        .w(px(dialog_w))
        .max_h(px(vh * 0.76))
        .flex()
        .flex_col()
        .px(px(20.0))
        .pt(px(18.0))
        .pb(px(16.0))
        .font_family(UI_FONT)
        .occlude()
        .child(header)
        .child(grid)
        .child(footer);

    let top = (vh * 0.10).max(0.0);
    let backdrop_close = on_close;
    let overlay = Glass::new(0.0, 28.0, 1.25, Spec::rrect(0.0).solid(rgba(192, 202, 245, 0.10)))
        .el()
        .w(vp.width)
        .h(vp.height)
        .occlude()
        .on_mouse_down(MouseButton::Left, move |_, w, a| backdrop_close(w, a))
        .child(div().absolute().top(px(top)).left(px((vw - dialog_w) / 2.0)).child(dialog));
    deferred(anchored().position(point(px(0.0), px(0.0))).anchor(Corner::TopLeft).child(overlay)).with_priority(8)
}

#[cfg(test)]
mod tests {
    use super::shortcut_columns;

    #[test]
    fn the_cheat_sheet_flows_into_columns_by_width() {
        assert_eq!(shortcut_columns(300.0), 1);
        assert_eq!(shortcut_columns(654.0), 2);
        assert_eq!(shortcut_columns(900.0), 3);
    }
}
