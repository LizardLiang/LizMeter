//! The shared scrollbar: `global.scss` `::-webkit-scrollbar` (4px wide, transparent track, `#292e42` thumb
//! with a 2px radius, `#565f89` on hover). It is laid out like Chromium's classic scrollbar: while the content
//! overflows, the scroller's content loses 4px on the right and the bar fills that strip.
//!
//! Use: hold a [`Scroll`], pass `scroll.handle()` to `track_scroll`, wrap the scroller's child with
//! [`Scroll::pad`] (a scroller that already has right padding of 4px or more may skip `pad`), and add
//! [`Scroll::bar`] as a later sibling of the scroller.

use crate::css::hex;
use crate::ui::col;
use gpui::*;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ops::Deref;
use std::rc::Rc;

pub const THICKNESS: f32 = 4.0;
pub const MIN_THUMB: f32 = 4.0;
const EPS: f32 = 0.5;

/// Thumb start and length along a track of `track` px for `content` px of content scrolled by `scrolled` px.
/// `None` when the content fits.
pub fn thumb(track: f32, content: f32, scrolled: f32) -> Option<(f32, f32)> {
    if track <= 0.0 || content <= track + EPS {
        return None;
    }
    let len = (track * track / content).max(MIN_THUMB).min(track);
    let max = content - track;
    let start = (track - len) * scrolled.clamp(0.0, max) / max;
    Some((start, len))
}

