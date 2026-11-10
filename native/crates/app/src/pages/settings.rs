//! Settings page (`SettingsPage.tsx`): timer durations, sound, issue trackers, widget, time
//! tracking, music, data location and sync. This file holds the state and the actions; the
//! section layouts live in `settings_sections.rs`.

use super::settings_ui::*;
use super::PageEvent;
use gpui::*;
use lizmeter_core::{DataLocationInfo, DataLocationMoveErrorCode, DataLocationMoveInput, DataLocationMoveResult, RenumberStatus, StopwatchSettings, SyncNotice, SyncStatus, TimerSettings, MAX_DURATION};
use lizmeter_services::Services;
use lizmeter_ui::text_input::{TextField, TextFieldEvent};
use std::sync::Arc;
use std::time::Duration;

pub const SAVED_FLASH: Duration = Duration::from_secs(2);
const NO_LIMIT_DEFAULT_SECONDS: i64 = 28800;

/// Why the move to another folder waits for a second confirmation.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AdoptReason {
    ExistingData,
    SyncPeer,
    UnsyncedDb,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum JiraAuth {
    Cloud,
    Server,
}

/// One minutes/seconds pair of the timer durations.
pub struct DurationPair {
    pub mins: Entity<TextField>,
    pub secs: Entity<TextField>,
}

pub struct SettingsPage {
    pub svc: Arc<Services>,
    pub visible: bool,
    pub work: DurationPair,
    pub short: DurationPair,
    pub long: DurationPair,
    pub saving: bool,
    pub saved: bool,
    pub error: Option<String>,
    pub sound: bool,
    pub sw: StopwatchSettings,
    pub max_hours: Entity<TextField>,
    // Issue trackers
    pub prov: super::settings_providers::ProviderState,
    pub gh_token: Entity<TextField>,
    pub lin_key: Entity<TextField>,
    pub jira_auth: JiraAuth,
    pub jira_domain: Entity<TextField>,
    pub jira_email: Entity<TextField>,
    pub jira_token: Entity<TextField>,
    pub jira_project: Entity<TextField>,
    pub jira_jql: Entity<TextField>,
    // Widget
    pub widget_enabled: bool,
    pub widget_visibility: String,
    /// Bumped by every change the desktop widget has to apply (switch, visibility, reset, avatars).
    pub widget_rev: u64,
    /// The three Claude-status avatar previews (idle, thinking, working) and the scale they were made for.
    pub avatar_previews: [Option<crate::avatar::Avatar>; 3],
    avatar_scale: f32,
    // Music
    pub cache_limit_mb: i64,
    pub confirm_clear: bool,
    // Data location
    pub data: Option<DataLocationInfo>,
    pub moving: bool,
    pub data_error: Option<String>,
    pub pending_adopt: Option<(String, AdoptReason)>,
    pub pending_disconnect: Option<String>,
    // Sync
    pub sync: Option<SyncStatus>,
    pub notices: Vec<SyncNotice>,
    pub renumber_count: i64,
    pub renumber_confirming: bool,
    pub renumber_running: bool,
    pub renumber_result: Option<String>,
    pub sync_disabling: bool,
}

impl EventEmitter<PageEvent> for SettingsPage {}

fn field(single: bool, style: lizmeter_ui::text_input::FieldStyle, placeholder: &str, max: usize, window: &mut Window, cx: &mut App) -> Entity<TextField> {
    let placeholder = placeholder.to_string();
    cx.new(|cx| TextField::new(single, style, &placeholder, window, cx).with_max_len(max))
}

fn number_field(max: usize, right: bool, window: &mut Window, cx: &mut Context<SettingsPage>) -> Entity<TextField> {
    let f = cx.new(|cx| {
        let t = TextField::new(true, number_style(), "", window, cx).with_max_len(max);
        if right {
            t.with_right_align()
        } else {
            t
        }
    });
    cx.subscribe(&f, |_, f, ev: &TextFieldEvent, cx| {
        if matches!(ev, TextFieldEvent::Changed) {
            let text = f.read(cx).text().to_string();
            let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
            if digits != text {
                f.update(cx, |f, cx| f.set_text(&digits, cx));
            }
        }
    })
    .detach();
    f
}

