//! The issue-tracker half of the Settings page (`SettingsPage.tsx`): saving, testing and removing
//! the GitHub, Linear and Jira credentials, and the Linear team choice. Every call that reaches a
//! tracker runs off the UI thread.

use super::settings::{JiraAuth, SettingsPage, SAVED_FLASH};
use gpui::*;
use lizmeter_core::{IssueProviderStatus, JiraAuthType, JiraProviderStatus, LinearProviderStatus, LinearTeam};
use lizmeter_services::tokens::Provider;

/// What one tracker's controls show besides its saved state.
#[derive(Default)]
pub struct Slot {
    pub saving: bool,
    pub saved: bool,
    pub testing: bool,
    pub error: Option<String>,
    /// `(ok, message)` of the last "Test Connection".
    pub test: Option<(bool, String)>,
}

#[derive(Default)]
pub struct ProviderState {
    pub status: Option<IssueProviderStatus>,
    pub linear: Option<LinearProviderStatus>,
    pub jira: Option<JiraProviderStatus>,
    /// Providers whose Electron token could not be carried over: their form asks for it again.
    pub reentry: Vec<Provider>,
    pub gh: Slot,
    pub lin: Slot,
    pub jira_slot: Slot,
    pub teams: Vec<LinearTeam>,
    pub teams_loading: bool,
    pub teams_error: Option<String>,
}

impl ProviderState {
    pub fn github_configured(&self) -> bool {
        self.status.as_ref().is_some_and(|s| s.configured)
    }

    pub fn linear_configured(&self) -> bool {
        self.linear.as_ref().is_some_and(|s| s.configured)
    }

    pub fn jira_configured(&self) -> bool {
        self.jira.as_ref().is_some_and(|s| s.configured)
    }

    pub fn needs_reentry(&self, p: Provider) -> bool {
        self.reentry.contains(&p)
    }
}

fn text_of(f: &Entity<lizmeter_ui::text_input::TextField>, cx: &App) -> String {
    f.read(cx).text().trim().to_string()
}

impl SettingsPage {
    /// Reads which trackers have credentials; called when the page opens and after every change.
    pub fn refresh_providers(&mut self, cx: &mut Context<Self>) {
        let svc = self.svc.clone();
        self.prov.status = svc.issue_provider_status().ok();
        self.prov.linear = svc.linear_provider_status().ok();
        self.prov.jira = svc.jira_provider_status().ok();
        self.prov.reentry = svc.tokens_needing_reentry();
        if self.prov.needs_reentry(Provider::Jira) && !self.prov.jira_configured() {
            // The domain, user name and auth type are settings, not secrets: they survived the migration.
            if let Some(a) = svc.get_setting_value("jira_auth_type").ok().flatten() {
                self.jira_auth = if a == "server" { JiraAuth::Server } else { JiraAuth::Cloud };
            }
            for (field, key) in [(&self.jira_domain, "jira_domain"), (&self.jira_email, "jira_email")] {
                if text_of(field, cx).is_empty() {
                    if let Some(v) = svc.get_setting_value(key).ok().flatten() {
                        field.update(cx, |f, cx| f.set_text(&v, cx));
                    }
                }
            }
        }
        cx.notify();
    }

