//! The decision layer of the live-preview notes editor, port of `editor/livePreviewRanges.ts` and
//! `editor/urlSchemes.ts`.
//!
//! Every choice live preview makes (which markdown syntax disappears, which text gets a class, and
//! when the cursor "owns" a construct and reveals its raw source) is made here, from the document
//! text and the selection alone. No gpui types, so each rule is unit-tested without a window.
//! `md_editor.rs` turns the descriptors into styled, hidden and replaced text.

use pulldown_cmark::{Alignment, CodeBlockKind, Event, LinkType, Options, Parser, Tag, TagEnd};
use std::ops::Range;

/// Longest block a construct may span and still be replaced (fenced code, tables). An unterminated
/// fence swallows the rest of the note; past the cap the block renders as raw source instead.
pub const MAX_BLOCK_LINES: usize = 200;

/// Deepest nesting level that still gets its own class.
const MAX_LIST_DEPTH: usize = 6;

/// Schemes a markdown destination may carry and still be rendered. `data:` is absent on purpose.
pub const ALLOWED_URL_SCHEMES: [&str; 4] = ["http:", "https:", "mailto:", "app-media:"];

/// True when a link or image destination may be rendered as a live element. Relative references
/// carry no scheme and cannot execute, so they pass; protocol-relative `//host` does not.
pub fn is_allowed_url(raw: &str) -> bool {
    let mut candidate = raw.trim();
    if candidate.starts_with('<') && candidate.ends_with('>') && candidate.len() >= 2 {
        candidate = &candidate[1..candidate.len() - 1];
    }
    // Browsers drop control characters and whitespace before resolving a scheme, so the test does too.
    let stripped: String = candidate.chars().filter(|c| (*c as u32) > 0x20 && (*c as u32) != 0x7f).collect();
    if stripped.is_empty() || stripped.starts_with("//") {
        return false;
    }
    let Some(colon) = stripped.find(':') else { return true };
    let scheme = &stripped[..colon];
    let mut chars = scheme.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !valid {
        return true;
    }
    let lower = format!("{}:", scheme.to_ascii_lowercase());
    ALLOWED_URL_SCHEMES.contains(&lower.as_str())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PreviewKind {
    /// Collapses the range to nothing.
    Hide,
    /// Wraps the range in a style class.
    Mark,
    /// Attaches a class to the whole line at `from` (layout only; applies whatever the cursor does).
    Line,
    /// Swaps the range for text, an image, a checkbox or a whole table.
    Widget,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Align {
    None,
    Left,
    Center,
    Right,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PreviewTable {
    pub header: Vec<String>,
    pub align: Vec<Align>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct PreviewRange {
    pub from: usize,
    pub to: usize,
    pub kind: PreviewKind,
    pub mark_class: Option<String>,
    pub widget_text: Option<String>,
    /// Image destination; set only after it passed `is_allowed_url`.
    pub widget_src: Option<String>,
    /// Task-list checkbox state.
    pub widget_checked: Option<bool>,
    pub widget_table: Option<PreviewTable>,
}

impl PreviewRange {
    fn new(kind: PreviewKind, from: usize, to: usize) -> Self {
        Self { from, to, kind, mark_class: None, widget_text: None, widget_src: None, widget_checked: None, widget_table: None }
    }
    fn hide(from: usize, to: usize) -> Self {
        Self::new(PreviewKind::Hide, from, to)
    }
    fn mark(from: usize, to: usize, class: &str) -> Self {
        let mut r = Self::new(PreviewKind::Mark, from, to);
        r.mark_class = Some(class.to_string());
        r
    }
    fn line(at: usize, class: String) -> Self {
        let mut r = Self::new(PreviewKind::Line, at, at);
        r.mark_class = Some(class);
        r
    }
    fn widget(from: usize, to: usize, class: &str) -> Self {
        let mut r = Self::new(PreviewKind::Widget, from, to);
        r.mark_class = Some(class.to_string());
        r
    }
    fn text(mut self, t: &str) -> Self {
        self.widget_text = Some(t.to_string());
        self
    }
}

struct Lines {
    starts: Vec<usize>,
    len: usize,
}

impl Lines {
    fn new(text: &str) -> Self {
        let mut starts = vec![0];
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                starts.push(i + 1);
            }
        }
        Self { starts, len: text.len() }
    }
    /// Zero-based line number containing `offset`.
    fn of(&self, offset: usize) -> usize {
        let o = offset.min(self.len);
        self.starts.partition_point(|s| *s <= o) - 1
    }
    fn start(&self, line: usize) -> usize {
        self.starts[line]
    }
    fn span(&self, from: usize, to: usize) -> (usize, usize) {
        (self.of(from), self.of(to))
    }
    fn one_line(&self, from: usize, to: usize) -> bool {
        let (a, b) = self.span(from, to);
        a == b
    }
}

struct Ctx<'a> {
    text: &'a str,
    lines: Lines,
    revealed: Vec<(usize, usize)>,
    out: Vec<PreviewRange>,
}

impl Ctx<'_> {
    fn owned(&self, from: usize, to: usize) -> bool {
        let (a, b) = self.lines.span(from, to);
        self.touches(a, b)
    }

    fn touches(&self, first: usize, last: usize) -> bool {
        for (rf, rl) in &self.revealed {
            if *rf > last {
                return false;
            }
            if *rl >= first {
                return true;
            }
        }
        false
    }

    fn push(&mut self, r: PreviewRange) {
        if r.kind == PreviewKind::Line {
            self.out.push(r);
            return;
        }
        if r.to <= r.from {
            return;
        }
        // A replace may not cross a line break; a mark may, and so may a whole table.
        let crosses_ok = r.kind == PreviewKind::Mark || r.widget_table.is_some();
        if !crosses_ok && !self.lines.one_line(r.from, r.to) {
            return;
        }
        self.out.push(r);
    }

    fn with_trailing_space(&self, pos: usize) -> usize {
        if self.text.as_bytes().get(pos) == Some(&b' ') { pos + 1 } else { pos }
    }
}

fn trim_end_range(text: &str, r: &Range<usize>) -> Range<usize> {
    let mut end = r.end.min(text.len());
    let b = text.as_bytes();
    while end > r.start && matches!(b[end - 1], b'\n' | b'\r') {
        end -= 1;
    }
    r.start..end
}

struct ItemInfo {
    range: Range<usize>,
    depth: usize,
    nested_from: Option<usize>,
}

/// The selection's line runs, sorted and merged.
fn revealed_lines(lines: &Lines, selections: &[Range<usize>]) -> Vec<(usize, usize)> {
    let mut spans: Vec<(usize, usize)> = selections.iter().map(|s| lines.span(s.start, s.end)).collect();
    spans.sort();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for s in spans {
        match merged.last_mut() {
            Some(prev) if s.0 <= prev.1 + 1 => prev.1 = prev.1.max(s.1),
            _ => merged.push(s),
        }
    }
    merged
}

fn options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}

