//! The decisions of the Music UI that need no window: time and size text, seek and volume maths,
//! the library list's paging and sort rules, and the queue move behind "Play Next".

use lizmeter_core::{MusicLibraryListInput, MusicSortDir, MusicSortField, RepeatMode};

pub const PAGE_SIZE: i64 = 50;
pub const SPEED_OPTIONS: [f64; 6] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

/// `MusicBottomBar.formatTime`: `m:ss`, or `h:mm:ss` from an hour on.
pub fn format_time(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "0:00".into();
    }
    let total = seconds.floor() as u64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// The list rows' duration: whole minutes (not wrapped at an hour) and `--:--` when unknown.
pub fn format_duration(seconds: Option<f64>) -> String {
    match seconds {
        Some(s) if s.is_finite() => {
            let m = (s / 60.0).floor() as i64;
            // `s % 60` as JS prints it: fractional seconds stay, a single digit gets a leading zero.
            let rest = s % 60.0;
            let text = if rest.fract() == 0.0 { format!("{}", rest as i64) } else { format!("{rest}") };
            format!("{m}:{text:0>2}")
        }
        _ => "--:--".into(),
    }
}

/// `BinaryConsentDialog.formatBytes`.
pub fn format_bytes(bytes: Option<i64>) -> String {
    match bytes {
        None => "size unknown".into(),
        Some(b) if b < 1024 * 1024 => format!("{} KB", js_fixed(b as f64 / 1024.0, 0)),
        Some(b) => format!("{} MB", js_fixed(b as f64 / (1024.0 * 1024.0), 1)),
    }
}

/// `BinaryConsentDialog.formatSpeed`.
pub fn format_speed(bytes_per_sec: f64) -> String {
    if bytes_per_sec < 1024.0 {
        format!("{} B/s", js_fixed(bytes_per_sec, 0))
    } else if bytes_per_sec < 1024.0 * 1024.0 {
        format!("{} KB/s", js_fixed(bytes_per_sec / 1024.0, 0))
    } else {
        format!("{} MB/s", js_fixed(bytes_per_sec / (1024.0 * 1024.0), 1))
    }
}

/// `Number.prototype.toFixed`: halves round away from zero.
fn js_fixed(v: f64, digits: usize) -> String {
    let scale = 10f64.powi(digits as i32);
    let r = (v * scale + 0.5).floor() / scale;
    format!("{r:.digits$}")
}

/// `LibraryView.SiteBadge`: first letter upper case, then at most seven more characters.
pub fn site_label(site: &str) -> String {
    let mut chars = site.chars();
    let first: String = chars.next().map(|c| c.to_uppercase().collect()).unwrap_or_default();
    let rest: String = site.chars().skip(1).take(7).collect();
    format!("{first}{rest}")
}

/// Seconds a click at `fraction` (0..=1) of the seek bar asks for. A track that is not cached can
/// only be sought inside what has been decoded.
pub fn seek_target(fraction: f64, duration: f64, buffered: f64, cached: bool) -> Option<f64> {
    if duration <= 0.0 {
        return None;
    }
    let mut target = fraction.clamp(0.0, 1.0) * duration;
    if !cached && buffered > 0.0 {
        target = target.min(buffered);
    }
    Some(target)
}

pub fn percent_of(value: f64, total: f64) -> f64 {
    if total > 0.0 {
        (value / total * 100.0).min(100.0)
    } else {
        0.0
    }
}

pub fn next_repeat(mode: RepeatMode) -> RepeatMode {
    match mode {
        RepeatMode::Off => RepeatMode::Queue,
        RepeatMode::Queue => RepeatMode::One,
        RepeatMode::One => RepeatMode::Off,
    }
}

pub fn repeat_label(mode: RepeatMode) -> &'static str {
    match mode {
        RepeatMode::Off => "off",
        RepeatMode::Queue => "queue",
        RepeatMode::One => "one",
    }
}