fn secret(placeholder: &str, window: &mut Window, cx: &mut App) -> Entity<TextField> {
    let placeholder = placeholder.to_string();
    cx.new(|cx| TextField::new(true, token_style(), &placeholder, window, cx).with_mask())
}

fn plain(placeholder: &str, window: &mut Window, cx: &mut App) -> Entity<TextField> {
    field(true, token_style(), placeholder, 512, window, cx)
}

impl SettingsPage {
    pub fn new(svc: Arc<Services>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let pair = |window: &mut Window, cx: &mut Context<Self>| DurationPair { mins: number_field(3, true, window, cx), secs: number_field(2, true, window, cx) };
        let max_hours = cx.new(|cx| TextField::new(true, number_style(), "", window, cx).with_max_len(5).with_right_align());
        cx.subscribe(&max_hours, |this, f, ev: &TextFieldEvent, cx| {
            if matches!(ev, TextFieldEvent::Changed) {
                this.max_hours_typed(&f, cx);
            }
        })
        .detach();
        let mut page = Self {
            svc,
            visible: false,
            work: pair(window, cx),
            short: pair(window, cx),
            long: pair(window, cx),
            saving: false,
            saved: false,
            error: None,
            sound: true,
            sw: StopwatchSettings { max_duration_seconds: NO_LIMIT_DEFAULT_SECONDS, prompt_for_issue: true },
            max_hours,
            prov: Default::default(),
            gh_token: secret("ghp_\u{2026}", window, cx),
            lin_key: secret("lin_api_\u{2026}", window, cx),
            jira_auth: JiraAuth::Cloud,
            jira_domain: plain("mycompany.atlassian.net", window, cx),
            jira_email: plain("you@company.com", window, cx),
            jira_token: secret("API token", window, cx),
            jira_project: plain("PROJ", window, cx),
            jira_jql: plain("assignee = currentUser() AND status != Done", window, cx),
            widget_enabled: false,
            widget_visibility: "always".into(),
            widget_rev: 0,
            avatar_previews: [None, None, None],
            avatar_scale: window.scale_factor(),
            cache_limit_mb: 1024,
            confirm_clear: false,
            data: None,
            moving: false,
            data_error: None,
            pending_adopt: None,
            pending_disconnect: None,
            sync: None,
            notices: vec![],
            renumber_count: 0,
            renumber_confirming: false,
            renumber_running: false,
            renumber_result: None,
            sync_disabling: false,
        };
        page.start_sync_poll(cx);
        page
    }

    /// Loads everything the page shows; called each time the page opens.
    pub fn show(&mut self, sound: bool, sw: StopwatchSettings, cx: &mut Context<Self>) {
        self.visible = true;
        self.sound = sound;
        self.sw = sw;
        let ts = self.svc.get_settings().unwrap_or(lizmeter_core::DEFAULT_SETTINGS);
        for (pair, secs) in [(&self.work, ts.work_duration), (&self.short, ts.short_break_duration), (&self.long, ts.long_break_duration)] {
            pair.mins.update(cx, |f, cx| f.set_text(&(secs / 60).to_string(), cx));
            pair.secs.update(cx, |f, cx| f.set_text(&(secs % 60).to_string(), cx));
        }
        self.show_max_hours(cx);
        self.widget_enabled = self.svc.get_setting_value("widget_enabled").ok().flatten().as_deref() == Some("true");
        self.widget_visibility = self.svc.get_setting_value("widget_visibility").ok().flatten().unwrap_or_else(|| "always".into());
        self.load_avatar_previews();
        self.data = Some(self.svc.data_location_get());
        self.refresh_sync(cx);
        self.refresh_providers(cx);
        cx.notify();
    }

    pub fn hide(&mut self) {
        self.visible = false;
    }