/// Describes how the document should render around the given selection.
///
/// `selections` are byte ranges; every line they touch renders as raw source. `visible` limits the
/// walk to the given byte windows (default: the whole document).
pub fn live_preview_ranges(text: &str, selections: &[Range<usize>], visible: Option<&[Range<usize>]>) -> Vec<PreviewRange> {
    if text.is_empty() {
        return Vec::new();
    }
    let lines = Lines::new(text);
    let mut cx = Ctx { text, revealed: revealed_lines(&lines, selections), lines, out: Vec::new() };

    let events: Vec<(Event, Range<usize>)> = Parser::new_ext(text, options()).into_offset_iter().collect();

    // Pass 1: list items, their depth and where a nested list starts.
    let mut items: Vec<ItemInfo> = Vec::new();
    {
        let mut item_stack: Vec<usize> = Vec::new();
        let mut depth = 0usize;
        for (ev, r) in &events {
            match ev {
                Event::Start(Tag::List(_)) => {
                    depth += 1;
                    if let Some(&i) = item_stack.last() {
                        if items[i].nested_from.is_none() {
                            items[i].nested_from = Some(r.start);
                        }
                    }
                }
                Event::End(TagEnd::List(_)) => depth = depth.saturating_sub(1),
                Event::Start(Tag::Item) => {
                    items.push(ItemInfo { range: trim_end_range(text, r), depth, nested_from: None });
                    item_stack.push(items.len() - 1);
                }
                Event::End(TagEnd::Item) => {
                    item_stack.pop();
                }
                _ => {}
            }
        }
    }

    let in_window = |r: &Range<usize>| match visible {
        None => true,
        Some(w) if w.is_empty() => true,
        Some(w) => w.iter().any(|win| r.start < win.end.max(win.start + 1) && r.end >= win.start),
    };

    // Pass 2: emit.
    let mut item_idx = 0usize;
    let mut item_stack: Vec<usize> = Vec::new();
    let mut quote_depth = 0usize;
    let mut skip_until: Option<TagEnd> = None;
    let mut link_depth = 0usize;
    let mut code_block = false;
    let mut pending: Option<Range<usize>> = None;

    for (ev, r) in &events {
        if let Some(end) = &skip_until {
            if matches!(ev, Event::End(e) if e == end) {
                skip_until = None;
            }
            continue;
        }
        let plain_text = matches!(ev, Event::Text(_)) && link_depth == 0 && !code_block;
        if plain_text {
            match &mut pending {
                Some(p) if p.end == r.start => p.end = r.end,
                _ => {
                    if let Some(p) = pending.take() {
                        if in_window(&p) {
                            bare_autolinks(&mut cx, &p);
                        }
                    }
                    pending = Some(r.clone());
                }
            }
            continue;
        }
        if let Some(p) = pending.take() {
            if in_window(&p) {
                bare_autolinks(&mut cx, &p);
            }
        }

        match ev {
            Event::Start(Tag::List(_)) | Event::End(TagEnd::List(_)) => {}
            Event::Start(Tag::Item) => {
                item_stack.push(item_idx);
                let info = &items[item_idx];
                item_idx += 1;
                if in_window(&info.range) {
                    list_mark(&mut cx, &info.range);
                }
            }
            Event::End(TagEnd::Item) => {
                item_stack.pop();
            }
            Event::Start(Tag::BlockQuote(_)) => {
                quote_depth += 1;
                let rr = trim_end_range(text, r);
                if in_window(&rr) {
                    blockquote(&mut cx, &rr, quote_depth);
                }
            }
            Event::End(TagEnd::BlockQuote(_)) => quote_depth = quote_depth.saturating_sub(1),
            Event::Start(Tag::Heading { level, .. }) => {
                let rr = trim_end_range(text, r);
                if in_window(&rr) {
                    heading(&mut cx, &rr, *level as usize);
                }
            }
            Event::Start(Tag::Strong) => {
                let rr = trim_end_range(text, r);
                if in_window(&rr) {
                    delimited(&mut cx, &rr, 2, "cm-md-strong");
                }
            }
            Event::Start(Tag::Emphasis) => {
                let rr = trim_end_range(text, r);
                if in_window(&rr) {
                    delimited(&mut cx, &rr, 1, "cm-md-em");
                }
            }
            Event::Start(Tag::Strikethrough) => {
                let rr = trim_end_range(text, r);
                if in_window(&rr) {
                    let n = text[rr.start..].bytes().take_while(|b| *b == b'~').count().min(2);
                    delimited(&mut cx, &rr, n, "cm-md-strike");
                }
            }
            Event::Code(_) => {
                let rr = trim_end_range(text, r);
                if in_window(&rr) {
                    let n = text[rr.start..].bytes().take_while(|b| *b == b'`').count();
                    delimited(&mut cx, &rr, n, "cm-md-code");
                }
            }
            Event::Start(Tag::Link { link_type, dest_url, .. }) => {
                link_depth += 1;
                let rr = trim_end_range(text, r);
                if in_window(&rr) {
                    match link_type {
                        LinkType::Inline => link(&mut cx, &rr, dest_url),
                        LinkType::Autolink | LinkType::Email => bracketed_autolink(&mut cx, &rr, dest_url),
                        _ => {}
                    }
                }
            }
            Event::End(TagEnd::Link) => link_depth = link_depth.saturating_sub(1),
            Event::Start(Tag::Image { link_type, dest_url, .. }) => {
                skip_until = Some(TagEnd::Image);
                let rr = trim_end_range(text, r);
                if in_window(&rr) && *link_type == LinkType::Inline {
                    image(&mut cx, &rr, dest_url);
                }
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                if let CodeBlockKind::Fenced(_) = kind {
                    let rr = trim_end_range(text, r);
                    if in_window(&rr) {
                        fenced_code(&mut cx, &rr);
                    }
                }
                code_block = true;
            }
            Event::End(TagEnd::CodeBlock) => code_block = false,
            Event::Rule => {
                let rr = trim_end_range(text, r);
                if in_window(&rr) && !cx.owned(rr.start, rr.end) {
                    cx.push(PreviewRange::widget(rr.start, rr.end, "cm-md-hr").text(""));
                }
            }
            Event::TaskListMarker(checked) => {
                if let Some(&i) = item_stack.last() {
                    let info = &items[i];
                    task(&mut cx, info, r, *checked);
                }
            }
            Event::Start(Tag::Table(aligns)) => {
                skip_until = Some(TagEnd::Table);
                let rr = trim_end_range(text, r);
                if in_window(&rr) {
                    table(&mut cx, &rr, aligns, &events, r.start);
                }
            }
            _ => {}
        }
    }
    if let Some(p) = pending.take() {
        if in_window(&p) {
            bare_autolinks(&mut cx, &p);
        }
    }

    // Hanging indent per list line: layout, not syntax, so independent of cursor ownership.
    for info in &items {
        let first = cx.lines.of(info.range.start);
        let last = match info.nested_from {
            Some(n) => cx.lines.of(n).saturating_sub(1),
            None => cx.lines.of(info.range.end.saturating_sub(1).max(info.range.start)),
        };
        if last < first || !in_window(&info.range) {
            continue;
        }
        let depth = info.depth.clamp(1, MAX_LIST_DEPTH);
        for n in first..=last {
            let at = cx.lines.start(n);
            cx.push(PreviewRange::line(at, format!("cm-md-li-depth-{depth}")));
        }
    }

    let mut out = std::mem::take(&mut cx.out);
    out.sort_by(|a, b| a.from.cmp(&b.from).then(a.to.cmp(&b.to)));
    drop_repeats(out)
}

/// Two overlapping windows visit a straddling node twice; sorted, the copies adjoin.
pub fn drop_repeats(ranges: Vec<PreviewRange>) -> Vec<PreviewRange> {
    let mut unique: Vec<PreviewRange> = Vec::with_capacity(ranges.len());
    for r in ranges {
        if unique.last().is_some_and(|p| *p == r) {
            continue;
        }
        unique.push(r);
    }
    unique
}

// ---- inline constructs ----

/// `<mark>content<mark>`: bold, italic, code, strikethrough. `n` is the delimiter width.
fn delimited(cx: &mut Ctx, node: &Range<usize>, n: usize, class: &str) {
    if cx.owned(node.start, node.end) || n == 0 {
        return;
    }
    let (open_end, close_start) = (node.start + n, node.end.saturating_sub(n));
    if close_start <= open_end {
        return;
    }
    cx.push(PreviewRange::hide(node.start, open_end));
    cx.push(PreviewRange::hide(close_start, node.end));
    cx.push(PreviewRange::mark(open_end, close_start, class));
}

