//! The row glyphs of the Todos list as SVG, served to gpui's asset loader under `gen/...`.
//! They are the same shapes `TodosPage.tsx` draws inline.

use std::borrow::Cow;

const PROJECT: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><path d="M8 1.6 14 5v6l-6 3.4L2 11V5l6-3.4Z"/><path d="M2 5l6 3.4L14 5"/><path d="M8 8.4v6"/></svg>"##;

const CHECK: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 13 13" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.3 6.8 5.6 9.1 9.8 4.2"/></svg>"##;

const TRIANGLE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" fill="#000"><path d="M1.4 0.6 6.8 4 1.4 7.4Z"/></svg>"##;

const SPARKLE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#000"><path d="M8 1 9.5 6.5 15 8 9.5 9.5 8 15 6.5 9.5 1 8 6.5 6.5Z"/></svg>"##;

const USER: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#000"><circle cx="8" cy="5" r="2.6"/><path d="M2.6 13C2.6 10 4.9 7.8 8 7.8 11.1 7.8 13.4 10 13.4 13 13.4 13.6 12.9 14 12.4 14L3.6 14C3.1 14 2.6 13.6 2.6 13Z"/></svg>"##;

const CLAUDE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 47 38" fill="#000"><path d="M5.08191 10.0769V0.938461H9.37422V10.0769H5.08191ZM9.23305 10.0769V0.938461H13.5254V10.0769H9.23305ZM13.3842 10.0769V0.938461H17.6765V10.0769H13.3842ZM17.5353 10.0769V0.938461H21.8276V10.0769H17.5353ZM21.6865 10.0769V0.938461H25.9788V10.0769H21.6865ZM25.8376 10.0769V0.938461H30.1299V10.0769H25.8376ZM29.9888 10.0769V0.938461H34.2811V10.0769H29.9888ZM34.1399 10.0769V0.938461H38.4322V10.0769H34.1399ZM38.291 10.0769V0.938461H42.5834V10.0769H38.291ZM0.930769 19.0769V9.93846H5.22308V19.0769H0.930769ZM5.08191 19.0769V9.93846H9.37422V19.0769H5.08191ZM9.23305 19.0769V14.5077H13.5254V19.0769H9.23305ZM13.3842 19.0769V9.93846H17.6765V19.0769H13.3842ZM17.5353 19.0769V9.93846H21.8276V19.0769H17.5353ZM21.6865 19.0769V9.93846H25.9788V19.0769H21.6865ZM25.8376 19.0769V9.93846H30.1299V19.0769H25.8376ZM29.9888 19.0769V9.93846H34.2811V19.0769H29.9888ZM34.1399 19.0769V14.5077H38.4322V19.0769H34.1399ZM38.291 19.0769V9.93846H42.5834V19.0769H38.291ZM42.4422 19.0769V9.93846H46.7345V19.0769H42.4422ZM5.08191 28.0769V18.9385H9.37422V28.0769H5.08191ZM9.23305 28.0769V18.9385H13.5254V28.0769H9.23305ZM13.3842 28.0769V18.9385H17.6765V28.0769H13.3842ZM17.5353 28.0769V18.9385H21.8276V28.0769H17.5353ZM21.6865 28.0769V18.9385H25.9788V28.0769H21.6865ZM25.8376 28.0769V18.9385H30.1299V28.0769H25.8376ZM29.9888 28.0769V18.9385H34.2811V28.0769H29.9888ZM34.1399 28.0769V18.9385H38.4322V28.0769H34.1399ZM38.291 28.0769V18.9385H42.5834V28.0769H38.291ZM5.08191 37.0769V27.9385H9.37422V37.0769H5.08191ZM13.3842 37.0769V27.9385H17.6765V37.0769H13.3842ZM29.9888 37.0769V27.9385H34.2811V37.0769H29.9888ZM38.291 37.0769V27.9385H42.5834V37.0769H38.291Z"/></svg>"##;

const CODEX: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#000"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>"##;

const CALENDAR: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.4"><rect x="2.25" y="3.25" width="11.5" height="10.5" rx="2"/><path d="M2.25 6.5h11.5M5.5 2v2.5M10.5 2v2.5" stroke-linecap="round"/></svg>"##;

const ARROW_UP: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>"##;

const ARROW_DOWN: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>"##;

