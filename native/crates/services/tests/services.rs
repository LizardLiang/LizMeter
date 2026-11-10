//! Service tests: every channel the service layer owns is called by name, and the channel list
//! is held equal to `electron/preload/index.ts`.

mod common;

use common::{rig, Caller};
use lizmeter_services::channels::{deferred_owner, SERVICE_CHANNELS};
use lizmeter_services::os::HostCall;
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn preload_channels() -> BTreeSet<String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../electron/preload/index.ts");
    let src = std::fs::read_to_string(path).expect("preload source");
    let mut out = BTreeSet::new();
    for chunk in src.split("invoke(\"").skip(1) {
        if let Some(end) = chunk.find('"') {
            out.insert(chunk[..end].to_string());
        }
    }
    out
}

#[test]
fn every_preload_channel_has_exactly_one_owner() {
    let preload = preload_channels();
    assert!(preload.len() >= 120, "preload parse found only {} channels", preload.len());
    let mut unowned = vec![];
    for channel in &preload {
        let service = SERVICE_CHANNELS.contains(&channel.as_str());
        let deferred = deferred_owner(channel).is_some();
        if service == deferred {
            unowned.push(channel.clone());
        }
    }
    assert!(unowned.is_empty(), "channels with no owner or two owners: {unowned:?}");
    for channel in SERVICE_CHANNELS {
        assert!(preload.contains(channel), "{channel} is not a preload channel");
    }
}

#[test]
fn a_deferred_channel_names_its_phase_and_an_unknown_one_says_so() {
    let r = rig();
    let msg = r.svc.dispatch("music:play", &[]).unwrap_err().to_string();
    assert!(msg.contains("Missing argument"), "music:play is served now: {msg}");
    let msg = r.svc.dispatch("widget:get-settings", &[]).unwrap_err().to_string();
    assert!(msg.contains("phase 11"), "{msg}");
    let msg = r.svc.dispatch("nope:nope", &[]).unwrap_err().to_string();
    assert!(msg.contains("Unknown channel"), "{msg}");
}

