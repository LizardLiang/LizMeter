//! Pure editing rules of the notes editor: Enter continues a list or quote, Backspace removes list
//! markup, upload placeholders follow the text around them, and the attachment embed syntax.

use std::ops::Range;

/// One edit: replace `range` with `insert`, then put the caret at `caret`.
#[derive(Debug, PartialEq, Eq)]
pub struct Edit {
    pub range: Range<usize>,
    pub insert: String,
    pub caret: usize,
}

/// What precedes a line's text: indentation, quote markers, a list marker and a task box.
struct Markup {
    /// Indentation and any `>` quote markers, copied as they are to a continued line.
    lead: String,
    /// `-`, `*`, `+`, or the digits and delimiter of an ordered marker.
    marker: Option<String>,
    /// `[ ] ` or `[x] ` including the trailing space.
    task: bool,
    /// Byte offset (within the line) where the line's own text starts.
    text_from: usize,
}

fn parse_markup(line: &str) -> Markup {
    let b = line.as_bytes();
    let mut pos = 0;
    let mut lead_end = 0;
    // indentation and quote markers
    loop {
        while pos < b.len() && matches!(b[pos], b' ' | b'\t') {
            pos += 1;
        }
        if b.get(pos) == Some(&b'>') {
            pos += 1;
            if b.get(pos) == Some(&b' ') {
                pos += 1;
            }
            lead_end = pos;
        } else {
            break;
        }
    }
    let lead_end = if lead_end > 0 { lead_end } else { pos };
    let mut p = lead_end;
    let m_start = p;
    let mut marker = None;
    if matches!(b.get(p), Some(b'-' | b'*' | b'+')) {
        p += 1;
    } else {
        while p < b.len() && b[p].is_ascii_digit() {
            p += 1;
        }
        if p > m_start && matches!(b.get(p), Some(b'.' | b')')) {
            p += 1;
        } else {
            p = m_start;
        }
    }
    if p > m_start && matches!(b.get(p), Some(b' ' | b'\t')) {
        marker = Some(line[m_start..p].to_string());
        while p < b.len() && matches!(b[p], b' ' | b'\t') {
            p += 1;
        }
    } else {
        p = lead_end;
    }
    let mut task = false;
    if let (true, Some(t)) = (marker.is_some(), line.get(p..p + 3)) {
        if matches!(t, "[ ]" | "[x]" | "[X]") && matches!(b.get(p + 3), Some(b' ' | b'\t')) {
            task = true;
            p += 4;
        }
    }
    Markup { lead: line[..lead_end].to_string(), marker, task, text_from: p }
}

/// True when the caret sits inside an open fenced code block (an odd number of fence lines precede it).
fn in_fence(text: &str, caret: usize) -> bool {
    let (ls, _) = line_bounds(text, caret);
    let fences = text[..ls].lines().filter(|l| {
        let t = l.trim_start();
        t.starts_with("```") || t.starts_with("~~~")
    });
    let before = fences.count();
    let cur = text[ls..].lines().next().unwrap_or("").trim_start();
    before % 2 == 1 || cur.starts_with("```") || cur.starts_with("~~~")
}

fn next_marker(marker: &str) -> String {
    let digits: String = marker.chars().take_while(|c| c.is_ascii_digit()).collect();
    match digits.parse::<u64>() {
        Ok(n) if !digits.is_empty() => format!("{}{}", n + 1, &marker[digits.len()..]),
        _ => marker.to_string(),
    }
}

fn line_bounds(text: &str, at: usize) -> (usize, usize) {
    let start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    let end = text[at..].find('\n').map_or(text.len(), |i| at + i);
    (start, end)
}

