//! Provider tests: the TS provider tests (`electron/main/issue-providers/__tests__`) ported to
//! Rust, run through `Services` against a local mock HTTP server. Fake tokens only; nothing here
//! talks to GitHub, Linear or Jira.

mod common;

use common::mock::{ok, status, Mock, Reply};
use common::{rig, Rig};
use lizmeter_core::{IssuesListInput, JiraAuthType, WorklogLogInput, WorklogStatus};
use lizmeter_services::providers::Endpoints;
use serde_json::{json, Value};

const GH: &str = "ghp_FAKE_PHASE8_0001";
const LIN: &str = "lin_api_FAKE_PHASE8_0002";
const JIRA: &str = "jira_FAKE_PHASE8_0003";

fn rig_for(mock: &Mock) -> Rig {
    let r = rig();
    r.svc.set_provider_endpoints(Endpoints { github: mock.url.clone(), linear: format!("{}/graphql", mock.url), jira_base: Some(mock.url.clone()) });
    r
}

/// An address nothing listens on.
fn dead_url() -> String {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    format!("http://{}", l.local_addr().unwrap())
}

fn err(r: Result<impl std::fmt::Debug, impl std::fmt::Display>) -> String {
    r.expect_err("expected a failure").to_string()
}

// ---------------------------------------------------------------- GitHub

fn gh_item(number: i64, extra: Value) -> Value {
    let mut base = json!({
        "number": number, "title": format!("Issue {number}"), "html_url": format!("https://github.com/o/r/issues/{number}"),
        "repository_url": "https://api.github.com/repos/o/r", "state": "open", "labels": [], "updated_at": "2026-02-24T10:00:00Z"
    });
    base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    base
}

fn gh_mock(items: Value) -> Mock {
    Mock::start(move |req| match req.path() {
        "/user" => ok(json!({"login": "liz"})),
        p if p.ends_with("/comments") => ok(json!([])),
        _ => ok(items.clone()),
    })
}

#[test]
fn github_lists_assigned_issues_with_octokits_request_and_maps_them() {
    let mock = gh_mock(json!([
        gh_item(1, json!({"labels": [{"name": "bug", "color": "d73a4a"}, "plain", {"name": null, "color": null}]})),
        gh_item(2, json!({"pull_request": {"url": "x"}})),
        gh_item(3, json!({"repository_url": null})),
    ]));
    let r = rig_for(&mock);
    r.svc.github_set_token(&format!("  {GH}  ")).unwrap();
    let issues = r.svc.github_issues(&IssuesListInput::default()).unwrap();
    assert_eq!(issues.iter().map(|i| i.number).collect::<Vec<_>>(), vec![1, 3], "the pull request is dropped");
    assert_eq!((issues[0].repo.as_str(), issues[0].state.as_str(), issues[0].url.as_str()), ("o/r", "open", "https://github.com/o/r/issues/1"));
    assert_eq!(issues[0].labels.iter().map(|l| (l.name.as_str(), l.color.as_str())).collect::<Vec<_>>(), vec![("bug", "d73a4a"), ("plain", "7aa2f7"), ("", "7aa2f7")]);
    assert_eq!(issues[1].repo, "", "no repository_url and no requested repo");
    let req = &mock.requests()[0];
    assert_eq!((req.method.as_str(), req.path()), ("GET", "/user/issues"));
    for (k, v) in [("filter", "assigned"), ("state", "open"), ("sort", "updated"), ("direction", "desc"), ("per_page", "100")] {
        assert_eq!(req.query(k).as_deref(), Some(v), "{k}");
    }
    assert_eq!(req.header("authorization"), Some(format!("token {GH}").as_str()), "the trimmed token is sent");
    assert!(req.header("user-agent").is_some_and(|u| !u.is_empty()), "GitHub requires a User-Agent");
}

