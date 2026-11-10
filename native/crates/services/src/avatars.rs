//! Widget avatars (`widget:avatar-upload`, `widget:avatar-remove`, `widget:avatar-get-paths`):
//! one image per Claude session status, copied into `<data dir>/avatars/avatar-<slot><ext>`.

use crate::{Result, Services};
use lizmeter_core::{widget_settings_keys as keys, AvatarPaths};
use std::path::{Path, PathBuf};

/// The three avatar slots, in the order Settings lists them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AvatarSlot {
    Idle,
    Thinking,
    ToolUse,
}

impl AvatarSlot {
    pub const ALL: [AvatarSlot; 3] = [AvatarSlot::Idle, AvatarSlot::Thinking, AvatarSlot::ToolUse];

    /// The name in the file (`avatar-<name>.png`).
    pub fn name(self) -> &'static str {
        match self {
            AvatarSlot::Idle => "idle",
            AvatarSlot::Thinking => "thinking",
            AvatarSlot::ToolUse => "tool_use",
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            AvatarSlot::Idle => keys::AVATAR_IDLE,
            AvatarSlot::Thinking => keys::AVATAR_THINKING,
            AvatarSlot::ToolUse => keys::AVATAR_TOOL_USE,
        }
    }

    /// The caption Settings shows.
    pub fn label(self) -> &'static str {
        match self {
            AvatarSlot::Idle => "Idle",
            AvatarSlot::Thinking => "Thinking",
            AvatarSlot::ToolUse => "Working",
        }
    }
}

/// The file types the picker offers.
pub const AVATAR_EXTENSIONS: [&str; 4] = ["gif", "png", "webp", "apng"];

impl Services {
    /// The stored avatar file of every slot whose file still exists.
    pub fn avatar_files(&self) -> AvatarPaths {
        let get = |slot: AvatarSlot| {
            self.get_setting_value(slot.key()).ok().flatten().filter(|p| !p.is_empty() && Path::new(p).is_file())
        };
        AvatarPaths { idle: get(AvatarSlot::Idle), thinking: get(AvatarSlot::Thinking), tool_use: get(AvatarSlot::ToolUse) }
    }

    /// True when any avatar path is stored (it makes the widget 112 px tall instead of 80).
    pub fn has_any_avatar(&self) -> bool {
        AvatarSlot::ALL.iter().any(|s| self.get_setting_value(s.key()).ok().flatten().is_some_and(|p| !p.is_empty()))
    }

    /// Copies `src` into the avatars folder and stores its path. Returns the stored path.
    pub fn set_avatar(&self, slot: AvatarSlot, src: &Path) -> Result<PathBuf> {
        let dir = self.data_dir().join("avatars");
        std::fs::create_dir_all(&dir)?;
        let ext = src.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let dest = dir.join(format!("avatar-{}{}", slot.name(), ext));
        std::fs::copy(src, &dest)?;
        self.set_setting_value(slot.key(), Some(&dest.to_string_lossy()))?;
        Ok(dest)
    }

    /// Deletes the stored file and the setting.
    pub fn remove_avatar(&self, slot: AvatarSlot) -> Result<()> {
        if let Some(path) = self.get_setting_value(slot.key())? {
            let _ = std::fs::remove_file(&path);
        }
        self.set_setting_value(slot.key(), None)
    }
}
