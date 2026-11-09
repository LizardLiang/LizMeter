//! Jira REST client (`jira-provider.ts`): Cloud (API v3, email + API token) and Server / Data
//! Center (API v2, username + password), both with HTTP basic auth.

use super::{send, status_line, Code, PResult, ProviderError};
use crate::tokens::Secret;
use base64::Engine;
use chrono::{DateTime, Utc};
use lizmeter_core::{IssueComment, JiraAuthType, JiraIssue};
use reqwest::blocking::{Client, Response};
use serde_json::{json, Value};

pub struct Jira<'a> {
    pub http: &'a Client,
    pub base_url: String,
    pub auth_type: JiraAuthType,
    /// `Basic <base64(user:secret)>`.
    auth_header: Secret,
}

/// `domain` without its scheme and trailing slashes.
pub fn normalize_domain(domain: &str) -> String {
    let d = domain.strip_prefix("https://").or_else(|| domain.strip_prefix("http://")).unwrap_or(domain);
    d.trim_end_matches('/').to_string()
}

impl<'a> Jira<'a> {
    pub fn new(http: &'a Client, base_override: Option<&str>, domain: &str, identity: &str, secret: &Secret, auth_type: JiraAuthType) -> Self {
        let base_url = match base_override {
            Some(b) => b.trim_end_matches('/').to_string(),
            None => format!("https://{}", normalize_domain(domain)),
        };
        let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{identity}:{}", secret.expose()));
        Jira { http, base_url, auth_type, auth_header: Secret::new(format!("Basic {encoded}")) }
    }