/// The scroll distance that puts the thumb's start at `start` (inverse of [`thumb`]).
pub fn scrolled_for_thumb_start(track: f32, content: f32, start: f32) -> f32 {
    match thumb(track, content, 0.0) {
        Some((_, len)) if track > len => (start / (track - len)).clamp(0.0, 1.0) * (content - track),
        _ => 0.0,
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum BarStyle {
    /// `global.scss`: transparent track, `#292e42` thumb.
    Global,
    /// `RichTextInput.module.scss`: `#292e42` track, `#414868` thumb.
    Inset,
}

#[derive(Clone)]
pub struct Scroll {
    handle: ScrollHandle,
    style: BarStyle,
    reserved: Rc<Cell<bool>>,
    /// Pointer offset inside the thumb while it is dragged.
    drag: Rc<Cell<Option<f32>>>,
    hover: Rc<Cell<bool>>,
}

impl Deref for Scroll {
    type Target = ScrollHandle;
    fn deref(&self) -> &ScrollHandle {
        &self.handle
    }
}

thread_local! {
    static KEYED: RefCell<HashMap<&'static str, Scroll>> = RefCell::new(HashMap::new());
}

/// One persistent [`Scroll`] per id, for scrollers rebuilt on every render.
pub fn keyed(id: &'static str, style: BarStyle) -> Scroll {
    KEYED.with(|m| m.borrow_mut().entry(id).or_insert_with(|| Scroll::new(style)).clone())
}

struct Geo {
    bounds: Bounds<Pixels>,
    track: f32,
    content: f32,
    start: f32,
    len: f32,
}

impl Scroll {
    pub fn new(style: BarStyle) -> Self {
        Self {
            handle: ScrollHandle::new(),
            style,
            reserved: Rc::new(Cell::new(false)),
            drag: Rc::new(Cell::new(None)),
            hover: Rc::new(Cell::new(false)),
        }
    }

    pub fn handle(&self) -> &ScrollHandle {
        &self.handle
    }

    /// Wraps the scroller's child; leaves the bar's 4px free while the content overflows.
    pub fn pad(&self, child: impl IntoElement) -> Div {
        let d = div();
        let d = if self.reserved.get() { d.pr(px(THICKNESS)) } else { d };
        d.child(child)
    }

    /// The bar; paints over the right edge of the scroller. Add it after the scroller.
    pub fn bar(&self) -> ScrollbarElement {
        ScrollbarElement { scroll: self.clone() }
    }

    fn geometry(&self) -> Option<Geo> {
        let bounds = self.handle.bounds();
        let track = f32::from(bounds.size.height);
        let content = track + f32::from(self.handle.max_offset().height);
        let scrolled = -f32::from(self.handle.offset().y);
        let (start, len) = thumb(track, content, scrolled)?;
        Some(Geo { bounds, track, content, start, len })
    }

    fn set_scrolled(&self, scrolled: f32) {
        let max = f32::from(self.handle.max_offset().height);
        let off = self.handle.offset();
        self.handle.set_offset(point(off.x, px(-scrolled.clamp(0.0, max))));
    }

    fn over_thumb(&self, hitbox: &Hitbox, p: Point<Pixels>, window: &Window) -> bool {
        match self.geometry() {
            Some(g) => hitbox.is_hovered(window) && p.y >= g.bounds.top() + px(g.start) && p.y <= g.bounds.top() + px(g.start + g.len),
            None => false,
        }
    }
}

pub struct ScrollbarElement {
    scroll: Scroll,
}

impl IntoElement for ScrollbarElement {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

pub struct BarPrepaint {
    hitbox: Option<Hitbox>,
}

impl Element for ScrollbarElement {
    type RequestLayoutState = ();
    type PrepaintState = BarPrepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        let mut s = Style::default();
        s.position = Position::Absolute;
        s.size.width = px(0.0).into();
        s.size.height = px(0.0).into();
        (window.request_layout(s, [], cx), ())
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: Bounds<Pixels>, _: &mut (), window: &mut Window, _: &mut App) -> BarPrepaint {
        let hitbox = self.scroll.geometry().map(|g| {
            let b = g.bounds;
            window.insert_hitbox(Bounds::new(point(b.right() - px(THICKNESS), b.top()), size(px(THICKNESS), b.size.height)), HitboxBehavior::BlockMouseExceptScroll)
        });
        BarPrepaint { hitbox }
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: Bounds<Pixels>, _: &mut (), prepaint: &mut BarPrepaint, window: &mut Window, _: &mut App) {
        let s = self.scroll.clone();
        let overflowing = f32::from(s.handle.max_offset().height) > EPS;
        if overflowing != s.reserved.get() {
            s.reserved.set(overflowing);
            window.refresh();
        }
        let (Some(hitbox), Some(g)) = (prepaint.hitbox.clone(), s.geometry()) else {
            return;
        };
        let b = g.bounds;
        let x = b.right() - px(THICKNESS);
        let (track, idle, hot) = match s.style {
            BarStyle::Global => (None, hex(0x292e42), hex(0x565f89)),
            BarStyle::Inset => (Some(hex(0x292e42)), hex(0x414868), hex(0x565f89)),
        };
        if let Some(t) = track {
            window.paint_quad(fill(Bounds::new(point(x, b.top()), size(px(THICKNESS), b.size.height)), col(t)).corner_radii(px(2.0)));
        }
        let lit = s.drag.get().is_some() || s.hover.get();
        let thumb_b = Bounds::new(point(x, b.top() + px(g.start)), size(px(THICKNESS), px(g.len)));
        window.paint_quad(fill(thumb_b, col(if lit { hot } else { idle })).corner_radii(px(2.0)));

        window.on_mouse_event({
            let s = s.clone();
            let hitbox = hitbox.clone();
            move |e: &MouseDownEvent, phase, window, cx| {
                if phase != DispatchPhase::Capture || e.button != MouseButton::Left || !hitbox.is_hovered(window) {
                    return;
                }
                let Some(g) = s.geometry() else { return };
                let rel = f32::from(e.position.y - g.bounds.top());
                if s.over_thumb(&hitbox, e.position, window) {
                    s.drag.set(Some(rel - g.start));
                } else {
                    let cur = -f32::from(s.handle.offset().y);
                    s.set_scrolled(if rel < g.start { cur - g.track } else { cur + g.track });
                }
                cx.stop_propagation();
                window.refresh();
            }
        });
        window.on_mouse_event({
            let s = s.clone();
            let hitbox = hitbox.clone();
            move |e: &MouseMoveEvent, _, window, _| {
                if let Some(grab) = s.drag.get() {
                    if e.pressed_button != Some(MouseButton::Left) {
                        s.drag.set(None);
                    } else if let Some(g) = s.geometry() {
                        let start = f32::from(e.position.y - g.bounds.top()) - grab;
                        s.set_scrolled(scrolled_for_thumb_start(g.track, g.content, start));
                    }
                    window.refresh();
                    return;
                }
                let h = s.over_thumb(&hitbox, e.position, window);
                if h != s.hover.get() {
                    s.hover.set(h);
                    window.refresh();
                }
            }
        });
        window.on_mouse_event(move |e: &MouseUpEvent, _, window, _| {
            if e.button == MouseButton::Left && s.drag.take().is_some() {
                window.refresh();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{MIN_THUMB, scrolled_for_thumb_start, thumb};

    #[test]
    fn fits_has_no_thumb() {
        assert_eq!(thumb(300.0, 300.0, 0.0), None);
        assert_eq!(thumb(300.0, 300.4, 0.0), None);
        assert_eq!(thumb(0.0, 500.0, 0.0), None);
    }

    #[test]
    fn length_is_the_viewport_ratio() {
        let (_, len) = thumb(300.0, 600.0, 0.0).unwrap();
        assert!((len - 150.0).abs() < 1e-3);
    }

    #[test]
    fn length_has_a_minimum() {
        let (_, len) = thumb(300.0, 1_000_000.0, 0.0).unwrap();
        assert_eq!(len, MIN_THUMB);
    }

    #[test]
    fn position_top_middle_bottom() {
        let (top, len) = thumb(300.0, 600.0, 0.0).unwrap();
        let (mid, _) = thumb(300.0, 600.0, 150.0).unwrap();
        let (bot, _) = thumb(300.0, 600.0, 300.0).unwrap();
        assert_eq!(top, 0.0);
        assert!((mid - 75.0).abs() < 1e-3);
        assert!((bot - (300.0 - len)).abs() < 1e-3);
    }

    #[test]
    fn overscroll_is_clamped() {
        let (a, len) = thumb(300.0, 600.0, 900.0).unwrap();
        assert!((a - (300.0 - len)).abs() < 1e-3);
        assert_eq!(thumb(300.0, 600.0, -50.0).unwrap().0, 0.0);
    }

    #[test]
    fn drag_maps_thumb_start_to_offset() {
        assert_eq!(scrolled_for_thumb_start(300.0, 600.0, 0.0), 0.0);
        assert!((scrolled_for_thumb_start(300.0, 600.0, 75.0) - 150.0).abs() < 1e-3);
        assert!((scrolled_for_thumb_start(300.0, 600.0, 150.0) - 300.0).abs() < 1e-3);
        assert!((scrolled_for_thumb_start(300.0, 600.0, 999.0) - 300.0).abs() < 1e-3);
        assert_eq!(scrolled_for_thumb_start(300.0, 600.0, -20.0), 0.0);
    }

    #[test]
    fn drag_round_trips() {
        for s in [0.0, 40.0, 123.0, 300.0] {
            let (start, _) = thumb(300.0, 600.0, s).unwrap();
            assert!((scrolled_for_thumb_start(300.0, 600.0, start) - s).abs() < 1e-3);
        }
    }
}