fn heading(cx: &mut Ctx, node: &Range<usize>, level: usize) {
    // Setext headings keep their raw source and token colours.
    if !cx.text[node.start..node.end].starts_with('#') {
        return;
    }
    if cx.owned(node.start, node.end) || !(1..=6).contains(&level) {
        return;
    }
    let hashes = cx.text[node.start..].bytes().take_while(|b| *b == b'#').count();
    let open_end = node.start + hashes;
    let content_from = cx.with_trailing_space(open_end);
    cx.push(PreviewRange::hide(node.start, content_from));

    let mut content_to = node.end;
    // `## Closed heading ##` swallows the trailing hashes and the space before them.
    let body = &cx.text[content_from.min(node.end)..node.end];
    let trimmed = body.trim_end_matches([' ', '\t']);
    let without_hashes = trimmed.trim_end_matches('#');
    if without_hashes.len() < trimmed.len() && (without_hashes.is_empty() || without_hashes.ends_with([' ', '\t'])) {
        let close_from = content_from + without_hashes.len();
        let close_to = content_from + trimmed.len();
        content_to = close_from;
        let b = cx.text.as_bytes();
        while content_to > content_from && b[content_to - 1] == b' ' {
            content_to -= 1;
        }
        cx.push(PreviewRange::hide(content_to, close_to));
        // trailing spaces after the closing hashes stay inside the heading text
    }
    cx.push(PreviewRange::mark(content_from, content_to, &format!("cm-md-h{level}")));
}