#[test]
fn github_caches_per_repo_and_force_refresh_bypasses_the_cache() {
    let mock = gh_mock(json!([gh_item(1, json!({}))]));
    let r = rig_for(&mock);
    r.svc.github_set_token(GH).unwrap();
    let all = IssuesListInput::default();
    r.svc.github_issues(&all).unwrap();
    r.svc.github_issues(&all).unwrap();
    assert_eq!(mock.count(), 1);
    r.svc.github_issues(&IssuesListInput { repo: None, force_refresh: Some(true) }).unwrap();
    assert_eq!(mock.count(), 2);
    r.svc.github_issues(&IssuesListInput { repo: Some("o/r".into()), force_refresh: None }).unwrap();
    assert_eq!(mock.count(), 4, "a repo has its own cache entry: /user then the repo list");
    r.svc.github_set_token(GH).unwrap();
    r.svc.github_issues(&all).unwrap();
    assert_eq!(mock.count(), 5, "saving a token empties the caches");
}

#[test]
fn github_repo_list_asks_for_the_users_login_once_and_rejects_a_bad_repo_before_any_request() {
    let mock = gh_mock(json!([gh_item(7, json!({}))]));
    let r = rig_for(&mock);
    r.svc.github_set_token(GH).unwrap();
    let list = |repo: &str| r.svc.github_issues(&IssuesListInput { repo: Some(repo.into()), force_refresh: Some(true) });
    assert_eq!(list("o/r").unwrap()[0].number, 7);
    let reqs = mock.requests();
    assert_eq!(reqs[0].path(), "/user");
    assert_eq!(reqs[1].path(), "/repos/o/r/issues");
    assert_eq!(reqs[1].query("assignee").as_deref(), Some("liz"));
    assert_eq!(reqs[1].query("per_page").as_deref(), Some("100"));
    list("o/r").unwrap();
    assert_eq!(mock.requests().iter().filter(|q| q.path() == "/user").count(), 1, "the login is cached");
    let before = mock.count();
    assert_eq!(err(list("no-slash")), "Invalid repo format: \"no-slash\". Expected \"owner/repo\"");
    assert_eq!(mock.count(), before);
}

#[test]
fn github_maps_statuses_to_the_texts_the_renderer_shows() {
    let reply = std::sync::Arc::new(std::sync::Mutex::new(401u16));
    let seen = reply.clone();
    let mock = Mock::start(move |_| match *seen.lock().unwrap() {
        404 => status(404, json!({"message": "Not Found"})),
        c => Reply { status: c, body: "{}".into() },
    });
    let r = rig_for(&mock);
    r.svc.github_set_token(GH).unwrap();
    let all = IssuesListInput { repo: None, force_refresh: Some(true) };
    assert_eq!(err(r.svc.github_issues(&all)), "GitHub token is invalid or has been revoked");
    assert_eq!(err(r.svc.github_test()), "GitHub token is invalid or has been revoked");
    *reply.lock().unwrap() = 403;
    assert_eq!(err(r.svc.github_issues(&all)), "GitHub API rate limit reached. Try again in a few minutes.");
    assert_eq!(err(r.svc.github_test()), "GitHub API rate limit reached. Try again in a few minutes.");
    assert_eq!(err(r.svc.github_comments("o/r", 1)), "GitHub API rate limit reached.");
    *reply.lock().unwrap() = 404;
    assert_eq!(err(r.svc.github_issues(&all)), "Not Found", "another status keeps GitHub's own message");
    r.svc.set_provider_endpoints(Endpoints { github: dead_url(), ..Endpoints::production() });
    assert_eq!(err(r.svc.github_issues(&all)), "Could not reach GitHub. Check your internet connection.");
}

#[test]
fn github_fetches_comments_and_tolerates_a_null_user_and_body() {
    let mock = Mock::start(|_| ok(json!([{"id": 11, "user": {"login": "ann"}, "body": "hi", "created_at": "2026-01-01T00:00:00Z"}, {"id": 12, "user": null, "body": null, "created_at": "2026-01-02T00:00:00Z"}])));
    let r = rig_for(&mock);
    r.svc.github_set_token(GH).unwrap();
    let c = r.svc.github_comments("o/r", 42).unwrap();
    assert_eq!((c[0].id.as_str(), c[0].author.as_str(), c[0].body.as_str()), ("11", "ann", "hi"));
    assert_eq!((c[1].author.as_str(), c[1].body.as_str()), ("unknown", ""));
    let req = &mock.requests()[0];
    assert_eq!(req.path(), "/repos/o/r/issues/42/comments");
    assert_eq!((req.query("per_page").as_deref(), req.query("sort").as_deref(), req.query("direction").as_deref()), (Some("100"), Some("created"), Some("asc")));
    assert_eq!(err(r.svc.github_comments("bad", 1)), "Invalid repo format: \"bad\". Expected \"owner/repo\"");
}