    fn show_max_hours(&mut self, cx: &mut Context<Self>) {
        let text = if self.sw.max_duration_seconds == 0 { String::new() } else { hours_text(self.sw.max_duration_seconds) };
        self.max_hours.update(cx, |f, cx| f.set_text(&text, cx));
    }

    // --- Timer durations ---

    fn parse(pair: &DurationPair, cx: &App) -> Option<i64> {
        parse_duration(pair.mins.read(cx).text(), pair.secs.read(cx).text())
    }

    pub fn save(&mut self, cx: &mut Context<Self>) {
        let (w, s, l) = (Self::parse(&self.work, cx), Self::parse(&self.short, cx), Self::parse(&self.long, cx));
        let (Some(w), Some(s), Some(l)) = (w, s, l) else {
            self.error = Some("All durations must be at least 1 second, and seconds must be between 0 and 59.".into());
            cx.notify();
            return;
        };
        if w > MAX_DURATION || s > MAX_DURATION || l > MAX_DURATION {
            self.error = Some("Durations cannot exceed 2 hours.".into());
            cx.notify();
            return;
        }
        self.error = None;
        self.saved = false;
        let ts = TimerSettings { work_duration: w, short_break_duration: s, long_break_duration: l };
        match self.svc.save_settings(&ts) {
            Ok(()) => {
                self.saved = true;
                cx.emit(PageEvent::TimerSettings(ts));
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(SAVED_FLASH).await;
                    let _ = this.update(cx, |p, cx| {
                        p.saved = false;
                        cx.notify();
                    });
                })
                .detach();
            }
            Err(e) => self.error = Some(e.to_string()),
        }
        cx.notify();
    }

    pub fn set_sound(&mut self, on: bool, cx: &mut Context<Self>) {
        self.sound = on;
        let _ = self.svc.set_setting_value("notification_sound_enabled", Some(if on { "true" } else { "false" }));
        cx.emit(PageEvent::SoundEnabled(on));
        cx.notify();
    }

    // --- Time tracking ---

    fn max_hours_typed(&mut self, f: &Entity<TextField>, cx: &mut Context<Self>) {
        let text: String = f.read(cx).text().chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
        if let Ok(hours) = text.parse::<f64>() {
            if hours > 0.0 {
                self.sw.max_duration_seconds = (hours * 3600.0).round() as i64;
                cx.emit(PageEvent::StopwatchSettings(self.sw));
                if !text.ends_with('.') {
                    self.show_max_hours(cx);
                }
            }
        }
        cx.notify();
    }

    pub fn set_no_limit(&mut self, no_limit: bool, cx: &mut Context<Self>) {
        self.sw.max_duration_seconds = if no_limit { 0 } else { NO_LIMIT_DEFAULT_SECONDS };
        cx.emit(PageEvent::StopwatchSettings(self.sw));
        self.show_max_hours(cx);
        cx.notify();
    }

    pub fn set_prompt_for_issue(&mut self, on: bool, cx: &mut Context<Self>) {
        self.sw.prompt_for_issue = on;
        cx.emit(PageEvent::StopwatchSettings(self.sw));
        cx.notify();
    }

    // --- Widget ---

    pub fn set_widget_enabled(&mut self, on: bool, cx: &mut Context<Self>) {
        self.widget_enabled = on;
        let _ = self.svc.set_setting_value("widget_enabled", Some(if on { "true" } else { "false" }));
        self.widget_rev += 1;
        cx.notify();
    }

    pub fn set_widget_visibility(&mut self, v: &str, cx: &mut Context<Self>) {
        self.widget_visibility = v.to_string();
        let _ = self.svc.set_setting_value("widget_visibility", Some(v));
        self.widget_rev += 1;
        cx.notify();
    }

    pub fn reset_widget_position(&mut self, cx: &mut Context<Self>) {
        for key in ["widget_pos_x", "widget_pos_y"] {
            let _ = self.svc.set_setting_value(key, None);
        }
        self.widget_rev += 1;
        cx.notify();
    }

    fn load_avatar_previews(&mut self) {
        let files = self.svc.avatar_files();
        let scale = self.avatar_scale;
        let load = |p: &Option<String>| p.as_deref().and_then(|p| crate::avatar::load_preview(std::path::Path::new(p), scale));
        self.avatar_previews = [load(&files.idle), load(&files.thinking), load(&files.tool_use)];
    }

    /// Click on a slot: pick an image, copy it into the avatars folder and show it in the widget.
    pub fn upload_avatar(&mut self, slot: lizmeter_services::avatars::AvatarSlot, cx: &mut Context<Self>) {
        let title = format!("Select avatar for \"{}\" status", slot.name());
        let filters = [lizmeter_services::os::shell::FileFilter { name: "Images", extensions: &lizmeter_services::avatars::AVATAR_EXTENSIONS }];
        let Some(path) = lizmeter_services::os::shell::pick_file(&title, &filters) else { return };
        if let Err(e) = self.svc.set_avatar(slot, &path) {
            eprintln!("[widget] could not store the avatar: {e}");
            return;
        }
        self.load_avatar_previews();
        self.widget_rev += 1;
        cx.notify();
    }

    pub fn remove_avatar(&mut self, slot: lizmeter_services::avatars::AvatarSlot, cx: &mut Context<Self>) {
        let _ = self.svc.remove_avatar(slot);
        self.load_avatar_previews();
        self.widget_rev += 1;
        cx.notify();
    }

    // --- Issue trackers ---

    pub fn open_link(&self, url: &str) {
        self.svc.open_external(url);
    }

    // --- Data location ---

    pub fn choose_folder(&mut self, cx: &mut Context<Self>) {
        self.data_error = None;
        self.pending_adopt = None;
        self.pending_disconnect = None;
        if let Some(target) = self.svc.data_location_choose() {
            self.run_move(target, false, false, false, false, cx);
        }
    }

    pub fn reset_folder(&mut self, cx: &mut Context<Self>) {
        let Some(info) = &self.data else { return };
        let target = info.default_data_dir.clone();
        self.data_error = None;
        self.pending_adopt = None;
        self.pending_disconnect = None;
        self.run_move(target, false, false, false, false, cx);
    }

    /// Runs the move off the UI thread. A move that succeeds closes the database and relaunches
    /// the app, so the "Moving\u{2026}" state is left on.
    pub fn run_move(&mut self, target: String, use_existing: bool, confirm_disconnect: bool, confirm_adopt: bool, confirm_unsynced: bool, cx: &mut Context<Self>) {
        self.moving = true;
        self.data_error = None;
        cx.notify();
        let svc = self.svc.clone();
        let input = DataLocationMoveInput {
            target_dir: target.clone(),
            use_existing: Some(use_existing),
            confirm_disconnect_sync: Some(confirm_disconnect),
            confirm_adopt: Some(confirm_adopt),
            confirm_unsynced_db: Some(confirm_unsynced),
        };
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { svc.data_location_move(&input) }).await;
            let _ = this.update(cx, |p, cx| p.finish_move(&target, result.map_err(|e| e.to_string()), cx));
        })
        .detach();
    }

    fn finish_move(&mut self, target: &str, result: Result<DataLocationMoveResult, String>, cx: &mut Context<Self>) {
        match result {
            Ok(DataLocationMoveResult::Ok { .. }) => {
                self.pending_adopt = None;
                self.pending_disconnect = None;
                cx.emit(PageEvent::Relaunch);
                return;
            }
            Ok(DataLocationMoveResult::Err { code, message, .. }) => {
                if code != DataLocationMoveErrorCode::SyncEnabledConfirmRequired {
                    self.pending_disconnect = None;
                }
                self.refuse_move(target, code, message);
            }
            Ok(_) => {}
            Err(e) => {
                self.pending_adopt = None;
                self.data_error = Some(e);
            }
        }
        self.moving = false;
        cx.notify();
    }

    fn refuse_move(&mut self, target: &str, code: DataLocationMoveErrorCode, message: String) {
        match code {
                DataLocationMoveErrorCode::TargetHasData => self.pending_adopt = Some((target.to_string(), AdoptReason::ExistingData)),
                DataLocationMoveErrorCode::AdoptConfirmRequired => self.pending_adopt = Some((target.to_string(), AdoptReason::SyncPeer)),
                DataLocationMoveErrorCode::TargetHasUnsyncedDbConfirmRequired => self.pending_adopt = Some((target.to_string(), AdoptReason::UnsyncedDb)),
                DataLocationMoveErrorCode::SyncEnabledConfirmRequired => self.pending_disconnect = Some(target.to_string()),
                _ => {
                    self.pending_adopt = None;
                    self.data_error = Some(message);
                }
        }
    }

    // --- Sync ---

    pub fn refresh_sync(&mut self, cx: &mut Context<Self>) {
        self.sync = self.svc.sync_status().ok();
        self.notices = self.svc.sync_notices(false).unwrap_or_default();
        self.renumber_count = self.svc.sync_pending_renumber_count().unwrap_or(0);
        cx.notify();
    }

    /// Sync changes in the background with no user action, so the open page re-reads it every 15 s.
    fn start_sync_poll(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_secs(15)).await;
            if this.update(cx, |p, cx| if p.visible { p.refresh_sync(cx) }).is_err() {
                break;
            }
        })
        .detach();
    }

    pub fn disable_sync(&mut self, cx: &mut Context<Self>) {
        self.sync_disabling = true;
        let _ = self.svc.sync_disable();
        self.sync_disabling = false;
        self.refresh_sync(cx);
    }

    pub fn dismiss_notice(&mut self, id: i64, cx: &mut Context<Self>) {
        let _ = self.svc.sync_dismiss_notice(id);
        self.refresh_sync(cx);
    }

    pub fn renumber(&mut self, confirm: bool, cx: &mut Context<Self>) {
        if !confirm {
            self.renumber_confirming = true;
            cx.notify();
            return;
        }
        self.renumber_running = true;
        match self.svc.sync_renumber_legacy_ids(true) {
            Ok(o) => {
                self.renumber_result = Some(if o.status == RenumberStatus::Done {
                    format!("Renumbered {} todo{}.", o.count, if o.count == 1 { "" } else { "s" })
                } else {
                    "Nothing needed renumbering.".into()
                });
                self.renumber_confirming = false;
            }
            Err(e) => self.renumber_result = Some(e.to_string()),
        }
        self.renumber_running = false;
        self.refresh_sync(cx);
    }
}

