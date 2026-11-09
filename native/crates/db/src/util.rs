//! Small helpers that reproduce JavaScript semantics the TypeScript database layer relied on:
//! `Date#toISOString`, `String#trim`, UTF-16 `length`/`slice`.

use chrono::{SecondsFormat, Utc};

/// `new Date().toISOString()`: `2026-11-09T05:22:39.123Z`.
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'
            | '\u{a}'
            | '\u{b}'
            | '\u{c}'
            | '\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `String.prototype.trim` (JS whitespace set, which differs from Rust's `str::trim`).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `String.prototype.length`: UTF-16 code units.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, max)` by UTF-16 code units. A surrogate pair cut in half is dropped whole,
/// because a lone surrogate cannot live in a Rust `String`.
pub fn js_truncate(s: &str, max: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for c in s.chars() {
        let w = c.len_utf16();
        if units + w > max {
            break;
        }
        units += w;
        out.push(c);
    }
    out
}

/// `/^\d{4}-\d{2}-\d{2}$/` followed by a `new Date(`${s}T00:00:00Z`)` validity check.
/// V8 accepts any day 1-31 for any month, so `2026-02-31` is valid and `2026-13-01` is not.
pub fn is_valid_iso_date(s: &str) -> bool {
    if !matches_date_shape(s) {
        return false;
    }
    let month: u32 = s[5..7].parse().unwrap_or(0);
    let day: u32 = s[8..10].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// `/^\d{4}-\d{2}-\d{2}$/` only.
pub fn matches_date_shape(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_matches_js() {
        assert_eq!(js_trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn truncate_counts_utf16() {
        assert_eq!(js_truncate("ab😀cd", 3), "ab");
        assert_eq!(js_truncate("ab😀cd", 4), "ab😀");
        assert_eq!(js_len("😀"), 2);
    }

    #[test]
    fn dates_follow_v8() {
        assert!(is_valid_iso_date("2026-02-31"));
        assert!(!is_valid_iso_date("2026-13-01"));
        assert!(!is_valid_iso_date("2026-01-00"));
        assert!(!is_valid_iso_date("2026-1-01"));
    }

    #[test]
    fn iso_shape() {
        let s = now_iso();
        assert_eq!(s.len(), 24);
        assert!(s.ends_with('Z'));
    }
}
