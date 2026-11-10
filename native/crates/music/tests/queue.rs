//! The queue rules of `MusicPlayerContext.tsx`: next/previous, repeat, shuffle, and how the
//! playing index follows queue edits.
use lizmeter_core::{MusicTrack, RepeatMode};
use lizmeter_music::queue::{PrevAction, QueueState, Removal};

fn track(id: &str) -> MusicTrack {
    MusicTrack {
        id: id.into(),
        source_url: format!("https://example.com/{id}"),
        source_id: id.into(),
        source_site: "youtube".into(),
        title: id.to_uppercase(),
        artist: None,
        duration_seconds: Some(100.0),
        thumbnail_url: None,
        is_cached: false,
        cache_size_bytes: None,
        play_count: 0,
        last_played_at: None,
        added_at: "2026-01-01T00:00:00.000Z".into(),
    }
}

fn queue_of(ids: &[&str], current: i64) -> QueueState {
    let mut q = QueueState::new(7);
    q.enqueue_bulk(ids.iter().map(|i| track(i)).collect(), None);
    q.current = current;
    q
}

fn ids(q: &QueueState) -> Vec<&str> {
    q.items.iter().map(|i| i.track.id.as_str()).collect()
}

#[test]
fn next_walks_the_queue_and_stops_at_the_end() {
    let q = queue_of(&["a", "b", "c"], 0);
    assert_eq!(q.compute_next_index(0, false), Some(1));
    assert_eq!(q.compute_next_index(2, false), None);
}

#[test]
fn repeat_queue_wraps_and_repeat_one_is_off_for_the_next_button_only() {
    let mut q = queue_of(&["a", "b", "c"], 2);
    q.repeat = RepeatMode::Queue;
    assert_eq!(q.compute_next_index(2, false), Some(0));
    q.repeat = RepeatMode::One;
    assert_eq!(q.compute_next_index(2, true), None, "next in repeat-one advances without wrapping");
    assert_eq!(q.compute_next_index(1, true), Some(2));
}

#[test]
fn shuffle_order_pins_the_current_track_first_and_is_a_permutation() {
    let mut q = queue_of(&["a", "b", "c", "d", "e", "f"], 3);
    q.set_shuffle(true);
    let order = q.shuffle_order.clone().unwrap();
    assert_eq!(order[0], 3);
    let mut sorted = order.clone();
    sorted.sort();
    assert_eq!(sorted, vec![0, 1, 2, 3, 4, 5]);
}

#[test]
fn next_in_shuffle_follows_the_order_and_wraps_only_with_repeat_queue() {
    let mut q = queue_of(&["a", "b", "c"], 0);
    q.set_shuffle(true);
    let order = q.shuffle_order.clone().unwrap();
    assert_eq!(q.compute_next_index(order[0] as i64, false), Some(order[1]));
    assert_eq!(q.compute_next_index(order[2] as i64, false), None);
    q.repeat = RepeatMode::Queue;
    assert_eq!(q.compute_next_index(order[2] as i64, false), Some(order[0]));
}

#[test]
fn prev_restarts_after_three_seconds_otherwise_steps_back_without_wrapping() {
    let q = queue_of(&["a", "b", "c"], 1);
    assert_eq!(q.prev_action(3.5), PrevAction::Restart);
    assert_eq!(q.prev_action(1.0), PrevAction::Index(0));
    let first = queue_of(&["a", "b"], 0);
    assert_eq!(first.prev_action(0.5), PrevAction::Nothing);
}

#[test]
fn navigation_flags_follow_repeat_and_shuffle() {
    let mut q = queue_of(&["a", "b", "c"], 0);
    assert_eq!(q.can_go(), (true, false));
    q.current = 2;
    assert_eq!(q.can_go(), (false, true));
    q.repeat = RepeatMode::Queue;
    assert_eq!(q.can_go(), (true, true), "queue repeat always has a next");
    q.repeat = RepeatMode::One;
    assert_eq!(q.can_go(), (false, true), "repeat-one does not wrap on next");
    q.current = -1;
    assert_eq!(q.can_go(), (false, false));
    assert_eq!(QueueState::new(1).can_go(), (false, false));
}

#[test]
fn dequeue_before_the_current_item_moves_the_index_down() {
    let mut q = queue_of(&["a", "b", "c"], 2);
    assert_eq!(q.dequeue_at(0), Some(false));
    assert_eq!((ids(&q), q.current), (vec!["b", "c"], 1));
}

#[test]
fn dequeue_of_the_current_item_clears_the_index() {
    let mut q = queue_of(&["a", "b", "c"], 1);
    assert_eq!(q.dequeue_at(1), Some(true));
    assert_eq!((ids(&q), q.current), (vec!["a", "c"], -1));
    assert_eq!(q.dequeue_at(9), None);
}

