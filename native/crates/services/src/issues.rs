//! The issue-provider calls the pages make: GitHub, Linear and Jira issue lists, their comments,
//! token and credential settings, connection tests and the Jira worklog. They are the bodies of the
//! `issues:*`, `linear:*`, `jira:*` and `worklog:log` channels of `ipc-handlers.ts`.
//!
//! Every call that reaches a tracker blocks on the network: callers run them off the UI thread.

use crate::error::{fail, Result};
use crate::providers::github::GitHub;
use crate::providers::jira::{normalize_domain, Jira};
use crate::providers::linear::Linear;
use crate::providers::{client, Code, Endpoints, ProviderError};
use crate::tokens::{migrate, MigrationState, Provider, Secret, TokenStore};
use crate::worklog_merge::{is_uploadable, iso_from_ms, parse_ms, summarize};
use crate::{lock, Services};
use lizmeter_core::{
    Issue, IssueComment, IssueProviderKind, IssueProviderStatus, IssuesListInput, JiraAuthType, JiraIssue, JiraProviderStatus, LinearIssue, LinearProviderStatus,
    LinearTeam, WorklogLogInput, WorklogLogResult, WorklogStatus,
};
use reqwest::blocking::Client;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// Tokens, endpoints, the HTTP client and the per-provider result caches.
pub(crate) struct Hub {
    pub(crate) tokens: TokenStore,
    endpoints: Mutex<Endpoints>,
    http: OnceLock<Client>,
    github_issues: Mutex<HashMap<String, Vec<Issue>>>,
    github_user: Mutex<Option<String>>,
    linear_issues: Mutex<HashMap<String, Vec<LinearIssue>>>,
    jira_issues: Mutex<HashMap<String, Vec<JiraIssue>>>,
}

impl Hub {
    pub(crate) fn new(user_data: &Path) -> Self {
        Hub {
            tokens: TokenStore::new(user_data),
            endpoints: Mutex::new(Endpoints::from_env()),
            http: OnceLock::new(),
            github_issues: Mutex::default(),
            github_user: Mutex::default(),
            linear_issues: Mutex::default(),
            jira_issues: Mutex::default(),
        }
    }

    fn http(&self) -> &Client {
        self.http.get_or_init(client)
    }

    fn endpoints(&self) -> Endpoints {
        lock(&self.endpoints).clone()
    }

    fn clear_caches(&self) {
        lock(&self.github_issues).clear();
        *lock(&self.github_user) = None;
        lock(&self.linear_issues).clear();
        lock(&self.jira_issues).clear();
    }
}

fn require_token(token: &str, what: &str) -> Result<String> {
    let t = token.trim();
    if t.is_empty() {
        return fail(format!("{what} cannot be empty"));
    }
    Ok(t.to_string())
}

fn no_token(what: &str) -> ProviderError {
    ProviderError::new(Code::NoToken, format!("No {what} configured"))
}

/// The settings a Jira client is built from.
struct JiraConfig {
    domain: String,
    identity: String,
    secret: Secret,
    auth_type: JiraAuthType,
}

fn parse_auth_type(v: Option<&str>) -> JiraAuthType {
    if v == Some("server") {
        JiraAuthType::Server
    } else {
        JiraAuthType::Cloud
    }
}

impl Services {
    /// Replaces the API hosts. Tests point the providers at a local mock server with it.
    pub fn set_provider_endpoints(&self, endpoints: Endpoints) {
        *lock(&self.hub.endpoints) = endpoints;
        self.hub.clear_caches();
    }

    /// Carries the Electron profile's tokens over once. Runs at launch.
    pub fn migrate_electron_tokens(&self) -> Vec<Provider> {
        migrate::migrate(&self.hub.tokens)
    }

    /// Providers whose Electron token could not be carried over and have no token now.
    pub fn tokens_needing_reentry(&self) -> Vec<Provider> {
        self.hub.tokens.needs_reentry()
    }

