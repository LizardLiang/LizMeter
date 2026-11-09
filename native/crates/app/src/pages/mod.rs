//! The pages of the main window that run on real services.

pub mod activity;
pub mod claude;
pub mod history;
pub mod settings;
pub mod settings_sections;
pub mod settings_ui;
pub mod stats;
pub mod tags;
pub mod todos;
pub mod todos_icons;
pub mod todos_logic;
pub mod todo_attachments;
pub mod todo_manage;
pub mod todo_picker;
pub mod todo_tree;
pub mod todo_widgets;
pub mod todos_menus;
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
    /// A data-folder move finished: the app restarts on the new folder.
    Relaunch,
}
