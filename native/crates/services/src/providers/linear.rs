//! Linear GraphQL client (`linear-provider.ts`).

use super::{send, Code, PResult, ProviderError};
use crate::tokens::Secret;
use lizmeter_core::{IssueComment, LinearIssue, LinearIssueState, LinearTeam};
use reqwest::blocking::Client;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

const VIEWER_QUERY: &str = "\n  query Viewer {\n    viewer {\n      id\n      name\n      email\n    }\n  }\n";

const TEAMS_QUERY: &str = "\n  query Teams {\n    teams {\n      nodes {\n        id\n        name\n        key\n      }\n    }\n  }\n";

const TEAM_ISSUES_QUERY: &str = "\n  query TeamIssues($teamId: String!, $first: Int!) {\n    team(id: $teamId) {\n      issues(\n        first: $first\n        orderBy: updatedAt\n        filter: { state: { type: { nin: [\"completed\", \"cancelled\"] } } }\n      ) {\n        nodes {\n          id\n          identifier\n          title\n          url\n          priority\n          state {\n            name\n            type\n          }\n          updatedAt\n        }\n      }\n    }\n  }\n";

const ISSUE_COMMENTS_QUERY: &str = "\n  query IssueComments($issueId: String!) {\n    issue(id: $issueId) {\n      comments(first: 100, orderBy: createdAt) {\n        nodes {\n          id\n          body\n          createdAt\n          user {\n            name\n          }\n        }\n      }\n    }\n  }\n";

const UNREACHABLE: &str = "Could not reach Linear. Check your internet connection.";

pub struct Linear<'a> {
    pub http: &'a Client,
    pub endpoint: &'a str,
    pub key: &'a Secret,
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: Option<T>,
    errors: Option<Vec<GqlError>>,
}

#[derive(Deserialize)]
struct GqlError {
    message: String,
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<T>,
}

#[derive(Deserialize)]
struct RawIssue {
    id: String,
    identifier: String,
    title: String,
    url: String,
    priority: i64,
    state: RawState,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

#[derive(Deserialize)]
struct RawState {
    name: String,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct RawComment {
    id: String,
    body: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    user: RawUser,
}

#[derive(Deserialize)]
struct RawUser {
    name: String,
}

impl Linear<'_> {
    fn graphql<T: DeserializeOwned>(&self, query: &str, variables: Option<Value>) -> PResult<T> {
        let body = match variables {
            Some(v) => json!({ "query": query, "variables": v }),
            None => json!({ "query": query }),
        };
        let req = self.http.post(self.endpoint).header("Authorization", self.key.expose()).json(&body);
        let response = send(req, UNREACHABLE)?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 => ProviderError::new(Code::AuthFailed, "Linear API key is invalid or has been revoked. Check Settings > Account > API in Linear."),
                429 => ProviderError::new(Code::RateLimited, "Linear API rate limit reached. Try again in a few minutes."),
                _ => ProviderError::new(Code::NetworkError, UNREACHABLE),
            });
        }
        let envelope: Envelope<T> = response.json().map_err(|_| ProviderError::new(Code::QueryError, "Linear returned a response that could not be read."))?;
        if let Some(first) = envelope.errors.as_ref().and_then(|e| e.first()) {
            return Err(ProviderError::new(Code::QueryError, first.message.clone()));
        }
        envelope.data.ok_or_else(|| ProviderError::new(Code::QueryError, "Linear returned no data."))
    }

    /// The display name of the key's user.
    pub fn test_connection(&self) -> PResult<String> {
        #[derive(Deserialize)]
        struct Viewer {
            viewer: RawUser,
        }
        Ok(self.graphql::<Viewer>(VIEWER_QUERY, None)?.viewer.name)
    }

    pub fn list_teams(&self) -> PResult<Vec<LinearTeam>> {
        #[derive(Deserialize)]
        struct Teams {
            teams: Nodes<LinearTeam>,
        }
        Ok(self.graphql::<Teams>(TEAMS_QUERY, None)?.teams.nodes)
    }

    pub fn fetch_issues(&self, team_id: &str) -> PResult<Vec<LinearIssue>> {
        #[derive(Deserialize)]
        struct Team {
            team: Issues,
        }
        #[derive(Deserialize)]
        struct Issues {
            issues: Nodes<RawIssue>,
        }
        let data: Team = self.graphql(TEAM_ISSUES_QUERY, Some(json!({ "teamId": team_id, "first": 100 })))?;
        Ok(data
            .team
            .issues
            .nodes
            .into_iter()
            .map(|r| LinearIssue {
                id: r.id,
                identifier: r.identifier,
                title: r.title,
                url: r.url,
                priority: r.priority,
                state: LinearIssueState { name: r.state.name, kind: r.state.kind },
                updated_at: r.updated_at,
            })
            .collect())
    }

    pub fn fetch_comments(&self, issue_id: &str) -> PResult<Vec<IssueComment>> {
        #[derive(Deserialize)]
        struct Issue {
            issue: Comments,
        }
        #[derive(Deserialize)]
        struct Comments {
            comments: Nodes<RawComment>,
        }
        let data: Issue = self.graphql(ISSUE_COMMENTS_QUERY, Some(json!({ "issueId": issue_id })))?;
        Ok(data.issue.comments.nodes.into_iter().map(|c| IssueComment { id: c.id, author: c.user.name, body: c.body, created_at: c.created_at }).collect())
    }
}