    /// Why the Electron token of `provider` could not be carried over, if it could not.
    pub fn token_migration_failure(&self, provider: Provider) -> Option<String> {
        match self.hub.tokens.states().remove(&provider) {
            Some(MigrationState::Failed { reason }) if !self.hub.tokens.has(provider) => Some(reason),
            _ => None,
        }
    }

    fn store_token(&self, provider: Provider, token: &str) -> Result<()> {
        self.hub.tokens.save(provider, token).or_else(|e| fail(e))?;
        let _ = self.hub.tokens.set_state(provider, MigrationState::Done);
        self.hub.clear_caches();
        Ok(())
    }

    fn remove_token(&self, provider: Provider) {
        self.hub.tokens.delete(provider);
        let _ = self.hub.tokens.set_state(provider, MigrationState::Done);
        self.hub.clear_caches();
    }

    fn token(&self, provider: Provider, what: &str) -> std::result::Result<Secret, ProviderError> {
        self.hub.tokens.load(provider).ok_or_else(|| no_token(what))
    }

    // --- Status ---

    /// `issues:provider-status`: which trackers have a token (and a team or domain).
    pub fn issue_provider_status(&self) -> Result<IssueProviderStatus> {
        let t = &self.hub.tokens;
        let (linear, jira, github) = (t.has(Provider::Linear), t.has(Provider::Jira), t.has(Provider::Github));
        Ok(IssueProviderStatus {
            configured: github,
            provider: github.then(|| "github".to_string()),
            linear_configured: linear,
            linear_team_selected: linear && self.get_setting_value("linear_team_id")?.is_some(),
            jira_configured: jira,
            jira_domain_set: jira && self.get_setting_value("jira_domain")?.is_some(),
        })
    }

    /// `linear:provider-status`.
    pub fn linear_provider_status(&self) -> Result<LinearProviderStatus> {
        let configured = self.hub.tokens.has(Provider::Linear);
        let team_id = self.get_setting_value("linear_team_id")?;
        let team_name = self.get_setting_value("linear_team_name")?;
        Ok(LinearProviderStatus {
            configured,
            team_selected: configured && team_id.is_some(),
            team_name: if configured { team_name.filter(|n| !n.is_empty()) } else { None },
        })
    }

    /// `jira:provider-status`.
    pub fn jira_provider_status(&self) -> Result<JiraProviderStatus> {
        let configured = self.hub.tokens.has(Provider::Jira);
        let auth = self.get_setting_value("jira_auth_type")?;
        Ok(JiraProviderStatus {
            configured,
            domain_set: configured && self.get_setting_value("jira_domain")?.is_some(),
            project_key_set: configured && self.get_setting_value("jira_project_key")?.is_some(),
            auth_type: auth.map(|a| parse_auth_type(Some(&a))),
        })
    }

    // --- GitHub ---

