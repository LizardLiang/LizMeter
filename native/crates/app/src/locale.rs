//! Dates and times in the Windows user locale, in the shapes the renderer's
//! `toLocaleDateString(undefined, ...)` / `toLocaleTimeString(undefined, ...)` give: Electron
//! follows the machine locale (zh-TW: `10月29日`, `上午11:14`), so the native app asks Windows for
//! the locale's long-date and time patterns and reshapes them.

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    /// A run of one pattern letter (`d`, `M`, `y`, `h`, `H`, `m`, `s`, `t`, `g`).
    Letter(char, usize),
    /// Text between letters; `quoted` keeps its quotes when written back.
    Lit(String, bool),
}

fn is_letter(c: char) -> bool {
    matches!(c, 'd' | 'M' | 'y' | 'h' | 'H' | 'm' | 's' | 't' | 'g')
}

fn tokenize(pattern: &str) -> Vec<Tok> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\'' {
            let mut j = i + 1;
            let mut text = String::new();
            while j < chars.len() && chars[j] != '\'' {
                text.push(chars[j]);
                j += 1;
            }
            out.push(Tok::Lit(text, true));
            i = j + 1;
        } else if is_letter(c) {
            let mut j = i;
            while j < chars.len() && chars[j] == c {
                j += 1;
            }
            out.push(Tok::Letter(c, j - i));
            i = j;
        } else {
            let mut text = String::new();
            while i < chars.len() && chars[i] != '\'' && !is_letter(chars[i]) {
                text.push(chars[i]);
                i += 1;
            }
            out.push(Tok::Lit(text, false));
        }
    }
    out
}

fn join(toks: &[Tok]) -> String {
    let mut s = String::new();
    for t in toks {
        match t {
            Tok::Letter(c, n) => s.extend(std::iter::repeat(*c).take(*n)),
            Tok::Lit(text, true) => {
                s.push('\'');
                s.push_str(text);
                s.push('\'');
            }
            Tok::Lit(text, false) => s.push_str(text),
        }
    }
    s
}

/// Removes the token at `i` with the literals that follow it up to the next letter. When no
/// letter follows, the plain separators in front of it go instead.
fn remove_with_separators(toks: &mut Vec<Tok>, i: usize) {
    let mut end = i + 1;
    while end < toks.len() && matches!(toks[end], Tok::Lit(..)) {
        end += 1;
    }
    if end < toks.len() {
        toks.drain(i..end);
        return;
    }
    let mut start = i;
    while start > 0 && matches!(toks[start - 1], Tok::Lit(_, false)) {
        start -= 1;
    }
    toks.drain(start..end);
}

fn trim_edges(toks: &mut Vec<Tok>) {
    let blank = |t: &Tok| matches!(t, Tok::Lit(s, false) if s.trim().is_empty() || s.trim() == ",");
    while toks.last().is_some_and(blank) {
        toks.pop();
    }
    while toks.first().is_some_and(blank) {
        toks.remove(0);
    }
}

/// `dddd, MMMM d, yyyy` to `MMM d, yyyy` (or `MMM d` without the year).
pub fn date_pattern(long_date: &str, with_year: bool) -> String {
    let mut toks = tokenize(long_date);
    while let Some(i) = toks.iter().position(|t| matches!(t, Tok::Letter('d', n) if *n >= 3)) {
        remove_with_separators(&mut toks, i);
    }
    for t in toks.iter_mut() {
        if let Tok::Letter('M', n) = t {
            if *n >= 4 {
                *n = 3;
            }
        }
    }
    if !with_year {
        while let Some(i) = toks.iter().position(|t| matches!(t, Tok::Letter('y', _))) {
            remove_with_separators(&mut toks, i);
        }
    }
    trim_edges(&mut toks);
    join(&toks)
}

/// The locale's time pattern as `toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"})`
/// shows it: two-digit hour, no seconds.
pub fn time_pattern(time_format: &str, am: &str) -> String {
    let mut toks = tokenize(time_format);
    if let Some(i) = toks.iter().position(|t| matches!(t, Tok::Letter('s', _))) {
        toks.remove(i);
        if i > 0 && matches!(&toks[i - 1], Tok::Lit(s, false) if s.trim() == ":") {
            toks.remove(i - 1);
        } else if i < toks.len() && matches!(&toks[i], Tok::Lit(s, false) if s.trim() == ":") {
            toks.remove(i);
        }
    }
    for t in toks.iter_mut() {
        if let Tok::Letter('h' | 'H', n) = t {
            *n = 2;
        }
    }
    tighten_marker(&mut toks, am);
    trim_edges(&mut toks);
    while matches!(toks.last(), Some(Tok::Lit(s, false)) if s.trim() == ".") {
        toks.pop();
    }
    join(&toks)
}