#[test]
fn github_test_returns_the_login_and_caches_it() {
    let mock = gh_mock(json!([]));
    let r = rig_for(&mock);
    assert_eq!(err(r.svc.github_test()), "No token configured");
    r.svc.github_set_token(GH).unwrap();
    assert_eq!(r.svc.github_test().unwrap(), "liz");
    assert_eq!(r.svc.github_test().unwrap(), "liz");
    assert_eq!(mock.count(), 1);
    r.svc.github_delete_token();
    assert!(!r.svc.issue_provider_status().unwrap().configured);
    assert_eq!(err(r.svc.github_issues(&IssuesListInput::default())), "No token configured");
}

// ---------------------------------------------------------------- Linear

fn linear_mock() -> Mock {
    Mock::start(|req| {
        let q = req.json()["query"].as_str().unwrap_or("").to_string();
        if q.contains("query Viewer") {
            ok(json!({"data": {"viewer": {"id": "u1", "name": "Jane Dev", "email": "j@x.dev"}}}))
        } else if q.contains("query Teams") {
            ok(json!({"data": {"teams": {"nodes": [{"id": "t1", "name": "Core", "key": "COR"}, {"id": "t2", "name": "Apps", "key": "APP"}]}}}))
        } else if q.contains("query TeamIssues") {
            ok(json!({"data": {"team": {"issues": {"nodes": [{"id": "i1", "identifier": "COR-1", "title": "First", "url": "https://linear.app/x/COR-1", "priority": 2, "state": {"name": "In Progress", "type": "started"}, "updatedAt": "2026-02-01T00:00:00.000Z"}]}}}}))
        } else {
            ok(json!({"data": {"issue": {"comments": {"nodes": [{"id": "c1", "body": "text", "createdAt": "2026-02-02T00:00:00.000Z", "user": {"name": "Ann"}}]}}}}))
        }
    })
}

#[test]
fn linear_sends_the_raw_key_and_returns_the_viewer_teams_issues_and_comments() {
    let mock = linear_mock();
    let r = rig_for(&mock);
    r.svc.linear_set_token(LIN).unwrap();
    assert_eq!(r.svc.linear_test().unwrap(), "Jane Dev");
    let first = &mock.requests()[0];
    assert_eq!((first.method.as_str(), first.path()), ("POST", "/graphql"));
    assert_eq!(first.header("authorization"), Some(LIN), "no Bearer prefix");
    assert!(first.json().get("variables").is_none());
    let teams = r.svc.linear_teams().unwrap();
    assert_eq!(teams.iter().map(|t| (t.id.as_str(), t.name.as_str(), t.key.as_str())).collect::<Vec<_>>(), vec![("t1", "Core", "COR"), ("t2", "Apps", "APP")]);
    r.svc.linear_set_team("t1", "Core").unwrap();
    let issues = r.svc.linear_issues(false).unwrap();
    assert_eq!((issues[0].identifier.as_str(), issues[0].priority, issues[0].state.kind.as_str(), issues[0].updated_at.as_str()), ("COR-1", 2, "started", "2026-02-01T00:00:00.000Z"));
    let req = mock.requests().into_iter().find(|q| q.json()["query"].as_str().unwrap().contains("TeamIssues")).unwrap();
    assert_eq!(req.json()["variables"], json!({"teamId": "t1", "first": 100}));
    assert!(req.json()["query"].as_str().unwrap().contains("nin: [\"completed\", \"cancelled\"]"));
    let comments = r.svc.linear_comments("i1").unwrap();
    assert_eq!((comments[0].author.as_str(), comments[0].body.as_str(), comments[0].created_at.as_str()), ("Ann", "text", "2026-02-02T00:00:00.000Z"));
    assert_eq!(mock.requests().last().unwrap().json()["variables"], json!({"issueId": "i1"}));
}

