//! Timer and stopwatch state machines (`useTimer.ts`, `useStopwatch.ts`) with the clock passed in.
//!
//! Time is whole milliseconds on any monotonic scale. A pause keeps the exact milliseconds that
//! are left, so a pause/resume pair never changes the remaining time.

use lizmeter_core::{TimerSettings, TimerType, MAX_DURATION, MIN_DURATION};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Idle,
    Running,
    Paused,
    Completed,
}

/// What one clock tick did.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Tick {
    pub changed: bool,
    pub completed: bool,
}

pub fn duration_for(settings: &TimerSettings, ty: TimerType) -> i64 {
    match ty {
        TimerType::Work => settings.work_duration,
        TimerType::ShortBreak => settings.short_break_duration,
        TimerType::LongBreak => settings.long_break_duration,
        TimerType::Stopwatch => 0,
    }
}

/// Whole seconds of `ms`, rounded half up like `Math.round`.
fn round_secs(ms: i64) -> i64 {
    (ms + 500).div_euclid(1000)
}

#[derive(Clone, Debug)]
pub struct Countdown {
    pub status: Status,
    pub timer_type: TimerType,
    pub settings: TimerSettings,
    /// Milliseconds left when the current segment started (or the idle value).
    left_ms: i64,
    seg_start: Option<u64>,
    accumulated_ms: i64,
    /// Planned duration of a restored session; `None` for a normal start.
    pub restored_planned: Option<i64>,
}

impl Countdown {
    pub fn new(settings: TimerSettings) -> Self {
        Self {
            status: Status::Idle,
            timer_type: TimerType::Work,
            settings,
            left_ms: settings.work_duration * 1000,
            seg_start: None,
            accumulated_ms: 0,
            restored_planned: None,
        }
    }

    fn run_ms(&self, now: u64) -> i64 {
        self.seg_start.map_or(0, |s| now.saturating_sub(s) as i64)
    }

    /// Milliseconds left at `now`.
    pub fn left_ms(&self, now: u64) -> i64 {
        match self.status {
            Status::Running => (self.left_ms - self.run_ms(now)).max(0),
            Status::Completed => 0,
            _ => self.left_ms,
        }
    }

    pub fn remaining_seconds(&self, now: u64) -> i64 {
        round_secs(self.left_ms(now))
    }

    /// Milliseconds until the displayed second changes; `None` unless running.
    pub fn next_wake_ms(&self, now: u64) -> Option<u64> {
        if self.status != Status::Running {
            return None;
        }
        // The display shows round(left / 1000): it flips when `left` crosses an x.5 s mark.
        let to_boundary = (self.left_ms(now) + 500).rem_euclid(1000);
        Some(if to_boundary == 0 { 1000 } else { to_boundary as u64 })
    }

    pub fn set_type(&mut self, ty: TimerType) {
        if self.status != Status::Idle {
            return;
        }
        self.timer_type = ty;
        self.left_ms = duration_for(&self.settings, ty) * 1000;
        self.restored_planned = None;
    }

    pub fn set_remaining(&mut self, secs: i64) {
        if self.status != Status::Idle {
            return;
        }
        self.left_ms = secs.clamp(MIN_DURATION, MAX_DURATION) * 1000;
    }

    pub fn start(&mut self, now: u64) {
        if self.status != Status::Idle {
            return;
        }
        self.status = Status::Running;
        self.seg_start = Some(now);
        self.accumulated_ms = 0;
    }

    pub fn pause(&mut self, now: u64) {
        if self.status != Status::Running {
            return;
        }
        let run = self.run_ms(now).min(self.left_ms);
        self.accumulated_ms += run;
        self.left_ms -= run;
        self.seg_start = None;
        self.status = Status::Paused;
    }

    pub fn resume(&mut self, now: u64) {
        if self.status != Status::Paused {
            return;
        }
        self.seg_start = Some(now);
        self.status = Status::Running;
    }

    pub fn reset(&mut self) {
        let restored_idle = self.status == Status::Idle && self.restored_planned.is_some();
        if !matches!(self.status, Status::Running | Status::Paused) && !restored_idle {
            return;
        }
        self.status = Status::Idle;
        self.left_ms = duration_for(&self.settings, self.timer_type) * 1000;
        self.seg_start = None;
        self.accumulated_ms = 0;
        self.restored_planned = None;
    }