/// A non-Latin AM/PM marker (`上午`) sits against the hour with no space.
fn tighten_marker(toks: &mut Vec<Tok>, am: &str) {
    if am.chars().next().is_none_or(|c| c.is_ascii()) {
        return;
    }
    let space = |t: &Tok| matches!(t, Tok::Lit(s, false) if s.trim().is_empty());
    let mut i = 0;
    while i < toks.len() {
        if matches!(toks[i], Tok::Letter('t', _)) {
            if i + 1 < toks.len() && space(&toks[i + 1]) {
                toks.remove(i + 1);
            }
            if i > 0 && space(&toks[i - 1]) {
                toks.remove(i - 1);
                i -= 1;
            }
        }
        i += 1;
    }
}

/// The shape of `toLocaleTimeString()`: the locale's time pattern with the marker tightened.
pub fn full_time_pattern(time_format: &str, am: &str) -> String {
    let mut toks = tokenize(time_format);
    tighten_marker(&mut toks, am);
    join(&toks)
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::OnceLock;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SYSTEMTIME;
    use windows::Win32::Globalization::{GetDateFormatEx, GetLocaleInfoEx, GetTimeFormatEx, ENUM_DATE_FORMATS_FLAGS, TIME_FORMAT_FLAGS};

    const LOCALE_S1159: u32 = 0x28;
    const LOCALE_SSHORTDATE: u32 = 0x1F;
    const LOCALE_SLONGDATE: u32 = 0x20;
    const LOCALE_STIMEFORMAT: u32 = 0x1003;

    fn info(kind: u32) -> Option<String> {
        let mut buf = [0u16; 160];
        let n = unsafe { GetLocaleInfoEx(PCWSTR::null(), kind, Some(&mut buf)) };
        if n <= 1 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..(n - 1) as usize]))
    }

    pub struct Patterns {
        pub long_date: String,
        pub date_year: String,
        pub date: String,
        pub time: String,
        pub full_time: String,
        pub short_date: String,
        pub comma_before_time: bool,
    }

    pub fn patterns() -> &'static Option<Patterns> {
        static P: OnceLock<Option<Patterns>> = OnceLock::new();
        P.get_or_init(|| {
            let long = info(LOCALE_SLONGDATE)?;
            let time = info(LOCALE_STIMEFORMAT)?;
            let am = info(LOCALE_S1159).unwrap_or_default();
            let short_date = info(LOCALE_SSHORTDATE)?;
            Some(Patterns {
                long_date: long.clone(),
                date_year: date_pattern(&long, true),
                date: date_pattern(&long, false),
                time: time_pattern(&time, &am),
                full_time: full_time_pattern(&time, &am),
                comma_before_time: !short_date.starts_with('y'),
                short_date,
            })
        })
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn format_date(pattern: &str, y: i32, m: u32, d: u32) -> Option<String> {
        let st = SYSTEMTIME { wYear: y as u16, wMonth: m as u16, wDay: d as u16, ..Default::default() };
        let fmt = wide(pattern);
        let mut buf = [0u16; 128];
        let n = unsafe { GetDateFormatEx(PCWSTR::null(), ENUM_DATE_FORMATS_FLAGS(0), Some(&st), PCWSTR(fmt.as_ptr()), Some(&mut buf), PCWSTR::null()) };
        (n > 1).then(|| String::from_utf16_lossy(&buf[..(n - 1) as usize]))
    }

    pub fn format_time(pattern: &str, h: u32, mi: u32, s: u32) -> Option<String> {
        let st = SYSTEMTIME { wYear: 2000, wMonth: 1, wDay: 1, wHour: h as u16, wMinute: mi as u16, wSecond: s as u16, ..Default::default() };
        let fmt = wide(pattern);
        let mut buf = [0u16; 128];
        let n = unsafe { GetTimeFormatEx(PCWSTR::null(), TIME_FORMAT_FLAGS(0), Some(&st), PCWSTR(fmt.as_ptr()), Some(&mut buf)) };
        (n > 1).then(|| String::from_utf16_lossy(&buf[..(n - 1) as usize]))
    }
}