#[test]
fn linear_caches_per_team_and_force_refresh_and_clear_on_token_save() {
    let mock = linear_mock();
    let r = rig_for(&mock);
    r.svc.linear_set_token(LIN).unwrap();
    assert_eq!(err(r.svc.linear_issues(false)), "No Linear team selected");
    r.svc.linear_set_team("t1", "Core").unwrap();
    r.svc.linear_issues(false).unwrap();
    r.svc.linear_issues(false).unwrap();
    assert_eq!(mock.count(), 1);
    r.svc.linear_issues(true).unwrap();
    assert_eq!(mock.count(), 2);
    r.svc.linear_set_token(LIN).unwrap();
    r.svc.linear_issues(false).unwrap();
    assert_eq!(mock.count(), 3);
}

#[test]
fn linear_maps_statuses_graphql_errors_and_network_failures() {
    let reply = std::sync::Arc::new(std::sync::Mutex::new((401u16, "{}".to_string())));
    let seen = reply.clone();
    let mock = Mock::start(move |_| {
        let (c, b) = seen.lock().unwrap().clone();
        Reply { status: c, body: b }
    });
    let r = rig_for(&mock);
    r.svc.linear_set_token(LIN).unwrap();
    assert_eq!(err(r.svc.linear_test()), "Linear API key is invalid or has been revoked. Check Settings > Account > API in Linear.");
    *reply.lock().unwrap() = (429, "{}".into());
    assert_eq!(err(r.svc.linear_test()), "Linear API rate limit reached. Try again in a few minutes.");
    *reply.lock().unwrap() = (500, "{}".into());
    assert_eq!(err(r.svc.linear_test()), "Could not reach Linear. Check your internet connection.");
    *reply.lock().unwrap() = (200, json!({"errors": [{"message": "Argument Validation Error"}, {"message": "second"}]}).to_string());
    assert_eq!(err(r.svc.linear_test()), "Argument Validation Error");
    *reply.lock().unwrap() = (200, json!({"data": {"viewer": {"id": "1", "name": "Ok", "email": "e"}}, "errors": []}).to_string());
    assert_eq!(r.svc.linear_test().unwrap(), "Ok", "an empty errors array is not a failure");
    r.svc.set_provider_endpoints(Endpoints { linear: format!("{}/graphql", dead_url()), ..Endpoints::production() });
    assert_eq!(err(r.svc.linear_test()), "Could not reach Linear. Check your internet connection.");
}

#[test]
fn linear_status_team_and_delete_follow_the_electron_handlers() {
    let r = rig_for(&linear_mock());
    assert!(!r.svc.linear_provider_status().unwrap().configured);
    r.svc.linear_set_token(LIN).unwrap();
    r.svc.linear_set_team("t1", "Core").unwrap();
    let st = r.svc.linear_provider_status().unwrap();
    assert_eq!((st.configured, st.team_selected, st.team_name.as_deref()), (true, true, Some("Core")));
    assert!(r.svc.issue_provider_status().unwrap().linear_team_selected);
    assert_eq!(r.svc.linear_team().unwrap(), Some(("t1".into(), "Core".into())));
    r.svc.linear_delete_token().unwrap();
    let st = r.svc.linear_provider_status().unwrap();
    assert_eq!((st.configured, st.team_selected, st.team_name), (false, false, None));
    assert_eq!(r.svc.linear_team().unwrap(), None);
    assert_eq!(err(r.svc.linear_test()), "No Linear API key configured");
}

// ---------------------------------------------------------------- Jira

fn jira_setup(mock: &Mock, auth: JiraAuthType) -> Rig {
    let r = rig_for(mock);
    r.svc.jira_set_auth_type(auth).unwrap();
    r.svc.jira_set_domain("https://acme.atlassian.net/").unwrap();
    r.svc.jira_set_email("liz@acme.dev").unwrap();
    r.svc.jira_set_token(JIRA).unwrap();
    r
}

fn basic(user: &str, secret: &str) -> String {
    use base64::Engine;
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{secret}")))
}

fn raw_issue(key: &str, fields: Value) -> Value {
    json!({"id": "10001", "key": key, "fields": fields})
}