    /// Advances the machine to `now`; `last_shown` is the second count the screen shows.
    pub fn tick(&mut self, now: u64, last_shown: i64) -> Tick {
        if self.status != Status::Running {
            return Tick::default();
        }
        if self.left_ms(now) <= 0 {
            self.accumulated_ms += self.left_ms;
            self.left_ms = 0;
            self.seg_start = None;
            self.status = Status::Completed;
            return Tick { changed: true, completed: true };
        }
        Tick { changed: self.remaining_seconds(now) != last_shown, completed: false }
    }

    pub fn clear_completion(&mut self) {
        if self.status != Status::Completed {
            return;
        }
        self.status = Status::Idle;
        self.left_ms = duration_for(&self.settings, self.timer_type) * 1000;
        self.accumulated_ms = 0;
        self.restored_planned = None;
    }

    pub fn update_settings(&mut self, settings: TimerSettings) {
        self.settings = settings;
        if self.status == Status::Idle && self.restored_planned.is_none() {
            self.left_ms = duration_for(&settings, self.timer_type) * 1000;
        }
    }

    pub fn actual_seconds(&self) -> i64 {
        round_secs(self.accumulated_ms)
    }

    pub fn planned_seconds(&self) -> i64 {
        self.restored_planned.unwrap_or_else(|| duration_for(&self.settings, self.timer_type))
    }

    /// `RESTORE`: resume a finished session's remaining time (idle only).
    pub fn restore(&mut self, ty: TimerType, planned: i64, actual: i64) {
        if self.status != Status::Idle {
            return;
        }
        self.timer_type = ty;
        self.left_ms = if actual >= planned { planned } else { (planned - actual).max(0) } * 1000;
        self.restored_planned = Some(planned);
        self.accumulated_ms = 0;
        self.seg_start = None;
    }
}

#[derive(Clone, Debug)]
pub struct Stopwatch {
    pub status: Status,
    accumulated_ms: i64,
    seg_start: Option<u64>,
    restored_base_ms: i64,
    pub restored_session_id: Option<String>,
}

impl Default for Stopwatch {
    fn default() -> Self {
        Self::new()
    }
}

impl Stopwatch {
    pub fn new() -> Self {
        Self { status: Status::Idle, accumulated_ms: 0, seg_start: None, restored_base_ms: 0, restored_session_id: None }
    }

    pub fn elapsed_ms(&self, now: u64) -> i64 {
        let seg = if self.status == Status::Running { self.seg_start.map_or(0, |s| now.saturating_sub(s) as i64) } else { 0 };
        self.accumulated_ms + seg
    }

    pub fn elapsed_seconds(&self, now: u64) -> i64 {
        round_secs(if self.status == Status::Idle { self.accumulated_ms.max(self.restored_base_ms) } else { self.elapsed_ms(now) })
    }

    pub fn start(&mut self, now: u64) {
        if self.status != Status::Idle {
            return;
        }
        self.status = Status::Running;
        self.seg_start = Some(now);
        self.accumulated_ms = self.restored_base_ms;
        self.restored_base_ms = 0;
    }

    pub fn pause(&mut self, now: u64) {
        if self.status != Status::Running {
            return;
        }
        self.accumulated_ms = self.elapsed_ms(now);
        self.seg_start = None;
        self.status = Status::Paused;
    }

    pub fn resume(&mut self, now: u64) {
        if self.status != Status::Paused {
            return;
        }
        self.seg_start = Some(now);
        self.status = Status::Running;
    }

    /// Stops a running or paused stopwatch; returns the elapsed whole seconds to save.
    pub fn stop(&mut self, now: u64) -> Option<i64> {
        if !matches!(self.status, Status::Running | Status::Paused) {
            return None;
        }
        self.accumulated_ms = self.elapsed_ms(now);
        self.seg_start = None;
        self.status = Status::Idle;
        Some(round_secs(self.accumulated_ms))
    }

    /// True once a running stopwatch reached `max_seconds` (0 = no limit).
    pub fn reached_max(&self, now: u64, max_seconds: i64) -> bool {
        self.status == Status::Running && max_seconds > 0 && round_secs(self.elapsed_ms(now)) >= max_seconds
    }

    pub fn restore(&mut self, base_ms: i64, session_id: String) {
        if self.status != Status::Idle {
            return;
        }
        self.restored_base_ms = base_ms;
        self.restored_session_id = Some(session_id);
    }

    /// Back to a blank stopwatch (after a save, or a cancelled restore).
    pub fn clear(&mut self) {
        *self = Self::new();
    }

