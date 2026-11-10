//! The glyphs of the Music page and its bar as SVG, served to gpui's asset loader under `music/...`.
//! They are the same shapes the `components/music/*.tsx` files draw inline.

use std::borrow::Cow;

macro_rules! glyph {
    ($vb:literal, $body:literal) => {
        concat!(r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox=""##, $vb, r##"" fill="#000">"##, $body, "</svg>")
    };
}

const PLAY: &str = glyph!("0 0 18 18", r#"<path d="M5 3.5l10 5.5-10 5.5V3.5z"/>"#);
const PAUSE: &str = glyph!("0 0 18 18", r#"<rect x="4" y="3" width="3.5" height="12" rx="1"/><rect x="10.5" y="3" width="3.5" height="12" rx="1"/>"#);
const PREV: &str = glyph!("0 0 16 16", r#"<rect x="2" y="2" width="2.5" height="12" rx="1"/><path d="M13 2.5L5.5 8 13 13.5V2.5z"/>"#);
const NEXT: &str = glyph!("0 0 16 16", r#"<rect x="11.5" y="2" width="2.5" height="12" rx="1"/><path d="M3 2.5L10.5 8 3 13.5V2.5z"/>"#);
const NOTE: &str = glyph!(
    "0 0 20 20",
    r#"<path d="M15 2v10.5a2.5 2.5 0 1 1-1.5-2.29V5.5L7 6.97v7.53a2.5 2.5 0 1 1-1.5-2.29V4.5a1 1 0 0 1 .78-.976l8-2A1 1 0 0 1 15 2z"/>"#
);
const VOL_BODY: &str = r#"<path d="M8 2.2L4.5 5.5H2a1 1 0 00-1 1v3a1 1 0 001 1h2.5L8 13.8a.5.5 0 00.85-.35V2.55A.5.5 0 008 2.2z"/>"#;
const SHUFFLE: &str = glyph!(
    "0 0 24 24",
    r#"<path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>"#
);
const REPEAT: &str = glyph!("0 0 24 24", r#"<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>"#);
const REPEAT_ONE: &str = glyph!("0 0 24 24", r#"<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2v-3h-1l-2 1v1h1.5v4H13v-3z"/>"#);
const CLEAR: &str = glyph!(
    "0 0 14 14",
    r#"<path d="M10.5 2h-7A1.5 1.5 0 0 0 2 3.5v.5h10v-.5A1.5 1.5 0 0 0 10.5 2zM3 5.5l.72 5.76A1 1 0 0 0 4.71 12h4.58a1 1 0 0 0 .99-.74L11 5.5H3zm3.25 1.25a.5.5 0 0 1 1 0v3.5a.5.5 0 0 1-1 0v-3.5zM5 6.75a.5.5 0 0 0-1 0v3.5a.5.5 0 0 0 1 0v-3.5zm4 0a.5.5 0 0 0-1 0v3.5a.5.5 0 0 0 1 0v-3.5z"/>"#
);
const BUFFERING: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="7" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-dasharray="30 14"/></svg>"##;
const DOTS: &str = glyph!("0 0 24 24", r#"<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>"#);
const CHEVRON: &str = glyph!("0 0 24 24", r#"<path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>"#);
const PLUS: &str = glyph!("0 0 24 24", r#"<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>"#);
const PLAY_SMALL: &str = glyph!("0 0 24 24", r#"<path d="M8 5v14l11-7z"/>"#);
const URL_PLAY: &str = glyph!("0 0 24 24", r#"<polygon points="5 3 19 12 5 21 5 3"/>"#);
const PENCIL: &str = glyph!("0 0 24 24", r#"<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>"#);
const TRASH: &str = glyph!("0 0 24 24", r#"<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>"#);
const GRIP: &str = glyph!("0 0 24 24", r#"<path d="M8 6h2v2H8zm0 4h2v2H8zm0 4h2v2H8zm6-8h2v2h-2zm0 4h2v2h-2zm0 4h2v2h-2z"/>"#);
const CLOSE: &str = glyph!("0 0 24 24", r#"<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>"#);
const SEARCH: &str = glyph!(
    "0 0 24 24",
    r#"<path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>"#
);
const DOWNLOAD: &str = glyph!("0 0 24 24", r#"<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>"#);
const CHECK_CIRCLE: &str = glyph!("0 0 24 24", r#"<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>"#);
const WARNING: &str = glyph!("0 0 24 24", r#"<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>"#);
const ARROW_LEFT: &str = glyph!("0 0 24 24", r#"<path d="M19 11H7.83l4.88-4.88c.39-.39.39-1.03 0-1.42-.39-.39-1.02-.39-1.41 0l-6.59 6.59c-.39.39-.39 1.02 0 1.41l6.59 6.59c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L7.83 13H19c.55 0 1-.45 1-1s-.45-1-1-1z"/>"#);
const TRACK_NOTE: &str = glyph!("0 0 24 24", r#"<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>"#);
const EMPTY_QUEUE: &str = glyph!("0 0 24 24", r#"<path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>"#);
const EMPTY_LIBRARY: &str = glyph!(
    "0 0 24 24",
    r#"<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>"#
);
const SORT_UP: &str = glyph!("0 0 24 24", r#"<path d="M7 14l5-5 5 5z"/>"#);

fn volume(parts: &[&str]) -> String {
    format!(r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#000">{VOL_BODY}{}</svg>"##, parts.join(""))
}

const WAVE_LOW: &str = r#"<path opacity="0.9" d="M10.05 5.88a.5.5 0 01.71 0 3.5 3.5 0 010 4.24.5.5 0 11-.76-.65 2.5 2.5 0 000-2.94.5.5 0 01.05-.65z"/>"#;
const WAVE_HIGH: &str = r#"<path opacity="0.7" d="M11.36 3.53a.5.5 0 01.71 0 6.5 6.5 0 010 8.94.5.5 0 11-.71-.71 5.5 5.5 0 000-7.52.5.5 0 010-.71z"/>"#;
const WAVE_MUTE: &str = r#"<path d="M12.35 5.65a.5.5 0 01.7.7L11.42 8l1.63 1.65a.5.5 0 01-.7.7L10.72 8.7l-1.63 1.65a.5.5 0 01-.7-.7L9.99 8 8.37 6.35a.5.5 0 01.7-.7l1.63 1.64 1.65-1.64z"/>"#;

/// The SVG behind a `music/` asset path, if it is one of ours.
pub fn load(path: &str) -> Option<Cow<'static, [u8]>> {
    let name = path.strip_prefix("music/")?.strip_suffix(".svg")?;
    let fixed = |s: &'static str| Some(Cow::Borrowed(s.as_bytes()));
    match name {
        "play" => fixed(PLAY),
        "pause" => fixed(PAUSE),
        "prev" => fixed(PREV),
        "next" => fixed(NEXT),
        "note" => fixed(NOTE),
        "shuffle" => fixed(SHUFFLE),
        "repeat" => fixed(REPEAT),
        "repeat-one" => fixed(REPEAT_ONE),
        "clear" => fixed(CLEAR),
        "buffering" => fixed(BUFFERING),
        "dots" => fixed(DOTS),
        "chevron" => fixed(CHEVRON),
        "plus" => fixed(PLUS),
        "play-small" => fixed(PLAY_SMALL),
        "url-play" => fixed(URL_PLAY),
        "pencil" => fixed(PENCIL),
        "trash" => fixed(TRASH),
        "grip" => fixed(GRIP),
        "close" => fixed(CLOSE),
        "search" => fixed(SEARCH),
        "download" => fixed(DOWNLOAD),
        "check-circle" => fixed(CHECK_CIRCLE),
        "warning" => fixed(WARNING),
        "arrow-left" => fixed(ARROW_LEFT),
        "track-note" => fixed(TRACK_NOTE),
        "empty-queue" => fixed(EMPTY_QUEUE),
        "empty-library" => fixed(EMPTY_LIBRARY),
        "sort-up" => fixed(SORT_UP),
        "vol-high" => Some(Cow::Owned(volume(&[WAVE_HIGH, WAVE_LOW]).into_bytes())),
        "vol-low" => Some(Cow::Owned(volume(&[WAVE_LOW]).into_bytes())),
        "vol-muted" => Some(Cow::Owned(volume(&[WAVE_MUTE]).into_bytes())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::load;

    #[test]
    fn every_glyph_is_well_formed_svg() {
        for name in [
            "play", "pause", "prev", "next", "note", "shuffle", "repeat", "repeat-one", "clear", "buffering", "dots", "chevron", "plus",
            "play-small", "url-play", "pencil", "trash", "grip", "close", "search", "download", "check-circle", "warning", "arrow-left",
            "track-note", "empty-queue", "empty-library", "sort-up", "vol-high", "vol-low", "vol-muted",
        ] {
            let svg = String::from_utf8(load(&format!("music/{name}.svg")).unwrap_or_else(|| panic!("{name} missing")).into_owned()).unwrap();
            assert!(svg.starts_with("<svg ") && svg.ends_with("</svg>"), "{name}: {svg}");
            assert_eq!(svg.matches('<').count(), svg.matches('>').count(), "{name}");
        }
        assert!(load("music/nope.svg").is_none());
        assert!(load("gen/play.svg").is_none());
    }
}
