//! The window's view of the music player: one entity that polls the service for its snapshot,
//! forwards the service's events, and tells the bar and the Music page when to repaint.
//!
//! Position and buffered seconds change every frame while a track plays, so they only `notify`
//! (the bar observes that). Anything else a view lists (queue, track, state, volume, flags) is a
//! `HubEvent::Structure`, which the page and the root also react to.

use gpui::*;
use lizmeter_core::MusicPlaybackState;
use lizmeter_music::{MusicEvent, MusicService, MusicSnapshot};
use lizmeter_services::os::hotkeys::{Binding, HotkeyManager, MEDIA_KEY_BINDINGS};
use lizmeter_services::Services;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug)]
pub enum HubEvent {
    /// Something other than the playing position changed.
    Structure,
    /// A service event: import, download and health-check progress, cache completion.
    Service(MusicEvent),
}

pub struct MusicHub {
    svc: Arc<Services>,
    pub snap: MusicSnapshot,
    inbox: Arc<Mutex<Vec<MusicEvent>>>,
}

impl EventEmitter<HubEvent> for MusicHub {}

/// Whether anything a list or a label shows differs between two snapshots.
pub fn structure_changed(a: &MusicSnapshot, b: &MusicSnapshot) -> bool {
    a.current_track.as_ref().map(|t| (&t.id, t.is_cached)) != b.current_track.as_ref().map(|t| (&t.id, t.is_cached))
        || a.playback_state != b.playback_state
        || a.current_index != b.current_index
        || a.queue.iter().map(|q| &q.queue_id).ne(b.queue.iter().map(|q| &q.queue_id))
        || a.queue.iter().map(|q| q.track.is_cached).ne(b.queue.iter().map(|q| q.track.is_cached))
        || a.volume != b.volume
        || a.muted != b.muted
        || a.playback_speed != b.playback_speed
        || a.shuffle_enabled != b.shuffle_enabled
        || a.repeat_mode != b.repeat_mode
        || a.import_progress != b.import_progress
        || a.last_error != b.last_error
        || a.is_bottom_bar_visible != b.is_bottom_bar_visible
        || a.can_go_next != b.can_go_next
        || a.can_go_prev != b.can_go_prev
        || a.seekable != b.seekable
        || a.duration != b.duration
}

impl MusicHub {
    pub fn new(svc: Arc<Services>, cx: &mut Context<Self>) -> Self {
        let inbox: Arc<Mutex<Vec<MusicEvent>>> = Arc::default();
        let sink = inbox.clone();
        svc.music().set_listener(move |e| {
            if !matches!(e, MusicEvent::Changed) {
                sink.lock().unwrap_or_else(|p| p.into_inner()).push(e);
            }
        });
        let snap = svc.music().snapshot();
        // Checking the binaries runs each one and opening the sound device takes a moment: do both
        // now, off the UI thread, so the first play does not wait for them.
        let warm = svc.clone();
        cx.background_executor().spawn(async move { warm.music().warm_up() }).detach();
        let hub = Self { svc, snap, inbox };
        hub.start_polling(cx);
        hub
    }

    pub fn svc(&self) -> &Arc<Services> {
        &self.svc
    }

    fn start_polling(&self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| loop {
            let idle = this.update(cx, |h, cx| h.poll(cx)).unwrap_or(true);
            cx.background_executor().timer(Duration::from_millis(if idle { 400 } else { 80 })).await;
        })
        .detach();
    }

    /// One look at the service. Returns true while nothing is loaded (the loop may slow down).
    fn poll(&mut self, cx: &mut Context<Self>) -> bool {
        let events: Vec<MusicEvent> = std::mem::take(&mut *self.inbox.lock().unwrap_or_else(|p| p.into_inner()));
        let next = self.svc.music().snapshot();
        let structure = structure_changed(&self.snap, &next);
        let moved = self.snap.current_time != next.current_time || self.snap.buffered != next.buffered;
        let idle = next.current_track.is_none() && !next.is_bottom_bar_visible && events.is_empty();
        self.snap = next;
        if structure {
            cx.emit(HubEvent::Structure);
        }
        for e in events {
            cx.emit(HubEvent::Service(e));
        }
        if structure || moved {
            cx.notify();
        }
        idle
    }

    /// Reads the snapshot now, for a view that just changed something.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.poll(cx);
    }
}

/// What a system media key asks the player to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaCommand {
    Pause,
    Resume,
    Next,
    Previous,
}

/// `MusicPlayerContext`'s media-key handler: play/pause toggles on the current state.
pub fn media_command(action: &str, state: MusicPlaybackState) -> Option<MediaCommand> {
    match action {
        "MediaPlayPause" if state == MusicPlaybackState::Playing => Some(MediaCommand::Pause),
        "MediaPlayPause" => Some(MediaCommand::Resume),
        "MediaNextTrack" => Some(MediaCommand::Next),
        "MediaPreviousTrack" => Some(MediaCommand::Previous),
        _ => None,
    }
}

/// Registers the system media keys for the player, as the Electron build does at start. The keys
/// go back when the returned manager drops. A key another app holds is reported and skipped.
pub fn start_media_keys(svc: Arc<Services>) -> Option<HotkeyManager> {
    let bindings = MEDIA_KEY_BINDINGS.iter().map(|(accelerator, action)| Binding { accelerator: accelerator.to_string(), action: action.to_string() }).collect();
    let on_key = Arc::new(move |action: &str| {
        let Some(cmd) = media_command(action, svc.music().snapshot().playback_state) else { return };
        // Next and previous may start a download: never on the thread that waits for keys.
        let svc = svc.clone();
        std::thread::spawn(move || {
            let m = svc.music();
            match cmd {
                MediaCommand::Pause => m.pause(),
                MediaCommand::Resume => m.resume(),
                MediaCommand::Next => m.next(),
                MediaCommand::Previous => m.prev(),
            }
        });
    });
    match HotkeyManager::start(bindings, on_key) {
        Ok((manager, results)) => {
            for r in results {
                if let Err(e) = r.result {
                    eprintln!("[media-keys] {e}");
                }
            }
            Some(manager)
        }
        Err(e) => {
            eprintln!("[media-keys] {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{media_command, MediaCommand};
    use lizmeter_core::MusicPlaybackState as S;

    #[test]
    fn play_pause_toggles_on_the_state_and_the_other_keys_skip() {
        assert_eq!(media_command("MediaPlayPause", S::Playing), Some(MediaCommand::Pause));
        for s in [S::Paused, S::Stopped, S::Buffering] {
            assert_eq!(media_command("MediaPlayPause", s), Some(MediaCommand::Resume));
        }
        assert_eq!(media_command("MediaNextTrack", S::Playing), Some(MediaCommand::Next));
        assert_eq!(media_command("MediaPreviousTrack", S::Paused), Some(MediaCommand::Previous));
        assert_eq!(media_command("VolumeUp", S::Playing), None);
    }
}
