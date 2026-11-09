//! Document model for the session-description editor and its TipTap HTML codec.
//!
//! The stored format is exactly what `editor.getHTML()` returns for the StarterKit subset used by
//! `RichTextInput.tsx` (paragraphs, bullet/ordered lists, bold, italic, strike, underline, code,
//! links, hard breaks). `tests/fixtures/richtext-golden.json` is generated from the real TipTap
//! (`native/tools/tiptap-golden/gen.ts`) and pins this codec byte for byte.

use std::ops::Range;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Marks {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub underline: bool,
    pub code: bool,
    pub link: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkKind {
    Bold,
    Italic,
    Strike,
    Underline,
    Code,
}

impl Marks {
    pub fn is_plain(&self) -> bool {
        *self == Marks::default()
    }

    pub fn has(&self, kind: MarkKind) -> bool {
        match kind {
            MarkKind::Bold => self.bold,
            MarkKind::Italic => self.italic,
            MarkKind::Strike => self.strike,
            MarkKind::Underline => self.underline,
            MarkKind::Code => self.code,
        }
    }

    /// Adds a mark following the schema: `code` excludes every other mark and is excluded by them.
    pub fn with(mut self, kind: MarkKind) -> Marks {
        match kind {
            MarkKind::Code => return Marks { code: true, ..Marks::default() },
            _ if self.code => return self,
            MarkKind::Bold => self.bold = true,
            MarkKind::Italic => self.italic = true,
            MarkKind::Strike => self.strike = true,
            MarkKind::Underline => self.underline = true,
        }
        self
    }

    pub fn without(mut self, kind: MarkKind) -> Marks {
        match kind {
            MarkKind::Bold => self.bold = false,
            MarkKind::Italic => self.italic = false,
            MarkKind::Strike => self.strike = false,
            MarkKind::Underline => self.underline = false,
            MarkKind::Code => self.code = false,
        }
        self
    }

    /// Normalizes a mark set coming from parsed HTML (code excludes the rest).
    fn normalized(self) -> Marks {
        if self.code { Marks { code: true, ..Marks::default() } } else { self }
    }

    /// Marks in schema rank order, outermost first: link, bold, code, italic, strike, underline.
    fn ranked(&self) -> Vec<Tag> {
        let mut v = Vec::new();
        if let Some(h) = &self.link {
            v.push(Tag::Link(h.clone()));
        }
        if self.bold {
            v.push(Tag::Bold);
        }
        if self.code {
            v.push(Tag::Code);
        }
        if self.italic {
            v.push(Tag::Italic);
        }
        if self.strike {
            v.push(Tag::Strike);
        }
        if self.underline {
            v.push(Tag::Underline);
        }
        v
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Tag {
    Link(String),
    Bold,
    Code,
    Italic,
    Strike,
    Underline,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
    pub text: String,
    pub marks: Marks,
}

/// A string with marks per range. A `\n` inside a run is a hard break.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StyledText {
    runs: Vec<Run>,
}

impl StyledText {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn plain(text: &str) -> Self {
        let mut s = Self::new();
        s.push(text, Marks::default());
        s
    }

    pub fn runs(&self) -> &[Run] {
        &self.runs
    }

    pub fn len(&self) -> usize {
        self.runs.iter().map(|r| r.text.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }

    pub fn text(&self) -> String {
        self.runs.iter().map(|r| r.text.as_str()).collect()
    }

    pub fn push(&mut self, text: &str, marks: Marks) {
        if text.is_empty() {
            return;
        }
        if let Some(last) = self.runs.last_mut() {
            if last.marks == marks {
                last.text.push_str(text);
                return;
            }
        }
        self.runs.push(Run { text: text.to_string(), marks });
    }

    pub fn append(&mut self, other: &StyledText) {
        for r in &other.runs {
            self.push(&r.text, r.marks.clone());
        }
    }

    pub fn slice(&self, range: Range<usize>) -> StyledText {
        let mut out = StyledText::new();
        let mut pos = 0;
        for r in &self.runs {
            let (rs, re) = (pos, pos + r.text.len());
            pos = re;
            let s = range.start.max(rs);
            let e = range.end.min(re);
            if s < e {
                out.push(&r.text[s - rs..e - rs], r.marks.clone());
            }
        }
        out
    }

    pub fn insert(&mut self, at: usize, text: &str, marks: Marks) {
        let tail = self.slice(at..self.len());
        let head = self.slice(0..at);
        *self = head;
        self.push(text, marks);
        self.append(&tail);
    }

    pub fn delete(&mut self, range: Range<usize>) {
        let tail = self.slice(range.end..self.len());
        let head = self.slice(0..range.start);
        *self = head;
        self.append(&tail);
    }

    /// Marks of the character just before `at` (what typing at `at` inherits), else of the one after.
    pub fn marks_at(&self, at: usize) -> Marks {
        let mut pos = 0;
        let mut after: Option<&Marks> = None;
        for r in &self.runs {
            let (rs, re) = (pos, pos + r.text.len());
            pos = re;
            if at > rs && at <= re {
                return r.marks.clone();
            }
            if at == rs && after.is_none() {
                after = Some(&r.marks);
            }
        }
        after.cloned().unwrap_or_default()
    }

    pub fn map_marks(&mut self, range: Range<usize>, f: impl Fn(&Marks) -> Marks) {
        let mut out = StyledText::new();
        let mut pos = 0;
        for r in &self.runs {
            let (rs, re) = (pos, pos + r.text.len());
            pos = re;
            let s = range.start.max(rs).min(re);
            let e = range.end.min(re).max(rs);
            if s >= e {
                out.push(&r.text, r.marks.clone());
                continue;
            }
            out.push(&r.text[..s - rs], r.marks.clone());
            out.push(&r.text[s - rs..e - rs], f(&r.marks));
            out.push(&r.text[e - rs..], r.marks.clone());
        }
        *self = out;
    }

    /// True when every character of `range` carries `kind` (empty range: false).
    pub fn all_have(&self, range: Range<usize>, kind: MarkKind) -> bool {
        let mut pos = 0;
        let mut any = false;
        for r in &self.runs {
            let (rs, re) = (pos, pos + r.text.len());
            pos = re;
            if range.start.max(rs) < range.end.min(re) {
                any = true;
                if !r.marks.has(kind) {
                    return false;
                }
            }
        }
        any
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListInfo {
    pub ordered: bool,
    /// 0 = outermost list.
    pub depth: usize,
    /// `start` attribute of an ordered list, read from the leaf that opens it.
    pub start: u32,
}

/// One paragraph: either a root paragraph or a single-paragraph list item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Leaf {
    pub list: Option<ListInfo>,
    pub text: StyledText,
}

impl Leaf {
    pub fn paragraph() -> Self {
        Leaf { list: None, text: StyledText::new() }
    }
}

// ---------------------------------------------------------------- parsing

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        if let Some(semi) = rest.find(';').filter(|&j| j <= 10) {
            let name = &rest[1..semi];
            let decoded = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some('\u{a0}'),
                _ => name
                    .strip_prefix("#x")
                    .or_else(|| name.strip_prefix("#X"))
                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                    .or_else(|| name.strip_prefix('#').and_then(|d| d.parse().ok()))
                    .and_then(char::from_u32),
            };
            if let Some(c) = decoded {
                out.push(c);
                rest = &rest[semi + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &rest[1..];
    }
    out.push_str(rest);
    out
}

struct Open {
    tag: String,
    mark: Option<Tag>,
}

#[derive(Default)]
struct Parser {
    leaves: Vec<Leaf>,
    lists: Vec<(bool, u32)>,
    open: Vec<Open>,
    current: Option<Leaf>,
    /// `<li>` seen and its paragraph not yet started.
    li_pending: bool,
    /// Last character written to the current paragraph was collapsible whitespace (or none yet).
    at_space: bool,
}

impl Parser {
    fn marks(&self) -> Marks {
        let mut m = Marks::default();
        for o in &self.open {
            match &o.mark {
                Some(Tag::Bold) => m.bold = true,
                Some(Tag::Italic) => m.italic = true,
                Some(Tag::Strike) => m.strike = true,
                Some(Tag::Underline) => m.underline = true,
                Some(Tag::Code) => m.code = true,
                Some(Tag::Link(h)) => m.link = Some(h.clone()),
                None => {}
            }
        }
        m.normalized()
    }

    fn list_info(&self) -> Option<ListInfo> {
        let (ordered, start) = *self.lists.last()?;
        Some(ListInfo { ordered, depth: self.lists.len() - 1, start })
    }

    fn start_paragraph(&mut self) {
        self.flush(false);
        self.current = Some(Leaf { list: self.list_info(), text: StyledText::new() });
        self.li_pending = false;
        self.at_space = true;
    }

    fn flush(&mut self, keep_empty: bool) {
        if let Some(mut leaf) = self.current.take() {
            // trailing collapsible space is trimmed
            if let Some(last) = leaf.text.runs.last_mut() {
                if last.text.ends_with(' ') && self.at_space {
                    last.text.pop();
                }
            }
            leaf.text.runs.retain(|r| !r.text.is_empty());
            let _ = keep_empty;
            self.leaves.push(leaf);
        }
    }

    fn text(&mut self, raw: &str) {
        let decoded = decode_entities(raw);
        let mut collapsed = String::new();
        for c in decoded.chars() {
            if matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{c}') {
                if !collapsed.ends_with(' ') && !(collapsed.is_empty() && self.at_space) {
                    collapsed.push(' ');
                }
            } else {
                collapsed.push(c);
            }
        }
        if collapsed.is_empty() {
            return;
        }
        if self.current.is_none() {
            if collapsed.trim().is_empty() {
                return;
            }
            self.start_paragraph();
            collapsed = collapsed.trim_start_matches(' ').to_string();
        }
        let marks = self.marks();
        if let Some(leaf) = self.current.as_mut() {
            if self.at_space && collapsed.starts_with(' ') {
                collapsed.remove(0);
            }
            if collapsed.is_empty() {
                return;
            }
            self.at_space = collapsed.ends_with(' ');
            leaf.text.push(&collapsed, marks);
        }
    }

    fn start_tag(&mut self, name: &str, attrs: &str, self_closing: bool) {
        match name {
            "ul" | "ol" => {
                self.flush(false);
                let start = attr(attrs, "start").and_then(|s| s.parse().ok()).unwrap_or(1);
                self.lists.push((name == "ol", start));
                self.open.push(Open { tag: name.into(), mark: None });
            }
            "li" => {
                self.flush(false);
                self.li_pending = true;
                self.open.push(Open { tag: name.into(), mark: None });
            }
            "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "pre" | "div" => {
                if matches!(name, "blockquote" | "div") {
                    self.flush(false);
                } else {
                    self.start_paragraph();
                }
                self.open.push(Open { tag: name.into(), mark: None });
            }
            "br" => {
                if self.current.is_none() {
                    self.start_paragraph();
                }
                let marks = self.marks();
                if let Some(leaf) = self.current.as_mut() {
                    leaf.text.push("\n", marks);
                }
                self.at_space = true;
            }
            _ => {
                let mark = match name {
                    "strong" | "b" => Some(Tag::Bold),
                    "em" | "i" => Some(Tag::Italic),
                    "s" | "strike" | "del" => Some(Tag::Strike),
                    "u" => Some(Tag::Underline),
                    "code" => Some(Tag::Code),
                    "a" => attr(attrs, "href").map(|h| Tag::Link(decode_entities(&h))),
                    _ => None,
                };
                if !self_closing {
                    self.open.push(Open { tag: name.into(), mark });
                }
            }
        }
    }

    fn end_tag(&mut self, name: &str) {
        let Some(pos) = self.open.iter().rposition(|o| o.tag == name) else { return };
        let closed: Vec<Open> = self.open.drain(pos..).collect();
        match name {
            "ul" | "ol" => {
                self.flush(false);
                self.lists.pop();
            }
            "li" => {
                if self.li_pending {
                    self.start_paragraph();
                }
                self.flush(true);
                self.li_pending = false;
            }
            "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "pre" | "div" => {
                if name == "p" || name.starts_with('h') || name == "pre" {
                    if self.current.is_none() {
                        // `<p></p>` still yields an empty paragraph
                        self.start_paragraph();
                    }
                }
                self.flush(true);
            }
            _ => {}
        }
        // nested closes of unclosed inline marks inside `closed` are dropped with the drain
        drop(closed);
    }
}

fn attr(attrs: &str, name: &str) -> Option<String> {
    let mut rest = attrs;
    while let Some(i) = rest.find(name) {
        let before_ok = i == 0 || rest.as_bytes()[i - 1].is_ascii_whitespace();
        let after = &rest[i + name.len()..];
        let after_trim = after.trim_start();
        if before_ok && after_trim.starts_with('=') {
            let v = after_trim[1..].trim_start();
            return if let Some(q) = v.chars().next().filter(|c| *c == '"' || *c == '\'') {
                let inner = &v[1..];
                inner.find(q).map(|e| inner[..e].to_string())
            } else {
                Some(v.split_whitespace().next().unwrap_or("").to_string())
            };
        }
        rest = &rest[i + name.len()..];
    }
    None
}

/// Parses TipTap / plain text input into leaves. Always returns at least one leaf.
pub fn parse_html(html: &str) -> Vec<Leaf> {
    let mut p = Parser::default();
    let mut rest = html;
    while !rest.is_empty() {
        match rest.find('<') {
            None => {
                p.text(rest);
                break;
            }
            Some(0) => {
                let Some(end) = rest.find('>') else {
                    p.text(rest);
                    break;
                };
                let inner = &rest[1..end];
                rest = &rest[end + 1..];
                if inner.starts_with('!') || inner.starts_with('?') {
                    continue;
                }
                if let Some(name) = inner.strip_prefix('/') {
                    p.end_tag(&name.trim().to_ascii_lowercase());
                } else {
                    let self_closing = inner.ends_with('/');
                    let inner = inner.trim_end_matches('/');
                    let (name, attrs) = match inner.find(|c: char| c.is_ascii_whitespace()) {
                        Some(i) => (&inner[..i], &inner[i..]),
                        None => (inner, ""),
                    };
                    p.start_tag(&name.to_ascii_lowercase(), attrs, self_closing);
                }
            }
            Some(i) => {
                p.text(&rest[..i]);
                rest = &rest[i..];
            }
        }
    }
    p.flush(true);
    let mut leaves = p.leaves;
    // A list may not jump more than one level at a time.
    let mut prev_depth: Option<usize> = None;
    for l in leaves.iter_mut() {
        if let Some(li) = l.list.as_mut() {
            let max = prev_depth.map(|d| d + 1).unwrap_or(0);
            li.depth = li.depth.min(max);
            prev_depth = Some(li.depth);
        } else {
            prev_depth = None;
        }
    }
    if leaves.is_empty() {
        leaves.push(Leaf::paragraph());
    }
    leaves
}

// ---------------------------------------------------------------- serializing

fn escape_text(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            c => out.push(c),
        }
    }
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('\u{a0}', "&nbsp;").replace('"', "&quot;")
}

