//! lizmeter-music: the music backend. Port of `electron/main/music/*` plus native playback.

pub mod binaries;
pub mod error;
pub mod process;

pub use error::{MusicError, Result};