/// "10月29日" / "Oct 29", or with the year "2025年10月29日" / "Oct 29, 2025".
pub fn month_day(y: i32, m: u32, d: u32, with_year: bool) -> String {
    #[cfg(windows)]
    if let Some(p) = win::patterns() {
        if let Some(s) = win::format_date(if with_year { &p.date_year } else { &p.date }, y, m, d) {
            return s;
        }
    }
    let name = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(m as usize).saturating_sub(1).min(11)];
    if with_year {
        format!("{name} {d}, {y}")
    } else {
        format!("{name} {d}")
    }
}

/// `toLocaleDateString(undefined, {weekday, year, month, day: "long"})`: "Monday, November 9, 2026".
pub fn long_date(y: i32, m: u32, d: u32) -> String {
    #[cfg(windows)]
    if let Some(p) = win::patterns() {
        if let Some(s) = win::format_date(&p.long_date, y, m, d) {
            return s;
        }
    }
    use chrono::NaiveDate;
    NaiveDate::from_ymd_opt(y, m, d).map(|n| n.format("%A, %B %-d, %Y").to_string()).unwrap_or_default()
}

/// "上午11:14" / "11:14 AM".
pub fn hour_minute(h: u32, m: u32) -> String {
    #[cfg(windows)]
    if let Some(p) = win::patterns() {
        if let Some(s) = win::format_time(&p.time, h, m, 0) {
            return s;
        }
    }
    let (h12, ap) = (if h % 12 == 0 { 12 } else { h % 12 }, if h < 12 { "AM" } else { "PM" });
    format!("{h12:02}:{m:02} {ap}")
}

/// `toLocaleString()`: "2026/11/9 上午11:14:05" / "11/9/2026, 11:14:05 AM".
pub fn date_time(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> String {
    #[cfg(windows)]
    if let Some(p) = win::patterns() {
        if let (Some(date), Some(time)) = (win::format_date(&p.short_date, y, mo, d), win::format_time(&p.full_time, h, mi, s)) {
            return format!("{date}{} {time}", if p.comma_before_time { "," } else { "" });
        }
    }
    let (h12, ap) = (if h % 12 == 0 { 12 } else { h % 12 }, if h < 12 { "AM" } else { "PM" });
    format!("{mo}/{d}/{y}, {h12}:{mi:02}:{s:02} {ap}")
}

/// Short weekday name: "週二" / "Tue".
pub fn weekday_short(y: i32, m: u32, d: u32) -> String {
    #[cfg(windows)]
    if let Some(s) = win::format_date("ddd", y, m, d) {
        return s;
    }
    use chrono::{Datelike, NaiveDate};
    NaiveDate::from_ymd_opt(y, m, d).map(|n| n.weekday().to_string()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn en_us_long_date_loses_weekday_and_full_month() {
        assert_eq!(date_pattern("dddd, MMMM d, yyyy", true), "MMM d, yyyy");
        assert_eq!(date_pattern("dddd, MMMM d, yyyy", false), "MMM d");
    }

    #[test]
    fn zh_tw_long_date_keeps_the_cjk_units() {
        assert_eq!(date_pattern("yyyy'年'M'月'd'日'", true), "yyyy'年'M'月'd'日'");
        assert_eq!(date_pattern("yyyy'年'M'月'd'日'", false), "M'月'd'日'");
        assert_eq!(date_pattern("yyyy'年'M'月'd'日' dddd", false), "M'月'd'日'");
    }

    #[test]
    fn other_orders_drop_the_year_cleanly() {
        assert_eq!(date_pattern("dddd, d. MMMM yyyy", false), "d. MMM");
        assert_eq!(date_pattern("yyyy'년' M'월' d'일' dddd", false), "M'월' d'일'");
    }

    #[test]
    fn time_patterns_use_two_digit_hours_without_seconds() {
        assert_eq!(time_pattern("h:mm:ss tt", "AM"), "hh:mm tt");
        assert_eq!(time_pattern("H:mm:ss", ""), "HH:mm");
        assert_eq!(time_pattern("tt hh:mm:ss", "上午"), "tthh:mm");
        assert_eq!(full_time_pattern("tt hh:mm:ss", "上午"), "tthh:mm:ss");
        assert_eq!(time_pattern("H.mm.ss", ""), "HH.mm");
    }

    #[test]
    fn formats_through_windows_without_panicking() {
        assert!(!month_day(2025, 10, 29, true).is_empty());
        assert!(!hour_minute(9, 5).is_empty());
        assert!(!date_time(2025, 10, 29, 9, 5, 7).is_empty());
        assert!(!weekday_short(2025, 10, 29).is_empty());
    }
}