/// Index of the `]` closing a label that opened right before `from`, honouring nesting and escapes.
fn label_close(text: &str, from: usize, limit: usize) -> Option<usize> {
    let b = text.as_bytes();
    let mut depth = 1usize;
    let mut i = from;
    while i < limit.min(b.len()) {
        match b[i] {
            b'\\' => i += 1,
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn link(cx: &mut Ctx, node: &Range<usize>, dest: &str) {
    if cx.owned(node.start, node.end) || !cx.lines.one_line(node.start, node.end) {
        return;
    }
    if dest.is_empty() || !is_allowed_url(dest) {
        return;
    }
    let open_to = node.start + 1;
    let Some(close) = label_close(cx.text, open_to, node.end) else { return };
    if close <= open_to {
        return;
    }
    cx.push(PreviewRange::hide(node.start, open_to));
    cx.push(PreviewRange::mark(open_to, close, "cm-md-link"));
    cx.push(PreviewRange::hide(close, node.end));
}

/// `<https://x.com>`: hides the angle brackets, marks the URL between them.
fn bracketed_autolink(cx: &mut Ctx, node: &Range<usize>, dest: &str) {
    if cx.owned(node.start, node.end) || !is_allowed_url(dest) {
        return;
    }
    if node.end <= node.start + 2 {
        return;
    }
    cx.push(PreviewRange::hide(node.start, node.start + 1));
    cx.push(PreviewRange::mark(node.start + 1, node.end - 1, "cm-md-link"));
    cx.push(PreviewRange::hide(node.end - 1, node.end));
}

/// `https://x.com` and `www.x.com` inside plain text: the URL is its own label, so only a mark.
fn bare_autolinks(cx: &mut Ctx, span: &Range<usize>) {
    for r in find_bare_urls(cx.text, span) {
        if cx.owned(r.start, r.end) || !is_allowed_url(&cx.text[r.clone()]) {
            continue;
        }
        cx.push(PreviewRange::mark(r.start, r.end, "cm-md-link"));
    }
}

fn find_bare_urls(source: &str, span: &Range<usize>) -> Vec<Range<usize>> {
    let text = &source[span.clone()];
    let b = text.as_bytes();
    let mut i = 0usize;
    let mut found: Vec<Range<usize>> = Vec::new();
    while i < b.len() {
        let rest = &text[i..];
        let scheme = ["https://", "http://", "www."].iter().find(|s| {
            rest.len() >= s.len() && rest.is_char_boundary(s.len()) && rest[..s.len()].eq_ignore_ascii_case(s)
        });
        let boundary_ok = i == 0 || matches!(b[i - 1], b' ' | b'\t' | b'\n' | b'*' | b'_' | b'~' | b'(');
        match scheme {
            Some(s) if boundary_ok => {
                let mut end = i + s.len();
                while end < b.len() && !matches!(b[end], b' ' | b'\t' | b'\n' | b'\r' | b'<') {
                    end += 1;
                }
                // Trailing punctuation is not part of the URL; `)` only when unbalanced.
                loop {
                    let url = &text[i..end];
                    let Some(last) = url.chars().last() else { break };
                    let trim = match last {
                        '?' | '!' | '.' | ',' | ':' | '*' | '_' | '~' | '\'' | '"' | ';' => true,
                        ')' => url.matches(')').count() > url.matches('(').count(),
                        _ => false,
                    };
                    if !trim {
                        break;
                    }
                    end -= last.len_utf8();
                }
                if end > i + s.len() {
                    found.push(span.start + i..span.start + end);
                }
                i = end.max(i + 1);
            }
            _ => i += rest.chars().next().map_or(1, |c| c.len_utf8()),
        }
    }
    found
}

/// Replaces the whole of `![alt](url)` with an image. A destination that is not allowed leaves the
/// entire source on screen. Empty destinations (the upload placeholder) stay raw.
fn image(cx: &mut Ctx, node: &Range<usize>, dest: &str) {
    if cx.owned(node.start, node.end) {
        return;
    }
    let dest = dest.trim();
    if dest.is_empty() || !is_allowed_url(dest) {
        return;
    }
    let alt_from = node.start + 2;
    let alt = match label_close(cx.text, alt_from, node.end) {
        Some(c) if c >= alt_from => cx.text[alt_from..c].to_string(),
        _ => String::new(),
    };
    let mut w = PreviewRange::widget(node.start, node.end, "cm-md-image").text(&alt);
    w.widget_src = Some(dest.to_string());
    cx.push(w);
}

// ---- block constructs ----

fn fenced_code(cx: &mut Ctx, node: &Range<usize>) {
    let (first, last) = cx.lines.span(node.start, node.end);
    if last - first + 1 > MAX_BLOCK_LINES || cx.touches(first, last) {
        return;
    }
    let text = cx.text;
    let b = text.as_bytes();
    let mut open = node.start;
    while open < node.end && matches!(b[open], b' ' | b'\t') {
        open += 1;
    }
    let fence_char = b.get(open).copied().unwrap_or(b'`');
    if !matches!(fence_char, b'`' | b'~') {
        return;
    }
    let open_len = b[open..node.end].iter().take_while(|c| **c == fence_char).count();
    cx.push(PreviewRange::hide(open, open + open_len));
    if last > first {
        let line_start = cx.lines.start(last).max(node.start);
        let tail = &text[line_start..node.end];
        let t = tail.trim();
        if t.len() >= open_len && t.bytes().all(|c| c == fence_char) {
            let from = line_start + (tail.len() - tail.trim_start().len());
            cx.push(PreviewRange::hide(from, from + t.len()));
        }
    }
    // The whole block in one mark: per-line toggling inside a fence tears visually.
    cx.push(PreviewRange::mark(node.start, node.end, "cm-md-fence"));
}

fn table(cx: &mut Ctx, node: &Range<usize>, aligns: &[Alignment], events: &[(Event, Range<usize>)], start: usize) {
    let (first, last) = cx.lines.span(node.start, node.end);
    if last - first + 1 > MAX_BLOCK_LINES || cx.touches(first, last) {
        return;
    }
    let text = cx.text;
    let mut header: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut in_head = false;
    let mut began = false;
    for (ev, r) in events {
        if !began {
            began = r.start == start && matches!(ev, Event::Start(Tag::Table(_)));
            continue;
        }
        match ev {
            Event::End(TagEnd::Table) => break,
            Event::Start(Tag::TableHead) => in_head = true,
            Event::End(TagEnd::TableHead) => {
                header = std::mem::take(&mut current);
                in_head = false;
            }
            Event::Start(Tag::TableRow) => current.clear(),
            Event::End(TagEnd::TableRow) => rows.push(std::mem::take(&mut current)),
            Event::End(TagEnd::TableCell) => {}
            Event::Start(Tag::TableCell) => {
                let cell = &text[r.start.min(text.len())..r.end.min(text.len())];
                current.push(cell.trim().replace("\\|", "|"));
            }
            _ => {}
        }
    }
    let _ = in_head;
    if header.is_empty() {
        return;
    }
    let align: Vec<Align> = aligns
        .iter()
        .map(|a| match a {
            Alignment::None => Align::None,
            Alignment::Left => Align::Left,
            Alignment::Center => Align::Center,
            Alignment::Right => Align::Right,
        })
        .collect();
    let n = align.len().max(header.len());
    header.resize(n, String::new());
    let rows: Vec<Vec<String>> = rows
        .into_iter()
        .map(|mut r| {
            r.resize(n, String::new());
            r
        })
        .collect();

    // Widen to the line start when the table's own indentation is pure whitespace, otherwise an
    // orphan raw line is left above the rendered table.
    let line_start = cx.lines.start(first);
    let from = if line_start != node.start && text[line_start..node.start].trim().is_empty() { line_start } else { node.start };
    let mut w = PreviewRange::widget(from, node.end, "cm-md-table");
    w.widget_table = Some(PreviewTable { header, align, rows });
    cx.push(w);
}

fn blockquote(cx: &mut Ctx, node: &Range<usize>, depth: usize) {
    if cx.owned(node.start, node.end) {
        return;
    }
    cx.push(PreviewRange::mark(node.start, node.end, "cm-md-quote"));
    for (f, t) in quote_markers(cx.text, &cx.lines, node, depth) {
        cx.push(PreviewRange::hide(f, t));
    }
}

/// The `depth`-th `>` (plus one following space) of every line of a quote: this quote's own marker.
/// A quote that starts mid-line (inside a list item) has no `>` before its own, so its first line
/// also tries from the quote's start.
fn quote_markers(text: &str, lines: &Lines, node: &Range<usize>, depth: usize) -> Vec<(usize, usize)> {
    let b = text.as_bytes();
    let nth_marker = |from: usize, depth: usize| -> Option<(usize, usize)> {
        let mut pos = from;
        for j in 1..=depth {
            while pos < b.len() && matches!(b[pos], b' ' | b'\t') {
                pos += 1;
            }
            if b.get(pos) != Some(&b'>') {
                return None;
            }
            let start = pos;
            pos += 1;
            if b.get(pos) == Some(&b' ') {
                pos += 1;
            }
            if j == depth {
                return Some((start, pos));
            }
        }
        None
    };
    let (first, last) = lines.span(node.start, node.end);
    let mut out = Vec::new();
    for line in first..=last {
        let mut found = nth_marker(lines.start(line), depth);
        if found.is_none() && line == first {
            found = nth_marker(node.start, 1);
        }
        out.extend(found);
    }
    out
}

fn list_mark(cx: &mut Ctx, item: &Range<usize>) {
    if cx.owned(item.start, item.end) {
        return;
    }
    let b = cx.text.as_bytes();
    let mut p = item.start;
    while p < item.end && matches!(b[p], b' ' | b'\t') {
        p += 1;
    }
    let from = p;
    if matches!(b.get(p), Some(b'-' | b'*' | b'+')) {
        cx.push(PreviewRange::widget(from, from + 1, "cm-md-bullet").text("\u{2022}"));
        return;
    }
    while p < item.end && b[p].is_ascii_digit() {
        p += 1;
    }
    if p > from && matches!(b.get(p), Some(b'.' | b')')) {
        // An ordered marker is data the user typed: styling it is the most that may be done.
        cx.push(PreviewRange::mark(from, p + 1, "cm-md-list-mark"));
    }
}

fn task(cx: &mut Ctx, item: &ItemInfo, marker: &Range<usize>, checked: bool) {
    if cx.owned(item.range.start, item.range.end) {
        return;
    }
    let content_from = cx.with_trailing_space(marker.end);
    let mut w = PreviewRange::widget(marker.start, content_from, "cm-md-task");
    w.widget_checked = Some(checked);
    cx.push(w);
    // The task's own text ends where a nested list begins.
    let mut end = item.nested_from.unwrap_or(item.range.end).min(item.range.end);
    let b = cx.text.as_bytes();
    while end > content_from && matches!(b[end - 1], b'\n' | b'\r' | b' ') {
        end -= 1;
    }
    if checked && content_from < end {
        cx.push(PreviewRange::mark(content_from, end, "cm-md-task-done"));
    }
}


// ---- syntax tokens (the colours a revealed raw line keeps) ----

/// A token class from the markdown highlighter, applied whether or not live preview hides the
/// syntax: `tok-heading`, `tok-strong`, `tok-emphasis`, `tok-strikethrough`, `tok-link`, `tok-url`,
/// `tok-quote`, `tok-monospace`, `tok-meta`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TokenRange {
    pub from: usize,
    pub to: usize,
    pub class: &'static str,
}

/// Token ranges for the whole document, outer constructs before the constructs inside them.
pub fn token_ranges(text: &str) -> Vec<TokenRange> {
    let mut out: Vec<TokenRange> = Vec::new();
    if text.is_empty() {
        return out;
    }
    let lines = Lines::new(text);
    let mut add = |from: usize, to: usize, class: &'static str| {
        if to > from {
            out.push(TokenRange { from, to, class });
        }
    };
    let mut quote_depth = 0usize;
    let mut skip_until: Option<TagEnd> = None;
    let mut pending: Option<Range<usize>> = None;
    let mut link_depth = 0usize;
    let mut code_block = false;
    let mut bare: Vec<Range<usize>> = Vec::new();
    for (ev, r) in Parser::new_ext(text, options()).into_offset_iter() {
        if let Some(end) = &skip_until {
            if matches!(&ev, Event::End(e) if e == end) {
                skip_until = None;
            }
            continue;
        }
        if matches!(ev, Event::Text(_)) && link_depth == 0 && !code_block {
            match &mut pending {
                Some(p) if p.end == r.start => p.end = r.end,
                _ => {
                    if let Some(p) = pending.take() {
                        bare.extend(find_bare_urls(text, &p));
                    }
                    pending = Some(r.clone());
                }
            }
            continue;
        }
        if let Some(p) = pending.take() {
            bare.extend(find_bare_urls(text, &p));
        }
        let rr = trim_end_range(text, &r);
        match &ev {
            Event::Start(Tag::Heading { .. }) => {
                let src = &text[rr.clone()];
                if src.starts_with('#') {
                    let hashes = src.bytes().take_while(|b| *b == b'#').count();
                    let content_from = if text.as_bytes().get(rr.start + hashes) == Some(&b' ') { rr.start + hashes + 1 } else { rr.start + hashes };
                    let body = &text[content_from.min(rr.end)..rr.end];
                    let trimmed = body.trim_end_matches([' ', '\t']);
                    let without = trimmed.trim_end_matches('#');
                    let mut content_to = rr.end;
                    if without.len() < trimmed.len() && (without.is_empty() || without.ends_with([' ', '\t'])) {
                        content_to = content_from + without.trim_end_matches([' ', '\t']).len();
                        add(content_from + without.len(), content_from + trimmed.len(), "tok-meta");
                    }
                    add(content_from, content_to, "tok-heading");
                    add(rr.start, rr.start + hashes, "tok-meta");
                } else {
                    let last_line = lines.of(rr.end.saturating_sub(1));
                    let under = lines.start(last_line).max(rr.start);
                    add(rr.start, under.saturating_sub(1).max(rr.start), "tok-heading");
                    add(under, rr.end, "tok-meta");
                }
            }
            Event::Start(Tag::Strong) => {
                add(rr.start, rr.end, "tok-strong");
                add(rr.start, rr.start + 2, "tok-meta");
                add(rr.end.saturating_sub(2), rr.end, "tok-meta");
            }
            Event::Start(Tag::Emphasis) => {
                add(rr.start, rr.end, "tok-emphasis");
                add(rr.start, rr.start + 1, "tok-meta");
                add(rr.end.saturating_sub(1), rr.end, "tok-meta");
            }
            Event::Start(Tag::Strikethrough) => {
                let n = text[rr.start..].bytes().take_while(|b| *b == b'~').count().min(2);
                add(rr.start, rr.end, "tok-strikethrough");
                add(rr.start, rr.start + n, "tok-meta");
                add(rr.end.saturating_sub(n), rr.end, "tok-meta");
            }
            Event::Code(_) => {
                let n = text[rr.start..].bytes().take_while(|b| *b == b'`').count();
                add(rr.start, rr.end, "tok-monospace");
                add(rr.start, rr.start + n, "tok-meta");
                add(rr.end.saturating_sub(n), rr.end, "tok-meta");
            }
            Event::Start(Tag::Link { link_type, .. }) => {
                link_depth += 1;
                match link_type {
                    LinkType::Autolink | LinkType::Email => {
                        add(rr.start, rr.end, "tok-url");
                        add(rr.start, rr.start + 1, "tok-meta");
                        add(rr.end.saturating_sub(1), rr.end, "tok-meta");
                    }
                    _ => link_tokens(&mut add, text, &rr, 1),
                }
            }
            Event::End(TagEnd::Link) => link_depth = link_depth.saturating_sub(1),
            Event::Start(Tag::Image { .. }) => {
                skip_until = Some(TagEnd::Image);
                link_tokens(&mut add, text, &rr, 2);
            }
            Event::Start(Tag::BlockQuote(_)) => {
                quote_depth += 1;
                add(rr.start, rr.end, "tok-quote");
                for (f, t) in quote_markers(text, &lines, &rr, quote_depth) {
                    add(f, t, "tok-meta");
                }
            }
            Event::End(TagEnd::BlockQuote(_)) => quote_depth = quote_depth.saturating_sub(1),
            Event::Start(Tag::Item) => {
                let b = text.as_bytes();
                let mut p = rr.start;
                while p < rr.end && matches!(b[p], b' ' | b'\t') {
                    p += 1;
                }
                let from = p;
                if matches!(b.get(p), Some(b'-' | b'*' | b'+')) {
                    add(from, from + 1, "tok-meta");
                } else {
                    while p < rr.end && b[p].is_ascii_digit() {
                        p += 1;
                    }
                    if p > from && matches!(b.get(p), Some(b'.' | b')')) {
                        add(from, p + 1, "tok-meta");
                    }
                }
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                code_block = true;
                if let CodeBlockKind::Fenced(info) = kind {
                    let b = text.as_bytes();
                    let mut open = rr.start;
                    while open < rr.end && matches!(b[open], b' ' | b'\t') {
                        open += 1;
                    }
                    let fc = b.get(open).copied().unwrap_or(b'`');
                    let open_len = b[open..rr.end].iter().take_while(|c| **c == fc).count();
                    add(open, open + open_len, "tok-meta");
                    let (first, last) = lines.span(rr.start, rr.end);
                    let mut content_to = rr.end;
                    if last > first {
                        let ls = lines.start(last);
                        let t = text[ls..rr.end].trim();
                        if t.len() >= open_len && t.bytes().all(|c| c == fc) {
                            add(ls, rr.end, "tok-meta");
                            content_to = ls;
                        }
                    }
                    let content_from = text[open..].find('\n').map_or(rr.end, |i| open + i + 1);
                    if content_from < content_to {
                        let lang = info.split_whitespace().next().unwrap_or("");
                        highlight_code(lang, &text[content_from..content_to], content_from, &mut |f, t, c| add(f, t, c));
                    }
                }
            }
            Event::End(TagEnd::CodeBlock) => code_block = false,
            Event::Start(Tag::Table(_)) => skip_until = Some(TagEnd::Table),
            _ => {}
        }
    }
    if let Some(p) = pending.take() {
        bare.extend(find_bare_urls(text, &p));
    }
    for r in bare {
        add(r.start, r.end, "tok-url");
    }
    out.sort_by(|a, b| a.from.cmp(&b.from).then(b.to.cmp(&a.to)));
    out
}

/// `[label](dest "title")` / `![alt](dest)`: label in link colour, brackets muted, destination as URL.
fn link_tokens(add: &mut impl FnMut(usize, usize, &'static str), text: &str, node: &Range<usize>, open_len: usize) {
    let open_to = node.start + open_len;
    let Some(close) = label_close(text, open_to, node.end) else { return };
    add(open_to, close, "tok-link");
    add(node.start, open_to, "tok-meta");
    add(close, (close + 1).min(node.end), "tok-meta");
    let after = close + 1;
    if after < node.end && text.as_bytes()[after] == b'(' {
        add(after, after + 1, "tok-meta");
        add(node.end.saturating_sub(1), node.end, "tok-meta");
        let inner = &text[after + 1..node.end.saturating_sub(1).max(after + 1)];
        let lead = inner.len() - inner.trim_start().len();
        let dest_end = inner[lead..].find([' ', '\t']).map_or(inner.len(), |i| lead + i);
        add(after + 1 + lead, after + 1 + dest_end, "tok-url");
    }
}


// ---- fenced code highlighting ----

const KEYWORDS: &[&str] = &[
    "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
    "import", "export", "from", "as", "default", "class", "extends", "implements", "interface", "type", "enum", "new",
    "this", "super", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "void",
    "true", "false", "null", "undefined", "fn", "pub", "struct", "impl", "use", "mod", "match", "mut", "self", "trait",
    "where", "loop", "move", "ref", "static", "crate", "def", "elif", "lambda", "None", "True", "False", "pass", "with",
    "yield", "raise", "package", "public", "private", "protected", "final", "int", "string", "bool", "echo", "fi", "then",
    "done", "func", "go", "defer", "select", "range", "map", "chan",
];

fn is_hash_comment_lang(lang: &str) -> bool {
    matches!(lang, "py" | "python" | "sh" | "bash" | "shell" | "zsh" | "yaml" | "yml" | "toml" | "rb" | "ruby" | "ps1" | "powershell" | "dockerfile")
}

/// A small language-agnostic highlighter for fenced code: comments, strings, numbers, keywords,
/// types and properties. It stands in for the per-language parsers CodeMirror loads on demand.
fn highlight_code(lang: &str, code: &str, base: usize, add: &mut impl FnMut(usize, usize, &'static str)) {
    let lang = lang.to_ascii_lowercase();
    let hash = is_hash_comment_lang(&lang);
    let json = lang == "json" || lang == "jsonc";
    let b = code.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        let c = b[i];
        let rest = &code[i..];
        if (hash && c == b'#') || (!hash && rest.starts_with("//")) {
            let end = rest.find('\n').map_or(b.len(), |n| i + n);
            add(base + i, base + end, "tok-comment");
            i = end;
        } else if !hash && rest.starts_with("/*") {
            let end = rest[2..].find("*/").map_or(b.len(), |n| i + 2 + n + 2);
            add(base + i, base + end, "tok-comment");
            i = end;
        } else if matches!(c, b'"' | b'\'' | b'`') {
            let mut j = i + 1;
            while j < b.len() && b[j] != c && (c == b'`' || b[j] != b'\n') {
                if b[j] == b'\\' {
                    j += 1;
                }
                j += 1;
            }
            let end = (j + 1).min(b.len());
            let is_key = json && code[end..].trim_start_matches([' ', '\t']).starts_with(':');
            add(base + i, base + end, if is_key { "tok-property" } else { "tok-string" });
            i = end;
        } else if c.is_ascii_digit() && (i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_')) {
            let mut j = i;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'.' || b[j] == b'_') {
                j += 1;
            }
            add(base + i, base + j, "tok-number");
            i = j;
        } else if c.is_ascii_alphabetic() || c == b'_' || c == b'$' {
            let mut j = i;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_' || b[j] == b'$') {
                j += 1;
            }
            let word = &code[i..j];
            let after_dot = i > 0 && b[i - 1] == b'.';
            let class = if KEYWORDS.contains(&word) && !after_dot {
                Some("tok-keyword")
            } else if after_dot {
                Some("tok-property")
            } else if c.is_ascii_uppercase() {
                Some("tok-type")
            } else {
                None
            };
            if let Some(class) = class {
                add(base + i, base + j, class);
            }
            i = j;
        } else if b"=+-*/<>!&|%^~?:;,(){}[]".contains(&c) {
            add(base + i, base + i + 1, "tok-operator");
            i += 1;
        } else {
            i += code[i..].chars().next().map_or(1, |ch| ch.len_utf8());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str, caret: usize) -> Vec<PreviewRange> {
        live_preview_ranges(text, &[caret..caret], None)
    }
    /// Caret at the very end of the document (a line past the construct under test when the note
    /// ends with a trailing paragraph).
    fn far(text: &str) -> Vec<PreviewRange> {
        at(text, text.len())
    }
    fn kinds(r: &[PreviewRange], k: PreviewKind) -> Vec<(usize, usize)> {
        r.iter().filter(|p| p.kind == k).map(|p| (p.from, p.to)).collect()
    }
    fn class_of<'a>(r: &'a [PreviewRange], class: &str) -> Vec<&'a PreviewRange> {
        r.iter().filter(|p| p.mark_class.as_deref() == Some(class)).collect()
    }

    #[test]
    fn empty_and_plain_documents_have_no_ranges() {
        assert!(live_preview_ranges("", &[0..0], None).is_empty());
        assert!(far("just some words\n\nmore words").is_empty());
    }

    // ---- inline constructs, cursor off the line ----

    #[test]
    fn bold_hides_delimiters_and_marks_content() {
        let t = "**bold**\n\nend";
        let r = far(t);
        assert_eq!(kinds(&r, PreviewKind::Hide), vec![(0, 2), (6, 8)]);
        assert_eq!((class_of(&r, "cm-md-strong")[0].from, class_of(&r, "cm-md-strong")[0].to), (2, 6));
    }

    #[test]
    fn italic_hides_delimiters() {
        let t = "*it*\n\nend";
        let r = far(t);
        assert_eq!(kinds(&r, PreviewKind::Hide), vec![(0, 1), (3, 4)]);
        assert_eq!(class_of(&r, "cm-md-em").len(), 1);
    }

    #[test]
    fn inline_code_hides_backticks() {
        let r = far("`x`\n\nend");
        assert_eq!(kinds(&r, PreviewKind::Hide), vec![(0, 1), (2, 3)]);
        assert_eq!(class_of(&r, "cm-md-code").len(), 1);
    }

    #[test]
    fn strikethrough_hides_tildes() {
        let r = far("~~gone~~\n\nend");
        assert_eq!(kinds(&r, PreviewKind::Hide), vec![(0, 2), (6, 8)]);
        assert_eq!(class_of(&r, "cm-md-strike").len(), 1);
    }

    #[test]
    fn atx_heading_hides_hashes_and_space() {
        let r = far("# Title\n\nend");
        assert_eq!(kinds(&r, PreviewKind::Hide), vec![(0, 2)]);
        let h = class_of(&r, "cm-md-h1");
        assert_eq!((h[0].from, h[0].to), (2, 7));
    }

    #[test]
    fn heading_levels_get_their_own_class() {
        let r = far("### Three\n\nend");
        assert_eq!(class_of(&r, "cm-md-h3").len(), 1);
    }

    #[test]
    fn closed_heading_swallows_trailing_hashes() {
        let r = far("## Closed ##\n\nend");
        assert_eq!(kinds(&r, PreviewKind::Hide), vec![(0, 3), (9, 12)]);
        let h = class_of(&r, "cm-md-h2");
        assert_eq!((h[0].from, h[0].to), (3, 9));
    }

    #[test]
    fn construct_nested_in_heading_is_decorated() {
        let r = far("# a **b**\n\nend");
        assert_eq!(class_of(&r, "cm-md-h1").len(), 1);
        assert_eq!(class_of(&r, "cm-md-strong").len(), 1);
    }

    #[test]
    fn link_hides_brackets_and_destination() {
        let t = "[hi](https://x.com)\n\nend";
        let r = far(t);
        assert_eq!(kinds(&r, PreviewKind::Hide), vec![(0, 1), (3, 19)]);
        let l = class_of(&r, "cm-md-link");
        assert_eq!((l[0].from, l[0].to), (1, 3));
    }

    // ---- URL scheme allowlist ----

    #[test]
    fn unsafe_link_schemes_stay_raw() {
        assert!(far("[x](javascript:alert(1))\n\nend").is_empty());
        assert!(far("[x](data:text/html;base64,AAAA)\n\nend").is_empty());
        assert!(far("[x]( java\tscript:alert(1))\n\nend").iter().all(|r| r.mark_class.as_deref() != Some("cm-md-link")));
    }

    #[test]
    fn mailto_and_app_media_links_render() {
        assert_eq!(class_of(&far("[m](mailto:a@b.c)\n\nend"), "cm-md-link").len(), 1);
        assert_eq!(class_of(&far("[f](app-media://x/1.pdf)\n\nend"), "cm-md-link").len(), 1);
    }

    #[test]
    fn url_predicate() {
        assert!(is_allowed_url("./notes.md"));
        assert!(is_allowed_url("#anchor"));
        assert!(is_allowed_url("HTTPS://X.COM"));
        assert!(is_allowed_url("<https://x.com/a b>"));
        assert!(!is_allowed_url(""));
        assert!(!is_allowed_url("//evil.example"));
        assert!(!is_allowed_url("java\nscript:alert(1)"));
        assert!(!is_allowed_url("data:image/svg+xml,<svg/>"));
        assert!(!is_allowed_url("file:///C:/x"));
    }

    // ---- cursor ownership ----

    #[test]
    fn caret_inside_a_construct_reveals_it() {
        assert!(at("**bold**", 4).is_empty());
    }

    #[test]
    fn caret_elsewhere_on_the_line_reveals_it_too() {
        assert!(at("**bold** and tail", 15).is_empty());
    }

    #[test]
    fn caret_reveals_every_construct_on_its_line() {
        assert!(at("**a** and *b*", 0).is_empty());
    }

    #[test]
    fn other_lines_stay_decorated() {
        let t = "**a**\n\n*b*\n\nend";
        assert_eq!(class_of(&far(t), "cm-md-strong").len(), 1);
        assert_eq!(class_of(&far(t), "cm-md-em").len(), 1);
    }

    #[test]
    fn multi_line_selection_reveals_every_line() {
        let t = "**a**\n*b*\n\nend";
        let r = live_preview_ranges(t, &[0..8], None);
        assert!(r.is_empty());
    }

    #[test]
    fn lines_outside_the_selection_stay_decorated() {
        let t = "**a**\n\n*b*\n\n**c**";
        let r = live_preview_ranges(t, &[0..3], None);
        assert!(class_of(&r, "cm-md-strong").iter().all(|p| p.from > 5));
        assert_eq!(class_of(&r, "cm-md-em").len(), 1);
    }

    #[test]
    fn several_cursors_reveal_every_line_touched() {
        let t = "**a**\n\n*b*\n\n`c`\n\nend";
        let r = live_preview_ranges(t, &[0..0, 8..8], None);
        assert!(class_of(&r, "cm-md-strong").is_empty());
        assert!(class_of(&r, "cm-md-em").is_empty());
        assert_eq!(class_of(&r, "cm-md-code").len(), 1);
    }

    // ---- malformed input ----

    #[test]
    fn unclosed_bold_and_empty_label_do_nothing() {
        assert!(far("**open\n\nend").is_empty());
        assert!(far("[](https://x.com)\n\nend").is_empty());
        assert!(far("[label][ref]\n\nend").is_empty());
    }

    // ---- images ----

    #[test]
    fn image_becomes_a_widget_off_the_line() {
        let t = "![cat](https://x.com/c.png)\n\nend";
        let r = far(t);
        let w = class_of(&r, "cm-md-image");
        assert_eq!(w.len(), 1);
        assert_eq!((w[0].from, w[0].to), (0, 27));
        assert_eq!(w[0].widget_text.as_deref(), Some("cat"));
        assert_eq!(w[0].widget_src.as_deref(), Some("https://x.com/c.png"));
        assert!(at(t, 3).is_empty());
    }

    #[test]
    fn images_without_alt_and_every_image_on_a_line() {
        assert_eq!(class_of(&far("![](https://x.com/c.png)\n\nend"), "cm-md-image")[0].widget_text.as_deref(), Some(""));
        assert_eq!(class_of(&far("![a](x.png) ![b](y.png)\n\nend"), "cm-md-image").len(), 2);
    }

    #[test]
    fn unsafe_reference_and_empty_images_stay_raw() {
        assert!(far("![a](javascript:alert(1))\n\nend").is_empty());
        assert!(far("![a](data:image/png;base64,AAAA)\n\nend").is_empty());
        assert!(far("![a][ref]\n\nend").is_empty());
        assert!(far("![uploading a.png...]()\n\nend").is_empty());
    }

    #[test]
    fn image_title_and_angle_brackets_stay_out_of_the_source() {
        let r = far("![a](x.png \"The title\")\n\nend");
        assert_eq!(class_of(&r, "cm-md-image")[0].widget_src.as_deref(), Some("x.png"));
        let r = far("![a](<my pic.png>)\n\nend");
        assert_eq!(class_of(&r, "cm-md-image")[0].widget_src.as_deref(), Some("my pic.png"));
    }

    #[test]
    fn markdown_inside_alt_text_is_not_decorated() {
        let r = far("![a **b**](x.png)\n\nend");
        assert!(class_of(&r, "cm-md-strong").is_empty());
        assert_eq!(class_of(&r, "cm-md-image")[0].widget_text.as_deref(), Some("a **b**"));
    }

    #[test]
    fn image_destination_on_the_next_line_stays_raw() {
        assert!(class_of(&far("![a](\nx.png)\n\nend"), "cm-md-image").is_empty());
    }

    #[test]
    fn image_next_to_a_bullet() {
        let r = far("- ![a](x.png)\n\nend");
        assert_eq!(class_of(&r, "cm-md-bullet").len(), 1);
        assert_eq!(class_of(&r, "cm-md-image").len(), 1);
    }

    // ---- task checkboxes ----

    #[test]
    fn unchecked_and_checked_tasks() {
        let r = far("- [ ] todo\n- [x] done\n\nend");
        let tasks = class_of(&r, "cm-md-task");
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].widget_checked, Some(false));
        assert_eq!(tasks[1].widget_checked, Some(true));
        assert_eq!((tasks[0].from, tasks[0].to), (2, 6));
        let done = class_of(&r, "cm-md-task-done");
        assert_eq!(done.len(), 1);
        assert_eq!(&"- [ ] todo\n- [x] done\n\nend"[done[0].from..done[0].to], "done");
        assert_eq!(class_of(&far("- [X] up\n\nend"), "cm-md-task")[0].widget_checked, Some(true));
    }

    #[test]
    fn markdown_inside_a_task_is_still_decorated() {
        assert_eq!(class_of(&far("- [ ] a **b**\n\nend"), "cm-md-strong").len(), 1);
    }

    #[test]
    fn caret_on_a_task_line_reveals_it() {
        let r = at("- [ ] a\n\n\nend", 4);
        assert!(class_of(&r, "cm-md-task").is_empty());
        assert!(class_of(&r, "cm-md-bullet").is_empty());
    }

    // ---- tables ----

    const TBL: &str = "| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |\n\nend";

    #[test]
    fn table_becomes_one_widget() {
        let r = far(TBL);
        let w = class_of(&r, "cm-md-table");
        assert_eq!(w.len(), 1);
        let t = w[0].widget_table.as_ref().unwrap();
        assert_eq!(t.header, vec!["a", "b"]);
        assert_eq!(t.align, vec![Align::Left, Align::Right]);
        assert_eq!(t.rows, vec![vec!["1", "2"], vec!["3", "4"]]);
        assert_eq!(w[0].from, 0);
    }

    #[test]
    fn table_alignments() {
        let r = far("| a | b | c | d |\n|:-|:-:|-:|-|\n| 1 | 2 | 3 | 4 |\n\nend");
        let t = class_of(&r, "cm-md-table")[0].widget_table.clone().unwrap();
        assert_eq!(t.align, vec![Align::Left, Align::Center, Align::Right, Align::None]);
    }

    #[test]
    fn table_reveals_on_any_of_its_lines() {
        assert!(class_of(&at(TBL, 2), "cm-md-table").is_empty());
        assert!(class_of(&at(TBL, 25), "cm-md-table").is_empty());
    }

    #[test]
    fn empty_cells_keep_their_column() {
        let t = |s: &str| class_of(&far(s), "cm-md-table")[0].widget_table.clone().unwrap();
        assert_eq!(t("| a | b | c |\n|---|---|---|\n| 1 |  | 3 |\n\nend").rows, vec![vec!["1", "", "3"]]);
        assert_eq!(t("| a | b |\n|---|---|\n|  | 2 |\n\nend").rows, vec![vec!["", "2"]]);
        assert_eq!(t("| a | b |\n|---|---|\n| 1 |  |\n\nend").rows, vec![vec!["1", ""]]);
    }

    #[test]
    fn escaped_pipe_and_ragged_rows() {
        let t = |s: &str| class_of(&far(s), "cm-md-table")[0].widget_table.clone().unwrap();
        assert_eq!(t("| a | b |\n|---|---|\n| x \\| y | 2 |\n\nend").rows, vec![vec!["x | y", "2"]]);
        assert_eq!(t("| a | b | c |\n|---|---|---|\n| 1 |\n\nend").rows, vec![vec!["1", "", ""]]);
        assert_eq!(t("| a | b |\n|---|---|\n| 1 | 2 | 3 |\n\nend").rows, vec![vec!["1", "2"]]);
    }

    #[test]
    fn oversized_table_stays_raw() {
        let mut s = String::from("| a |\n|---|\n");
        for _ in 0..MAX_BLOCK_LINES {
            s.push_str("| x |\n");
        }
        s.push_str("\nend");
        assert!(class_of(&far(&s), "cm-md-table").is_empty());
    }

    #[test]
    fn table_at_the_end_of_the_document() {
        let r = far("x\n\n| a |\n|---|\n| 1 |");
        // caret at the end touches the table's last line, so move it up
        assert!(class_of(&r, "cm-md-table").is_empty());
        let r = live_preview_ranges("x\n\n| a |\n|---|\n| 1 |", &[0..0], None);
        assert_eq!(class_of(&r, "cm-md-table").len(), 1);
    }

    #[test]
    fn indented_table_widens_to_the_line_start() {
        let t = "  | a |\n  |---|\n  | 1 |\n\nend";
        let w = class_of(&far(t), "cm-md-table").into_iter().next().map(|w| w.from);
        assert_eq!(w, Some(0));
    }

    // ---- nested list indentation ----

    #[test]
    fn list_lines_get_depth_classes() {
        let t = "- a\n  - b\n    - c\n\nend";
        let r = far(t);
        let depth = |n: usize| class_of(&r, &format!("cm-md-li-depth-{n}")).iter().map(|p| p.from).collect::<Vec<_>>();
        assert_eq!(depth(1), vec![0]);
        assert_eq!(depth(2), vec![4]);
        assert_eq!(depth(3), vec![10]);
    }

    #[test]
    fn depth_is_capped_and_ignores_the_caret() {
        let mut t = String::new();
        for d in 0..8 {
            t.push_str(&format!("{}- x\n", "  ".repeat(d)));
        }
        let r = live_preview_ranges(&t, &[0..0], None);
        assert_eq!(class_of(&r, "cm-md-li-depth-6").len(), 3);
        assert!(!class_of(&r, "cm-md-li-depth-1").is_empty());
    }

    #[test]
    fn ordered_marker_is_styled_not_replaced() {
        let r = far("1. one\n2. two\n\nend");
        assert_eq!(class_of(&r, "cm-md-list-mark").len(), 2);
        assert!(class_of(&r, "cm-md-bullet").is_empty());
        assert_eq!(class_of(&r, "cm-md-li-depth-1").len(), 2);
    }

    // ---- autolinks ----

    #[test]
    fn bare_autolinks() {
        let t = "see https://x.com/a_b, ok\n\nend";
        let r = far(t);
        let l = class_of(&r, "cm-md-link");
        assert_eq!(l.len(), 1);
        assert_eq!(&t[l[0].from..l[0].to], "https://x.com/a_b");
        let t = "go www.x.com now\n\nend";
        let r = far(t);
        let l = class_of(&r, "cm-md-link");
        assert_eq!(&t[l[0].from..l[0].to], "www.x.com");
        assert!(at("see https://x.com", 0).is_empty());
    }

    #[test]
    fn bracketed_autolink() {
        let t = "<https://x.com>\n\nend";
        let r = far(t);
        assert_eq!(kinds(&r, PreviewKind::Hide), vec![(0, 1), (14, 15)]);
        assert!(at(t, 3).is_empty());
        assert!(far("<javascript:alert(1)>\n\nend").iter().all(|r| r.mark_class.as_deref() != Some("cm-md-link")));
    }

    // ---- visible windows ----

    #[test]
    fn visible_windows() {
        let t = "**a**\n\n**b**\n\nend";
        let all = live_preview_ranges(t, &[t.len()..t.len()], None);
        assert_eq!(class_of(&all, "cm-md-strong").len(), 2);
        let some = live_preview_ranges(t, &[t.len()..t.len()], Some(&[0..5]));
        assert_eq!(class_of(&some, "cm-md-strong").len(), 1);
        let overlap = live_preview_ranges(t, &[t.len()..t.len()], Some(&[0..9, 5..14]));
        assert_eq!(class_of(&overlap, "cm-md-strong").len(), 2);
    }

    // ---- fenced code highlighting ----

    #[test]
    fn fenced_code_gets_language_tokens() {
        let t = "```ts\nconst total = items.length; // n\n```\n";
        let toks = token_ranges(t);
        let find = |class: &str| toks.iter().filter(|k| k.class == class).map(|k| &t[k.from..k.to]).collect::<Vec<_>>();
        assert_eq!(find("tok-keyword"), vec!["const"]);
        assert_eq!(find("tok-property"), vec!["length"]);
        assert_eq!(find("tok-comment"), vec!["// n"]);
    }

    #[test]
    fn json_keys_and_strings_differ() {
        let t = "```json\n{\"a\": \"b\", \"n\": 12}\n```\n";
        let toks = token_ranges(t);
        let find = |class: &str| toks.iter().filter(|k| k.class == class).map(|k| &t[k.from..k.to]).collect::<Vec<_>>();
        assert_eq!(find("tok-property"), vec!["\"a\"", "\"n\""]);
        assert_eq!(find("tok-string"), vec!["\"b\""]);
        assert_eq!(find("tok-number"), vec!["12"]);
    }

    #[test]
    fn tokens_cover_headings_emphasis_links_and_marks() {
        let t = "## Title\n\n**b** and [l](https://x.com)\n";
        let toks = token_ranges(t);
        let find = |class: &str| toks.iter().filter(|k| k.class == class).map(|k| &t[k.from..k.to]).collect::<Vec<_>>();
        assert_eq!(find("tok-heading"), vec!["Title"]);
        assert_eq!(find("tok-strong"), vec!["**b**"]);
        assert_eq!(find("tok-link"), vec!["l"]);
        assert_eq!(find("tok-url"), vec!["https://x.com"]);
        assert!(find("tok-meta").contains(&"##"));
    }

    // ---- block constructs ----

    #[test]
    fn fenced_code_hides_markers_and_marks_the_block() {
        let t = "```rs\nlet x = 1;\n```\n\nend";
        let r = far(t);
        assert_eq!(kinds(&r, PreviewKind::Hide), vec![(0, 3), (17, 20)]);
        let m = class_of(&r, "cm-md-fence");
        assert_eq!((m[0].from, m[0].to), (0, 20));
    }

    #[test]
    fn fence_reveals_from_any_line() {
        let t = "```\ncode\n```\n\nend";
        assert!(at(t, 5).is_empty());
        assert!(at(t, 10).is_empty());
    }

    #[test]
    fn unclosed_fence_under_the_cap_is_decorated_and_over_it_is_raw() {
        let r = live_preview_ranges("```\ncode\n\nmore", &[], None);
        assert_eq!(class_of(&r, "cm-md-fence").len(), 1);
        assert_eq!(kinds(&r, PreviewKind::Hide), vec![(0, 3)]);
        let mut s = String::from("```\n");
        for _ in 0..MAX_BLOCK_LINES + 5 {
            s.push_str("x\n");
        }
        assert!(class_of(&live_preview_ranges(&s, &[], None), "cm-md-fence").is_empty());
    }

    #[test]
    fn blockquote_hides_markers_and_marks_the_block() {
        let t = "> a\n> b\n\nend";
        let r = far(t);
        assert_eq!(kinds(&r, PreviewKind::Hide), vec![(0, 2), (4, 6)]);
        assert_eq!(class_of(&r, "cm-md-quote").len(), 1);
        assert!(at(t, 5).is_empty());
    }

    #[test]
    fn nested_blockquote_markers() {
        let r = far("> a\n> > b\n\nend");
        assert_eq!(kinds(&r, PreviewKind::Hide), vec![(0, 2), (4, 6), (6, 8)]);
    }

    #[test]
    fn bullet_is_replaced_by_a_glyph_and_reveals_per_item() {
        let t = "- one\n- two\n\nend";
        let r = far(t);
        let b = class_of(&r, "cm-md-bullet");
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].widget_text.as_deref(), Some("\u{2022}"));
        let r = at(t, 8);
        assert_eq!(class_of(&r, "cm-md-bullet").len(), 1);
        assert_eq!(class_of(&r, "cm-md-bullet")[0].from, 0);
    }

    #[test]
    fn horizontal_rule_is_a_widget_off_its_line() {
        let t = "---\n\nend";
        assert_eq!(class_of(&far(t), "cm-md-hr").len(), 1);
        assert!(at(t, 1).is_empty());
    }

    // ---- output shape ----

    #[test]
    fn output_is_sorted_nonempty_and_never_replaces_across_a_line_break() {
        let t = "# H\n\n**a** *b* `c`\n\n> q\n\n- [x] t\n\n![i](x.png)\n\n[l](https://x.com)\n\n```\nz\n```\n\nend";
        let r = far(t);
        assert!(r.windows(2).all(|w| w[0].from <= w[1].from));
        for p in &r {
            if p.kind != PreviewKind::Line {
                assert!(p.to > p.from);
            }
            if matches!(p.kind, PreviewKind::Hide | PreviewKind::Widget) {
                assert!(!t[p.from..p.to].contains('\n'), "{p:?}");
            }
        }
    }

    #[test]
    fn emphasis_across_a_soft_break_is_marked() {
        let t = "*a\nb*\n\nend";
        let r = far(t);
        assert_eq!(class_of(&r, "cm-md-em").len(), 1);
        assert_eq!(kinds(&r, PreviewKind::Hide), vec![(0, 1), (4, 5)]);
    }

    #[test]
    fn dedupe_keeps_ranges_that_differ_in_checked_state_or_table() {
        let mut a = PreviewRange::widget(0, 3, "cm-md-task");
        a.widget_checked = Some(false);
        let mut b = a.clone();
        b.widget_checked = Some(true);
        assert_eq!(drop_repeats(vec![a.clone(), b.clone()]).len(), 2);
        assert_eq!(drop_repeats(vec![a.clone(), a]).len(), 1);
        let t1 = PreviewTable { header: vec!["a".into()], align: vec![Align::None], rows: vec![] };
        let mut x = PreviewRange::widget(0, 3, "cm-md-table");
        x.widget_table = Some(t1.clone());
        let mut y = x.clone();
        y.widget_table = Some(PreviewTable { header: vec!["b".into()], ..t1 });
        assert_eq!(drop_repeats(vec![x.clone(), y]).len(), 2);
        assert_eq!(drop_repeats(vec![x.clone(), x]).len(), 1);
    }
}
