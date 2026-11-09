//! Pure editing model behind `TextInput` / `TextArea`: content, selection, IME composition,
//! undo/redo. No gpui types, so every rule is unit-tested without a window.

use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EditKind {
    /// Consecutive typing / IME commits merge into one undo step.
    Typing,
    /// Consecutive backspace / delete presses merge into one undo step.
    Deleting,
    /// Paste, cut, replace: always its own undo step.
    Other,
}

#[derive(Clone)]
struct Snapshot {
    content: String,
    anchor: usize,
    head: usize,
}

pub struct TextBuffer {
    content: String,
    anchor: usize,
    head: usize,
    marked: Option<Range<usize>>,
    single_line: bool,
    max_len: Option<usize>,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    last_kind: Option<EditKind>,
}

const UNDO_LIMIT: usize = 200;

impl TextBuffer {
    pub fn new(single_line: bool) -> Self {
        Self {
            content: String::new(),
            anchor: 0,
            head: 0,
            marked: None,
            single_line,
            max_len: None,
            undo: Vec::new(),
            redo: Vec::new(),
            last_kind: None,
        }
    }

    pub fn with_max_len(mut self, max_len: usize) -> Self {
        self.max_len = Some(max_len);
        self
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub fn is_empty(&self) -> bool {
        self.content.is_empty()
    }

    pub fn is_single_line(&self) -> bool {
        self.single_line
    }

    /// Replaces the whole text from outside (not an edit: clears history and composition).
    pub fn set_content(&mut self, text: &str) {
        self.content = self.sanitize(text);
        self.anchor = self.content.len();
        self.head = self.content.len();
        self.marked = None;
        self.undo.clear();
        self.redo.clear();
        self.last_kind = None;
    }

    pub fn selection(&self) -> Range<usize> {
        self.anchor.min(self.head)..self.anchor.max(self.head)
    }

    pub fn anchor(&self) -> usize {
        self.anchor
    }

    pub fn head(&self) -> usize {
        self.head
    }

    pub fn has_selection(&self) -> bool {
        self.anchor != self.head
    }

    pub fn marked_range(&self) -> Option<Range<usize>> {
        self.marked.clone()
    }

    pub fn selected_text(&self) -> &str {
        &self.content[self.selection()]
    }

    pub fn set_selection(&mut self, anchor: usize, head: usize) {
        self.anchor = self.clamp(anchor);
        self.head = self.clamp(head);
        self.last_kind = None;
    }

    pub fn move_to(&mut self, offset: usize, extend: bool) {
        let o = self.clamp(offset);
        self.head = o;
        if !extend {
            self.anchor = o;
        }
        self.last_kind = None;
    }

    pub fn select_all(&mut self) {
        self.anchor = 0;
        self.head = self.content.len();
        self.last_kind = None;
    }

    fn clamp(&self, offset: usize) -> usize {
        let mut o = offset.min(self.content.len());
        while !self.content.is_char_boundary(o) {
            o -= 1;
        }
        o
    }

    fn sanitize(&self, text: &str) -> String {
        let mut s = if self.single_line {
            text.replace("\r\n", " ").replace(['\n', '\r'], " ")
        } else {
            text.replace("\r\n", "\n").replace('\r', "\n")
        };
        if let Some(max) = self.max_len {
            if s.chars().count() > max {
                s = s.chars().take(max).collect();
            }
        }
        s
    }

    // ---- cursor geometry on the text itself ----

    pub fn prev_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .rev()
            .find_map(|(i, _)| (i < offset).then_some(i))
            .unwrap_or(0)
    }