fn open_tag(t: &Tag) -> String {
    match t {
        Tag::Link(h) => format!("<a target=\"_blank\" rel=\"noopener noreferrer nofollow\" href=\"{}\">", escape_attr(h)),
        Tag::Bold => "<strong>".into(),
        Tag::Code => "<code>".into(),
        Tag::Italic => "<em>".into(),
        Tag::Strike => "<s>".into(),
        Tag::Underline => "<u>".into(),
    }
}

fn close_tag(t: &Tag) -> &'static str {
    match t {
        Tag::Link(_) => "</a>",
        Tag::Bold => "</strong>",
        Tag::Code => "</code>",
        Tag::Italic => "</em>",
        Tag::Strike => "</s>",
        Tag::Underline => "</u>",
    }
}

/// Mirrors ProseMirror's `DOMSerializer.serializeFragment` mark nesting: marks stay open across
/// adjacent nodes while they match, outermost (lowest rank) first.
fn write_inline(text: &StyledText, out: &mut String) {
    let mut active: Vec<Tag> = Vec::new();
    for run in text.runs() {
        let marks = run.marks.ranked();
        let mut keep = 0;
        while keep < active.len() && keep < marks.len() && active[keep] == marks[keep] {
            keep += 1;
        }
        while active.len() > keep {
            out.push_str(close_tag(&active.pop().unwrap()));
        }
        for m in &marks[keep..] {
            out.push_str(&open_tag(m));
            active.push(m.clone());
        }
        let mut first = true;
        for seg in run.text.split('\n') {
            if !first {
                out.push_str("<br>");
            }
            first = false;
            escape_text(seg, out);
        }
    }
    while let Some(t) = active.pop() {
        out.push_str(close_tag(&t));
    }
}

