//! `Services::dispatch`: call a service by its Electron channel name with the preload's
//! positional arguments as JSON. Used by the pipe server and by tests; the UI calls the typed
//! methods directly.

use crate::error::{fail, Result, ServiceError};
use crate::Services;
use lizmeter_core::*;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

fn arg<T: DeserializeOwned>(args: &[Value], i: usize, what: &str) -> Result<T> {
    match args.get(i) {
        None | Some(Value::Null) => fail(format!("Missing argument: {what}")),
        Some(v) => serde_json::from_value(v.clone()).map_err(ServiceError::from),
    }
}

/// An argument the Electron handler defaults when it is `undefined` or `null`.
fn arg_or_default<T: DeserializeOwned + Default>(args: &[Value], i: usize) -> Result<T> {
    match args.get(i) {
        None | Some(Value::Null) => Ok(T::default()),
        Some(v) => serde_json::from_value(v.clone()).map_err(ServiceError::from),
    }
}

fn out<T: Serialize>(v: T) -> Result<Value> {
    Ok(serde_json::to_value(v)?)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdAndDuration {
    id: String,
    actual_duration_seconds: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteState {
    id: i64,
    reassign_to_id: i64,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct IncludeDismissed {
    #[serde(default)]
    include_dismissed: bool,
}

#[derive(serde::Deserialize, Default)]
struct Confirm {
    #[serde(default)]
    confirm: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectDir {
    project_dir_name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionUuids {
    session_uuids: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdArg {
    session_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkLogged {
    session_ids: Vec<String>,
    worklog_id: String,
}

#[derive(serde::Deserialize)]
struct IdArg {
    id: i64,
}

#[derive(serde::Deserialize)]
struct TokenArg {
    token: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoIssue {
    repo: String,
    issue_number: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamArg {
    team_id: String,
    team_name: String,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ForceRefresh {
    #[serde(default)]
    force_refresh: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueIdArg {
    issue_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueKeyArg {
    issue_key: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthTypeArg {
    auth_type: JiraAuthType,
}

#[derive(serde::Deserialize)]
struct DomainArg {
    domain: String,
}

#[derive(serde::Deserialize)]
struct EmailArg {
    email: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectKeyArg {
    project_key: String,
}

#[derive(serde::Deserialize)]
struct JqlArg {
    jql: String,
}

#[derive(serde::Deserialize)]
struct UrlArg {
    url: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistCreate {
    name: String,
    #[serde(default)]
    track_ids: Vec<String>,
}

#[derive(serde::Deserialize)]
struct PlaylistRename {
    id: i64,
    name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistReorder {
    playlist_id: i64,
    track_entry_id: i64,
    to_position: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetArg {
    delete_binaries: bool,
}

impl Services {
    /// Calls `channel` with the arguments the preload passes to `ipcRenderer.invoke`.
    pub fn dispatch(&self, channel: &str, args: &[Value]) -> Result<Value> {
        match channel {
            "session:save" => out(self.save_session(&arg(args, 0, "input")?)?),
            "session:save-with-tracking" => out(self.save_session_with_tracking(&arg(args, 0, "input")?)?),
            "session:list" => out(self.list_sessions(&arg_or_default::<ListSessionsInput>(args, 0)?)?),
            "session:update-duration" => {
                let a: IdAndDuration = arg(args, 0, "input")?;
                out(self.update_session_duration(&a.id, a.actual_duration_seconds)?)
            }
            "session:delete" => out(self.delete_session(&arg::<String>(args, 0, "id")?)?),

            "settings:get" => out(self.get_settings()?),
            "settings:save" => out(self.save_settings(&arg(args, 0, "settings")?)?),
            "settings:get-value" => out(self.get_setting_value(&arg::<String>(args, 0, "key")?)?),
            "settings:set-value" => {
                let key: String = arg(args, 0, "key")?;
                let value: Option<String> = match args.get(1) {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(serde_json::from_value(v.clone())?),
                };
                out(self.set_setting_value(&key, value.as_deref())?)
            }

            "tag:create" => out(self.create_tag(&arg(args, 0, "input")?)?),
            "tag:list" => out(self.list_tags()?),
            "tag:update" => out(self.update_tag(&arg(args, 0, "input")?)?),
            "tag:delete" => out(self.delete_tag(arg(args, 0, "id")?)?),
            "tag:assign" => out(self.assign_tag(&arg(args, 0, "input")?)?),
            "tag:unassign" => out(self.unassign_tag(&arg(args, 0, "input")?)?),
            "tag:list-for-session" => out(self.list_tags_for_session(&arg::<String>(args, 0, "sessionId")?)?),

            "todo:create" => out(self.create_todo(&arg(args, 0, "input")?)?),
            "todo:list" => out(self.list_todos(&arg_or_default::<ListTodosInput>(args, 0)?)?),
            "todo:update" => out(self.update_todo(&arg(args, 0, "input")?)?),
            "todo:delete" => out(self.delete_todo(arg(args, 0, "id")?)?),
            "todo:clear-completed" => out(self.clear_completed_todos()?),
            "todo:list-milestones" => out(self.list_todo_milestones()?),

            "attachment:add" => out(self.add_attachment(arg::<AddTodoAttachmentInput>(args, 0, "input")?.todo_id)?),
            "attachment:add-buffer" => out(self.add_attachment_buffer(&arg(args, 0, "input")?)?),
            "attachment:list" => out(self.list_attachments(arg(args, 0, "todoId")?)?),
            "attachment:delete" => out(self.delete_attachment(arg(args, 0, "id")?)?),
            "attachment:open" => out(self.open_attachment(arg(args, 0, "id")?)?),
            "attachment:reveal" => out(self.reveal_attachment(arg(args, 0, "id")?)?),

            "todo-state:list" => out(self.list_todo_states()?),
            "todo-state:create" => out(self.create_todo_state(&arg(args, 0, "input")?)?),
            "todo-state:update" => out(self.update_todo_state(&arg(args, 0, "input")?)?),
            "todo-state:delete" => {
                let a: DeleteState = arg(args, 0, "input")?;
                out(self.delete_todo_state(a.id, a.reassign_to_id)?)
            }
            "todo-state:reorder" => out(self.reorder_todo_states(&arg::<Vec<i64>>(args, 0, "orderedIds")?)?),
            "todo-project:list" => out(self.list_todo_projects()?),
            "todo-project:create" => out(self.create_todo_project(&arg(args, 0, "input")?)?),
            "todo-project:update" => out(self.update_todo_project(&arg(args, 0, "input")?)?),
            "todo-project:delete" => out(self.delete_todo_project(arg(args, 0, "id")?)?),
            "todo-project:reorder" => out(self.reorder_todo_projects(&arg::<Vec<i64>>(args, 0, "orderedIds")?)?),
            "todo-label:list" => out(self.list_todo_labels()?),
            "todo-label:create" => out(self.create_todo_label(&arg(args, 0, "input")?)?),
            "todo-label:update" => out(self.update_todo_label(&arg(args, 0, "input")?)?),
            "todo-label:delete" => out(self.delete_todo_label(arg(args, 0, "id")?)?),

            "data-location:get" => out(self.data_location_get()),
            "data-location:choose" => out(self.data_location_choose()),
            "data-location:move" => out(self.data_location_move(&arg(args, 0, "input")?)?),
            "data-location:reveal" => {
                self.data_location_reveal();
                Ok(Value::Null)
            }

            "sync:get-status" => out(self.sync_status()?),
            "sync:disable" => out(self.sync_disable()?),
            "sync:list-notices" => {
                out(self.sync_notices(arg_or_default::<IncludeDismissed>(args, 0)?.include_dismissed)?)
            }
            "sync:dismiss-notice" => out(self.sync_dismiss_notice(arg::<IdArg>(args, 0, "input")?.id)?),
            "sync:pending-renumber-count" => out(self.sync_pending_renumber_count()?),
            "sync:renumber-legacy-ids" => {
                out(self.sync_renumber_legacy_ids(arg_or_default::<Confirm>(args, 0)?.confirm)?)
            }

            "shell:open-external" => {
                self.open_external(&arg::<String>(args, 0, "url")?);
                Ok(Value::Null)
            }
            "notification:timer-complete" => {
                // The handler ignores anything that is not a pair of strings.
                if let (Some(Value::String(title)), Some(Value::String(body))) = (args.first(), args.get(1)) {
                    self.notify_timer_complete(title, body);
                }
                Ok(Value::Null)
            }

            "claude-tracker:scan" => {
                let r = self.claude_scan(&arg::<ProjectDir>(args, 0, "input")?.project_dir_name)?;
                let mut v = json!({ "success": r.success, "sessions": r.sessions });
                if let Some(e) = r.error {
                    v["error"] = Value::String(e);
                }
                Ok(v)
            }
            "claude-tracker:track-selected" => {
                let uuids = arg::<SessionUuids>(args, 0, "input")?.session_uuids;
                Ok(json!({ "tracked": self.claude_track_selected(&uuids) }))
            }
            "claude-tracker:stop" => Ok(json!({ "sessions": self.claude_stop() })),
            "claude-tracker:pause" => {
                self.claude_pause();
                Ok(Value::Null)
            }
            "claude-tracker:resume" => {
                self.claude_resume();
                Ok(Value::Null)
            }
            "claude-tracker:scan-all" => Ok(json!({ "sessions": self.claude_scan_all() })),
            "claude-tracker:get-projects" => Ok(json!({ "projects": self.claude_projects() })),
            "claude-tracker:get-for-session" => {
                out(self.claude_data_for_session(&arg::<SessionIdArg>(args, 0, "input")?.session_id)?)
            }

            "nvim-activity:list-by-date" => {
                out(self.list_nvim_activity_by_date(&arg::<ListNvimActivityInput>(args, 0, "input")?.date)?)
            }
            "worklog:mark-logged" => {
                let a: MarkLogged = arg(args, 0, "input")?;
                out(self.mark_worklog_logged(&a.session_ids, &a.worklog_id)?)
            }

            "worklog:log" => out(self.worklog_log(&arg(args, 0, "input")?)?),

            "issues:list" => Ok(json!({ "issues": self.github_issues(&arg_or_default::<IssuesListInput>(args, 0)?)? })),
            "issues:provider-status" => out(self.issue_provider_status()?),
            "issues:set-token" => out(self.github_set_token(&arg::<TokenArg>(args, 0, "input")?.token)?),
            "issues:test-token" => Ok(json!({ "username": self.github_test()? })),
            "issues:fetch-comments" => {
                let a: RepoIssue = arg(args, 0, "input")?;
                out(self.github_comments(&a.repo, a.issue_number)?)
            }
            "issues:delete-token" => out(self.github_delete_token()),

            "linear:set-token" => out(self.linear_set_token(&arg::<TokenArg>(args, 0, "input")?.token)?),
            "linear:delete-token" => out(self.linear_delete_token()?),
            "linear:test-connection" => Ok(json!({ "displayName": self.linear_test()? })),
            "linear:list-teams" => out(self.linear_teams()?),
            "linear:set-team" => {
                let a: TeamArg = arg(args, 0, "input")?;
                out(self.linear_set_team(&a.team_id, &a.team_name)?)
            }
            "linear:get-team" => Ok(match self.linear_team()? {
                Some((team_id, team_name)) => json!({ "teamId": team_id, "teamName": team_name }),
                None => Value::Null,
            }),
            "linear:fetch-issues" => out(self.linear_issues(arg_or_default::<ForceRefresh>(args, 0)?.force_refresh)?),
            "linear:fetch-comments" => out(self.linear_comments(&arg::<IssueIdArg>(args, 0, "input")?.issue_id)?),
            "linear:provider-status" => out(self.linear_provider_status()?),

            "jira:set-token" => out(self.jira_set_token(&arg::<TokenArg>(args, 0, "input")?.token)?),
            "jira:delete-token" => out(self.jira_delete_token()?),
            "jira:test-connection" => Ok(json!({ "displayName": self.jira_test()? })),
            "jira:fetch-issues" => out(self.jira_issues(arg_or_default::<ForceRefresh>(args, 0)?.force_refresh)?),
            "jira:fetch-comments" => out(self.jira_comments(&arg::<IssueKeyArg>(args, 0, "input")?.issue_key)?),
            "jira:provider-status" => out(self.jira_provider_status()?),
            "jira:set-auth-type" => out(self.jira_set_auth_type(arg::<AuthTypeArg>(args, 0, "input")?.auth_type)?),
            "jira:set-domain" => out(self.jira_set_domain(&arg::<DomainArg>(args, 0, "input")?.domain)?),
            "jira:set-email" => out(self.jira_set_email(&arg::<EmailArg>(args, 0, "input")?.email)?),
            "jira:set-project-key" => out(self.jira_set_project_key(&arg::<ProjectKeyArg>(args, 0, "input")?.project_key)?),
            "jira:set-jql-filter" => out(self.jira_set_jql_filter(&arg::<JqlArg>(args, 0, "input")?.jql)?),

            // Music. There is no stream URL in the native app: `music:play` returns the track and
            // whether it came from the cache, and the audio goes straight to the sound device.
            "music:play" => {
                let m = self.music.clone();
                let played = m.play(&arg::<MusicPlayRequest>(args, 0, "input")?.url, None)?;
                Ok(match played {
                    Some(p) => json!({ "track": p.track, "fromCache": p.from_cache }),
                    None => Value::Null,
                })
            }
            "music:stop" => out(self.music.stop()),
            "music:meta" => out(self.music.meta(&arg::<UrlArg>(args, 0, "input")?.url)?),
            "music:library:list" => out(self.music.library_list(&arg_or_default::<MusicLibraryListInput>(args, 0)?)?),
            "music:library:delete" => out(self.music.library_delete(&arg::<String>(args, 0, "trackId")?)?),
            "music:library:clear" => out(self.music.library_clear()?),
            "music:playlist:create" => {
                let a: PlaylistCreate = arg(args, 0, "input")?;
                out(self.music.playlist_create(&a.name, &a.track_ids)?)
            }
            "music:playlist:rename" => {
                let a: PlaylistRename = arg(args, 0, "input")?;
                out(self.music.playlist_rename(a.id, &a.name)?)
            }
            "music:playlist:delete" => out(self.music.playlist_delete(arg(args, 0, "id")?)?),
            "music:playlist:list" => out(self.music.playlist_list()?),
            "music:playlist:tracks" => out(self.music.playlist_tracks(arg(args, 0, "playlistId")?)?),
            "music:playlist:add-track" => out(self.music.playlist_add_track(&arg::<PlaylistAddTrackInput>(args, 0, "input")?)?),
            "music:playlist:remove-track" => out(self.music.playlist_remove_track(arg(args, 0, "playlistTrackId")?)?),
            "music:playlist:reorder" => {
                let a: PlaylistReorder = arg(args, 0, "input")?;
                out(self.music.playlist_reorder(a.playlist_id, a.track_entry_id, a.to_position)?)
            }
            "music:cache:stats" => out(self.music.cache_stats()?),
            "music:cache:clear" => out(self.music.cache_clear()?),
            "music:cache:set-limit" => out(self.music.cache_set_limit(arg(args, 0, "maxBytes")?)?),
            "music:binary:status" => out(self.music.binary_status()),
            "music:binary:info" => out(self.music.binary_info()),
            "music:binary:download" => out(self.music.download_binaries()?),
            "music:import:cancel" => out(self.music.import_cancel()),
            "music:reset" => out(self.music.reset(arg::<ResetArg>(args, 0, "input")?.delete_binaries)?),
            "music:integrity:check" => out(self.music.integrity_check()?),
            "music:integrity:repair" => out(self.music.integrity_repair(&arg::<Vec<String>>(args, 0, "trackIds")?)?),

            other => match crate::channels::deferred_owner(other) {
                Some(owner) => fail(format!("Channel {other} is not available yet (phase {})", owner.phase())),
                None => fail(format!("Unknown channel: {other}")),
            },
        }
    }
}