    pub fn next_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .find_map(|(i, g)| (i + g.len() > offset).then_some(i + g.len()))
            .unwrap_or(self.content.len())
    }

    /// Start of the word at or before `offset` (CJK ideographs count as one word each).
    pub fn prev_word_boundary(&self, offset: usize) -> usize {
        let mut result = 0;
        for (i, w) in self.content.split_word_bound_indices() {
            if i >= offset {
                break;
            }
            if w.chars().any(|c| !c.is_whitespace()) {
                result = i;
            }
        }
        result
    }

    pub fn next_word_boundary(&self, offset: usize) -> usize {
        for (i, w) in self.content.split_word_bound_indices() {
            let end = i + w.len();
            if end > offset && w.chars().any(|c| !c.is_whitespace()) {
                return end;
            }
        }
        self.content.len()
    }

    pub fn line_start(&self, offset: usize) -> usize {
        self.content[..offset].rfind('\n').map(|i| i + 1).unwrap_or(0)
    }

    pub fn line_end(&self, offset: usize) -> usize {
        self.content[offset..].find('\n').map(|i| offset + i).unwrap_or(self.content.len())
    }

    // ---- UTF-16 mapping (platform IME speaks UTF-16) ----

    pub fn offset_to_utf16(&self, offset: usize) -> usize {
        self.content[..self.clamp(offset)].chars().map(char::len_utf16).sum()
    }

    pub fn offset_from_utf16(&self, utf16: usize) -> usize {
        let mut u = 0;
        for (i, c) in self.content.char_indices() {
            if u >= utf16 {
                return i;
            }
            u += c.len_utf16();
        }
        self.content.len()
    }

    pub fn range_to_utf16(&self, r: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(r.start)..self.offset_to_utf16(r.end)
    }

    pub fn range_from_utf16(&self, r: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(r.start)..self.offset_from_utf16(r.end)
    }

    // ---- editing ----

    fn snapshot(&self) -> Snapshot {
        Snapshot { content: self.content.clone(), anchor: self.anchor, head: self.head }
    }

    fn checkpoint(&mut self, kind: EditKind) {
        let merge = kind != EditKind::Other && self.last_kind == Some(kind) && !self.undo.is_empty();
        if !merge {
            self.undo.push(self.snapshot());
            if self.undo.len() > UNDO_LIMIT {
                self.undo.remove(0);
            }
        }
        self.redo.clear();
        self.last_kind = Some(kind);
    }

    /// Replaces `range` (default: composition range, else selection) with `text`; caret after the text.
    pub fn replace(&mut self, range: Option<Range<usize>>, text: &str, kind: EditKind) {
        let range = range.or_else(|| self.marked.clone()).unwrap_or_else(|| self.selection());
        let start = self.clamp(range.start);
        let end = self.clamp(range.end).max(start);
        let mut text = self.sanitize(text);
        if let Some(max) = self.max_len {
            let room = max.saturating_sub(self.content[..start].chars().count() + self.content[end..].chars().count());
            if text.chars().count() > room {
                text = text.chars().take(room).collect();
            }
        }
        if text.is_empty() && start == end {
            return;
        }
        self.checkpoint(kind);
        self.content.replace_range(start..end, &text);
        self.anchor = start + text.len();
        self.head = self.anchor;
        self.marked = None;
    }

    /// IME composition update: replaces the target range with the preedit and marks it.
    pub fn replace_and_mark(&mut self, range: Option<Range<usize>>, text: &str, selected: Option<Range<usize>>) {
        let range = range.or_else(|| self.marked.clone()).unwrap_or_else(|| self.selection());
        let start = self.clamp(range.start);
        let end = self.clamp(range.end).max(start);
        let text = self.sanitize(text);
        self.checkpoint(EditKind::Typing);
        self.content.replace_range(start..end, &text);
        self.marked = if text.is_empty() { None } else { Some(start..start + text.len()) };
        let (a, h) = match selected {
            Some(sel) => {
                let a = (start + sel.start).min(start + text.len());
                let h = (start + sel.end).min(start + text.len());
                (a, h)
            }
            None => (start + text.len(), start + text.len()),
        };
        self.anchor = self.clamp(a);
        self.head = self.clamp(h);
    }

    pub fn unmark(&mut self) {
        self.marked = None;
    }

    pub fn insert(&mut self, text: &str) {
        self.replace(None, text, EditKind::Typing);
    }

    pub fn backspace(&mut self) {
        if self.has_selection() {
            self.replace(None, "", EditKind::Other);
            return;
        }
        let start = self.prev_boundary(self.head);
        if start < self.head {
            self.replace_deleting(start..self.head);
        }
    }

    pub fn delete_forward(&mut self) {
        if self.has_selection() {
            self.replace(None, "", EditKind::Other);
            return;
        }
        let end = self.next_boundary(self.head);
        if end > self.head {
            self.replace_deleting(self.head..end);
        }
    }

    pub fn delete_word_backward(&mut self) {
        if self.has_selection() {
            self.replace(None, "", EditKind::Other);
            return;
        }
        let start = self.prev_word_boundary(self.head);
        if start < self.head {
            self.replace(Some(start..self.head), "", EditKind::Other);
        }
    }

    pub fn delete_word_forward(&mut self) {
        if self.has_selection() {
            self.replace(None, "", EditKind::Other);
            return;
        }
        let end = self.next_word_boundary(self.head);
        if end > self.head {
            self.replace(Some(self.head..end), "", EditKind::Other);
        }
    }

    fn replace_deleting(&mut self, range: Range<usize>) {
        self.replace(Some(range), "", EditKind::Deleting);
    }

    pub fn undo(&mut self) -> bool {
        let Some(prev) = self.undo.pop() else { return false };
        self.redo.push(self.snapshot());
        self.restore(prev);
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(next) = self.redo.pop() else { return false };
        self.undo.push(self.snapshot());
        self.restore(next);
        true
    }

    fn restore(&mut self, s: Snapshot) {
        self.content = s.content;
        self.anchor = s.anchor;
        self.head = s.head;
        self.marked = None;
        self.last_kind = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buf(text: &str) -> TextBuffer {
        let mut b = TextBuffer::new(false);
        b.set_content(text);
        b
    }

    #[test]
    fn typing_replaces_selection_and_moves_caret() {
        let mut b = buf("hello world");
        b.set_selection(0, 5);
        b.insert("bye");
        assert_eq!(b.content(), "bye world");
        assert_eq!((b.anchor(), b.head()), (3, 3));
    }

    #[test]
    fn backspace_deletes_whole_grapheme() {
        let mut b = buf("a\u{1F345}\u{FE0F}e\u{301}");
        b.backspace();
        assert_eq!(b.content(), "a\u{1F345}\u{FE0F}");
        b.backspace();
        assert_eq!(b.content(), "a");
    }

    #[test]
    fn cjk_and_utf16_offsets() {
        let b = buf("a中\u{1F345}b");
        assert_eq!(b.offset_to_utf16(b.content().len()), 1 + 1 + 2 + 1);
        assert_eq!(b.offset_from_utf16(2), "a中".len());
        assert_eq!(b.offset_from_utf16(4), "a中\u{1F345}".len());
    }

    #[test]
    fn ime_composition_replaces_preedit_then_commits() {
        let mut b = buf("ab");
        b.set_selection(1, 1);
        b.replace_and_mark(None, "ni", Some(2..2));
        assert_eq!(b.content(), "anib");
        assert_eq!(b.marked_range(), Some(1..3));
        b.replace_and_mark(None, "你", None);
        assert_eq!(b.content(), "a你b");
        assert_eq!(b.marked_range(), Some(1..4));
        b.replace(None, "你", EditKind::Typing);
        assert_eq!(b.content(), "a你b");
        assert_eq!(b.marked_range(), None);
        assert_eq!(b.head(), 4);
    }

    #[test]
    fn undo_groups_typing_and_redo_restores() {
        let mut b = buf("");
        for c in ["a", "b", "c"] {
            b.insert(c);
        }
        b.move_to(0, false);
        b.move_to(3, false);
        b.insert("d");
        assert_eq!(b.content(), "abcd");
        assert!(b.undo());
        assert_eq!(b.content(), "abc");
        assert!(b.undo());
        assert_eq!(b.content(), "");
        assert!(!b.undo());
        assert!(b.redo());
        assert_eq!(b.content(), "abc");
        assert!(b.redo());
        assert_eq!(b.content(), "abcd");
    }

    #[test]
    fn new_edit_clears_redo() {
        let mut b = buf("");
        b.insert("a");
        b.undo();
        b.insert("z");
        assert!(!b.redo());
        assert_eq!(b.content(), "z");
    }

    #[test]
    fn single_line_flattens_newlines() {
        let mut b = TextBuffer::new(true);
        b.insert("a\nb\r\nc");
        assert_eq!(b.content(), "a b c");
    }

    #[test]
    fn multi_line_normalizes_crlf() {
        let mut b = TextBuffer::new(false);
        b.insert("a\r\nb\rc");
        assert_eq!(b.content(), "a\nb\nc");
    }

    #[test]
    fn max_len_truncates_insert() {
        let mut b = TextBuffer::new(false).with_max_len(4);
        b.insert("abcdef");
        assert_eq!(b.content(), "abcd");
        b.insert("x");
        assert_eq!(b.content(), "abcd");
    }

    #[test]
    fn word_boundaries() {
        let b = buf("foo bar  baz");
        assert_eq!(b.next_word_boundary(0), 3);
        assert_eq!(b.next_word_boundary(3), 7);
        assert_eq!(b.prev_word_boundary(12), 9);
        assert_eq!(b.prev_word_boundary(9), 4);
    }

    #[test]
    fn delete_word_backward_removes_word() {
        let mut b = buf("foo bar");
        b.delete_word_backward();
        assert_eq!(b.content(), "foo ");
    }

    #[test]
    fn line_start_end() {
        let b = buf("ab\ncde\nf");
        assert_eq!(b.line_start(5), 3);
        assert_eq!(b.line_end(3), 6);
        assert_eq!(b.line_start(1), 0);
    }

    #[test]
    fn selection_move_extend() {
        let mut b = buf("hello");
        b.move_to(0, false);
        b.move_to(3, true);
        assert_eq!(b.selection(), 0..3);
        assert_eq!(b.selected_text(), "hel");
        b.move_to(1, false);
        assert!(!b.has_selection());
    }
}