/// Enter with an empty selection: continues a list item or quote on the next line, or, on an item
/// with no text, removes the marker. `None` means a plain newline.
pub fn continue_markup(text: &str, caret: usize) -> Option<Edit> {
    if in_fence(text, caret) {
        return None;
    }
    let (ls, le) = line_bounds(text, caret);
    let line = &text[ls..le];
    let m = parse_markup(line);
    let in_quote = m.lead.contains('>');
    if m.marker.is_none() && !in_quote {
        return None;
    }
    // The caret inside the markup itself is an ordinary newline.
    if caret < ls + m.text_from.max(m.lead.len()) {
        return None;
    }
    let rest_empty = line[m.text_from..].trim().is_empty();
    if rest_empty && caret == le {
        // An empty item ends the list (or the quote): drop the marker; a list inside a quote keeps the quote.
        let keep = if in_quote && m.marker.is_some() { m.lead.clone() } else { String::new() };
        let caret_to = ls + keep.len();
        return Some(Edit { range: ls..le, insert: keep, caret: caret_to });
    }
    let mut insert = String::from("\n");
    insert.push_str(&m.lead);
    if let Some(marker) = &m.marker {
        insert.push_str(&next_marker(marker));
        insert.push(' ');
        if m.task {
            insert.push_str("[ ] ");
        }
    }
    let caret_to = caret + insert.len();
    Some(Edit { range: caret..caret, insert, caret: caret_to })
}

/// Backspace right after list markup (`- `, `1. `, `- [ ] `): removes the markup, keeping the
/// indentation. `None` means an ordinary backspace.
pub fn delete_markup_backward(text: &str, caret: usize) -> Option<Edit> {
    if in_fence(text, caret) {
        return None;
    }
    let (ls, le) = line_bounds(text, caret);
    let line = &text[ls..le];
    let m = parse_markup(line);
    m.marker.as_ref()?;
    if caret != ls + m.text_from {
        return None;
    }
    let from = ls + m.lead.len();
    Some(Edit { range: from..caret, insert: String::new(), caret: from })
}

/// Where a position goes when `old_len` bytes at `start` become `new_len` bytes. `assoc` > 0 keeps a
/// position at the edit's start after the inserted text, `assoc` < 0 before it.
pub fn map_pos(pos: usize, start: usize, old_len: usize, new_len: usize, assoc: i32) -> usize {
    let end = start + old_len;
    if pos < start || (pos == start && assoc < 0) {
        pos
    } else if pos > end || (pos == end && old_len == 0 && assoc > 0) {
        if pos >= end { pos - old_len + new_len } else { pos }
    } else if pos == end {
        if assoc > 0 { start + new_len } else { start }
    } else if assoc > 0 {
        start + new_len
    } else {
        start
    }
}

/// The single contiguous change between two texts: (start, removed length, inserted length).
pub fn diff_span(old: &str, new: &str) -> (usize, usize, usize) {
    let (a, b) = (old.as_bytes(), new.as_bytes());
    let mut prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    while prefix > 0 && !(old.is_char_boundary(prefix) && new.is_char_boundary(prefix)) {
        prefix -= 1;
    }
    let max_suffix = a.len().min(b.len()) - prefix;
    let mut suffix = a.iter().rev().zip(b.iter().rev()).take(max_suffix).take_while(|(x, y)| x == y).count();
    while suffix > 0 && !(old.is_char_boundary(a.len() - suffix) && new.is_char_boundary(b.len() - suffix)) {
        suffix -= 1;
    }
    (prefix, a.len() - prefix - suffix, b.len() - prefix - suffix)
}

/// Marks an upload placeholder that has not been replaced by its real embed yet.
pub const PLACEHOLDER_PREFIX: &str = "![uploading ";

