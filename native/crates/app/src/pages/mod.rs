//! The pages of the main window that run on real services.

pub mod history;
pub mod stats;
pub mod tags;
pub mod stats_data;

use lizmeter_core::{Session, StopwatchSettings, TimerSettings};

/// What a page tells the main window.
pub enum PageEvent {
    /// History's Resume button.
    Resume(Session),
    /// The session list changed (delete, tag edit); other pages reload on next show.
    SessionsChanged,
    /// Settings saved new timer durations.
    TimerSettings(TimerSettings),
    SoundEnabled(bool),
    StopwatchSettings(StopwatchSettings),
    /// A todo-linked badge was clicked.
    OpenTodo(i64),
}