/// The priority glyph: three ascending bars filled up to the level, urgent as a solid block.
fn priority(level: i64) -> String {
    let filled = |l: i64| if level > 0 && level <= l { "1" } else { "0.28" };
    let body = if level == 1 {
        r#"<rect x="6.4" y="1.5" width="3.2" height="8.4" rx="1.4"/><rect x="6.4" y="11.6" width="3.2" height="3" rx="1.4"/>"#.to_string()
    } else {
        format!(
            r#"<rect x="1" y="9.5" width="3.6" height="5" rx="1" opacity="{}"/><rect x="6.2" y="6" width="3.6" height="8.5" rx="1" opacity="{}"/><rect x="11.4" y="2.5" width="3.6" height="12" rx="1" opacity="{}"/>"#,
            filled(4),
            filled(3),
            filled(2)
        )
    };
    format!(r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#000">{body}</svg>"##)
}

/// How far a parent's sub-issues have got: a ring that fills clockwise from 12 o'clock.
/// No arc is drawn at zero, because a round cap on a zero-length dash still paints a dot.
fn ring(done: i64, total: i64) -> String {
    let radius = 5.0_f64;
    let circumference = 2.0 * std::f64::consts::PI * radius;
    let ratio = if total > 0 { (done as f64 / total as f64).min(1.0) } else { 0.0 };
    let arc = if ratio > 0.0 {
        format!(
            r##"<circle cx="7" cy="7" r="5" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-dasharray="{:.4} {:.4}" transform="rotate(-90 7 7)"/>"##,
            circumference * ratio,
            circumference
        )
    } else {
        String::new()
    };
    format!(r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="#000" stroke-width="1.5" opacity="0.3"/>{arc}</svg>"##)
}

/// The SVG behind a `gen/` asset path, if it is one of ours.
pub fn load(path: &str) -> Option<Cow<'static, [u8]>> {
    let name = path.strip_prefix("gen/")?.strip_suffix(".svg")?;
    let owned = |s: String| Some(Cow::Owned(s.into_bytes()));
    match name {
        "check" => Some(Cow::Borrowed(CHECK.as_bytes())),
        "tri" => Some(Cow::Borrowed(TRIANGLE.as_bytes())),
        "project" => Some(Cow::Borrowed(PROJECT.as_bytes())),
        "src-ai" => Some(Cow::Borrowed(SPARKLE.as_bytes())),
        "src-user" => Some(Cow::Borrowed(USER.as_bytes())),
        "src-claude" => Some(Cow::Borrowed(CLAUDE.as_bytes())),
        "calendar" => Some(Cow::Borrowed(CALENDAR.as_bytes())),
        "arrow-up" => Some(Cow::Borrowed(ARROW_UP.as_bytes())),
        "arrow-down" => Some(Cow::Borrowed(ARROW_DOWN.as_bytes())),
        "src-codex" => Some(Cow::Borrowed(CODEX.as_bytes())),
        _ => {
            if let Some(level) = name.strip_prefix("priority-") {
                return owned(priority(level.parse().ok()?));
            }
            let rest = name.strip_prefix("ring-")?;
            let (done, total) = rest.split_once('-')?;
            owned(ring(done.parse().ok()?, total.parse().ok()?))
        }
    }
}

/// The asset path of the priority glyph (0 draws dim).
pub fn priority_path(priority: i64) -> String {
    format!("gen/priority-{}.svg", priority.clamp(0, 4))
}

pub fn ring_path(done: i64, total: i64) -> String {
    format!("gen/ring-{done}-{total}.svg")
}

/// Which agent mark a `sourceLabel` gets: a case-insensitive substring match, a generic sparkle otherwise.
pub fn ai_glyph(source_label: Option<&str>) -> (&'static str, u32) {
    let n = source_label.map(str::to_lowercase).unwrap_or_default();
    if n.contains("claude") {
        ("gen/src-claude.svg", 0xd97757)
    } else if n.contains("codex") || n.contains("openai") || n.contains("gpt") {
        ("gen/src-codex.svg", 0x9ece6a)
    } else {
        ("gen/src-ai.svg", 0xbb9af7)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_generated_path_serves_an_svg() {
        for p in ["gen/project.svg", "gen/check.svg", "gen/tri.svg", "gen/src-user.svg", "gen/src-ai.svg", "gen/src-claude.svg", "gen/src-codex.svg", "gen/calendar.svg", "gen/arrow-up.svg", "gen/arrow-down.svg", "gen/priority-0.svg", "gen/priority-1.svg", "gen/priority-4.svg", "gen/ring-0-3.svg", "gen/ring-2-3.svg"] {
            let svg = load(p).unwrap_or_else(|| panic!("{p} not served"));
            assert!(std::str::from_utf8(&svg).unwrap().starts_with("<svg"));
        }
        assert!(load("icons/clock.svg").is_none());
        assert!(load("gen/ring-x-3.svg").is_none());
    }

    #[test]
    fn a_ring_at_zero_has_no_arc_and_a_full_ring_closes() {
        let none = String::from_utf8(load("gen/ring-0-4.svg").unwrap().into_owned()).unwrap();
        assert!(!none.contains("dasharray"));
        let full = String::from_utf8(load("gen/ring-4-4.svg").unwrap().into_owned()).unwrap();
        assert!(full.contains("dasharray=\"31.4159 31.4159\""));
    }

    #[test]
    fn the_agent_glyph_follows_the_label() {
        assert_eq!(ai_glyph(Some("Claude-Code")).0, "gen/src-claude.svg");
        assert_eq!(ai_glyph(Some("openai")).0, "gen/src-codex.svg");
        assert_eq!(ai_glyph(None).0, "gen/src-ai.svg");
    }
}