#[test]
fn every_service_channel_round_trips_through_dispatch() {
    let r = rig();
    let c = Caller::new(&r.svc);

    // settings
    assert_eq!(c.call("settings:get", vec![]), json!({"workDuration": 1500, "shortBreakDuration": 300, "longBreakDuration": 900}));
    c.call("settings:save", vec![json!({"workDuration": 1200, "shortBreakDuration": 240, "longBreakDuration": 600})]);
    assert_eq!(c.call("settings:get", vec![])["workDuration"], 1200);
    c.call("settings:set-value", vec![json!("k"), json!("v")]);
    assert_eq!(c.call("settings:get-value", vec![json!("k")]), json!("v"));
    c.call("settings:set-value", vec![json!("k"), Value::Null]);
    assert_eq!(c.call("settings:get-value", vec![json!("k")]), Value::Null);

    // sessions and tags
    let s = c.call(
        "session:save",
        vec![json!({"title": "Write ports", "timerType": "work", "plannedDurationSeconds": 1500, "actualDurationSeconds": 1500})],
    );
    let session_id = s["id"].as_str().unwrap().to_string();
    let tracked = c.call(
        "session:save-with-tracking",
        vec![json!({
            "title": "Tracked", "timerType": "stopwatch", "plannedDurationSeconds": 0, "actualDurationSeconds": 600,
            "claudeCodeSessions": [{
                "ccSessionUuid": "abc", "fileEditCount": 1, "totalIdleSeconds": 0, "idlePeriodCount": 0,
                "firstActivityAt": null, "lastActivityAt": null, "filesEdited": ["a.rs"], "idlePeriods": []
            }]
        })],
    );
    let tracked_id = tracked["id"].as_str().unwrap().to_string();
    let for_session = c.call("claude-tracker:get-for-session", vec![json!({"sessionId": tracked_id})]);
    assert_eq!(for_session[0]["ccSessionUuid"], "abc");
    let listed = c.call("session:list", vec![]);
    assert_eq!(listed["total"], 2);
    let tag = c.call("tag:create", vec![json!({"name": "deep", "color": "#7aa2f7"})]);
    let tag_id = tag["id"].as_i64().unwrap();
    c.call("tag:update", vec![json!({"id": tag_id, "name": "deeper", "color": "#bb9af7"})]);
    c.call("tag:assign", vec![json!({"sessionId": session_id, "tagId": tag_id})]);
    assert_eq!(c.call("tag:list-for-session", vec![json!(session_id)])[0]["name"], "deeper");
    assert_eq!(c.call("session:list", vec![json!({"tagId": tag_id})])["total"], 1);
    c.call("tag:unassign", vec![json!({"sessionId": session_id, "tagId": tag_id})]);
    assert_eq!(c.call("tag:list", vec![]).as_array().unwrap().len(), 1);
    c.call("tag:delete", vec![json!(tag_id)]);
    assert_eq!(c.call("tag:list", vec![]).as_array().unwrap().len(), 0);
    c.call("session:update-duration", vec![json!({"id": session_id, "actualDurationSeconds": 90})]);
    c.call("worklog:mark-logged", vec![json!({"sessionIds": [session_id], "worklogId": "W-1"})]);
    let logged = c.call("session:list", vec![]);
    let row = logged["sessions"].as_array().unwrap().iter().find(|s| s["id"] == json!(session_id)).unwrap();
    assert_eq!((row["actualDurationSeconds"].clone(), row["worklogStatus"].clone()), (json!(90), json!("logged")));
    c.call("session:delete", vec![json!(session_id)]);
    assert_eq!(c.call("session:list", vec![])["total"], 1);

    // todo states, projects, labels
    let states = c.call("todo-state:list", vec![]);
    assert!(!states.as_array().unwrap().is_empty(), "seeded states");
    let new_state = c.call("todo-state:create", vec![json!({"label": "Blocked"})]);
    let state_id = new_state["id"].as_i64().unwrap();
    c.call("todo-state:update", vec![json!({"id": state_id, "label": "Waiting"})]);
    let mut order: Vec<i64> = c.call("todo-state:list", vec![]).as_array().unwrap().iter().map(|s| s["id"].as_i64().unwrap()).collect();
    order.reverse();
    let reordered = c.call("todo-state:reorder", vec![json!(order)]);
    assert_eq!(reordered[0]["id"], json!(order[0]));
    let project = c.call("todo-project:create", vec![json!({"name": "Port"})]);
    let project_id = project["id"].as_i64().unwrap();
    c.call("todo-project:update", vec![json!({"id": project_id, "name": "Port 2"})]);
    c.call("todo-project:create", vec![json!({"name": "Other"})]);
    let ids: Vec<i64> = c.call("todo-project:list", vec![]).as_array().unwrap().iter().map(|p| p["id"].as_i64().unwrap()).collect();
    c.call("todo-project:reorder", vec![json!(ids.iter().rev().collect::<Vec<_>>())]);
    let label = c.call("todo-label:create", vec![json!({"name": "urgent"})]);
    let label_id = label["id"].as_i64().unwrap();
    c.call("todo-label:update", vec![json!({"id": label_id, "name": "asap"})]);
    assert_eq!(c.call("todo-label:list", vec![])[0]["name"], "asap");

    // todos and attachments
    let todo = c.call("todo:create", vec![json!({"title": "Port services", "projectId": project_id, "labelIds": [label_id], "milestone": "M1"})]);
    let todo_id = todo["id"].as_i64().unwrap();
    c.call("todo:update", vec![json!({"id": todo_id, "title": "Port the service layer"})]);
    assert_eq!(c.call("todo:list", vec![])[0]["title"], "Port the service layer");
    assert_eq!(c.call("todo:list-milestones", vec![]), json!(["M1"]));

    let picked = r.root.join("note.txt");
    std::fs::write(&picked, b"hello attachment").unwrap();
    assert_eq!(c.call("attachment:add", vec![json!({"todoId": todo_id})]), Value::Null, "cancelled picker attaches nothing");
    *r.host.file_to_pick.lock().unwrap() = Some(picked);
    let added = c.call("attachment:add", vec![json!({"todoId": todo_id})]);
    assert_eq!(added["fileName"], "note.txt");
    assert_eq!(added["mimeType"], "text/plain");
    let att_id = added["id"].as_i64().unwrap();
    let pasted = c.call(
        "attachment:add-buffer",
        vec![json!({"todoId": todo_id, "fileName": "shot.png", "mimeType": "", "data": [137, 80, 78, 71, 1, 2, 3]})],
    );
    assert_eq!(pasted["kind"], "image");
    assert_eq!(pasted["mimeType"], "image/png");
    let pasted_id = pasted["id"].as_i64().unwrap();
    assert_eq!(c.call("attachment:list", vec![json!(todo_id)]).as_array().unwrap().len(), 2);
    assert_eq!(c.call("attachment:open", vec![json!(att_id)]), Value::Null);
    assert_eq!(c.call("attachment:open", vec![json!(9999)]), json!("Attachment not found"));
    c.call("attachment:reveal", vec![json!(att_id)]);
    let host_calls = r.host.calls();
    assert!(host_calls.iter().any(|h| matches!(h, HostCall::OpenPath(p) if p.to_string_lossy().ends_with(".txt"))));
    assert!(host_calls.iter().any(|h| matches!(h, HostCall::ShowInFolder(_))));
    c.call("attachment:delete", vec![json!(pasted_id)]);
    assert_eq!(c.call("attachment:list", vec![json!(todo_id)]).as_array().unwrap().len(), 1);
    c.call("todo:delete", vec![json!(todo_id)]);
    assert_eq!(c.call("todo:list", vec![]).as_array().unwrap().len(), 0);
    let done_state = states.as_array().unwrap().iter().find(|s| s["isCompleted"] == json!(true)).unwrap()["id"].clone();
    c.call("todo:create", vec![json!({"title": "Finished", "stateId": done_state})]);
    assert_eq!(c.call("todo:clear-completed", vec![]), json!(1));
    c.call("todo-label:delete", vec![json!(label_id)]);
    c.call("todo-project:delete", vec![json!(project_id)]);
    let default_state = states.as_array().unwrap().iter().find(|s| s["isDefault"] == json!(true)).unwrap()["id"].clone();
    c.call("todo-state:delete", vec![json!({"id": state_id, "reassignToId": default_state})]);

    // nvim activity
    r.svc.with_db(|db| Ok(db.insert_nvim_activity("proj", "main.rs")?)).unwrap();
    let today = chrono_today();
    assert_eq!(c.call("nvim-activity:list-by-date", vec![json!({"date": today})])["records"][0]["file"], "main.rs");
    assert!(c.call_err("nvim-activity:list-by-date", vec![json!({"date": "09/11/2026"})]).contains("Invalid date format"));

    // shell and notification
    c.call("shell:open-external", vec![json!("https://example.com/x")]);
    c.call("shell:open-external", vec![json!("file:///C:/Windows/system32/calc.exe")]);
    c.call("shell:open-external", vec![json!("javascript:alert(1)")]);
    c.call("notification:timer-complete", vec![json!("Done"), json!("Time is up")]);
    c.call("notification:timer-complete", vec![json!(1), Value::Null]);
    let host_calls = r.host.calls();
    assert_eq!(
        host_calls.iter().filter(|h| matches!(h, HostCall::OpenExternal(_))).count(),
        1,
        "only the https link is opened"
    );
    assert!(host_calls.contains(&HostCall::Notify("Done".into(), "Time is up".into())));
    assert_eq!(host_calls.iter().filter(|h| matches!(h, HostCall::Notify(..))).count(), 1, "non-string args are ignored");

    // sync
    let status = c.call("sync:get-status", vec![]);
    assert_eq!(status["enabled"], false);
    assert_eq!(c.call("sync:list-notices", vec![]), json!([]));
    assert_eq!(c.call("sync:list-notices", vec![json!({"includeDismissed": true})]), json!([]));
    c.call("sync:dismiss-notice", vec![json!({"id": 1})]);
    assert_eq!(c.call("sync:pending-renumber-count", vec![]), json!(0));
    assert_eq!(c.call("sync:renumber-legacy-ids", vec![])["status"], "nothing-to-do");
    c.call("sync:disable", vec![]);

    // Claude Code tracker (empty projects folder)
    assert_eq!(c.call("claude-tracker:get-projects", vec![]), json!({"projects": []}));
    assert_eq!(c.call("claude-tracker:scan-all", vec![]), json!({"sessions": []}));
    let scan = c.call("claude-tracker:scan", vec![json!({"projectDirName": "no-such-project"})]);
    assert_eq!((scan["success"].clone(), scan["error"].clone()), (json!(false), json!("Project not found")));
    assert_eq!(c.call("claude-tracker:track-selected", vec![json!({"sessionUuids": []})]), json!({"tracked": 0}));
    c.call("claude-tracker:pause", vec![]);
    c.call("claude-tracker:resume", vec![]);
    assert_eq!(c.call("claude-tracker:stop", vec![]), json!({"sessions": []}));

    // issue providers: no token yet, so every fetch names what is missing; the settings calls work
    assert_eq!(c.call("issues:provider-status", vec![])["configured"], false);
    assert!(c.call_err("issues:list", vec![]).contains("No token configured"));
    assert!(c.call_err("issues:test-token", vec![]).contains("No token configured"));
    assert!(c.call_err("issues:fetch-comments", vec![json!({"repo": "o/r", "issueNumber": 1})]).contains("No token configured"));
    assert!(c.call_err("issues:set-token", vec![json!({"token": "  ", "provider": "github"})]).contains("Token cannot be empty"));
    c.call("issues:delete-token", vec![]);
    assert!(c.call_err("linear:test-connection", vec![]).contains("No Linear API key configured"));
    assert!(c.call_err("linear:list-teams", vec![]).contains("No Linear API key configured"));
    assert!(c.call_err("linear:fetch-issues", vec![json!({"forceRefresh": true})]).contains("No Linear API key configured"));
    assert!(c.call_err("linear:fetch-comments", vec![json!({"issueId": "x"})]).contains("No Linear API key configured"));
    assert!(c.call_err("linear:set-token", vec![json!({"token": ""})]).contains("Token cannot be empty"));
    c.call("linear:set-team", vec![json!({"teamId": "t1", "teamName": "Core"})]);
    assert_eq!(c.call("linear:get-team", vec![]), json!({"teamId": "t1", "teamName": "Core"}));
    assert_eq!(c.call("linear:provider-status", vec![])["configured"], false);
    c.call("linear:delete-token", vec![]);
    assert_eq!(c.call("linear:get-team", vec![]), Value::Null);
    assert!(c.call_err("jira:test-connection", vec![]).contains("No Jira credentials configured"));
    assert!(c.call_err("jira:fetch-issues", vec![]).contains("No Jira credentials configured"));
    assert!(c.call_err("jira:fetch-comments", vec![json!({"issueKey": "P-1"})]).contains("No Jira credentials configured"));
    assert!(c.call_err("jira:set-token", vec![json!({"token": ""})]).contains("Token cannot be empty"));
    c.call("jira:set-auth-type", vec![json!({"authType": "server"})]);
    c.call("jira:set-domain", vec![json!({"domain": " https://jira.example.com/ "})]);
    c.call("jira:set-email", vec![json!({"email": " liz "})]);
    c.call("jira:set-project-key", vec![json!({"projectKey": "PROJ"})]);
    c.call("jira:set-jql-filter", vec![json!({"jql": "assignee = me"})]);
    assert_eq!(c.call("settings:get-value", vec![json!("jira_domain")]), json!("jira.example.com"));
    assert_eq!(c.call("jira:provider-status", vec![])["authType"], "server");
    c.call("jira:delete-token", vec![]);
    assert_eq!(c.call("settings:get-value", vec![json!("jira_domain")]), Value::Null);
    assert!(c.call_err("worklog:log", vec![json!({"sessionId": "s", "issueKey": "P-1"})]).contains("No Jira credentials configured"));

    // music: no binaries in the scratch folder and release URLs that point at a closed port, so
    // nothing here touches the network or the sound device
    assert_eq!(c.call("music:binary:status", vec![]), json!({"ytDlpInstalled": false, "ffmpegInstalled": false, "ytDlpVersion": null}));
    let info = c.call("music:binary:info", vec![]);
    assert!(info["error"].as_str().unwrap().starts_with("Failed to fetch binary info"), "{info}");
    assert!(c.call_err("music:binary:download", vec![]).contains("Failed to fetch binary info"));
    assert!(c.call_err("music:play", vec![json!({"url": "https://example.com/watch?v=x"})]).contains("yt-dlp or ffmpeg is not installed"));
    assert!(c.call_err("music:meta", vec![json!({"url": "https://example.com/watch?v=x"})]).contains("yt-dlp is not installed"));
    assert_eq!(c.call("music:stop", vec![]), Value::Null);
    assert_eq!(c.call("music:library:list", vec![]), json!({"tracks": [], "total": 0}));
    assert!(c.call_err("music:library:delete", vec![json!("nope")]).contains("Track not found: nope"));
    r.svc
        .with_db(|db| {
            Ok(db.upsert_track(&lizmeter_db::TrackUpsert {
                id: "t1".into(),
                source_url: "https://example.com/t1".into(),
                source_id: "t1".into(),
                source_site: "youtube".into(),
                title: "One".into(),
                artist: None,
                duration_seconds: None,
                thumbnail_url: None,
                cached_file_path: None,
                cache_size_bytes: None,
                added_at: None,
            })?)
        })
        .unwrap();
    let pl = c.call("music:playlist:create", vec![json!({"name": "Mix", "trackIds": ["t1"]})]);
    assert_eq!((pl["name"].as_str(), pl["trackCount"].as_i64()), (Some("Mix"), Some(1)));
    let pid = pl["id"].as_i64().unwrap();
    c.call("music:playlist:rename", vec![json!({"id": pid, "name": "Mix 2"})]);
    assert_eq!(c.call("music:playlist:list", vec![])[0]["name"], "Mix 2");
    let tracks = c.call("music:playlist:tracks", vec![json!(pid)]);
    assert_eq!(tracks[0]["track"]["title"], "One");
    let added = c.call("music:playlist:add-track", vec![json!({"playlistId": pid, "trackId": "t1"})]);
    c.call("music:playlist:reorder", vec![json!({"playlistId": pid, "trackEntryId": added["id"], "toPosition": 0})]);
    c.call("music:playlist:remove-track", vec![added["id"].clone()]);
    c.call("music:playlist:delete", vec![json!(pid)]);
    assert!(c.call_err("music:playlist:delete", vec![json!(pid)]).contains("not found"));
    assert_eq!(c.call("music:cache:stats", vec![])["maxBytes"], 2_147_483_648_i64);
    c.call("music:cache:set-limit", vec![json!(1000)]);
    assert_eq!(c.call("music:cache:stats", vec![])["maxBytes"], 1000);
    c.call("music:cache:clear", vec![]);
    assert_eq!(c.call("music:integrity:check", vec![])["error"], "ffmpeg is not installed");
    assert_eq!(c.call("music:integrity:repair", vec![json!(["t1"])]), json!(0));
    c.call("music:import:cancel", vec![]);
    c.call("music:reset", vec![json!({"deleteBinaries": false})]);
    assert_eq!(c.call("music:library:clear", vec![]), Value::Null);

    // data location, last: a move retires this instance
    let info = c.call("data-location:get", vec![]);
    assert_eq!(info["isCustom"], false);
    assert_eq!(c.call("data-location:choose", vec![]), Value::Null);
    let target = r.root.join("moved");
    *r.host.folder_to_pick.lock().unwrap() = Some(target.clone());
    assert_eq!(c.call("data-location:choose", vec![]), json!(target.to_string_lossy()));
    c.call("data-location:reveal", vec![]);
    let moved = c.call("data-location:move", vec![json!({"targetDir": target.to_string_lossy()})]);
    assert_eq!(moved["ok"], true, "{moved}");
    assert!(r.host.calls().contains(&HostCall::Relaunch));

    let missing: Vec<&str> = SERVICE_CHANNELS.iter().copied().filter(|ch| !c.seen.lock().unwrap().contains(*ch)).collect();
    assert!(missing.is_empty(), "channels never exercised: {missing:?}");
}

