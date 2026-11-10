//! GitHub REST client (`github-provider.ts`, which used Octokit): the calls Octokit made, with the
//! same query strings, and its status-to-error mapping.

use super::{send, Code, PResult, ProviderError};
use crate::tokens::Secret;
use lizmeter_core::{Issue, IssueComment, IssueLabel};
use reqwest::blocking::{Client, RequestBuilder, Response};
use serde_json::Value;
use std::sync::Mutex;

const UNREACHABLE: &str = "Could not reach GitHub. Check your internet connection.";

pub struct GitHub<'a> {
    pub http: &'a Client,
    pub base: &'a str,
    pub token: &'a Secret,
    /// The login behind the token, fetched once.
    pub user: &'a Mutex<Option<String>>,
}

fn invalid_repo(repo: &str) -> ProviderError {
    ProviderError::new(Code::NetworkError, format!("Invalid repo format: \"{repo}\". Expected \"owner/repo\""))
}

/// `owner` and `name` of an `owner/repo` string, as `repo.split("/")` gives them.
fn split_repo(repo: &str) -> PResult<(&str, &str)> {
    let mut parts = repo.split('/');
    match (parts.next(), parts.next()) {
        (Some(o), Some(r)) if !o.is_empty() && !r.is_empty() => Ok((o, r)),
        _ => Err(invalid_repo(repo)),
    }
}

impl GitHub<'_> {
    fn get(&self, path: &str) -> RequestBuilder {
        self.http
            .get(format!("{}{path}", self.base))
            .header("Authorization", format!("token {}", self.token.expose()))
            .header("Accept", "application/vnd.github.v3+json")
    }

    /// 2xx body as JSON, or the error Octokit's callers mapped.
    fn json(&self, req: RequestBuilder, forbidden: &str) -> PResult<Value> {
        let response = send(req, UNREACHABLE)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(match status {
                401 => ProviderError::new(Code::AuthFailed, "GitHub token is invalid or has been revoked"),
                403 => ProviderError::new(Code::RateLimited, forbidden),
                _ => ProviderError::new(Code::NetworkError, github_message(response)),
            });
        }
        response.json().map_err(|_| ProviderError::new(Code::NetworkError, UNREACHABLE))
    }

    /// The login the token belongs to.
    pub fn username(&self) -> PResult<String> {
        if let Some(name) = self.user.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            return Ok(name);
        }
        let user = self.json(self.get("/user"), "GitHub API rate limit reached. Try again in a few minutes.")?;
        let name = user.get("login").and_then(Value::as_str).map(str::to_string).ok_or_else(|| ProviderError::new(Code::NetworkError, UNREACHABLE))?;
        *self.user.lock().unwrap_or_else(|e| e.into_inner()) = Some(name.clone());
        Ok(name)
    }

    pub fn list_issues(&self, repo: Option<&str>) -> PResult<Vec<Issue>> {
        const RATE: &str = "GitHub API rate limit reached. Try again in a few minutes.";
        let query = |assignee: Option<&str>| {
            let mut q: Vec<(&str, String)> = vec![];
            match assignee {
                Some(a) => q.push(("assignee", a.to_string())),
                None => q.push(("filter", "assigned".into())),
            }
            q.extend([("state", "open".into()), ("sort", "updated".into()), ("direction", "desc".into()), ("per_page", "100".into())]);
            q
        };
        let items = match repo {
            Some(repo) => {
                let (owner, name) = split_repo(repo)?;
                let username = self.username()?;
                self.json(self.get(&format!("/repos/{owner}/{name}/issues")).query(&query(Some(&username))), RATE)?
            }
            None => self.json(self.get("/user/issues").query(&query(None)), RATE)?,
        };
        let items = items.as_array().cloned().unwrap_or_default();
        Ok(items.iter().filter(|i| i.get("pull_request").is_none_or(Value::is_null)).map(|i| map_issue(i, repo)).collect())
    }

    pub fn fetch_comments(&self, repo: &str, issue_number: i64) -> PResult<Vec<IssueComment>> {
        let (owner, name) = split_repo(repo)?;
        let req = self
            .get(&format!("/repos/{owner}/{name}/issues/{issue_number}/comments"))
            .query(&[("per_page", "100"), ("sort", "created"), ("direction", "asc")]);
        let items = self.json(req, "GitHub API rate limit reached.")?;
        Ok(items
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|c| IssueComment {
                id: match c.get("id") {
                    Some(Value::Number(n)) => n.to_string(),
                    Some(Value::String(s)) => s.clone(),
                    _ => String::new(),
                },
                author: c.pointer("/user/login").and_then(Value::as_str).unwrap_or("unknown").to_string(),
                body: c.get("body").and_then(Value::as_str).unwrap_or("").to_string(),
                created_at: c.get("created_at").and_then(Value::as_str).unwrap_or("").to_string(),
            })
            .collect())
    }
}

/// The `message` GitHub puts in an error body, or the unreachable text.
fn github_message(response: Response) -> String {
    response.json::<Value>().ok().and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_string)).unwrap_or_else(|| UNREACHABLE.to_string())
}

fn map_issue(item: &Value, requested_repo: Option<&str>) -> Issue {
    let text = |k: &str| item.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let repo_from_url = item
        .get("repository_url")
        .and_then(Value::as_str)
        .and_then(|u| u.split("/repos/").nth(1))
        .filter(|r| !r.is_empty())
        .map(str::to_string);
    let labels = item
        .get("labels")
        .and_then(Value::as_array)
        .map(|ls| {
            ls.iter()
                .map(|l| match l {
                    Value::String(s) => IssueLabel { name: s.clone(), color: "7aa2f7".into() },
                    other => IssueLabel {
                        name: other.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                        color: other.get("color").and_then(Value::as_str).unwrap_or("7aa2f7").to_string(),
                    },
                })
                .collect()
        })
        .unwrap_or_default();
    Issue {
        number: item.get("number").and_then(Value::as_i64).unwrap_or(0),
        title: text("title"),
        url: text("html_url"),
        repo: repo_from_url.unwrap_or_else(|| requested_repo.unwrap_or("").to_string()),
        state: text("state"),
        labels,
        updated_at: item.get("updated_at").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()),
    }
}
