//! The section layouts of the Settings page.

use super::settings::*;
use super::settings_ui::*;
use crate::controls::*;
use crate::css::hex;
use crate::fmt::local;
use crate::ui::*;
use chrono::{Datelike, Timelike};
use gpui::*;
use lizmeter_ui::text_input::TextField;

fn focused(f: &Entity<TextField>, window: &Window, cx: &App) -> bool {
    f.read(cx).focus_handle().is_focused(window)
}

fn number_box(f: &Entity<TextField>, width: f32, window: &Window, cx: &App) -> Div {
    glass_field(f, focused(f, window, cx), 12.0, 10.0).pr(px(27.0)).w(px(width)).flex_shrink_0()
}

fn unit(text: &str) -> Div {
    ui_text(13.0).text_color(col(TN_TEXT_DIM)).child(text.to_string())
}

fn when_text(iso: &str) -> String {
    local(iso).map(|d| crate::locale::date_time(d.year(), d.month(), d.day(), d.hour(), d.minute(), d.second())).unwrap_or_default()
}

fn mb_text(bytes: f64) -> String {
    format!("{:.1}", bytes / (1024.0 * 1024.0))
}

fn link(id: &'static str, text: &str, url: &'static str, me: &Entity<SettingsPage>) -> Stateful<Div> {
    let me = me.clone();
    div().id(id).text_color(col(TN_BLUE)).cursor_pointer().hover(|s| s.underline()).on_click(move |_, _, a| me.update(a, |p, _| p.open_link(url))).child(text.to_string())
}

fn hint_row(children: Vec<AnyElement>) -> Div {
    let mut row = hint().flex().flex_row().flex_wrap().items_center();
    for c in children {
        row = row.child(c);
    }
    row
}

fn t(text: &str) -> AnyElement {
    div().child(text.to_string()).into_any_element()
}

