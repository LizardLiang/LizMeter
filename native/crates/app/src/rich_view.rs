//! Read-only rendering of TipTap HTML (`.cardTitleRich`): paragraphs, lists, bold, italic, strike, code.

use crate::css::C;
use crate::ui::*;
use gpui::*;
use lizmeter_ui::rich_doc::parse_html;

/// True when `s` holds an HTML tag (`/<[a-z][\s\S]*>/i`).
pub fn is_html(s: &str) -> bool {
    let b = s.as_bytes();
    s.contains('>') && b.windows(2).any(|w| w[0] == b'<' && w[1].is_ascii_alphabetic())
}

pub fn rich_view(html: &str, size: f32, color: C) -> Div {
    let leaves = parse_html(html);
    let mut out = div().flex().flex_col().gap(px(4.0)).text_size(px(size)).line_height(px((size * 1.6).round())).text_color(col(color));
    let mut counters: Vec<u32> = Vec::new();
    for leaf in leaves {
        let text = leaf.text.text();
        let mut prefix = String::new();
        let mut indent = 0.0;
        match &leaf.list {
            Some(info) => {
                if counters.len() <= info.depth {
                    counters.resize(info.depth + 1, 0);
                }
                counters.truncate(info.depth + 1);
                counters[info.depth] += 1;
                prefix = if info.ordered { format!("{}. ", info.start + counters[info.depth] - 1) } else { "\u{2022} ".to_string() };
                indent = 20.0 + 16.0 * info.depth as f32;
            }
            None => counters.clear(),
        }
        let full = format!("{prefix}{text}");
        let mut runs = Vec::new();
        if !prefix.is_empty() {
            runs.push(TextRun { len: prefix.len(), font: font(UI_FONT), color: col(color), background_color: None, underline: None, strikethrough: None });
        }
        for r in leaf.text.runs() {
            let mut f = font(if r.marks.code { MONO } else { UI_FONT });
            if r.marks.bold {
                f.weight = FontWeight::BOLD;
            }
            if r.marks.italic {
                f.style = FontStyle::Italic;
            }
            let c = if r.marks.code {
                TN_CYAN
            } else if r.marks.strike {
                TN_MUTED
            } else {
                color
            };
            runs.push(TextRun {
                len: r.text.len(),
                font: f,
                color: col(c),
                background_color: None,
                underline: None,
                strikethrough: r.marks.strike.then(|| StrikethroughStyle { thickness: px(1.0), color: Some(col(TN_MUTED)) }),
            });
        }
        let line = if !full.is_empty() && runs.iter().map(|r| r.len).sum::<usize>() == full.len() {
            StyledText::new(full).with_runs(runs).into_any_element()
        } else {
            div().child(full).into_any_element()
        };
        out = out.child(div().pl(px(indent)).child(line));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::is_html;

    #[test]
    fn detects_html_titles() {
        assert!(is_html("<p>Linked session test</p>"));
        assert!(!is_html("a < b and c > d"));
        assert!(!is_html("plain"));
    }
}