#[test]
fn jira_cloud_and_server_use_basic_auth_and_their_api_version() {
    for (auth, version) in [(JiraAuthType::Cloud, "3"), (JiraAuthType::Server, "2")] {
        let mock = Mock::start(|_| ok(json!({"displayName": "Liz"})));
        let r = jira_setup(&mock, auth);
        assert_eq!(r.svc.jira_test().unwrap(), "Liz");
        let req = &mock.requests()[0];
        assert_eq!((req.method.as_str(), req.path()), ("GET", format!("/rest/api/{version}/myself").as_str()));
        assert_eq!(req.header("authorization"), Some(basic("liz@acme.dev", JIRA).as_str()));
        assert_eq!(req.header("accept"), Some("application/json"));
        assert!(req.body.is_empty() && req.header("content-type").is_none(), "a GET has no body");
    }
}

#[test]
fn jira_search_builds_the_jql_and_maps_issues_including_null_fields() {
    let mock = Mock::start(|_| {
        ok(json!({"issues": [
            raw_issue("PROJ-1", json!({"summary": "Wire it", "status": {"name": "In Progress"}, "priority": {"name": "High"}, "assignee": {"displayName": "Liz"}, "issuetype": {"name": "Bug"}, "labels": ["a", "b"]})),
            raw_issue("PROJ-2", json!({"summary": "Bare", "status": {"name": "To Do"}, "priority": null, "assignee": null, "issuetype": null, "labels": []})),
        ]}))
    });
    let r = jira_setup(&mock, JiraAuthType::Cloud);
    let issues = r.svc.jira_issues(false).unwrap();
    assert_eq!((issues[0].key.as_str(), issues[0].title.as_str(), issues[0].status.as_str(), issues[0].priority.as_deref(), issues[0].assignee.as_deref(), issues[0].issue_type.as_deref()), ("PROJ-1", "Wire it", "In Progress", Some("High"), Some("Liz"), Some("Bug")));
    assert_eq!(issues[0].labels, vec!["a", "b"]);
    assert_eq!(issues[0].url, format!("{}/browse/PROJ-1", mock.url));
    assert_eq!((issues[1].priority.clone(), issues[1].assignee.clone(), issues[1].issue_type.clone()), (None, None, None));
    let req = &mock.requests()[0];
    assert_eq!(req.path(), "/rest/api/3/search");
    assert_eq!(req.query("jql").as_deref(), Some("assignee = currentUser() ORDER BY updated DESC"));
    assert_eq!((req.query("maxResults").as_deref(), req.query("fields").as_deref()), (Some("50"), Some("summary,status,priority,assignee,issuetype,labels")));
    r.svc.jira_set_project_key("PROJ").unwrap();
    r.svc.jira_issues(false).unwrap();
    assert_eq!(mock.requests()[1].query("jql").as_deref(), Some("project = PROJ ORDER BY updated DESC"));
    r.svc.jira_set_jql_filter("assignee = me AND status != Done").unwrap();
    r.svc.jira_issues(false).unwrap();
    assert_eq!(mock.requests()[2].query("jql").as_deref(), Some("assignee = me AND status != Done"), "the JQL filter wins over the project key");
    r.svc.jira_issues(false).unwrap();
    assert_eq!(mock.count(), 3, "cached per filter");
    r.svc.jira_issues(true).unwrap();
    assert_eq!(mock.count(), 4);
}