    fn flash_saved(&mut self, which: Provider, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SAVED_FLASH).await;
            let _ = this.update(cx, |p, cx| {
                match which {
                    Provider::Github => p.prov.gh.saved = false,
                    Provider::Linear => p.prov.lin.saved = false,
                    Provider::Jira => p.prov.jira_slot.saved = false,
                }
                cx.notify();
            });
        })
        .detach();
    }

    // --- GitHub ---

    pub fn save_github(&mut self, cx: &mut Context<Self>) {
        let token = text_of(&self.gh_token, cx);
        if token.is_empty() {
            self.prov.gh.error = Some("Token cannot be empty.".into());
            cx.notify();
            return;
        }
        self.prov.gh = Slot { saving: true, ..Slot::default() };
        match self.svc.github_set_token(&token) {
            Ok(()) => {
                self.prov.gh = Slot { saved: true, ..Slot::default() };
                self.gh_token.update(cx, |f, cx| f.set_text("", cx));
                self.flash_saved(Provider::Github, cx);
            }
            Err(e) => self.prov.gh = Slot { error: Some(e.to_string()), ..Slot::default() },
        }
        self.refresh_providers(cx);
    }

    pub fn test_github(&mut self, cx: &mut Context<Self>) {
        self.prov.gh.testing = true;
        self.prov.gh.test = None;
        cx.notify();
        let svc = self.svc.clone();
        cx.spawn(async move |this, cx| {
            let r = cx.background_executor().spawn(async move { svc.github_test() }).await;
            let _ = this.update(cx, |p, cx| {
                p.prov.gh.testing = false;
                p.prov.gh.test = Some(match r {
                    Ok(u) => (true, format!("Connected as {u}")),
                    Err(e) => (false, e.to_string()),
                });
                cx.notify();
            });
        })
        .detach();
    }

    pub fn remove_github(&mut self, cx: &mut Context<Self>) {
        self.svc.github_delete_token();
        self.prov.gh = Slot::default();
        self.refresh_providers(cx);
    }

    // --- Linear ---

    pub fn save_linear(&mut self, cx: &mut Context<Self>) {
        let key = text_of(&self.lin_key, cx);
        if key.is_empty() {
            self.prov.lin.error = Some("API key cannot be empty.".into());
            cx.notify();
            return;
        }
        self.prov.lin = Slot { saving: true, ..Slot::default() };
        match self.svc.linear_set_token(&key) {
            Ok(()) => {
                self.prov.lin = Slot::default();
                self.lin_key.update(cx, |f, cx| f.set_text("", cx));
                self.refresh_providers(cx);
                self.test_linear(cx);
            }
            Err(e) => {
                self.prov.lin = Slot { error: Some(e.to_string()), ..Slot::default() };
                cx.notify();
            }
        }
    }

    /// "Test Connection": on success the teams load, and a workspace with one team picks it.
    pub fn test_linear(&mut self, cx: &mut Context<Self>) {
        self.prov.lin.testing = true;
        self.prov.lin.test = None;
        self.prov.teams_error = None;
        cx.notify();
        let svc = self.svc.clone();
        cx.spawn(async move |this, cx| {
            let r = cx.background_executor().spawn(async move { svc.linear_test() }).await;
            let ok = r.is_ok();
            let _ = this.update(cx, |p, cx| {
                p.prov.lin.testing = false;
                p.prov.lin.test = Some(match r {
                    Ok(name) => (true, format!("Connected as {name}")),
                    Err(e) => (false, e.to_string()),
                });
                cx.notify();
                if ok {
                    p.load_linear_teams(cx);
                }
            });
        })
        .detach();
    }

    pub fn load_linear_teams(&mut self, cx: &mut Context<Self>) {
        self.prov.teams_loading = true;
        self.prov.teams_error = None;
        cx.notify();
        let svc = self.svc.clone();
        cx.spawn(async move |this, cx| {
            let r = cx.background_executor().spawn(async move { svc.linear_teams() }).await;
            let _ = this.update(cx, |p, cx| {
                p.prov.teams_loading = false;
                match r {
                    Ok(teams) => {
                        let only = (teams.len() == 1).then(|| teams[0].clone());
                        p.prov.teams = teams;
                        if let Some(t) = only {
                            p.pick_linear_team(&t.id, &t.name, cx);
                        }
                    }
                    Err(e) => p.prov.teams_error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub fn pick_linear_team(&mut self, id: &str, name: &str, cx: &mut Context<Self>) {
        let _ = self.svc.linear_set_team(id, name);
        self.refresh_providers(cx);
    }

    pub fn disconnect_linear(&mut self, cx: &mut Context<Self>) {
        let _ = self.svc.linear_delete_token();
        self.prov.lin = Slot::default();
        self.prov.teams.clear();
        self.prov.teams_error = None;
        self.refresh_providers(cx);
    }

    // --- Jira ---

    pub fn save_jira(&mut self, cx: &mut Context<Self>) {
        let (domain, identity, secret) = (text_of(&self.jira_domain, cx), text_of(&self.jira_email, cx), text_of(&self.jira_token, cx));
        if domain.is_empty() || identity.is_empty() || secret.is_empty() {
            self.prov.jira_slot.error = Some(
                match self.jira_auth {
                    JiraAuth::Cloud => "Domain, email, and API token are all required.",
                    JiraAuth::Server => "Server URL, username, and password are all required.",
                }
                .into(),
            );
            cx.notify();
            return;
        }
        let (project, jql) = (text_of(&self.jira_project, cx), text_of(&self.jira_jql, cx));
        let auth = if self.jira_auth == JiraAuth::Server { JiraAuthType::Server } else { JiraAuthType::Cloud };
        let svc = self.svc.clone();
        let saved = (|| {
            svc.jira_set_auth_type(auth)?;
            svc.jira_set_domain(&domain)?;
            svc.jira_set_email(&identity)?;
            svc.jira_set_token(&secret)?;
            if !project.is_empty() {
                svc.jira_set_project_key(&project)?;
            }
            if !jql.is_empty() {
                svc.jira_set_jql_filter(&jql)?;
            }
            Ok::<(), lizmeter_services::ServiceError>(())
        })();
        match saved {
            Ok(()) => {
                self.prov.jira_slot = Slot::default();
                self.jira_token.update(cx, |f, cx| f.set_text("", cx));
                self.refresh_providers(cx);
                self.test_jira(cx);
            }
            Err(e) => {
                self.prov.jira_slot = Slot { error: Some(e.to_string()), ..Slot::default() };
                cx.notify();
            }
        }
    }

    pub fn test_jira(&mut self, cx: &mut Context<Self>) {
        self.prov.jira_slot.testing = true;
        self.prov.jira_slot.test = None;
        cx.notify();
        let svc = self.svc.clone();
        cx.spawn(async move |this, cx| {
            let r = cx.background_executor().spawn(async move { svc.jira_test() }).await;
            let _ = this.update(cx, |p, cx| {
                p.prov.jira_slot.testing = false;
                p.prov.jira_slot.test = Some(match r {
                    Ok(name) => (true, format!("Connected as {name}")),
                    Err(e) => (false, e.to_string()),
                });
                cx.notify();
            });
        })
        .detach();
    }

    pub fn disconnect_jira(&mut self, cx: &mut Context<Self>) {
        let _ = self.svc.jira_delete_token();
        self.prov.jira_slot = Slot::default();
        self.jira_auth = JiraAuth::Cloud;
        for f in [&self.jira_domain, &self.jira_email, &self.jira_project, &self.jira_jql] {
            f.update(cx, |f, cx| f.set_text("", cx));
        }
        self.refresh_providers(cx);
    }

    /// Capture hooks (`--do settings-<op>`): drive the same actions the buttons do, with the values
    /// the op carries (`gh=<token>`, `lin=<key>`, `jira=<cloud|server>;<domain>;<user>;<secret>`,
    /// `gh-test`, `lin-test`, `jira-test`, `gh-remove`, `lin-team=<index>`).
    pub fn capture(&mut self, op: &str, cx: &mut Context<Self>) {
        let (name, value) = op.split_once('=').unwrap_or((op, ""));
        match name {
            "gh" => {
                self.gh_token.update(cx, |f, cx| f.set_text(value, cx));
                self.save_github(cx);
            }
            "gh-test" => self.test_github(cx),
            "gh-remove" => self.remove_github(cx),
            "lin" => {
                self.lin_key.update(cx, |f, cx| f.set_text(value, cx));
                self.save_linear(cx);
            }
            "lin-test" => self.test_linear(cx),
            "lin-set-team" => {
                if let Some((id, name)) = value.split_once(';') {
                    self.pick_linear_team(id, name, cx);
                }
            }
            "lin-team" => {
                if let Some(t) = value.parse::<usize>().ok().and_then(|i| self.prov.teams.get(i).cloned()) {
                    self.pick_linear_team(&t.id, &t.name, cx);
                }
            }
            "jira" => {
                let parts: Vec<&str> = value.split(';').collect();
                if let [kind, domain, user, secret] = parts[..] {
                    self.jira_auth = if kind == "server" { JiraAuth::Server } else { JiraAuth::Cloud };
                    for (f, v) in [(&self.jira_domain, domain), (&self.jira_email, user), (&self.jira_token, secret)] {
                        f.update(cx, |f, cx| f.set_text(v, cx));
                    }
                    self.save_jira(cx);
                }
            }
            "jira-test" => self.test_jira(cx),
            "jira-form" => {
                self.jira_auth = if value == "server" { JiraAuth::Server } else { JiraAuth::Cloud };
                cx.notify();
            }
            _ => {}
        }
    }
}
