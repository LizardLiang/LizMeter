//! Issue-tracker HTTP clients: GitHub REST, Linear GraphQL and Jira REST (Cloud v3, Server v2).
//! Ports of `electron/main/issue-providers/*-provider.ts` with the same requests, response
//! mapping and error texts. They are stateless: [`crate::issues`] owns the caches and tokens.

pub mod github;
pub mod jira;
pub mod linear;

use crate::error::ServiceError;
use reqwest::blocking::{Client, RequestBuilder, Response};
use std::time::Duration;

/// `IssueProviderError.code` of the TS providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    NoToken,
    AuthFailed,
    NetworkError,
    RateLimited,
    QueryError,
    NotFound,
    Ineligible,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderError {
    pub code: Code,
    pub message: String,
}

impl ProviderError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        ProviderError { code, message: message.into() }
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<ProviderError> for ServiceError {
    fn from(e: ProviderError) -> Self {
        ServiceError::Message(e.message)
    }
}

pub type PResult<T> = std::result::Result<T, ProviderError>;

/// Where each provider's API lives. Production values are the real hosts; tests and the
/// debug-build environment overrides point them at a local mock server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub github: String,
    pub linear: String,
    /// Replaces `https://<domain>` for Jira when set.
    pub jira_base: Option<String>,
}

impl Endpoints {
    pub fn production() -> Self {
        Endpoints { github: "https://api.github.com".into(), linear: "https://api.linear.app/graphql".into(), jira_base: None }
    }

    /// Production, plus `LIZMETER_GITHUB_API_URL`, `LIZMETER_LINEAR_API_URL` and
    /// `LIZMETER_JIRA_BASE_URL` in debug builds only. A release build ignores them.
    pub fn from_env() -> Self {
        #[allow(unused_mut)]
        let mut e = Self::production();
        #[cfg(debug_assertions)]
        {
            let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
            if let Some(v) = var("LIZMETER_GITHUB_API_URL") {
                e.github = v.trim_end_matches('/').to_string();
            }
            if let Some(v) = var("LIZMETER_LINEAR_API_URL") {
                e.linear = v;
            }
            if let Some(v) = var("LIZMETER_JIRA_BASE_URL") {
                e.jira_base = Some(v.trim_end_matches('/').to_string());
            }
        }
        e
    }
}

pub fn client() -> Client {
    Client::builder().timeout(Duration::from_secs(30)).user_agent("LizMeter").build().expect("the HTTP client builds with the bundled TLS settings")
}

/// Sends the request; a transport failure becomes `network_message`.
pub(crate) fn send(req: RequestBuilder, network_message: impl Into<String>) -> PResult<Response> {
    req.send().map_err(|_| ProviderError::new(Code::NetworkError, network_message))
}

/// The reason phrase after the status code, as `Response.statusText` gives it.
pub(crate) fn status_line(r: &Response) -> String {
    let s = r.status();
    format!("{} {}", s.as_u16(), s.canonical_reason().unwrap_or(""))
}