fn chrono_today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

#[test]
fn a_moved_data_folder_retires_the_database_handle_and_keeps_the_data() {
    let r = rig();
    let c = Caller::new(&r.svc);
    c.call("tag:create", vec![json!({"name": "keep", "color": "#7aa2f7"})]);
    let target = r.root.join("elsewhere");
    let moved = c.call("data-location:move", vec![json!({"targetDir": target.to_string_lossy()})]);
    assert_eq!(moved["ok"], true);
    assert!(target.join("lizmeter.db").exists(), "the database was copied");
    let msg = r.svc.dispatch("tag:list", &[]).unwrap_err().to_string();
    assert!(msg.contains("restarting"), "{msg}");
    // Reopening at the new location sees the same data, as the relaunched app would.
    let host = std::sync::Arc::new(lizmeter_services::os::RecordingHost::default());
    let (again, _) = lizmeter_services::Services::open(
        lizmeter_db::data_location::DataLocation::new(&r.user_data),
        host,
        &r.projects,
    )
    .unwrap();
    assert_eq!(again.list_tags().unwrap()[0].name, "keep");
}

#[test]
fn moving_to_the_current_folder_is_refused_and_leaves_the_app_working() {
    let r = rig();
    let c = Caller::new(&r.svc);
    c.call("tag:create", vec![json!({"name": "still-here", "color": "#7aa2f7"})]);
    let same = r.user_data.to_string_lossy().into_owned();
    let refused = c.call("data-location:move", vec![json!({"targetDir": same})]);
    assert_eq!((refused["ok"].clone(), refused["code"].clone()), (json!(false), json!("SAME_DIR")));
    assert_eq!(c.call("tag:list", vec![]).as_array().unwrap().len(), 1, "the database reopened");
    assert!(!r.host.calls().contains(&HostCall::Relaunch));
}

