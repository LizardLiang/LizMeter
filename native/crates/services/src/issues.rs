//! The issue-provider calls the pages make: GitHub, Linear and Jira issue lists, their comments,
//! and the Jira worklog. Phase 8 ports the providers and their token storage; until then no token
//! exists, so the status reports nothing configured and every fetch fails with the same text the
//! channel dispatcher gives for a deferred channel. The signatures are the ones phase 8 keeps.

use crate::error::{fail, Result};
use crate::Services;
use lizmeter_core::{
    Issue, IssueComment, IssueProviderStatus, IssuesListInput, JiraIssue, LinearIssue, WorklogLogInput, WorklogLogResult,
};

const NOT_AVAILABLE: &str = "is not available yet (phase 8)";

impl Services {
    /// `issues:provider-status`: which trackers have a token (and a team or domain).
    pub fn issue_provider_status(&self) -> Result<IssueProviderStatus> {
        Ok(IssueProviderStatus {
            configured: false,
            provider: None,
            linear_configured: false,
            linear_team_selected: false,
            jira_configured: false,
            jira_domain_set: false,
        })
    }

    /// `issues:list`.
    pub fn github_issues(&self, _input: &IssuesListInput) -> Result<Vec<Issue>> {
        fail(format!("Channel issues:list {NOT_AVAILABLE}"))
    }

    /// `linear:fetch-issues`.
    pub fn linear_issues(&self, _force_refresh: bool) -> Result<Vec<LinearIssue>> {
        fail(format!("Channel linear:fetch-issues {NOT_AVAILABLE}"))
    }

    /// `jira:fetch-issues`.
    pub fn jira_issues(&self, _force_refresh: bool) -> Result<Vec<JiraIssue>> {
        fail(format!("Channel jira:fetch-issues {NOT_AVAILABLE}"))
    }

    /// `issues:fetch-comments`.
    pub fn github_comments(&self, _repo: &str, _issue_number: i64) -> Result<Vec<IssueComment>> {
        fail(format!("Channel issues:fetch-comments {NOT_AVAILABLE}"))
    }

    /// `linear:fetch-comments`.
    pub fn linear_comments(&self, _issue_id: &str) -> Result<Vec<IssueComment>> {
        fail(format!("Channel linear:fetch-comments {NOT_AVAILABLE}"))
    }

    /// `jira:fetch-comments`.
    pub fn jira_comments(&self, _issue_key: &str) -> Result<Vec<IssueComment>> {
        fail(format!("Channel jira:fetch-comments {NOT_AVAILABLE}"))
    }

    /// `worklog:log`: one Jira worklog for the sessions, with the dialog's overrides.
    pub fn worklog_log(&self, _input: &WorklogLogInput) -> Result<WorklogLogResult> {
        fail(format!("Channel worklog:log {NOT_AVAILABLE}"))
    }
}