/// `parseDuration` of `SettingsPage.tsx`: minutes and seconds fields to total seconds, at least 1.
pub fn parse_duration(minutes: &str, seconds: &str) -> Option<i64> {
    let part = |t: &str| -> Option<i64> {
        let t = t.trim();
        if t.is_empty() {
            Some(0)
        } else {
            t.parse().ok()
        }
    };
    let (m, s) = (part(minutes)?, part(seconds)?);
    if m < 0 || s < 0 || s > 59 {
        return None;
    }
    let total = m * 60 + s;
    (total >= 1).then_some(total)
}

/// `String(seconds / 3600)`: "8", "1.5".
pub fn hours_text(seconds: i64) -> String {
    let h = seconds as f64 / 3600.0;
    if h.fract() == 0.0 {
        format!("{}", h as i64)
    } else {
        format!("{h}")
    }
}

#[cfg(test)]
mod tests {
    use super::{hours_text, parse_duration};

    #[test]
    fn durations_follow_the_renderer_rules() {
        assert_eq!(parse_duration("25", "0"), Some(1500));
        assert_eq!(parse_duration("", "45"), Some(45));
        assert_eq!(parse_duration("0", "0"), None);
        assert_eq!(parse_duration("1", "60"), None);
        assert_eq!(parse_duration("x", "1"), None);
    }

    #[test]
    fn hours_read_like_a_js_number() {
        assert_eq!(hours_text(28800), "8");
        assert_eq!(hours_text(5400), "1.5");
        assert_eq!(hours_text(3600), "1");
    }
}