    fn api_version(&self) -> &'static str {
        match self.auth_type {
            JiraAuthType::Server => "2",
            JiraAuthType::Cloud => "3",
        }
    }

    fn request(&self, method: reqwest::Method, path: &str, query: &[(&str, String)], body: Option<&Value>) -> PResult<Response> {
        let mut req = self
            .http
            .request(method, format!("{}{path}", self.base_url))
            .header("Authorization", self.auth_header.expose())
            .header("Accept", "application/json");
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let response = send(req, format!("Could not reach {}. Check the domain and your internet connection.", self.base_url))?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(response);
        }
        Err(match status {
            401 => ProviderError::new(
                Code::AuthFailed,
                match self.auth_type {
                    JiraAuthType::Server => "Jira credentials are invalid. Check your username and password.",
                    JiraAuthType::Cloud => "Jira credentials are invalid. Check your email and API token.",
                },
            ),
            403 => ProviderError::new(Code::AuthFailed, "Access denied. Your account may lack permissions for this resource."),
            404 => ProviderError::new(Code::NotFound, "Resource not found in Jira. The issue may have been deleted."),
            429 => ProviderError::new(Code::RateLimited, "Jira API rate limit reached. Try again in a few minutes."),
            400 => {
                let line = status_line(&response);
                match response.json::<Value>() {
                    Ok(v) => {
                        let first = v.get("errorMessages").and_then(Value::as_array).and_then(|m| m.first()).and_then(Value::as_str);
                        ProviderError::new(Code::QueryError, first.unwrap_or("Invalid request to Jira API"))
                    }
                    Err(_) => ProviderError::new(Code::NetworkError, format!("Jira API error: {line}")),
                }
            }
            _ => ProviderError::new(Code::NetworkError, format!("Jira API error: {}", status_line(&response))),
        })
    }

    fn get_json(&self, path: &str, query: &[(&str, String)]) -> PResult<Value> {
        self.request(reqwest::Method::GET, path, query, None)?
            .json()
            .map_err(|_| ProviderError::new(Code::NetworkError, format!("Could not reach {}. Check the domain and your internet connection.", self.base_url)))
    }

    /// The display name of the signed-in user.
    pub fn test_connection(&self) -> PResult<String> {
        let me = self.get_json(&format!("/rest/api/{}/myself", self.api_version()), &[])?;
        Ok(me.get("displayName").and_then(Value::as_str).unwrap_or("").to_string())
    }

    pub fn fetch_issues(&self, project_key: Option<&str>, jql_filter: Option<&str>) -> PResult<Vec<JiraIssue>> {
        let jql = match (jql_filter, project_key) {
            (Some(j), _) => j.to_string(),
            (None, Some(p)) => format!("project = {p} ORDER BY updated DESC"),
            (None, None) => "assignee = currentUser() ORDER BY updated DESC".to_string(),
        };
        let query = [("jql", jql), ("maxResults", "50".to_string()), ("fields", "summary,status,priority,assignee,issuetype,labels".to_string())];
        let data = self.get_json(&format!("/rest/api/{}/search", self.api_version()), &query)?;
        Ok(data.get("issues").and_then(Value::as_array).map(|a| a.iter().map(|raw| self.map_issue(raw)).collect()).unwrap_or_default())
    }

    fn map_issue(&self, raw: &Value) -> JiraIssue {
        let s = |p: &str| raw.pointer(p).and_then(Value::as_str).map(str::to_string);
        let key = s("/key").unwrap_or_default();
        JiraIssue {
            id: s("/id").unwrap_or_default(),
            title: s("/fields/summary").unwrap_or_default(),
            url: format!("{}/browse/{key}", self.base_url),
            status: s("/fields/status/name").unwrap_or_default(),
            priority: s("/fields/priority/name"),
            assignee: s("/fields/assignee/displayName"),
            issue_type: s("/fields/issuetype/name"),
            labels: raw.pointer("/fields/labels").and_then(Value::as_array).map(|l| l.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
            key,
        }
    }

    /// Posts one worklog and returns its id. `started` is an ISO-8601 instant.
    pub fn add_worklog(&self, issue_key: &str, time_spent_seconds: i64, started: &str, comment: &str) -> PResult<String> {
        let started = format_jira_timestamp(started).ok_or_else(|| ProviderError::new(Code::QueryError, "Invalid start time for the worklog."))?;
        let comment = match self.auth_type {
            JiraAuthType::Server => json!(comment),
            JiraAuthType::Cloud => json!({ "type": "doc", "version": 1, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": comment }] }] }),
        };
        let body = json!({ "timeSpentSeconds": time_spent_seconds, "started": started, "comment": comment });
        let data: Value = self
            .request(reqwest::Method::POST, &format!("/rest/api/{}/issue/{issue_key}/worklog", self.api_version()), &[], Some(&body))?
            .json()
            .map_err(|_| ProviderError::new(Code::NetworkError, "Jira returned a response that could not be read."))?;
        Ok(match data.get("id") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            _ => "undefined".to_string(),
        })
    }

    pub fn fetch_comments(&self, issue_key: &str) -> PResult<Vec<IssueComment>> {
        let data = self.get_json(&format!("/rest/api/{}/issue/{issue_key}/comment", self.api_version()), &[("orderBy", "created".to_string())])?;
        Ok(data
            .get("comments")
            .and_then(Value::as_array)
            .map(|cs| {
                cs.iter()
                    .map(|c| IssueComment {
                        id: match c.get("id") {
                            Some(Value::String(s)) => s.clone(),
                            Some(Value::Number(n)) => n.to_string(),
                            _ => String::new(),
                        },
                        author: c.pointer("/author/displayName").and_then(Value::as_str).unwrap_or("Unknown").to_string(),
                        body: c.get("body").map(extract_body).unwrap_or_default(),
                        created_at: c.get("created").and_then(Value::as_str).unwrap_or("").to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }
}

/// `2026-02-24T10:30:00.000+0000`, the form Jira expects, from any ISO-8601 instant.
pub fn format_jira_timestamp(iso: &str) -> Option<String> {
    let t: DateTime<Utc> = DateTime::parse_from_rfc3339(iso).ok()?.with_timezone(&Utc);
    Some(t.format("%Y-%m-%dT%H:%M:%S%.3f+0000").to_string())
}

/// A comment body: plain text (v2) or Atlassian Document Format (v3), flattened to its text.
fn extract_body(body: &Value) -> String {
    match body {
        Value::String(s) => s.clone(),
        Value::Object(o) if o.contains_key("content") => flatten_adf(body),
        _ => String::new(),
    }
}

fn flatten_adf(node: &Value) -> String {
    if let Some(t) = node.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        return t.to_string();
    }
    node.get("content").and_then(Value::as_array).map(|c| c.iter().map(flatten_adf).collect()).unwrap_or_default()
}