#[test]
fn an_attachment_survives_until_its_last_reference_goes() {
    let r = rig();
    let c = Caller::new(&r.svc);
    let a = c.call("todo:create", vec![json!({"title": "a"})])["id"].as_i64().unwrap();
    let b = c.call("todo:create", vec![json!({"title": "b"})])["id"].as_i64().unwrap();
    let bytes = json!([1, 2, 3, 4, 5]);
    let one = c.call("attachment:add-buffer", vec![json!({"todoId": a, "fileName": "x.bin", "mimeType": "", "data": bytes})]);
    let two = c.call("attachment:add-buffer", vec![json!({"todoId": b, "fileName": "x.bin", "mimeType": "", "data": bytes})]);
    assert_eq!(one["sha256"], two["sha256"], "same bytes, one blob");
    let url = one["url"].as_str().unwrap();
    let file = r.svc.resolve_attachment_url(url).expect("the url resolves");
    assert!(file.exists());
    c.call("attachment:delete", vec![one["id"].clone()]);
    assert!(file.exists(), "todo b still references the blob");
    c.call("todo:delete", vec![json!(b)]);
    assert!(!file.exists(), "no reference left, the blob is collected");
}

#[test]
fn startup_sweeps_blobs_no_row_references() {
    let r = rig();
    let orphan = r.svc.data_dir().join("attachments").join(format!("{}.png", "a".repeat(64)));
    std::fs::create_dir_all(orphan.parent().unwrap()).unwrap();
    std::fs::write(&orphan, b"x").unwrap();
    let host = std::sync::Arc::new(lizmeter_services::os::RecordingHost::default());
    let (_again, report) =
        lizmeter_services::Services::open(lizmeter_db::data_location::DataLocation::new(&r.user_data), host, &r.projects)
            .unwrap();
    assert!(report.swept_orphans);
    assert!(!orphan.exists());
}