impl SettingsPage {
    fn duration_row(&self, title: &str, pair: &DurationPair, window: &Window, cx: &App) -> Div {
        field_row(
            label(title),
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(16.0))
                .child(div().flex().flex_row().items_center().gap(px(8.0)).child(number_box(&pair.mins, 80.0, window, cx)).child(unit("min")))
                .child(div().flex().flex_row().items_center().gap(px(8.0)).child(number_box(&pair.secs, 64.0, window, cx)).child(unit("sec"))),
        )
    }

    fn timer_section(&mut self, window: &Window, cx: &mut Context<Self>) -> Div {
        let me = cx.entity();
        let (m_save, m_sound) = (me.clone(), me.clone());
        let sound = self.sound;
        let mut s = div()
            .flex()
            .flex_col()
            .child(self.duration_row("Work Duration", &self.work, window, cx))
            .child(self.duration_row("Short Break", &self.short, window, cx))
            .child(self.duration_row("Long Break", &self.long, window, cx));
        if let Some(e) = &self.error {
            s = s.child(error_text(e.clone()));
        }
        let text = if self.saving {
            "Saving\u{2026}"
        } else if self.saved {
            "Saved \u{2713}"
        } else {
            "Save Settings"
        };
        s.child(div().flex().flex_row().child(save_button("save-settings", text, !self.saving, move |_, a| m_save.update(a, |p, cx| p.save(cx)))))
            .child(div().mt(px(16.0)).child(checkbox("sound", sound, "Play sound when timer completes", move |_, a| m_sound.update(a, |p, cx| p.set_sound(!sound, cx)))))
    }

    fn token_form(&self, title: &str, hint_row_el: Div, field: &Entity<TextField>, msg: &Option<String>, button: &str, id: &'static str, on_save: impl Fn(&mut Window, &mut App) + 'static, window: &Window, cx: &App) -> Div {
        let mut f = div().flex().flex_col().gap(px(8.0)).child(label(title)).child(hint_row_el).child(token_frame(field, focused(field, window, cx)));
        if let Some(m) = msg {
            f = f.child(error_text(m.clone()));
        }
        f.child(save_button(id, button, true, on_save))
    }

    fn github_section(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let me = cx.entity();
        let m_save = me.clone();
        let hint = hint_row(vec![t("Needs\u{a0}"), code("repo"), t("\u{a0}scope.\u{a0}"), link("gh-link", "Create token \u{2197}", "https://github.com/settings/tokens", &me).into_any_element()]);
        section("Issue Tracker", true).child(self.token_form("GitHub Personal Access Token", hint, &self.gh_token, &self.gh_msg, "Save Token", "gh-save", move |_, a| m_save.update(a, |p, cx| p.save_github(cx)), window, cx))
    }

    fn linear_section(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let me = cx.entity();
        let m_save = me.clone();
        let hint = hint_row(vec![t("Generate at\u{a0}"), link("lin-link", "Settings > Account > API in Linear \u{2197}", "https://linear.app/settings/api", &me).into_any_element()]);
        section("Linear", true).child(self.token_form("Linear API Key", hint, &self.lin_key, &self.lin_msg, "Save Key", "lin-save", move |_, a| m_save.update(a, |p, cx| p.save_linear(cx)), window, cx))
    }

    fn jira_section(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let me = cx.entity();
        let cloud = self.jira_auth == JiraAuth::Cloud;
        let m_pick = me.clone();
        let m_save = me.clone();
        let seg = segmented("jira-auth", &[("Cloud".to_string(), cloud), ("Server / Data Center".to_string(), !cloud)], move |i, _, a| {
            m_pick.update(a, |p, cx| {
                p.jira_auth = if i == 0 { JiraAuth::Cloud } else { JiraAuth::Server };
                cx.notify();
            })
        });
        let input = |f: &Entity<TextField>| token_frame(f, focused(f, window, cx));
        let lbl = |text: &str, top: f32| label(text).mt(px(top));
        let mut form = div().flex().flex_col().gap(px(8.0)).child(seg);
        if cloud {
            form = form
                .child(label("Atlassian Domain"))
                .child(hint_row(vec![t("e.g.\u{a0}"), code("mycompany.atlassian.net")]))
                .child(input(&self.jira_domain))
                .child(lbl("Email", 12.0))
                .child(input(&self.jira_email))
                .child(lbl("API Token", 12.0))
                .child(hint_row(vec![t("Generate at\u{a0}"), link("jira-link", "Atlassian API tokens \u{2197}", "https://id.atlassian.com/manage-profile/security/api-tokens", &me).into_any_element()]))
                .child(input(&self.jira_token));
        } else {
            form = form
                .child(label("Server URL"))
                .child(hint_row(vec![t("e.g.\u{a0}"), code("jira.mycompany.com"), t("\u{a0}or\u{a0}"), code("jira.mycompany.com:8080")]))
                .child(input(&self.jira_domain))
                .child(lbl("Username", 12.0))
                .child(input(&self.jira_email))
                .child(lbl("Password", 12.0))
                .child(input(&self.jira_token));
        }
        form = form
            .child(lbl("Project Key (optional)", 12.0))
            .child(hint_row(vec![t("e.g.\u{a0}"), code("PROJ"), t("\u{a0}\u{2014} leave empty to show issues assigned to you")]))
            .child(input(&self.jira_project))
            .child(lbl("JQL Filter (optional)", 12.0))
            .child(hint().child("Custom JQL overrides the project key filter"))
            .child(input(&self.jira_jql));
        if let Some(m) = &self.jira_msg {
            form = form.child(error_text(m.clone()));
        }
        section("Jira", true).child(form.child(save_button("jira-save", "Save & Connect", true, move |_, a| m_save.update(a, |p, cx| p.save_jira(cx)))))
    }

    fn widget_section(&self, cx: &mut Context<Self>) -> Div {
        let me = cx.entity();
        let enabled = self.widget_enabled;
        let m_en = me.clone();
        let mut s = section("Desktop Widget", true).child(checkbox("widget-enable", enabled, "Enable Widget", move |_, a| m_en.update(a, |p, cx| p.set_widget_enabled(!enabled, cx))));
        if enabled {
            let m_vis = me.clone();
            let m_reset = me.clone();
            let always = self.widget_visibility == "always";
            s = s
                .child(label("Visibility").mt(px(16.0)))
                .child(
                    div().mt(px(8.0)).child(segmented("widget-vis", &[("Always visible".to_string(), always), ("When active".to_string(), !always)], move |i, _, a| {
                        m_vis.update(a, |p, cx| p.set_widget_visibility(if i == 0 { "always" } else { "when-active" }, cx))
                    })),
                )
                .child(div().mt(px(12.0)).flex().flex_row().child(ghost_button("widget-reset", "Reset Position", TN_BLUE, true, move |_, a| m_reset.update(a, |p, cx| p.reset_widget_position(cx)))))
                .child(label("Avatar").mt(px(16.0)))
                .child(hint().child("Upload GIF/PNG for each Claude session status. Pixel art auto-scales crispy."));
            let mut grid = div().mt(px(12.0)).flex().flex_row().gap(px(12.0));
            for name in ["Idle", "Thinking", "Working"] {
                grid = grid.child(
                    div().flex().flex_col().items_center().gap(px(6.0)).child(ui_text(11.0).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT_DIM)).child(name)).child(
                        div()
                            .size(px(64.0))
                            .rounded(px(8.0))
                            .border(px(1.0))
                            .border_dashed()
                            .border_color(col(crate::css::rgba(122, 162, 247, 0.25)))
                            .bg(col(crate::css::rgba(12, 13, 24, 0.55)))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px(20.0))
                            .text_color(col(ICON_DIM))
                            .child("+"),
                    ),
                );
            }
            s = s.child(grid);
        }
        s
    }

    fn time_tracking_section(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let me = cx.entity();
        let (m_limit, m_prompt) = (me.clone(), me.clone());
        let no_limit = self.sw.max_duration_seconds == 0;
        let prompt = self.sw.prompt_for_issue;
        self.max_hours.update(cx, |f, cx| f.set_disabled(no_limit, cx));
        let mut input = number_box(&self.max_hours, 80.0, window, cx);
        if no_limit {
            input = input.opacity(0.5);
        }
        section("Time Tracking", true)
            .child(field_row(label("Max Duration"), div().flex().flex_row().items_center().gap(px(8.0)).child(input).child(unit("hours"))))
            .child(checkbox("sw-nolimit", no_limit, "No limit", move |_, a| m_limit.update(a, |p, cx| p.set_no_limit(!no_limit, cx))))
            .child(div().mt(px(12.0)).child(checkbox("sw-prompt", prompt, "Prompt to link issue when starting", move |_, a| m_prompt.update(a, |p, cx| p.set_prompt_for_issue(!prompt, cx)))))
    }

    fn music_section(&self, cx: &mut Context<Self>) -> Div {
        let me = cx.entity();
        let m_pick = me.clone();
        let limits = [500i64, 1024, 2048, 5120];
        let items: Vec<(String, bool)> = limits.iter().map(|mb| (if *mb >= 1024 { format!("{} GB", mb / 1024) } else { format!("{mb} MB") }, *mb == self.cache_limit_mb)).collect();
        let seg = div().mt(px(8.0)).w(px(214.0)).child(segmented("cache-limit", &items, move |i, _, a| {
            m_pick.update(a, |p, cx| {
                p.cache_limit_mb = limits[i];
                cx.notify();
            })
        }));
        let bin = self.svc.data_dir().join("bin").to_string_lossy().into_owned();
        section("Music", true)
            .child(field_row(label_lines(&["Cache Size", "Limit"]), seg))
            .child(field_row(label("Current Cache Usage"), hint().mt(px(6.0)).child(format!("{} MB used ({} tracks cached)", mb_text(0.0), 0))))
            .child(div().mt(px(8.0)).flex().flex_row().child(ghost_button("cache-clear", "Clear Cache", TN_BLUE, false, |_, _| {})))
            .child(div().mt(px(16.0)).child(field_row(label("yt-dlp Version"), hint().mt(px(6.0)).child("Not installed"))))
            .child(path_stack("Binary Storage Path", &bin))
    }

    fn data_section(&self, cx: &mut Context<Self>) -> Div {
        let me = cx.entity();
        let mut s = section("Data Location", true);
        let Some(info) = &self.data else { return s };
        let sync_on = self.sync.as_ref().is_some_and(|x| x.enabled);
        let kind = if info.is_custom { "(custom)" } else { "(default)" };
        s = s.child(path_stack(&format!("Current Folder {kind}"), &info.data_dir));
        if !info.available {
            s = s.child(error_text("This folder is not reachable right now."));
        }
        s = s.child(hint().mr(px(-4.0)).child(if sync_on {
            "LizMeter keeps the attachments folder and the shared sync history here. Choosing a new folder copies the attachments, then restarts the app \u{2014} the database itself lives privately on this machine and never moves with it. Avatars, saved tokens and the music cache do not move either."
        } else {
            "LizMeter keeps lizmeter.db and the attachments folder here. Choosing a new folder copies both, then restarts the app. The old copy is left where it is \u{2014} delete it yourself once you have checked the move. Avatars, saved tokens and the music cache do not move."
        }));
        let moving = self.moving;
        if let Some(dir) = self.pending_disconnect.clone() {
            let (m_go, m_cancel) = (me.clone(), me.clone());
            let d = dir.clone();
            s = s.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(error_text("This will disconnect this machine from sync."))
                    .child(hint().child(format!("{dir} does not hold the other machine\u{2019}s sync history, so this machine will stop seeing its changes (and vice versa) until both are pointed at the same folder again. This machine\u{2019}s own database is untouched either way \u{2014} only the attachments folder moves.")))
                    .child(
                        action_row()
                            .child(row_save_button("move-disconnect", if moving { "Moving\u{2026}" } else { "Move and Disconnect Sync" }, !moving, move |_, a| m_go.update(a, |p, cx| p.run_move(d.clone(), false, true, false, false, cx))))
                            .child(row_ghost_button("move-cancel", "Cancel", TN_BLUE, !moving, move |_, a| {
                                m_cancel.update(a, |p, cx| {
                                    p.pending_disconnect = None;
                                    cx.notify();
                                })
                            })),
                    ),
            );
        } else if let Some((dir, reason)) = self.pending_adopt.clone() {
            let (m_go, m_cancel) = (me.clone(), me.clone());
            let d = dir.clone();
            let head = match reason {
                AdoptReason::SyncPeer => "That folder holds another machine's synced data.",
                AdoptReason::UnsyncedDb => "That folder already holds a LizMeter database, but no other machine has synced through it yet.",
                AdoptReason::ExistingData => "That folder already holds a LizMeter database.",
            };
            let body = match reason {
                AdoptReason::SyncPeer => "Using it here adopts that machine\u{2019}s todos and sessions as this machine\u{2019}s own working set \u{2014} this machine will show that data, and this machine\u{2019}s current database stays on disk, untouched, as a backup. This is one-way: there is no button in LizMeter to switch this machine back to its own database afterward.".to_string(),
                AdoptReason::UnsyncedDb => format!("Continuing turns sync on and publishes this machine\u{2019}s own data instead \u{2014} the database already in {dir} will not be read by sync and is left on disk, unused but untouched. Cancel and pick an empty folder instead if you meant to keep using the data already there."),
                AdoptReason::ExistingData => format!("Open the data already in {dir}, or cancel and pick an empty folder. Nothing is copied either way, and the data in the current folder is left untouched."),
            };
            let go = match (moving, reason) {
                (true, AdoptReason::UnsyncedDb) => "Enabling\u{2026}",
                (true, _) => "Switching\u{2026}",
                (false, AdoptReason::UnsyncedDb) => "Enable Sync Anyway",
                (false, _) => "Use the Data There",
            };
            s = s.child(
                div().flex().flex_col().gap(px(8.0)).child(error_text(head)).child(hint().child(body)).child(
                    action_row()
                        .child(row_save_button("adopt-go", go, !moving, move |_, a| {
                            m_go.update(a, |p, cx| p.run_move(d.clone(), reason == AdoptReason::ExistingData, false, reason == AdoptReason::SyncPeer, reason == AdoptReason::UnsyncedDb, cx))
                        }))
                        .child(row_ghost_button("adopt-cancel", "Cancel", TN_BLUE, !moving, move |_, a| {
                            m_cancel.update(a, |p, cx| {
                                p.pending_adopt = None;
                                cx.notify();
                            })
                        })),
                ),
            );
        } else {
            let (m_choose, m_open, m_reset) = (me.clone(), me.clone(), me.clone());
            let mut row = action_row().flex_wrap().child(row_save_button("choose-folder", if moving { "Moving\u{2026}" } else { "Change Folder\u{2026}" }, !moving, move |_, a| m_choose.update(a, |p, cx| p.choose_folder(cx))));
            row = row.child(row_ghost_button("open-folder", "Open Folder", TN_BLUE, info.available, move |_, a| m_open.update(a, |p, _| p.svc.data_location_reveal())));
            if info.is_custom {
                row = row.child(row_ghost_button("reset-folder", "Reset to Default", TN_RED, !moving, move |_, a| m_reset.update(a, |p, cx| p.reset_folder(cx))));
            }
            s = s.child(row);
        }
        if let Some(e) = &self.data_error {
            s = s.child(error_text(e.clone()));
        }
        s
    }

    fn sync_section(&self, cx: &mut Context<Self>) -> Div {
        let me = cx.entity();
        let mut s = section("Sync", true);
        let Some(st) = self.sync.as_ref().filter(|x| x.enabled) else {
            return s.child(hint().mr(px(-4.0)).child("Sync is off. Point the data folder above at a shared cloud-drive folder to turn it on \u{2014} the same Change Folder button, no separate step. LizMeter will publish this machine\u{2019}s data there, and a second machine pointed at the same folder will offer to adopt it."));
        };
        let status = if st.halted.is_some() {
            "Paused \u{2014} see details below".to_string()
        } else if let Some(at) = &st.last_synced_at {
            format!("Last synced {}", when_text(at))
        } else {
            "Waiting for the first sync pass".into()
        };
        let mut status_el = div().flex().flex_col().child(hint().mt(px(6.0)).child(status));
        if let Some(h) = &st.halted {
            status_el = status_el.child(error_text(h.reason.clone()));
        }
        s = s.child(field_row(label("Status"), status_el));
        if !st.devices.is_empty() {
            let list = st.devices.iter().map(|d| format!("#{} (last seen {})", d.device_number, when_text(&d.last_seen_at))).collect::<Vec<_>>().join(", ");
            s = s.child(field_row(label("Machines"), hint().mt(px(6.0)).max_w(px(190.0)).child(list)));
        }
        if !self.notices.is_empty() {
            let mut stack = div().flex().flex_col().gap(px(8.0)).mb(px(16.0)).child(label("Recent automatic resolutions"));
            for n in &self.notices {
                let (m, id) = (me.clone(), n.id);
                let mut card = div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap(px(6.0))
                    .px(px(12.0))
                    .py(px(10.0))
                    .rounded(px(8.0))
                    .bg(col(TN_SURFACE))
                    .border(px(1.0))
                    .border_color(col(hex(0x292e42)))
                    .child(ui_text(12.0).line_height(px(18.0)).text_color(col(TN_TEXT)).child(n.message.clone()));
                if let Some(d) = &n.detail {
                    card = card.child(ui_text(11.0).line_height(px(16.5)).text_color(col(TN_MUTED)).child(d.clone()));
                }
                stack = stack.child(card.child(ghost_button(SharedString::from(format!("notice-{id}")), "Dismiss", TN_BLUE, true, move |_, a| m.update(a, |p, cx| p.dismiss_notice(id, cx)))));
            }
            s = s.child(stack);
        }
        if self.renumber_count > 0 {
            let n = self.renumber_count;
            let mut stack = div().flex().flex_col().gap(px(8.0)).mb(px(16.0)).child(label("Todo numbers")).child(hint().child(format!(
                "{n} todo{} left over from an older version. Renumbering folds them into the normal sequence. Todos that already have short numbers keep them.",
                if n == 1 { " has a very long number" } else { "s have very long numbers" }
            )));
            let running = self.renumber_running;
            if self.renumber_confirming {
                let (m_go, m_cancel) = (me.clone(), me.clone());
                stack = stack.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .child(error_text("Update your other machines first."))
                        .child(hint().child("A machine still running the older version keeps handing out long numbers, so this would need running again afterwards. The new numbers replace the old ones everywhere \u{2014} anything you wrote down that refers to a long number will no longer match. A backup is saved first."))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .gap(px(8.0))
                                .mt(px(8.0))
                                .child(save_button("renumber-go", if running { "Renumbering\u{2026}" } else { "Renumber Todos" }, !running, move |_, a| m_go.update(a, |p, cx| p.renumber(true, cx))))
                                .child(ghost_button("renumber-cancel", "Cancel", TN_BLUE, !running, move |_, a| {
                                    m_cancel.update(a, |p, cx| {
                                        p.renumber_confirming = false;
                                        cx.notify();
                                    })
                                })),
                        ),
                );
            } else {
                let m = me.clone();
                stack = stack.child(div().flex().flex_row().child(ghost_button("renumber", "Renumber Todos\u{2026}", TN_BLUE, true, move |_, a| m.update(a, |p, cx| p.renumber(false, cx)))));
            }
            s = s.child(stack);
        }
        if let Some(r) = &self.renumber_result {
            s = s.child(hint().mt(px(6.0)).child(r.clone()));
        }
        let m = me.clone();
        s.child(div().mt(px(8.0)).flex().flex_row().child(ghost_button("sync-off", if self.sync_disabling { "Turning off\u{2026}" } else { "Turn Off Sync" }, TN_RED, !self.sync_disabling, move |_, a| m.update(a, |p, cx| p.disable_sync(cx)))))
    }
}

impl Render for SettingsPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body = div()
            .flex()
            .flex_col()
            .child(page_heading("Settings").mt(px(8.7)).mb(px(28.0)))
            .child(self.timer_section(window, cx))
            .child(self.github_section(window, cx))
            .child(self.linear_section(window, cx))
            .child(self.jira_section(window, cx))
            .child(self.widget_section(cx))
            .child(self.time_tracking_section(window, cx))
            .child(self.music_section(cx))
            .child(self.data_section(cx))
            .child(self.sync_section(cx))
            .child(div().h(px(1.0)));
        page_shell("settings-page", 400.0, body)
    }
}
