//! Editing model for the rich-text session input: leaves (paragraphs / list items), selection,
//! stored marks for the next typed character, IME composition and undo/redo.
//! No gpui types, so every rule is unit-tested without a window.

use crate::rich_doc::{Leaf, ListInfo, MarkKind, Marks, StyledText, parse_html, to_html};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Pos {
    pub leaf: usize,
    pub off: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RichEdit {
    Typing,
    Deleting,
    Other,
}

#[derive(Clone)]
struct Snap {
    leaves: Vec<Leaf>,
    anchor: Pos,
    head: Pos,
}

pub struct RichState {
    leaves: Vec<Leaf>,
    anchor: Pos,
    head: Pos,
    stored: Option<Marks>,
    marked: Option<(usize, Range<usize>)>,
    undo: Vec<Snap>,
    redo: Vec<Snap>,
    last: Option<RichEdit>,
}

impl RichState {
    pub fn from_html(html: &str) -> Self {
        let leaves = parse_html(html);
        let end = Pos { leaf: leaves.len() - 1, off: leaves.last().unwrap().text.len() };
        Self { leaves, anchor: end, head: end, stored: None, marked: None, undo: Vec::new(), redo: Vec::new(), last: None }
    }

    /// Replaces the document from outside (not an edit: history is cleared).
    pub fn set_html(&mut self, html: &str) {
        *self = Self::from_html(html);
    }

    pub fn to_html(&self) -> String {
        to_html(&self.leaves)
    }

    pub fn leaves(&self) -> &[Leaf] {
        &self.leaves
    }

    pub fn is_empty(&self) -> bool {
        self.leaves.len() == 1 && self.leaves[0].text.is_empty() && self.leaves[0].list.is_none()
    }

    pub fn anchor(&self) -> Pos {
        self.anchor
    }

    pub fn head(&self) -> Pos {
        self.head
    }

    pub fn has_selection(&self) -> bool {
        self.anchor != self.head
    }

    pub fn selection(&self) -> (Pos, Pos) {
        if self.anchor <= self.head { (self.anchor, self.head) } else { (self.head, self.anchor) }
    }

    pub fn marked(&self) -> Option<(usize, Range<usize>)> {
        self.marked.clone()
    }

    pub fn unmark(&mut self) {
        self.marked = None;
    }

    pub fn clamp(&self, p: Pos) -> Pos {
        let leaf = p.leaf.min(self.leaves.len() - 1);
        let text = self.leaves[leaf].text.text();
        let mut off = p.off.min(text.len());
        while !text.is_char_boundary(off) {
            off -= 1;
        }
        Pos { leaf, off }
    }

    pub fn set_selection(&mut self, anchor: Pos, head: Pos) {
        self.anchor = self.clamp(anchor);
        self.head = self.clamp(head);
        self.stored = None;
        self.last = None;
    }

    pub fn move_to(&mut self, p: Pos, extend: bool) {
        let p = self.clamp(p);
        self.head = p;
        if !extend {
            self.anchor = p;
        }
        self.stored = None;
        self.last = None;
    }

    pub fn select_all(&mut self) {
        self.stored = None;
        let last = self.leaves.len() - 1;
        self.anchor = Pos { leaf: 0, off: 0 };
        self.head = Pos { leaf: last, off: self.leaves[last].text.len() };
        self.last = None;
    }

    pub fn leaf_text(&self, leaf: usize) -> String {
        self.leaves[leaf].text.text()
    }

    // ---- flat text (leaves joined by \n) for the platform IME ----

    pub fn flat_text(&self) -> String {
        self.leaves.iter().map(|l| l.text.text()).collect::<Vec<_>>().join("\n")
    }

    pub fn flat_offset(&self, p: Pos) -> usize {
        self.leaves[..p.leaf].iter().map(|l| l.text.len() + 1).sum::<usize>() + p.off
    }

    pub fn pos_from_flat(&self, mut offset: usize) -> Pos {
        for (i, l) in self.leaves.iter().enumerate() {
            if offset <= l.text.len() {
                return self.clamp(Pos { leaf: i, off: offset });
            }
            offset -= l.text.len() + 1;
        }
        let last = self.leaves.len() - 1;
        Pos { leaf: last, off: self.leaves[last].text.len() }
    }

    pub fn flat_to_utf16(&self, offset: usize) -> usize {
        self.flat_text()[..offset.min(self.flat_text().len())].chars().map(char::len_utf16).sum()
    }

    pub fn flat_from_utf16(&self, utf16: usize) -> usize {
        let flat = self.flat_text();
        let mut u = 0;
        for (i, c) in flat.char_indices() {
            if u >= utf16 {
                return i;
            }
            u += c.len_utf16();
        }
        flat.len()
    }

    pub fn selected_plain(&self) -> String {
        let (s, e) = self.selection();
        let flat = self.flat_text();
        flat[self.flat_offset(s)..self.flat_offset(e)].to_string()
    }

    // ---- cursor geometry ----

    pub fn prev_pos(&self, p: Pos) -> Pos {
        if p.off == 0 {
            return if p.leaf == 0 { p } else { Pos { leaf: p.leaf - 1, off: self.leaves[p.leaf - 1].text.len() } };
        }
        let t = self.leaf_text(p.leaf);
        let off = t.grapheme_indices(true).rev().find_map(|(i, _)| (i < p.off).then_some(i)).unwrap_or(0);
        Pos { leaf: p.leaf, off }
    }

    pub fn next_pos(&self, p: Pos) -> Pos {
        let t = self.leaf_text(p.leaf);
        if p.off >= t.len() {
            return if p.leaf + 1 >= self.leaves.len() { p } else { Pos { leaf: p.leaf + 1, off: 0 } };
        }
        let off = t.grapheme_indices(true).find_map(|(i, g)| (i + g.len() > p.off).then_some(i + g.len())).unwrap_or(t.len());
        Pos { leaf: p.leaf, off }
    }

    pub fn prev_word(&self, p: Pos) -> Pos {
        if p.off == 0 {
            return self.prev_pos(p);
        }
        let t = self.leaf_text(p.leaf);
        let mut result = 0;
        for (i, w) in t.split_word_bound_indices() {
            if i >= p.off {
                break;
            }
            if w.chars().any(|c| !c.is_whitespace()) {
                result = i;
            }
        }
        Pos { leaf: p.leaf, off: result }
    }

    pub fn next_word(&self, p: Pos) -> Pos {
        let t = self.leaf_text(p.leaf);
        if p.off >= t.len() {
            return self.next_pos(p);
        }
        for (i, w) in t.split_word_bound_indices() {
            let end = i + w.len();
            if end > p.off && w.chars().any(|c| !c.is_whitespace()) {
                return Pos { leaf: p.leaf, off: end };
            }
        }
        Pos { leaf: p.leaf, off: t.len() }
    }

    // ---- history ----

    fn snap(&self) -> Snap {
        Snap { leaves: self.leaves.clone(), anchor: self.anchor, head: self.head }
    }

    fn checkpoint(&mut self, kind: RichEdit) {
        let merge = kind != RichEdit::Other && self.last == Some(kind) && !self.undo.is_empty();
        if !merge {
            self.undo.push(self.snap());
            if self.undo.len() > 200 {
                self.undo.remove(0);
            }
        }
        self.redo.clear();
        self.last = Some(kind);
    }

    pub fn undo(&mut self) -> bool {
        let Some(s) = self.undo.pop() else { return false };
        self.redo.push(self.snap());
        self.restore(s);
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(s) = self.redo.pop() else { return false };
        self.undo.push(self.snap());
        self.restore(s);
        true
    }

    fn restore(&mut self, s: Snap) {
        self.leaves = s.leaves;
        self.anchor = s.anchor;
        self.head = s.head;
        self.stored = None;
        self.marked = None;
        self.last = None;
    }

    // ---- editing ----

    fn inherited_marks(&self, p: Pos) -> Marks {
        if let Some(m) = &self.stored {
            return m.clone();
        }
        let mut m = self.leaves[p.leaf].text.marks_at(p.off);
        m.link = None;
        m
    }

    fn delete_range(&mut self, s: Pos, e: Pos) {
        if s == e {
            return;
        }
        if s.leaf == e.leaf {
            self.leaves[s.leaf].text.delete(s.off..e.off);
        } else {
            let tail = self.leaves[e.leaf].text.slice(e.off..self.leaves[e.leaf].text.len());
            let slen = self.leaves[s.leaf].text.len();
            self.leaves[s.leaf].text.delete(s.off..slen);
            self.leaves[s.leaf].text.append(&tail);
            self.leaves.drain(s.leaf + 1..=e.leaf);
        }
    }

    /// Replaces the range (default: composition, else selection) with `text` (`\n` splits paragraphs).
    pub fn replace(&mut self, range: Option<(Pos, Pos)>, text: &str, kind: RichEdit) {
        let (s, e) = range
            .or_else(|| self.marked.clone().map(|(l, r)| (Pos { leaf: l, off: r.start }, Pos { leaf: l, off: r.end })))
            .unwrap_or_else(|| self.selection());
        let (s, e) = (self.clamp(s), self.clamp(e));
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        if text.is_empty() && s == e {
            return;
        }
        self.checkpoint(kind);
        let marks = self.inherited_marks(s);
        self.delete_range(s, e);
        let mut pos = s;
        for (i, seg) in text.split('\n').enumerate() {
            if i > 0 {
                pos = self.split_at(pos);
            }
            self.leaves[pos.leaf].text.insert(pos.off, seg, marks.clone());
            pos.off += seg.len();
        }
        self.anchor = pos;
        self.head = pos;
        self.stored = None;
        self.marked = None;
    }

    /// Splits the leaf at `p`; the tail becomes a new leaf of the same list kind. Returns its start.
    fn split_at(&mut self, p: Pos) -> Pos {
        let tail = self.leaves[p.leaf].text.slice(p.off..self.leaves[p.leaf].text.len());
        let len = self.leaves[p.leaf].text.len();
        self.leaves[p.leaf].text.delete(p.off..len);
        let list = self.leaves[p.leaf].list.map(|l| ListInfo { start: 1, ..l });
        self.leaves.insert(p.leaf + 1, Leaf { list, text: tail });
        Pos { leaf: p.leaf + 1, off: 0 }
    }

    pub fn replace_and_mark(&mut self, range: Option<(Pos, Pos)>, text: &str, selected: Option<Range<usize>>) {
        let (s, e) = range
            .or_else(|| self.marked.clone().map(|(l, r)| (Pos { leaf: l, off: r.start }, Pos { leaf: l, off: r.end })))
            .unwrap_or_else(|| self.selection());
        let (s, e) = (self.clamp(s), self.clamp(e));
        let text = text.replace(['\n', '\r'], " ");
        self.checkpoint(RichEdit::Typing);
        let marks = self.inherited_marks(s);
        self.delete_range(s, e);
        self.leaves[s.leaf].text.insert(s.off, &text, marks);
        self.marked = (!text.is_empty()).then(|| (s.leaf, s.off..s.off + text.len()));
        let (a, h) = match selected {
            Some(sel) => ((s.off + sel.start).min(s.off + text.len()), (s.off + sel.end).min(s.off + text.len())),
            None => (s.off + text.len(), s.off + text.len()),
        };
        self.anchor = self.clamp(Pos { leaf: s.leaf, off: a });
        self.head = self.clamp(Pos { leaf: s.leaf, off: h });
    }

    pub fn insert(&mut self, text: &str) {
        self.replace(None, text, RichEdit::Typing);
    }

    /// Enter: splits the paragraph; Enter on an empty list item leaves the list (one level).
    pub fn enter(&mut self) {
        if self.has_selection() {
            self.replace(None, "", RichEdit::Other);
        }
        let p = self.head;
        let leaf = &self.leaves[p.leaf];
        if let Some(li) = leaf.list {
            if leaf.text.is_empty() {
                self.checkpoint(RichEdit::Other);
                self.lift(p.leaf, li);
                return;
            }
        }
        self.checkpoint(RichEdit::Other);
        let marks = self.inherited_marks(p);
        let np = self.split_at(p);
        // the new paragraph keeps typing in the same marks
        self.stored = (!marks.is_plain()).then_some(marks);
        self.anchor = np;
        self.head = np;
    }

    /// Shift+Enter: hard break.
    pub fn hard_break(&mut self) {
        self.replace(None, "", RichEdit::Other);
        let marks = self.inherited_marks(self.head);
        self.checkpoint(RichEdit::Other);
        let p = self.head;
        self.leaves[p.leaf].text.insert(p.off, "\n", marks);
        self.head = Pos { leaf: p.leaf, off: p.off + 1 };
        self.anchor = self.head;
    }

    fn lift(&mut self, leaf: usize, li: ListInfo) {
        if li.depth == 0 {
            self.leaves[leaf].list = None;
        } else {
            self.leaves[leaf].list = Some(ListInfo { depth: li.depth - 1, ..li });
        }
    }

    pub fn backspace(&mut self) {
        if self.has_selection() {
            self.replace(None, "", RichEdit::Other);
            return;
        }
        let p = self.head;
        if p.off > 0 {
            let s = self.prev_pos(p);
            self.replace(Some((s, p)), "", RichEdit::Deleting);
            return;
        }
        if let Some(li) = self.leaves[p.leaf].list {
            self.checkpoint(RichEdit::Other);
            self.lift(p.leaf, li);
            return;
        }
        if p.leaf > 0 {
            let s = self.prev_pos(p);
            self.replace(Some((s, p)), "", RichEdit::Other);
        }
    }

    pub fn delete_forward(&mut self) {
        if self.has_selection() {
            self.replace(None, "", RichEdit::Other);
            return;
        }
        let p = self.head;
        let e = self.next_pos(p);
        if e != p {
            let kind = if e.leaf == p.leaf { RichEdit::Deleting } else { RichEdit::Other };
            self.replace(Some((p, e)), "", kind);
        }
    }

    pub fn delete_word_backward(&mut self) {
        if self.has_selection() {
            self.replace(None, "", RichEdit::Other);
            return;
        }
        let s = self.prev_word(self.head);
        if s != self.head {
            self.replace(Some((s, self.head)), "", RichEdit::Other);
        }
    }

    pub fn delete_word_forward(&mut self) {
        if self.has_selection() {
            self.replace(None, "", RichEdit::Other);
            return;
        }
        let e = self.next_word(self.head);
        if e != self.head {
            self.replace(Some((self.head, e)), "", RichEdit::Other);
        }
    }

    // ---- formatting ----

    fn selected_segments(&self) -> Vec<(usize, Range<usize>)> {
        let (s, e) = self.selection();
        (s.leaf..=e.leaf)
            .map(|i| {
                let len = self.leaves[i].text.len();
                let a = if i == s.leaf { s.off } else { 0 };
                let b = if i == e.leaf { e.off } else { len };
                (i, a..b)
            })
            .filter(|(_, r)| r.start < r.end)
            .collect()
    }

    /// Toolbar state for a mark: the selection fully carries it, or (caret) typing would.
    pub fn is_active(&self, kind: MarkKind) -> bool {
        if self.has_selection() {
            let segs = self.selected_segments();
            return !segs.is_empty() && segs.iter().all(|(i, r)| self.leaves[*i].text.all_have(r.clone(), kind));
        }
        match &self.stored {
            Some(m) => m.has(kind),
            None => self.inherited_marks(self.head).has(kind),
        }
    }

    pub fn toggle_mark(&mut self, kind: MarkKind) {
        if !self.has_selection() {
            let cur = self.inherited_marks(self.head);
            let next = if cur.has(kind) { cur.without(kind) } else { cur.with(kind) };
            self.stored = Some(next);
            return;
        }
        let remove = self.is_active(kind);
        self.checkpoint(RichEdit::Other);
        for (i, r) in self.selected_segments() {
            self.leaves[i].text.map_marks(r, |m| if remove { m.clone().without(kind) } else { m.clone().with(kind) });
        }
    }

    pub fn list_kind_at_caret(&self) -> Option<bool> {
        self.leaves[self.head.leaf].list.map(|l| l.ordered)
    }

    /// True when every selected leaf is in a list of the given kind.
    pub fn is_list_active(&self, ordered: bool) -> bool {
        let (s, e) = self.selection();
        (s.leaf..=e.leaf).all(|i| self.leaves[i].list.map(|l| l.ordered == ordered).unwrap_or(false))
    }

    pub fn toggle_list(&mut self, ordered: bool) {
        let (s, e) = self.selection();
        let all = self.is_list_active(ordered);
        self.checkpoint(RichEdit::Other);
        for i in s.leaf..=e.leaf {
            let l = &mut self.leaves[i];
            l.list = if all {
                None
            } else {
                Some(match l.list {
                    Some(li) => ListInfo { ordered, ..li },
                    None => ListInfo { ordered, depth: 0, start: 1 },
                })
            };
        }
    }

    /// Tab / Shift+Tab inside a list: indent (max one deeper than the previous item) or outdent.
    pub fn indent(&mut self, deeper: bool) {
        let (s, e) = self.selection();
        self.checkpoint(RichEdit::Other);
        for i in s.leaf..=e.leaf {
            let max = if i == 0 {
                0
            } else {
                self.leaves[i - 1].list.map(|l| l.depth + 1).unwrap_or(0)
            };
            if let Some(li) = self.leaves[i].list.as_mut() {
                if deeper {
                    li.depth = (li.depth + 1).min(max);
                } else if li.depth > 0 {
                    li.depth -= 1;
                }
            }
        }
    }

    /// Plain text of one leaf as a `StyledText` (for rendering).
    pub fn styled(&self, leaf: usize) -> &StyledText {
        &self.leaves[leaf].text
    }

    /// 1-based number of an ordered item (counts same-depth siblings of the same list), or None.
    pub fn list_number(&self, leaf: usize) -> Option<u32> {
        let li = self.leaves[leaf].list?;
        if !li.ordered {
            return None;
        }
        let mut n = 0u32;
        let mut i = leaf;
        let mut opener_start = li.start;
        loop {
            let cur = self.leaves[i].list?;
            if cur.depth == li.depth && cur.ordered {
                n += 1;
                opener_start = cur.start;
            }
            if i == 0 {
                break;
            }
            let prev = self.leaves[i - 1].list;
            match prev {
                Some(p) if p.depth > li.depth || (p.depth == li.depth && p.ordered) => i -= 1,
                _ => break,
            }
        }
        Some(opener_start + n - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(html: &str) -> RichState {
        RichState::from_html(html)
    }

    #[test]
    fn typing_into_empty_doc_emits_paragraph() {
        let mut s = st("");
        s.insert("hi");
        assert_eq!(s.to_html(), "<p>hi</p>");
    }

    #[test]
    fn toggle_bold_on_selection_then_off() {
        let mut s = st("<p>hello</p>");
        s.set_selection(Pos { leaf: 0, off: 1 }, Pos { leaf: 0, off: 3 });
        s.toggle_mark(MarkKind::Bold);
        assert_eq!(s.to_html(), "<p>h<strong>el</strong>lo</p>");
        assert!(s.is_active(MarkKind::Bold));
        s.toggle_mark(MarkKind::Bold);
        assert_eq!(s.to_html(), "<p>hello</p>");
    }

    #[test]
    fn stored_mark_applies_to_next_typed_text_only() {
        let mut s = st("<p>ab</p>");
        s.move_to(Pos { leaf: 0, off: 2 }, false);
        s.toggle_mark(MarkKind::Italic);
        assert!(s.is_active(MarkKind::Italic));
        s.insert("c");
        assert_eq!(s.to_html(), "<p>ab<em>c</em></p>");
        s.insert("d");
        assert_eq!(s.to_html(), "<p>ab<em>cd</em></p>");
    }

    #[test]
    fn enter_splits_and_backspace_merges() {
        let mut s = st("<p>abcd</p>");
        s.move_to(Pos { leaf: 0, off: 2 }, false);
        s.enter();
        assert_eq!(s.to_html(), "<p>ab</p><p>cd</p>");
        assert_eq!(s.head(), Pos { leaf: 1, off: 0 });
        s.backspace();
        assert_eq!(s.to_html(), "<p>abcd</p>");
        assert_eq!(s.head(), Pos { leaf: 0, off: 2 });
    }

    #[test]
    fn bullet_list_toggle_enter_and_exit() {
        let mut s = st("<p>one</p>");
        s.toggle_list(false);
        assert_eq!(s.to_html(), "<ul><li><p>one</p></li></ul>");
        s.enter();
        s.insert("two");
        assert_eq!(s.to_html(), "<ul><li><p>one</p></li><li><p>two</p></li></ul>");
        s.enter();
        s.enter();
        assert_eq!(s.to_html(), "<ul><li><p>one</p></li><li><p>two</p></li></ul><p></p>");
    }

    #[test]
    fn ordered_numbers_follow_siblings() {
        let s = st("<ol><li><p>a</p></li><li><p>b</p><ul><li><p>x</p></li></ul></li><li><p>c</p></li></ol>");
        assert_eq!(s.list_number(0), Some(1));
        assert_eq!(s.list_number(1), Some(2));
        assert_eq!(s.list_number(2), None);
        assert_eq!(s.list_number(3), Some(3));
    }

    #[test]
    fn backspace_at_start_of_list_item_lifts_out() {
        let mut s = st("<ul><li><p>a</p></li></ul>");
        s.move_to(Pos { leaf: 0, off: 0 }, false);
        s.backspace();
        assert_eq!(s.to_html(), "<p>a</p>");
    }

    #[test]
    fn delete_across_paragraphs_joins_them() {
        let mut s = st("<p>abc</p><p>def</p>");
        s.set_selection(Pos { leaf: 0, off: 1 }, Pos { leaf: 1, off: 2 });
        s.backspace();
        assert_eq!(s.to_html(), "<p>af</p>");
    }

    #[test]
    fn paste_multiline_makes_paragraphs() {
        let mut s = st("");
        s.replace(None, "a\nb", RichEdit::Other);
        assert_eq!(s.to_html(), "<p>a</p><p>b</p>");
    }

    #[test]
    fn code_toggle_clears_other_marks() {
        let mut s = st("<p><strong>ab</strong></p>");
        s.select_all();
        s.toggle_mark(MarkKind::Code);
        assert_eq!(s.to_html(), "<p><code>ab</code></p>");
    }

    #[test]
    fn hard_break_inserts_br() {
        let mut s = st("<p>ab</p>");
        s.move_to(Pos { leaf: 0, off: 1 }, false);
        s.hard_break();
        assert_eq!(s.to_html(), "<p>a<br>b</p>");
    }

    #[test]
    fn undo_redo_restores_document() {
        let mut s = st("<p>a</p>");
        s.insert("b");
        s.toggle_list(true);
        assert_eq!(s.to_html(), "<ol><li><p>ab</p></li></ol>");
        assert!(s.undo());
        assert_eq!(s.to_html(), "<p>ab</p>");
        assert!(s.undo());
        assert_eq!(s.to_html(), "<p>a</p>");
        assert!(s.redo());
        assert_eq!(s.to_html(), "<p>ab</p>");
    }

    #[test]
    fn ime_composition_in_rich_leaf() {
        let mut s = st("<p>ab</p>");
        s.move_to(Pos { leaf: 0, off: 1 }, false);
        s.replace_and_mark(None, "ni", Some(2..2));
        assert_eq!(s.marked(), Some((0, 1..3)));
        s.replace_and_mark(None, "你", None);
        s.replace(None, "你", RichEdit::Typing);
        assert_eq!(s.to_html(), "<p>a你b</p>");
        assert_eq!(s.marked(), None);
    }

    #[test]
    fn flat_offsets_round_trip() {
        let s = st("<p>ab</p><p>cd</p>");
        assert_eq!(s.flat_text(), "ab\ncd");
        let p = Pos { leaf: 1, off: 1 };
        assert_eq!(s.flat_offset(p), 4);
        assert_eq!(s.pos_from_flat(4), p);
        assert_eq!(s.pos_from_flat(2), Pos { leaf: 0, off: 2 });
    }

    #[test]
    fn typing_after_link_does_not_extend_link() {
        let mut s = st("<p><a href=\"https://e.com\">x</a></p>");
        s.insert("y");
        assert!(!s.to_html().contains("xy"));
    }
}

#[cfg(test)]
mod reach_tests {
    use super::*;

    #[test]
    fn outdent_in_the_middle_of_a_nested_list_still_serializes() {
        let mut s = RichState::from_html("<ul><li><p>a</p><ul><li><p>b</p><ul><li><p>c</p></li></ul></li></ul></li></ul>");
        s.move_to(Pos { leaf: 1, off: 0 }, false);
        s.indent(false);
        let html = s.to_html();
        assert!(html.starts_with("<ul>") && html.contains("c"));
    }

    #[test]
    fn select_all_drops_stored_marks() {
        let mut s = RichState::from_html("<p>ab</p>");
        s.toggle_mark(MarkKind::Bold);
        s.select_all();
        s.insert("x");
        assert_eq!(s.to_html(), "<p>x</p>");
    }
}