#[test]
fn jira_maps_every_status_to_its_text() {
    let reply = std::sync::Arc::new(std::sync::Mutex::new((401u16, "{}".to_string())));
    let seen = reply.clone();
    let mock = Mock::start(move |_| {
        let (c, b) = seen.lock().unwrap().clone();
        Reply { status: c, body: b }
    });
    let cloud = jira_setup(&mock, JiraAuthType::Cloud);
    let set = |c: u16, b: &str| *reply.lock().unwrap() = (c, b.to_string());
    assert_eq!(err(cloud.svc.jira_test()), "Jira credentials are invalid. Check your email and API token.");
    set(403, "{}");
    assert_eq!(err(cloud.svc.jira_test()), "Access denied. Your account may lack permissions for this resource.");
    set(404, "{}");
    assert_eq!(err(cloud.svc.jira_test()), "Resource not found in Jira. The issue may have been deleted.");
    set(429, "{}");
    assert_eq!(err(cloud.svc.jira_test()), "Jira API rate limit reached. Try again in a few minutes.");
    set(400, r#"{"errorMessages": ["Error in the JQL Query"]}"#);
    assert_eq!(err(cloud.svc.jira_issues(true)), "Error in the JQL Query");
    set(400, r#"{"errorMessages": []}"#);
    assert_eq!(err(cloud.svc.jira_issues(true)), "Invalid request to Jira API");
    set(400, "not json");
    assert_eq!(err(cloud.svc.jira_issues(true)), "Jira API error: 400 Bad Request");
    set(500, "{}");
    assert_eq!(err(cloud.svc.jira_test()), "Jira API error: 500 Internal Server Error");
    set(401, "{}");
    let server = jira_setup(&mock, JiraAuthType::Server);
    assert_eq!(err(server.svc.jira_test()), "Jira credentials are invalid. Check your username and password.");
    let dead = dead_url();
    server.svc.set_provider_endpoints(Endpoints { jira_base: Some(dead.clone()), ..Endpoints::production() });
    assert_eq!(err(server.svc.jira_test()), format!("Could not reach {dead}. Check the domain and your internet connection."));
}

#[test]
fn jira_comments_read_plain_text_adf_and_a_missing_author() {
    let mock = Mock::start(|_| {
        ok(json!({"comments": [
            {"id": "1", "author": {"displayName": "Ann"}, "body": "plain v2", "created": "2026-02-01T10:00:00.000+0000"},
            {"id": "2", "author": {"displayName": "Bob"}, "body": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Hello "}, {"type": "text", "text": "world"}]}]}, "created": "2026-02-02T10:00:00.000+0000"},
            {"id": 3, "body": 5, "created": "2026-02-03T10:00:00.000+0000"},
        ]}))
    });
    let r = jira_setup(&mock, JiraAuthType::Cloud);
    let c = r.svc.jira_comments("PROJ-9").unwrap();
    assert_eq!((c[0].author.as_str(), c[0].body.as_str()), ("Ann", "plain v2"));
    assert_eq!(c[1].body, "Hello world");
    assert_eq!((c[2].id.as_str(), c[2].author.as_str(), c[2].body.as_str()), ("3", "Unknown", ""));
    let req = &mock.requests()[0];
    assert_eq!(req.path(), "/rest/api/3/issue/PROJ-9/comment");
    assert_eq!(req.query("orderBy").as_deref(), Some("created"));
}

#[test]
fn jira_settings_are_normalised_and_a_missing_piece_means_no_credentials() {
    let mock = Mock::start(|_| ok(json!({"displayName": "x"})));
    let r = rig_for(&mock);
    assert_eq!(err(r.svc.jira_test()), "No Jira credentials configured");
    r.svc.jira_set_token(JIRA).unwrap();
    assert_eq!(err(r.svc.jira_test()), "No Jira credentials configured", "token alone is not enough");
    r.svc.jira_set_domain("  http://jira.corp.example:8080//  ").unwrap();
    assert_eq!(r.svc.get_setting_value("jira_domain").unwrap().as_deref(), Some("jira.corp.example:8080"));
    r.svc.jira_set_email("liz").unwrap();
    r.svc.jira_test().unwrap();
    let st = r.svc.jira_provider_status().unwrap();
    assert_eq!((st.configured, st.domain_set, st.project_key_set, st.auth_type), (true, true, false, None));
    r.svc.jira_set_project_key("  ").unwrap();
    assert!(!r.svc.jira_provider_status().unwrap().project_key_set);
    r.svc.jira_delete_token().unwrap();
    let st = r.svc.jira_provider_status().unwrap();
    assert_eq!((st.configured, st.domain_set), (false, false));
    assert_eq!(r.svc.get_setting_value("jira_email").unwrap(), None);
}

// ---------------------------------------------------------------- Worklog

fn save(r: &Rig, extra: Value) -> String {
    let mut input = json!({"title": "Fix bug", "timerType": "work", "plannedDurationSeconds": 1500, "actualDurationSeconds": 1500, "issueProvider": "jira", "issueId": "PROJ-1"});
    input.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    r.svc.dispatch("session:save", &[input]).unwrap()["id"].as_str().unwrap().to_string()
}

fn worklog_mock(code: u16) -> Mock {
    Mock::start(move |_| if code == 200 { ok(json!({"id": 10042})) } else { status(code, json!({})) })
}

fn input(session: &str) -> WorklogLogInput {
    WorklogLogInput { session_id: session.into(), issue_key: "PROJ-1".into(), ..Default::default() }
}

fn status_of(r: &Rig, id: &str) -> (WorklogStatus, Option<String>) {
    let s = r.svc.with_db(|db| Ok(db.get_session_by_id(id)?.unwrap())).unwrap();
    (s.worklog_status, s.worklog_id)
}

#[test]
fn a_worklog_posts_adf_to_cloud_with_the_jira_timestamp_and_marks_the_session_logged() {
    let mock = worklog_mock(200);
    let r = jira_setup(&mock, JiraAuthType::Cloud);
    let id = save(&r, json!({}));
    let out = r.svc.worklog_log(&WorklogLogInput { start_time_override: Some("2026-02-24T10:30:00.000Z".into()), end_time_override: Some("2026-02-24T10:55:00.000Z".into()), description_override: Some("Did things".into()), ..input(&id) }).unwrap();
    assert_eq!(out.worklog_id, "10042", "a numeric id comes back as text");
    let req = &mock.requests()[0];
    assert_eq!((req.method.as_str(), req.path()), ("POST", "/rest/api/3/issue/PROJ-1/worklog"));
    assert_eq!(req.header("content-type"), Some("application/json"));
    assert_eq!(
        req.json(),
        json!({"timeSpentSeconds": 1500, "started": "2026-02-24T10:30:00.000+0000", "comment": {"type": "doc", "version": 1, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Did things"}]}]}})
    );
    assert_eq!(status_of(&r, &id), (WorklogStatus::Logged, Some("10042".into())));
}

#[test]
fn a_server_worklog_sends_a_plain_string_comment_and_defaults_to_the_session_span_and_title() {
    let mock = worklog_mock(200);
    let r = jira_setup(&mock, JiraAuthType::Server);
    let id = save(&r, json!({"title": ""}));
    r.svc.worklog_log(&input(&id)).unwrap();
    let req = &mock.requests()[0];
    assert_eq!(req.path(), "/rest/api/2/issue/PROJ-1/worklog");
    let body = req.json();
    assert_eq!((body["timeSpentSeconds"].clone(), body["comment"].clone()), (json!(1500), json!("Work session")));
    assert!(body["started"].as_str().unwrap().ends_with("+0000") && body["started"].as_str().unwrap().len() == 28);
}

#[test]
fn a_jira_error_marks_the_session_failed_and_the_next_success_marks_it_logged() {
    let code = std::sync::Arc::new(std::sync::atomic::AtomicU16::new(404));
    let c = code.clone();
    let mock = Mock::start(move |_| match c.load(std::sync::atomic::Ordering::SeqCst) {
        200 => ok(json!({"id": "77"})),
        n => status(n, json!({})),
    });
    let r = jira_setup(&mock, JiraAuthType::Cloud);
    let id = save(&r, json!({}));
    assert_eq!(err(r.svc.worklog_log(&input(&id))), "Resource not found in Jira. The issue may have been deleted.");
    assert_eq!(status_of(&r, &id), (WorklogStatus::Failed, None));
    code.store(200, std::sync::atomic::Ordering::SeqCst);
    r.svc.worklog_log(&input(&id)).unwrap();
    assert_eq!(status_of(&r, &id), (WorklogStatus::Logged, Some("77".into())));
}

#[test]
fn a_worklog_refuses_what_jira_would_refuse_without_calling_it() {
    let mock = worklog_mock(200);
    let r = jira_setup(&mock, JiraAuthType::Cloud);
    let short = save(&r, json!({"actualDurationSeconds": 59}));
    assert_eq!(err(r.svc.worklog_log(&input(&short))), "Session duration is less than 60 seconds (Jira minimum)");
    let brk = save(&r, json!({"timerType": "short_break"}));
    assert_eq!(err(r.svc.worklog_log(&input(&brk))), "Only work and stopwatch sessions can be uploaded to Jira");
    assert_eq!(err(r.svc.worklog_log(&input("no-such-session"))), "Session not found");
    let id = save(&r, json!({}));
    let bad_range = WorklogLogInput { start_time_override: Some("2026-02-24T10:00:00.000Z".into()), end_time_override: Some("2026-02-24T10:00:30.000Z".into()), ..input(&id) };
    assert_eq!(err(r.svc.worklog_log(&bad_range)), "Session duration is less than 60 seconds (Jira minimum)");
    assert_eq!(mock.count(), 0);
    assert_eq!(status_of(&r, &id).0, WorklogStatus::NotLogged, "a refusal before the call leaves the status alone");
}

#[test]
fn a_bulk_worklog_merges_the_selected_sessions_of_that_issue() {
    let mock = worklog_mock(200);
    let r = jira_setup(&mock, JiraAuthType::Cloud);
    let a = save(&r, json!({"actualDurationSeconds": 600}));
    let b = save(&r, json!({"actualDurationSeconds": 900}));
    let other = save(&r, json!({"issueId": "PROJ-2", "actualDurationSeconds": 3000}));
    let out = r.svc.worklog_log(&WorklogLogInput { selected_session_ids: Some(vec![a.clone(), b.clone(), other.clone()]), ..input(&a) });
    assert!(out.is_ok());
    let body = mock.requests()[0].json();
    let spent = body["timeSpentSeconds"].as_i64().unwrap();
    assert!(spent >= 900, "the merged span covers the two PROJ-1 sessions and not PROJ-2: {spent}");
    assert!(spent < 3000, "{spent}");
    assert_eq!(status_of(&r, &a).0, WorklogStatus::Logged);
    assert_eq!(status_of(&r, &other).0, WorklogStatus::NotLogged);
    let none_left = r.svc.worklog_log(&WorklogLogInput { selected_session_ids: Some(vec![other.clone(), brk_id(&r)]), ..input(&a) });
    assert_eq!(err(none_left), "Select at least one work or stopwatch session to upload");
}

fn brk_id(r: &Rig) -> String {
    save(r, json!({"timerType": "long_break"}))
}

// ---------------------------------------------------------------- Secrets

#[test]
fn no_error_text_carries_a_token() {
    let mock = Mock::start(|_| status(500, json!({"message": "boom"})));
    let r = jira_setup(&mock, JiraAuthType::Cloud);
    r.svc.github_set_token(GH).unwrap();
    r.svc.linear_set_token(LIN).unwrap();
    r.svc.linear_set_team("t", "T").unwrap();
    let id = save(&r, json!({}));
    let texts = [
        err(r.svc.github_issues(&IssuesListInput::default())),
        err(r.svc.github_test()),
        err(r.svc.linear_issues(true)),
        err(r.svc.jira_test()),
        err(r.svc.worklog_log(&input(&id))),
    ];
    for t in texts {
        for secret in [GH, LIN, JIRA] {
            assert!(!t.contains(secret), "{t}");
        }
    }
}

#[test]
fn every_provider_call_reports_status_through_dispatch_with_the_electron_shapes() {
    let mock = Mock::start(|req| match req.path() {
        "/user" => ok(json!({"login": "liz"})),
        "/graphql" => ok(json!({"data": {"viewer": {"id": "1", "name": "Jane", "email": "e"}}})),
        _ => ok(json!({"displayName": "Liz"})),
    });
    let r = jira_setup(&mock, JiraAuthType::Cloud);
    r.svc.dispatch("issues:set-token", &[json!({"token": GH, "provider": "github"})]).unwrap();
    r.svc.dispatch("linear:set-token", &[json!({"token": LIN})]).unwrap();
    assert_eq!(r.svc.dispatch("issues:test-token", &[]).unwrap(), json!({"username": "liz"}));
    assert_eq!(r.svc.dispatch("linear:test-connection", &[]).unwrap(), json!({"displayName": "Jane"}));
    assert_eq!(r.svc.dispatch("jira:test-connection", &[]).unwrap(), json!({"displayName": "Liz"}));
    let status = r.svc.dispatch("issues:provider-status", &[]).unwrap();
    assert_eq!(status, json!({"configured": true, "provider": "github", "linearConfigured": true, "linearTeamSelected": false, "jiraConfigured": true, "jiraDomainSet": true}));
    let _ = mock.requests();
}