    fn github_client<'a>(&'a self, token: &'a Secret, endpoints: &'a Endpoints) -> GitHub<'a> {
        GitHub { http: self.hub.http(), base: &endpoints.github, token, user: &self.hub.github_user }
    }

    /// `issues:set-token`.
    pub fn github_set_token(&self, token: &str) -> Result<()> {
        let t = require_token(token, "Token")?;
        self.store_token(Provider::Github, &t)
    }

    /// `issues:delete-token`.
    pub fn github_delete_token(&self) {
        self.remove_token(Provider::Github);
    }

    /// `issues:test-token`: the login the token belongs to.
    pub fn github_test(&self) -> Result<String> {
        let token = self.token(Provider::Github, "token")?;
        let endpoints = self.hub.endpoints();
        Ok(self.github_client(&token, &endpoints).username()?)
    }

    /// `issues:list`.
    pub fn github_issues(&self, input: &IssuesListInput) -> Result<Vec<Issue>> {
        let token = self.token(Provider::Github, "token")?;
        let key = input.repo.clone().unwrap_or_else(|| "__all__".to_string());
        if input.force_refresh == Some(true) {
            lock(&self.hub.github_issues).remove(&key);
        }
        if let Some(hit) = lock(&self.hub.github_issues).get(&key) {
            return Ok(hit.clone());
        }
        let endpoints = self.hub.endpoints();
        let issues = self.github_client(&token, &endpoints).list_issues(input.repo.as_deref())?;
        lock(&self.hub.github_issues).insert(key, issues.clone());
        Ok(issues)
    }

    /// `issues:fetch-comments`.
    pub fn github_comments(&self, repo: &str, issue_number: i64) -> Result<Vec<IssueComment>> {
        let token = self.token(Provider::Github, "token")?;
        let endpoints = self.hub.endpoints();
        Ok(self.github_client(&token, &endpoints).fetch_comments(repo, issue_number)?)
    }

    // --- Linear ---

    fn linear_client<'a>(&'a self, key: &'a Secret, endpoints: &'a Endpoints) -> Linear<'a> {
        Linear { http: self.hub.http(), endpoint: &endpoints.linear, key }
    }

    /// `linear:set-token`.
    pub fn linear_set_token(&self, token: &str) -> Result<()> {
        let t = require_token(token, "Token")?;
        self.store_token(Provider::Linear, &t)
    }

    /// `linear:delete-token`: the key, the team and everything cached.
    pub fn linear_delete_token(&self) -> Result<()> {
        self.remove_token(Provider::Linear);
        self.set_setting_value("linear_team_id", None)?;
        self.set_setting_value("linear_team_name", None)
    }

    /// `linear:test-connection`: the key owner's display name.
    pub fn linear_test(&self) -> Result<String> {
        let key = self.token(Provider::Linear, "Linear API key")?;
        let endpoints = self.hub.endpoints();
        Ok(self.linear_client(&key, &endpoints).test_connection()?)
    }

    /// `linear:list-teams`.
    pub fn linear_teams(&self) -> Result<Vec<LinearTeam>> {
        let key = self.token(Provider::Linear, "Linear API key")?;
        let endpoints = self.hub.endpoints();
        Ok(self.linear_client(&key, &endpoints).list_teams()?)
    }

    /// `linear:set-team`.
    pub fn linear_set_team(&self, team_id: &str, team_name: &str) -> Result<()> {
        self.set_setting_value("linear_team_id", Some(team_id))?;
        self.set_setting_value("linear_team_name", Some(team_name))
    }

    /// `linear:get-team`: `(id, name)` of the chosen team.
    pub fn linear_team(&self) -> Result<Option<(String, String)>> {
        let id = self.get_setting_value("linear_team_id")?.filter(|v| !v.is_empty());
        let name = self.get_setting_value("linear_team_name")?.filter(|v| !v.is_empty());
        Ok(id.zip(name))
    }

    /// `linear:fetch-issues`.
    pub fn linear_issues(&self, force_refresh: bool) -> Result<Vec<LinearIssue>> {
        let key = self.token(Provider::Linear, "Linear API key")?;
        let Some(team_id) = self.get_setting_value("linear_team_id")?.filter(|v| !v.is_empty()) else {
            return Err(ProviderError::new(Code::NoToken, "No Linear team selected").into());
        };
        if force_refresh {
            lock(&self.hub.linear_issues).remove(&team_id);
        }
        if let Some(hit) = lock(&self.hub.linear_issues).get(&team_id) {
            return Ok(hit.clone());
        }
        let endpoints = self.hub.endpoints();
        let issues = self.linear_client(&key, &endpoints).fetch_issues(&team_id)?;
        lock(&self.hub.linear_issues).insert(team_id, issues.clone());
        Ok(issues)
    }

    /// `linear:fetch-comments`.
    pub fn linear_comments(&self, issue_id: &str) -> Result<Vec<IssueComment>> {
        let key = self.token(Provider::Linear, "Linear API key")?;
        let endpoints = self.hub.endpoints();
        Ok(self.linear_client(&key, &endpoints).fetch_comments(issue_id)?)
    }

    // --- Jira ---

    fn jira_config(&self) -> Result<JiraConfig> {
        let secret = self.token(Provider::Jira, "Jira credentials")?;
        let domain = self.get_setting_value("jira_domain")?.filter(|v| !v.is_empty());
        let identity = self.get_setting_value("jira_email")?.filter(|v| !v.is_empty());
        let (Some(domain), Some(identity)) = (domain, identity) else {
            return Err(no_token("Jira credentials").into());
        };
        let auth_type = parse_auth_type(self.get_setting_value("jira_auth_type")?.as_deref());
        Ok(JiraConfig { domain, identity, secret, auth_type })
    }

    fn with_jira<T>(&self, f: impl FnOnce(&Jira<'_>) -> std::result::Result<T, ProviderError>) -> Result<T> {
        let cfg = self.jira_config()?;
        let endpoints = self.hub.endpoints();
        let jira = Jira::new(self.hub.http(), endpoints.jira_base.as_deref(), &cfg.domain, &cfg.identity, &cfg.secret, cfg.auth_type);
        Ok(f(&jira)?)
    }

    /// `jira:set-token`.
    pub fn jira_set_token(&self, token: &str) -> Result<()> {
        let t = require_token(token, "Token")?;
        self.store_token(Provider::Jira, &t)
    }

    /// `jira:delete-token`: the secret and every Jira setting.
    pub fn jira_delete_token(&self) -> Result<()> {
        self.remove_token(Provider::Jira);
        for key in ["jira_domain", "jira_email", "jira_project_key", "jira_jql_filter", "jira_auth_type"] {
            self.set_setting_value(key, None)?;
        }
        Ok(())
    }

    /// `jira:set-auth-type`.
    pub fn jira_set_auth_type(&self, auth_type: JiraAuthType) -> Result<()> {
        self.hub.clear_caches();
        self.set_setting_value("jira_auth_type", Some(if auth_type == JiraAuthType::Server { "server" } else { "cloud" }))
    }

    /// `jira:set-domain`: stored without scheme or trailing slashes.
    pub fn jira_set_domain(&self, domain: &str) -> Result<()> {
        self.hub.clear_caches();
        self.set_setting_value("jira_domain", Some(&normalize_domain(lizmeter_db::util::js_trim(domain))))
    }

    /// `jira:set-email`: the email, or the username on Server.
    pub fn jira_set_email(&self, email: &str) -> Result<()> {
        self.hub.clear_caches();
        self.set_setting_value("jira_email", Some(lizmeter_db::util::js_trim(email)))
    }

    /// `jira:set-project-key`: empty clears it.
    pub fn jira_set_project_key(&self, key: &str) -> Result<()> {
        let k = lizmeter_db::util::js_trim(key);
        self.set_setting_value("jira_project_key", (!k.is_empty()).then_some(k))
    }

    /// `jira:set-jql-filter`: empty clears it.
    pub fn jira_set_jql_filter(&self, jql: &str) -> Result<()> {
        let j = lizmeter_db::util::js_trim(jql);
        self.set_setting_value("jira_jql_filter", (!j.is_empty()).then_some(j))
    }

    /// `jira:test-connection`: the signed-in user's display name.
    pub fn jira_test(&self) -> Result<String> {
        self.with_jira(|j| j.test_connection())
    }

    /// `jira:fetch-issues`.
    pub fn jira_issues(&self, force_refresh: bool) -> Result<Vec<JiraIssue>> {
        let project = self.get_setting_value("jira_project_key")?.filter(|v| !v.is_empty());
        let jql = self.get_setting_value("jira_jql_filter")?.filter(|v| !v.is_empty());
        let key = jql.clone().or_else(|| project.clone()).unwrap_or_else(|| "__all__".to_string());
        // A call with no credentials fails before the cache answers, as with a missing provider.
        self.jira_config()?;
        if force_refresh {
            lock(&self.hub.jira_issues).remove(&key);
        }
        if let Some(hit) = lock(&self.hub.jira_issues).get(&key) {
            return Ok(hit.clone());
        }
        let issues = self.with_jira(|j| j.fetch_issues(project.as_deref(), jql.as_deref()))?;
        lock(&self.hub.jira_issues).insert(key, issues.clone());
        Ok(issues)
    }

    /// `jira:fetch-comments`.
    pub fn jira_comments(&self, issue_key: &str) -> Result<Vec<IssueComment>> {
        self.with_jira(|j| j.fetch_comments(issue_key))
    }

    // --- Worklog ---

    /// `worklog:log`: one Jira worklog for the sessions, with the dialog's overrides. The session
    /// becomes `logged` with the worklog id, or `failed` when Jira refuses.
    pub fn worklog_log(&self, input: &WorklogLogInput) -> Result<WorklogLogResult> {
        let cfg = self.jira_config()?;
        let session = self.with_db(|db| Ok(db.get_session_by_id(&input.session_id)?))?;
        let Some(session) = session else { return fail("Session not found") };
        if !is_uploadable(&session) {
            return Err(ProviderError::new(Code::Ineligible, "Only work and stopwatch sessions can be uploaded to Jira").into());
        }
        let invalid_time = || ProviderError::new(Code::QueryError, "Invalid start or end time.");
        let (started_ms, duration_seconds) = match (&input.selected_session_ids, &input.start_time_override, &input.end_time_override) {
            (Some(ids), start, _) if ids.len() > 1 => {
                let candidates = self.with_db(|db| {
                    let mut found = vec![];
                    for id in ids {
                        if let Some(s) = db.get_session_by_id(id)? {
                            found.push(s);
                        }
                    }
                    Ok(found)
                })?;
                let selected: Vec<_> = candidates.into_iter().filter(|s| s.issue_provider == Some(IssueProviderKind::Jira) && s.issue_id.as_deref() == Some(input.issue_key.as_str())).collect();
                let merged = summarize(&selected);
                let (true, Some(first)) = (!merged.uploadable_ids.is_empty(), merged.started_at) else {
                    return Err(ProviderError::new(Code::Ineligible, "Select at least one work or stopwatch session to upload").into());
                };
                let started = match start {
                    Some(s) => parse_ms(s).ok_or_else(invalid_time)?,
                    None => first,
                };
                (started, merged.total_duration_seconds)
            }
            (_, Some(start), Some(end)) => {
                let (s, e) = (parse_ms(start).ok_or_else(invalid_time)?, parse_ms(end).ok_or_else(invalid_time)?);
                (s, ((e - s) as f64 / 1000.0).round() as i64)
            }
            _ => {
                let completed = parse_ms(&session.completed_at).ok_or_else(invalid_time)?;
                (completed - session.actual_duration_seconds * 1000, session.actual_duration_seconds)
            }
        };
        if duration_seconds < 60 {
            return Err(ProviderError::new(Code::Ineligible, "Session duration is less than 60 seconds (Jira minimum)").into());
        }
        let comment = match &input.description_override {
            Some(d) => d.clone(),
            None if session.title.is_empty() => "Work session".to_string(),
            None => session.title.clone(),
        };
        let endpoints = self.hub.endpoints();
        let jira = Jira::new(self.hub.http(), endpoints.jira_base.as_deref(), &cfg.domain, &cfg.identity, &cfg.secret, cfg.auth_type);
        match jira.add_worklog(&input.issue_key, duration_seconds, &iso_from_ms(started_ms), &comment) {
            Ok(id) => {
                self.with_db(|db| Ok(db.update_worklog_status(&input.session_id, WorklogStatus::Logged, Some(&id))?))?;
                Ok(WorklogLogResult { worklog_id: id })
            }
            Err(e) => {
                let _ = self.with_db(|db| Ok(db.update_worklog_status(&input.session_id, WorklogStatus::Failed, None)?));
                Err(e.into())
            }
        }
    }
}