pub fn speed_label(speed: f64) -> String {
    format!("{speed}x")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VolumeIcon {
    Muted,
    Low,
    High,
}

pub fn volume_icon(muted: bool, volume: f32) -> VolumeIcon {
    if muted || volume == 0.0 {
        VolumeIcon::Muted
    } else if volume < 0.5 {
        VolumeIcon::Low
    } else {
        VolumeIcon::High
    }
}

/// What the mute button does: the new muted flag and the volume to restore when unmuting at zero.
pub fn toggle_mute(muted: bool, volume: f32, previous: f32) -> (bool, Option<f32>) {
    if muted {
        (false, (volume == 0.0).then_some(if previous > 0.0 { previous } else { 0.5 }))
    } else {
        (true, None)
    }
}

/// "Play Next": the track was appended at `queue_len`; move it right after the playing one.
pub fn play_next_move(queue_len: usize, current: i64) -> Option<(usize, usize)> {
    let target = (current + 1).max(0) as usize;
    (queue_len > target).then_some((queue_len, target))
}

/// The queue after dragging row `from` onto row `to` (what dnd-kit's `arrayMove` yields).
pub fn array_move<T>(items: &mut Vec<T>, from: usize, to: usize) {
    if from >= items.len() || to >= items.len() || from == to {
        return;
    }
    let item = items.remove(from);
    items.insert(to, item);
}

/// The playing index after row `from` moved to `to`.
pub fn index_after_move(current: i64, from: usize, to: usize) -> i64 {
    if current < 0 {
        return current;
    }
    let c = current as usize;
    if c == from {
        to as i64
    } else if from < c && to >= c {
        current - 1
    } else if from > c && to <= c {
        current + 1
    } else {
        current
    }
}

/// `useMusicLibrary`: what is asked for, and the rows received so far.
#[derive(Debug, Clone)]
pub struct LibraryQuery {
    pub search: String,
    pub sort_field: MusicSortField,
    pub sort_dir: MusicSortDir,
    pub offline_only: bool,
}

impl Default for LibraryQuery {
    fn default() -> Self {
        LibraryQuery { search: String::new(), sort_field: MusicSortField::LastPlayedAt, sort_dir: MusicSortDir::Desc, offline_only: false }
    }
}

impl LibraryQuery {
    /// The request for the page starting at `offset` (all `limit` rows when asked for the whole list).
    pub fn input(&self, limit: i64, offset: i64) -> MusicLibraryListInput {
        MusicLibraryListInput {
            limit: Some(limit),
            offset: Some(offset),
            search: (!self.search.is_empty()).then(|| self.search.clone()),
            sort_field: Some(self.sort_field),
            sort_dir: Some(self.sort_dir),
            cached_only: self.offline_only.then_some(true),
        }
    }

    /// A click on a sort button: the active one flips direction, another one becomes active.
    pub fn click_sort(&mut self, field: MusicSortField) {
        if self.sort_field == field {
            self.sort_dir = match self.sort_dir {
                MusicSortDir::Desc => MusicSortDir::Asc,
                MusicSortDir::Asc => MusicSortDir::Desc,
            };
        } else {
            self.sort_field = field;
        }
    }

    pub fn filtered(&self) -> bool {
        !self.search.is_empty() || self.offline_only
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_read_like_the_bottom_bar() {
        assert_eq!(format_time(0.0), "0:00");
        assert_eq!(format_time(65.9), "1:05");
        assert_eq!(format_time(3599.0), "59:59");
        assert_eq!(format_time(3600.0), "1:00:00");
        assert_eq!(format_time(f64::NAN), "0:00");
        assert_eq!(format_time(-3.0), "0:00");
    }

    #[test]
    fn list_durations_keep_minutes_unwrapped() {
        assert_eq!(format_duration(Some(65.0)), "1:05");
        assert_eq!(format_duration(Some(3725.0)), "62:05");
        assert_eq!(format_duration(Some(9.0)), "0:09");
        assert_eq!(format_duration(None), "--:--");
        assert_eq!(format_duration(Some(f64::INFINITY)), "--:--");
    }

    #[test]
    fn sizes_and_speeds_round_like_tofixed() {
        assert_eq!(format_bytes(None), "size unknown");
        assert_eq!(format_bytes(Some(512)), "1 KB");
        assert_eq!(format_bytes(Some(10 * 1024 * 1024)), "10.0 MB");
        assert_eq!(format_bytes(Some(145_000_000)), "138.3 MB");
        assert_eq!(format_speed(900.0), "900 B/s");
        assert_eq!(format_speed(2048.0), "2 KB/s");
        assert_eq!(format_speed(3.5 * 1024.0 * 1024.0), "3.5 MB/s");
    }

    #[test]
    fn site_badges_take_eight_characters() {
        assert_eq!(site_label("youtube"), "Youtube");
        assert_eq!(site_label("soundcloud"), "Soundclo");
        assert_eq!(site_label(""), "");
    }

    #[test]
    fn a_stream_cannot_seek_past_what_is_decoded() {
        assert_eq!(seek_target(0.5, 200.0, 0.0, true), Some(100.0));
        assert_eq!(seek_target(0.9, 200.0, 60.0, false), Some(60.0));
        assert_eq!(seek_target(0.9, 200.0, 60.0, true), Some(180.0));
        assert_eq!(seek_target(0.5, 0.0, 10.0, true), None);
        assert_eq!(seek_target(1.7, 100.0, 0.0, true), Some(100.0));
    }

    #[test]
    fn repeat_cycles_off_queue_one() {
        assert_eq!(next_repeat(RepeatMode::Off), RepeatMode::Queue);
        assert_eq!(next_repeat(RepeatMode::Queue), RepeatMode::One);
        assert_eq!(next_repeat(RepeatMode::One), RepeatMode::Off);
        assert_eq!(speed_label(1.0), "1x");
        assert_eq!(speed_label(0.75), "0.75x");
    }

    #[test]
    fn mute_restores_the_previous_volume_only_from_zero() {
        assert_eq!(toggle_mute(false, 0.4, 0.4), (true, None));
        assert_eq!(toggle_mute(true, 0.4, 0.4), (false, None));
        assert_eq!(toggle_mute(true, 0.0, 0.7), (false, Some(0.7)));
        assert_eq!(toggle_mute(true, 0.0, 0.0), (false, Some(0.5)));
        assert_eq!(volume_icon(true, 0.9), VolumeIcon::Muted);
        assert_eq!(volume_icon(false, 0.0), VolumeIcon::Muted);
        assert_eq!(volume_icon(false, 0.3), VolumeIcon::Low);
        assert_eq!(volume_icon(false, 0.5), VolumeIcon::High);
    }

    #[test]
    fn play_next_moves_the_new_track_behind_the_playing_one() {
        assert_eq!(play_next_move(5, 1), Some((5, 2)));
        assert_eq!(play_next_move(2, 1), None);
        assert_eq!(play_next_move(3, -1), Some((3, 0)));
    }

    #[test]
    fn dragging_a_queue_row_moves_it_and_the_playing_mark_follows() {
        let mut v = vec!['a', 'b', 'c', 'd'];
        array_move(&mut v, 0, 2);
        assert_eq!(v, vec!['b', 'c', 'a', 'd']);
        assert_eq!(index_after_move(0, 0, 2), 2);
        assert_eq!(index_after_move(1, 0, 2), 0);
        assert_eq!(index_after_move(2, 3, 0), 3);
        assert_eq!(index_after_move(3, 0, 1), 3);
        assert_eq!(index_after_move(-1, 0, 1), -1);
        array_move(&mut v, 9, 0);
        assert_eq!(v.len(), 4);
    }

    #[test]
    fn the_library_query_flips_the_direction_of_the_active_sort() {
        let mut q = LibraryQuery::default();
        assert_eq!((q.sort_field, q.sort_dir), (MusicSortField::LastPlayedAt, MusicSortDir::Desc));
        q.click_sort(MusicSortField::Title);
        assert_eq!((q.sort_field, q.sort_dir), (MusicSortField::Title, MusicSortDir::Desc));
        q.click_sort(MusicSortField::Title);
        assert_eq!(q.sort_dir, MusicSortDir::Asc);
        q.search = "x".into();
        q.offline_only = true;
        let i = q.input(50, 100);
        assert_eq!((i.limit, i.offset, i.search.as_deref(), i.cached_only), (Some(50), Some(100), Some("x"), Some(true)));
        assert!(q.filtered());
        assert_eq!(LibraryQuery::default().input(50, 0).cached_only, None);
    }
}