#[test]
fn two_instances_on_one_data_folder_cannot_both_start() {
    let r = rig();
    let tmp = tempfile::tempdir().unwrap();
    let user_data = tmp.path().join("userData");
    let projects = tmp.path().join("projects");
    let host = std::sync::Arc::new(lizmeter_services::os::RecordingHost::default());
    let location = || lizmeter_db::data_location::DataLocation::new(&user_data);

    let (first, _) =
        lizmeter_services::Services::open_guarded_with(location(), host.clone(), &projects, None).unwrap();
    first.create_tag(&lizmeter_core::CreateTagInput { name: "mine".into(), color: "#7aa2f7".into() }).unwrap();

    let refused = lizmeter_services::Services::open_guarded_with(location(), host.clone(), &projects, None)
        .err()
        .expect("the second instance is refused");
    let text = refused.to_string();
    assert!(text.contains("already running"), "{text}");
    assert!(text.contains(&format!("process {}", std::process::id())), "{text}");
    assert_eq!(first.list_tags().unwrap().len(), 1, "the running instance is undisturbed");

    drop(first);
    let (again, _) = lizmeter_services::Services::open_guarded_with(location(), host, &projects, None).unwrap();
    assert_eq!(again.list_tags().unwrap()[0].name, "mine", "the data survived the refusal");
    drop(r);
}