#[test]
fn dequeue_rebuilds_the_shuffle_order_and_empties_it_with_the_queue() {
    let mut q = queue_of(&["a", "b", "c", "d"], 0);
    q.set_shuffle(true);
    q.dequeue_at(3);
    let mut order = q.shuffle_order.clone().unwrap();
    order.sort();
    assert_eq!(order, vec![0, 1, 2]);
    for _ in 0..3 {
        q.dequeue_at(0);
    }
    assert_eq!(q.shuffle_order, None);
}

#[test]
fn remove_track_purges_duplicates_that_share_the_source_url() {
    let mut q = queue_of(&["a", "b", "c"], 2);
    let mut dup = track("b2");
    dup.source_url = "https://example.com/b".into();
    q.enqueue(dup, None);
    let r = q.remove_track("b");
    assert_eq!(r, Removal { removed: true, removed_current: false });
    assert_eq!((ids(&q), q.current), (vec!["a", "c"], 1));
}

#[test]
fn remove_track_of_the_playing_one_reports_it_and_clears_the_index() {
    let mut q = queue_of(&["a", "b", "c"], 1);
    let r = q.remove_track("b");
    assert_eq!(r, Removal { removed: true, removed_current: true });
    assert_eq!((ids(&q), q.current), (vec!["a", "c"], -1));
    assert_eq!(q.remove_track("zzz"), Removal { removed: false, removed_current: false });
}

#[test]
fn remove_track_in_shuffle_leaves_a_valid_order_for_the_remaining_items() {
    let mut q = queue_of(&["a", "b", "c", "d"], 2);
    q.set_shuffle(true);
    q.remove_track("c");
    let order = q.shuffle_order.clone().unwrap();
    assert_eq!(order.len(), 3);
    assert!(order.iter().all(|&i| i < 3));
    assert!(q.compute_next_index(q.current, true).is_some_and(|i| i < 3));
}

#[test]
fn reorder_keeps_the_playing_item_playing() {
    let mut q = queue_of(&["a", "b", "c", "d"], 1);
    q.reorder(1, 3);
    assert_eq!((ids(&q), q.current), (vec!["a", "c", "d", "b"], 3));
    let mut q = queue_of(&["a", "b", "c", "d"], 2);
    q.reorder(0, 3);
    assert_eq!((ids(&q), q.current), (vec!["b", "c", "d", "a"], 1));
    let mut q = queue_of(&["a", "b", "c", "d"], 1);
    q.reorder(3, 0);
    assert_eq!((ids(&q), q.current), (vec!["d", "a", "b", "c"], 2));
    q.reorder(2, 2);
    q.reorder(0, 9);
    assert_eq!(ids(&q), vec!["d", "a", "b", "c"]);
}

#[test]
fn play_with_something_playing_inserts_right_after_it() {
    let mut q = queue_of(&["a", "b", "c"], 0);
    let at = q.insert_after_current(track("x"));
    assert_eq!((at, ids(&q), q.current), (1, vec!["a", "x", "b", "c"], 1));
}

#[test]
fn play_with_nothing_playing_goes_first_and_replaces_a_queued_duplicate() {
    let mut q = queue_of(&["a", "b"], -1);
    q.insert_first(track("b"));
    assert_eq!((ids(&q), q.current), (vec!["b", "a"], 0));
    assert_eq!(q.items.len(), 2);
}

#[test]
fn shuffle_on_a_populated_queue_after_play_keeps_every_item_reachable() {
    let mut q = queue_of(&["a", "b", "c", "d"], -1);
    q.set_shuffle(true);
    q.insert_first(track("x"));
    let mut order = q.shuffle_order.clone().unwrap();
    assert_eq!(order[0], 0);
    order.sort();
    assert_eq!(order, vec![0, 1, 2, 3, 4]);
}

#[test]
fn enqueue_with_shuffle_on_places_the_track_after_the_playing_one() {
    let mut q = queue_of(&["a", "b", "c"], 0);
    q.set_shuffle(true);
    q.enqueue(track("d"), Some(5));
    let order = q.shuffle_order.clone().unwrap();
    assert_eq!(order.len(), 4);
    assert_eq!(order[0], 0, "the playing track stays first");
    assert!(order.contains(&3));
    assert_eq!(q.items[3].source_playlist_id, Some(5));
}

#[test]
fn enqueue_on_an_empty_queue_with_shuffle_on_still_builds_an_order() {
    let mut q = QueueState::new(3);
    q.set_shuffle(true);
    q.enqueue(track("a"), None);
    assert_eq!(q.shuffle_order, Some(vec![0]));
}

#[test]
fn mark_cached_updates_every_queued_copy() {
    let mut q = queue_of(&["a", "b"], 0);
    q.enqueue(track("a"), None);
    q.mark_cached("a");
    assert_eq!(q.items.iter().map(|i| i.track.is_cached).collect::<Vec<_>>(), vec![true, false, true]);
}

#[test]
fn clear_empties_everything() {
    let mut q = queue_of(&["a", "b"], 1);
    q.set_shuffle(true);
    q.clear();
    assert_eq!((q.items.len(), q.current, q.shuffle_order.clone()), (0, -1, None));
    assert!(q.shuffle_enabled, "clearing the queue keeps the shuffle switch");
}