fn write_list(leaves: &[Leaf], i: &mut usize, depth: usize, out: &mut String) {
    let info = leaves[*i].list.unwrap();
    let ordered = info.ordered;
    if ordered {
        if info.start != 1 {
            out.push_str(&format!("<ol start=\"{}\">", info.start));
        } else {
            out.push_str("<ol>");
        }
    } else {
        out.push_str("<ul>");
    }
    while *i < leaves.len() {
        let Some(li) = leaves[*i].list else { break };
        if li.depth != depth || li.ordered != ordered {
            break;
        }
        out.push_str("<li><p>");
        write_inline(&leaves[*i].text, out);
        out.push_str("</p>");
        *i += 1;
        while *i < leaves.len() && leaves[*i].list.map(|l| l.depth > depth).unwrap_or(false) {
            write_list(leaves, i, depth + 1, out);
        }
        out.push_str("</li>");
    }
    out.push_str(if ordered { "</ol>" } else { "</ul>" });
}

pub fn to_html(leaves: &[Leaf]) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < leaves.len() {
        if leaves[i].list.is_some() {
            let d = leaves[i].list.unwrap().depth;
            write_list(leaves, &mut i, d, &mut out);
        } else {
            out.push_str("<p>");
            write_inline(&leaves[i].text, &mut out);
            out.push_str("</p>");
            i += 1;
        }
    }
    if out.is_empty() {
        out.push_str("<p></p>");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        input: String,
        output: String,
    }

    fn roundtrip(html: &str) -> String {
        to_html(&parse_html(html))
    }

    fn golden() -> Vec<Case> {
        let raw = include_str!("../tests/fixtures/richtext-golden.json");
        serde_json::from_str(raw).expect("golden json")
    }

    #[test]
    fn matches_real_tiptap_for_every_golden_input() {
        for c in golden() {
            assert_eq!(roundtrip(&c.input), c.output, "input: {}", c.input);
        }
    }

    #[test]
    fn tiptap_output_round_trips_byte_identical() {
        for c in golden() {
            assert_eq!(roundtrip(&c.output), c.output, "output re-parsed: {}", c.output);
        }
    }

    #[test]
    fn dev_db_shapes_round_trip() {
        for html in ["<p>Linked session test</p>", "<p>Prompt dialog testLinked session test</p>", "<p>gpu probe</p>"] {
            assert_eq!(roundtrip(html), html);
        }
    }

    #[test]
    fn styled_text_edit_keeps_marks() {
        let mut t = StyledText::plain("hello");
        t.map_marks(1..3, |m| m.clone().with(MarkKind::Bold));
        assert!(t.all_have(1..3, MarkKind::Bold));
        assert!(!t.all_have(0..3, MarkKind::Bold));
        t.insert(2, "XY", Marks::default().with(MarkKind::Italic));
        assert_eq!(t.text(), "heXYllo");
        t.delete(2..4);
        assert_eq!(t.text(), "hello");
        assert_eq!(to_html(&[Leaf { list: None, text: t }]), "<p>h<strong>el</strong>lo</p>");
    }

    #[test]
    fn code_excludes_other_marks() {
        let m = Marks::default().with(MarkKind::Bold).with(MarkKind::Code);
        assert!(m.code && !m.bold);
        assert_eq!(m.clone().with(MarkKind::Italic), m);
    }
}