    /// Milliseconds until the displayed second changes; `None` unless running.
    pub fn next_wake_ms(&self, now: u64) -> Option<u64> {
        (self.status == Status::Running).then(|| {
            let to_boundary = (self.elapsed_ms(now) + 500).rem_euclid(1000);
            if to_boundary == 0 { 1000 } else { 1000 - to_boundary as u64 }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lizmeter_core::DEFAULT_SETTINGS;

    fn cd() -> Countdown {
        Countdown::new(DEFAULT_SETTINGS)
    }

    #[test]
    fn pause_resume_keeps_the_exact_time_left() {
        let mut c = cd();
        c.start(0);
        c.pause(1_400);
        assert_eq!(c.left_ms(9_999), 1_500_000 - 1_400);
        c.resume(10_000);
        c.pause(10_300);
        c.resume(20_000);
        assert_eq!(c.left_ms(20_000), 1_500_000 - 1_700, "no second is lost across two pauses");
        assert_eq!(c.remaining_seconds(20_000), 1498);
    }

    #[test]
    fn counts_down_and_completes_with_the_planned_duration() {
        let mut c = cd();
        c.start(5_000);
        assert_eq!(c.remaining_seconds(5_000), 1500);
        assert_eq!(c.remaining_seconds(65_000), 1440);
        assert_eq!(c.tick(5_000 + 1_499_999, 1), Tick { changed: true, completed: false });
        let t = c.tick(5_000 + 1_500_000, 1);
        assert!(t.completed);
        assert_eq!(c.status, Status::Completed);
        assert_eq!(c.actual_seconds(), 1500);
        assert_eq!(c.planned_seconds(), 1500);
    }

    #[test]
    fn a_paused_session_saves_the_active_time_only() {
        let mut c = cd();
        c.start(0);
        c.pause(60_000);
        c.resume(500_000);
        c.tick(500_000 + 1_440_000, 1);
        assert_eq!(c.status, Status::Completed);
        assert_eq!(c.actual_seconds(), 1500);
    }

    #[test]
    fn edits_apply_only_when_idle_and_clamp() {
        let mut c = cd();
        c.set_remaining(99_999);
        assert_eq!(c.remaining_seconds(0), MAX_DURATION);
        c.set_remaining(0);
        assert_eq!(c.remaining_seconds(0), MIN_DURATION);
        c.set_remaining(60);
        c.start(0);
        c.set_remaining(30);
        c.set_type(TimerType::ShortBreak);
        assert_eq!(c.timer_type, TimerType::Work);
        assert_eq!(c.remaining_seconds(0), 60);
    }

    #[test]
    fn reset_and_settings_follow_the_state_machine() {
        let mut c = cd();
        c.reset();
        assert_eq!(c.status, Status::Idle);
        c.start(0);
        c.reset();
        assert_eq!(c.remaining_seconds(0), 1500);
        c.update_settings(TimerSettings { work_duration: 60, ..DEFAULT_SETTINGS });
        assert_eq!(c.remaining_seconds(0), 60);
        c.restore(TimerType::Work, 1500, 600);
        c.update_settings(DEFAULT_SETTINGS);
        assert_eq!(c.remaining_seconds(0), 900, "restored time survives a settings change");
        c.reset();
        assert_eq!(c.restored_planned, None);
    }

    #[test]
    fn the_wake_time_lands_on_the_next_display_change() {
        let mut c = cd();
        assert_eq!(c.next_wake_ms(0), None);
        c.start(0);
        // 1500 s is shown; it flips to 1499 once 1499.5 s are left, 500 ms from now.
        assert_eq!(c.next_wake_ms(0), Some(500));
        assert_eq!(c.next_wake_ms(500), Some(1000));
        assert_eq!(c.next_wake_ms(600), Some(900));
    }

    #[test]
    fn stopwatch_tracks_wall_time_across_pauses_and_a_restore() {
        let mut s = Stopwatch::new();
        s.start(1_000);
        assert_eq!(s.elapsed_seconds(3_600), 3);
        s.pause(4_000);
        assert_eq!(s.elapsed_seconds(90_000), 3);
        s.resume(10_000);
        assert_eq!(s.stop(12_000), Some(5));
        assert_eq!(s.status, Status::Idle);
        assert_eq!(s.stop(13_000), None);

        let mut r = Stopwatch::new();
        r.restore(60_000, "abc".into());
        assert_eq!(r.elapsed_seconds(0), 60);
        r.start(0);
        assert_eq!(r.stop(2_000), Some(62));
    }

    #[test]
    fn stopwatch_stops_itself_at_the_maximum() {
        let mut s = Stopwatch::new();
        s.start(0);
        assert!(!s.reached_max(28_799_000, 28_800));
        assert!(s.reached_max(28_800_000, 28_800));
        assert!(!s.reached_max(28_800_000, 0), "0 means no limit");
    }
}