#[test]
fn the_editor_image_resolver_serves_stored_attachments_and_nothing_else() {
    let r = rig();
    let todo = r.svc.create_todo(&lizmeter_core::CreateTodoInput { title: "pic".into(), ..Default::default() }).unwrap();
    let added = r
        .svc
        .add_attachment_buffer(&lizmeter_core::AddTodoAttachmentBufferInput {
            todo_id: todo.id,
            file_name: "shot.png".into(),
            mime_type: "image/png".into(),
            data: vec![137, 80, 78, 71],
        })
        .unwrap();
    let resolve = r.svc.image_resolver();
    let file = resolve(&added.url).expect("the attachment url resolves");
    assert_eq!(std::fs::read(file).unwrap(), vec![137, 80, 78, 71]);
    assert_eq!(resolve("https://example.com/a.png"), None);
    assert_eq!(resolve("app-media://attachments/../../secret.png"), None);
    assert_eq!(resolve(&format!("app-media://attachments/{}.png", "0".repeat(64))).map(|p| p.exists()), Some(false));
}

#[test]
fn a_custom_data_folder_is_guarded_without_a_lock_file_in_it() {
    let tmp = tempfile::tempdir().unwrap();
    let user_data = tmp.path().join("userData");
    let shared = tmp.path().join("shared-cloud-folder");
    std::fs::create_dir_all(&user_data).unwrap();
    std::fs::create_dir_all(&shared).unwrap();
    std::fs::write(
        user_data.join("data-location.json"),
        serde_json::json!({ "dataDir": shared.to_string_lossy() }).to_string(),
    )
    .unwrap();
    let host = std::sync::Arc::new(lizmeter_services::os::RecordingHost::default());
    let location = || lizmeter_db::data_location::DataLocation::new(&user_data);

    let (first, _) = lizmeter_services::Services::open_guarded_with(location(), host.clone(), tmp.path(), None).unwrap();
    let names = |dir: &std::path::Path| -> Vec<String> {
        std::fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()
    };
    assert!(names(&user_data).iter().any(|n| n == "lizmeter.lock"), "the per-user folder holds the lock file");
    assert!(!names(&shared).iter().any(|n| n.starts_with("lizmeter.lock")), "the shared folder gets none");

    // A second device identity (another per-user folder) pointed at the same shared folder is refused too.
    let other_user_data = tmp.path().join("userData2");
    std::fs::create_dir_all(&other_user_data).unwrap();
    std::fs::write(
        other_user_data.join("data-location.json"),
        serde_json::json!({ "dataDir": shared.to_string_lossy() }).to_string(),
    )
    .unwrap();
    let refused = lizmeter_services::Services::open_guarded_with(
        lizmeter_db::data_location::DataLocation::new(&other_user_data),
        host,
        tmp.path(),
        None,
    )
    .err()
    .expect("same shared folder, second writer");
    assert!(refused.to_string().contains("already running"), "{refused}");
    drop(first);
}

#[test]
fn the_same_bytes_attached_under_two_extensions_leave_no_file_behind() {
    let r = rig();
    let todo = r.svc.create_todo(&lizmeter_core::CreateTodoInput { title: "t".into(), ..Default::default() }).unwrap();
    let add = |name: &str| {
        r.svc
            .add_attachment_buffer(&lizmeter_core::AddTodoAttachmentBufferInput {
                todo_id: todo.id,
                file_name: name.into(),
                mime_type: String::new(),
                data: vec![9, 9, 9],
            })
            .unwrap()
    };
    let (png, jpg) = (add("x.png"), add("x.jpg"));
    r.svc.delete_attachment(jpg.id).unwrap();
    r.svc.delete_attachment(png.id).unwrap();
    let left = std::fs::read_dir(r.svc.data_dir().join("attachments")).unwrap().count();
    assert_eq!(left, 0);
}
