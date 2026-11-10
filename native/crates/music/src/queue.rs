//! The play queue, shuffle order and repeat rules of `MusicPlayerContext.tsx`, as plain data.
//!
//! No playback happens here: the functions answer "which index next" and keep the current index
//! and the shuffle order consistent when the queue changes.

use lizmeter_core::{MusicQueueItem, MusicTrack, RepeatMode};

/// Small deterministic generator (SplitMix64): shuffle needs spread, not strength, and tests need
/// a fixed seed.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A value in `0..n` (`n > 0`).
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

/// What a queue change did to the playing track.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Removal {
    /// At least one item was removed.
    pub removed: bool,
    /// The playing item was among them: the caller stops playback.
    pub removed_current: bool,
}

/// What `prev` should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrevAction {
    /// More than 3 seconds in: restart the track.
    Restart,
    Index(usize),
    Nothing,
}

#[derive(Debug, Clone)]
pub struct QueueState {
    pub items: Vec<MusicQueueItem>,
    /// Index of the playing item, `-1` for none.
    pub current: i64,
    /// Play order as queue indices; `None` while shuffle is off.
    pub shuffle_order: Option<Vec<usize>>,
    pub shuffle_enabled: bool,
    pub repeat: RepeatMode,
    rng: Rng,
}

impl QueueState {
    pub fn new(seed: u64) -> Self {
        QueueState { items: Vec::new(), current: -1, shuffle_order: None, shuffle_enabled: false, repeat: RepeatMode::Off, rng: Rng::new(seed) }
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn current_item(&self) -> Option<&MusicQueueItem> {
        usize::try_from(self.current).ok().and_then(|i| self.items.get(i))
    }

    fn new_item(track: MusicTrack, playlist_id: Option<i64>) -> MusicQueueItem {
        MusicQueueItem { queue_id: lizmeter_db::util::new_uuid(), track, source_playlist_id: playlist_id }
    }

    /// Fisher-Yates over positions 1.., with `pin_first` moved to position 0.
    pub fn build_shuffle_order(&mut self, length: usize, pin_first: usize) -> Vec<usize> {
        let mut order: Vec<usize> = (0..length).collect();
        if let Some(pin_idx) = order.iter().position(|&i| i == pin_first) {
            if pin_idx > 0 {
                order.swap(0, pin_idx);
            }
        }
        let mut i = length.saturating_sub(1);
        while i > 1 {
            let j = self.rng.below(i) + 1;
            order.swap(i, j);
            i -= 1;
        }
        order
    }

    fn rebuild_shuffle(&mut self, pin: usize) {
        if self.shuffle_enabled && !self.items.is_empty() {
            self.shuffle_order = Some(self.build_shuffle_order(self.items.len(), pin));
        } else if self.items.is_empty() {
            self.shuffle_order = None;
        }
    }

    /// The index to play after `from`. `treat_repeat_one_as_off`: the next button advances even in
    /// repeat-one mode, while the "track ended" event replays the track (the caller handles that).
    pub fn compute_next_index(&self, from: i64, treat_repeat_one_as_off: bool) -> Option<usize> {
        let repeat = if self.repeat == RepeatMode::One && treat_repeat_one_as_off { RepeatMode::Off } else { self.repeat };
        if let Some(order) = &self.shuffle_order {
            let pos: i64 = order.iter().position(|&i| i as i64 == from).map_or(-1, |p| p as i64);
            let next = (pos + 1) as usize;
            if next < order.len() {
                return Some(order[next]);
            }
            return if repeat == RepeatMode::Queue { order.first().copied() } else { None };
        }
        if from + 1 < self.items.len() as i64 {
            return Some((from + 1) as usize);
        }
        if repeat == RepeatMode::Queue && !self.items.is_empty() {
            return Some(0);
        }
        None
    }

    fn prev_index(&self) -> Option<usize> {
        if let Some(order) = &self.shuffle_order {
            let pos = order.iter().position(|&i| i as i64 == self.current)?;
            return (pos > 0).then(|| order[pos - 1]);
        }
        (self.current > 0).then(|| (self.current - 1) as usize)
    }

    /// What the previous button does: restart after 3 s, else step back (never wraps).
    pub fn prev_action(&self, position_secs: f64) -> PrevAction {
        if position_secs > 3.0 {
            return PrevAction::Restart;
        }
        self.prev_index().map_or(PrevAction::Nothing, PrevAction::Index)
    }

    /// Whether the next and previous buttons would do something.
    pub fn can_go(&self) -> (bool, bool) {
        if self.items.is_empty() || self.current < 0 {
            return (false, false);
        }
        let can_prev = self.prev_index().is_some();
        let can_next = match (&self.shuffle_order, self.repeat) {
            (_, RepeatMode::Queue) => true,
            (Some(order), _) => order.iter().position(|&i| i as i64 == self.current).is_some_and(|p| p + 1 < order.len()),
            (None, _) => self.current + 1 < self.items.len() as i64,
        };
        (can_next, can_prev)
    }

    /// Appends one track. With shuffle on it lands at a random place after the playing one.
    pub fn enqueue(&mut self, track: MusicTrack, playlist_id: Option<i64>) {
        self.items.push(Self::new_item(track, playlist_id));
        if self.shuffle_enabled {
            let new_idx = self.items.len() - 1;
            match self.shuffle_order.take() {
                Some(mut ord) => {
                    let pos = (self.current + 1).max(0) as usize;
                    let span = ord.len().saturating_sub(pos) + 1;
                    let at = (pos + self.rng.below(span)).min(ord.len());
                    ord.insert(at, new_idx);
                    self.shuffle_order = Some(ord);
                }
                None => self.rebuild_shuffle(self.current.max(0) as usize),
            }
        }
    }

    pub fn enqueue_bulk(&mut self, tracks: Vec<MusicTrack>, playlist_id: Option<i64>) {
        self.items.extend(tracks.into_iter().map(|t| Self::new_item(t, playlist_id)));
        if self.shuffle_enabled && !self.items.is_empty() {
            self.rebuild_shuffle(self.current.max(0) as usize);
        }
    }

    /// Removes the item at `index`. Returns whether it was the playing one.
    pub fn dequeue_at(&mut self, index: usize) -> Option<bool> {
        if index >= self.items.len() {
            return None;
        }
        self.items.remove(index);
        let idx = index as i64;
        let was_current = idx == self.current;
        if idx < self.current {
            self.current -= 1;
        } else if was_current {
            self.current = -1;
        }
        self.rebuild_shuffle(self.current.max(0) as usize);
        Some(was_current)
    }

    /// Removes every item for a deleted library track, including duplicates that share its
    /// `source_url`.
    pub fn remove_track(&mut self, track_id: &str) -> Removal {
        let urls: Vec<String> = self.items.iter().filter(|i| i.track.id == track_id).map(|i| i.track.source_url.clone()).collect();
        if urls.is_empty() {
            return Removal { removed: false, removed_current: false };
        }
        let gone = |i: &MusicQueueItem| i.track.id == track_id || urls.contains(&i.track.source_url);
        let removed_current = self.current >= 0 && self.items.get(self.current as usize).is_some_and(gone);
        let before = self.items.iter().take(self.current.max(0) as usize).filter(|i| gone(i)).count() as i64;
        self.items.retain(|i| !gone(i));
        self.current = if removed_current { -1 } else { self.current - before };
        self.rebuild_shuffle(self.current.max(0) as usize);
        Removal { removed: true, removed_current }
    }

    /// Moves an item; the playing item stays the playing item. Out-of-range moves do nothing.
    pub fn reorder(&mut self, from: usize, to: usize) {
        if from == to || from >= self.items.len() || to >= self.items.len() {
            return;
        }
        let item = self.items.remove(from);
        self.items.insert(to, item);
        let (f, t) = (from as i64, to as i64);
        let idx = self.current;
        self.current = if idx == f {
            t
        } else if f < t && idx > f && idx <= t {
            idx - 1
        } else if f > t && idx >= t && idx < f {
            idx + 1
        } else {
            idx
        };
        if self.shuffle_enabled && !self.items.is_empty() {
            self.rebuild_shuffle(self.current.max(0) as usize);
        }
    }

    pub fn clear(&mut self) {
        self.items.clear();
        self.current = -1;
        self.shuffle_order = None;
    }

    pub fn set_shuffle(&mut self, on: bool) {
        self.shuffle_enabled = on;
        if on {
            if !self.items.is_empty() {
                self.shuffle_order = Some(self.build_shuffle_order(self.items.len(), self.current.max(0) as usize));
            }
        } else {
            self.shuffle_order = None;
        }
    }

    /// `play(url)` with something already playing: the new track goes right after it and plays.
    /// Returns its index.
    pub fn insert_after_current(&mut self, track: MusicTrack) -> usize {
        let at = (self.current + 1).max(0) as usize;
        let item = Self::new_item(track, None);
        self.items.insert(at.min(self.items.len()), item);
        self.current = at as i64;
        self.rebuild_shuffle(at);
        at
    }

    /// `play(url)` with nothing playing: the track becomes index 0; other items that share its
    /// `source_url` are dropped (a playlist import may already have queued them).
    pub fn insert_first(&mut self, track: MusicTrack) -> usize {
        let url = track.source_url.clone();
        self.items.retain(|i| i.track.source_url != url);
        self.items.insert(0, Self::new_item(track, None));
        self.current = 0;
        self.rebuild_shuffle(0);
        0
    }

    /// Marks every queued copy of `track_id` as cached.
    pub fn mark_cached(&mut self, track_id: &str) {
        for i in self.items.iter_mut().filter(|i| i.track.id == track_id) {
            i.track.is_cached = true;
        }
    }

    pub fn index_of_queue_id(&self, queue_id: &str) -> Option<usize> {
        self.items.iter().position(|i| i.queue_id == queue_id)
    }
}