/// Link text is bracket-delimited, so a file called `a[1].png` has to be escaped.
pub fn escape_link_text(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if matches!(c, '\\' | '[' | ']') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

pub fn upload_placeholder(file_name: &str) -> String {
    format!("{PLACEHOLDER_PREFIX}{}...]()", escape_link_text(file_name))
}

/// Markdown for a stored attachment: an image embeds, anything else links.
pub fn embed_markdown(file_name: &str, url: &str, is_image: bool) -> String {
    let t = escape_link_text(file_name);
    if is_image { format!("![{t}]({url})") } else { format!("[{t}]({url})") }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(text: &str, e: &Edit) -> String {
        format!("{}{}{}", &text[..e.range.start], e.insert, &text[e.range.end..])
    }

    #[test]
    fn enter_continues_a_bullet_list() {
        let t = "- one";
        let e = continue_markup(t, t.len()).unwrap();
        assert_eq!(apply(t, &e), "- one\n- ");
        assert_eq!(e.caret, 8);
    }

    #[test]
    fn enter_continues_numbers_and_keeps_indent() {
        let t = "  3. three";
        let e = continue_markup(t, t.len()).unwrap();
        assert_eq!(apply(t, &e), "  3. three\n  4. ");
        let t = "1) a";
        assert_eq!(apply(t, &continue_markup(t, t.len()).unwrap()), "1) a\n2) ");
    }

    #[test]
    fn enter_continues_a_task_with_an_open_box() {
        let t = "- [x] done";
        assert_eq!(apply(t, &continue_markup(t, t.len()).unwrap()), "- [x] done\n- [ ] ");
    }

    #[test]
    fn enter_in_the_middle_splits_the_item() {
        let t = "- ab";
        let e = continue_markup(t, 3).unwrap();
        assert_eq!(apply(t, &e), "- a\n- b");
        assert_eq!(e.caret, 6);
    }

    #[test]
    fn enter_on_an_empty_item_removes_the_marker() {
        let t = "- one\n- ";
        let e = continue_markup(t, t.len()).unwrap();
        assert_eq!(apply(t, &e), "- one\n");
        assert_eq!(e.caret, 6);
        let t = "- [ ] ";
        assert_eq!(apply(t, &continue_markup(t, t.len()).unwrap()), "");
    }

    #[test]
    fn enter_continues_a_quote() {
        let t = "> hi";
        assert_eq!(apply(t, &continue_markup(t, t.len()).unwrap()), "> hi\n> ");
        let t = "> hi\n> ";
        assert_eq!(apply(t, &continue_markup(t, t.len()).unwrap()), "> hi\n");
    }

    #[test]
    fn non_ascii_list_text_does_not_panic_and_fences_are_left_alone() {
        assert!(delete_markup_backward("- \u{e9}\u{e9}", 0).is_none());
        let t = "- \u{4f60}\u{597d}";
        assert_eq!(apply(t, &continue_markup(t, t.len()).unwrap()), "- \u{4f60}\u{597d}\n- ");
        let t = "```\n- x";
        assert!(continue_markup(t, t.len()).is_none());
        let t = "```\n- x\n```\n- y";
        assert!(continue_markup(t, t.len()).is_some());
    }

    #[test]
    fn enter_in_plain_text_or_inside_the_marker_is_a_plain_newline() {
        assert!(continue_markup("plain", 5).is_none());
        assert!(continue_markup("- one", 1).is_none());
        assert!(continue_markup("-one", 4).is_none());
    }

    #[test]
    fn backspace_after_markup_removes_it() {
        let t = "  - ";
        let e = delete_markup_backward(t, t.len()).unwrap();
        assert_eq!(apply(t, &e), "  ");
        let t = "- [ ] ";
        assert_eq!(apply(t, &delete_markup_backward(t, t.len()).unwrap()), "");
        assert!(delete_markup_backward("- a", 3).is_none());
        assert!(delete_markup_backward("plain", 5).is_none());
    }

    #[test]
    fn positions_map_through_an_edit() {
        // 3 bytes at 2 become 5 bytes
        assert_eq!(map_pos(1, 2, 3, 5, 1), 1);
        assert_eq!(map_pos(10, 2, 3, 5, 1), 12);
        assert_eq!(map_pos(3, 2, 3, 5, 1), 7);
        assert_eq!(map_pos(3, 2, 3, 5, -1), 2);
        // a pure insert at the position: assoc decides which side the position lands on
        assert_eq!(map_pos(4, 4, 0, 2, 1), 6);
        assert_eq!(map_pos(4, 4, 0, 2, -1), 4);
    }

    #[test]
    fn diff_finds_the_changed_span() {
        assert_eq!(diff_span("hello world", "hello brave world"), (6, 0, 6));
        assert_eq!(diff_span("abc", "abc"), (3, 0, 0));
        assert_eq!(diff_span("abcdef", "abXef"), (2, 2, 1));
        // never splits a character
        let (s, r, i) = diff_span("a\u{4f60}b", "a\u{597d}b");
        assert_eq!((s, r, i), (1, 3, 3));
    }

    #[test]
    fn placeholders_and_embeds_escape_brackets() {
        assert_eq!(upload_placeholder("a[1].png"), "![uploading a\\[1\\].png...]()");
        assert_eq!(embed_markdown("a.png", "app-media://x/1", true), "![a.png](app-media://x/1)");
        assert_eq!(embed_markdown("r[2].pdf", "app-media://x/2", false), "[r\\[2\\].pdf](app-media://x/2)");
    }
}
