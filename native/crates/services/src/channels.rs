//! The IPC channels of `electron/preload/index.ts` and who owns each in the native app.

/// Channels answered by [`crate::Services::dispatch`] in this phase.
pub const SERVICE_CHANNELS: [&str; 115] = [
    "session:save",
    "session:save-with-tracking",
    "session:list",
    "session:delete",
    "session:update-duration",
    "settings:get",
    "settings:save",
    "settings:get-value",
    "settings:set-value",
    "tag:create",
    "tag:list",
    "tag:update",
    "tag:delete",
    "tag:assign",
    "tag:unassign",
    "tag:list-for-session",
    "todo:create",
    "todo:list",
    "todo:update",
    "todo:delete",
    "todo:clear-completed",
    "todo:list-milestones",
    "attachment:add",
    "attachment:add-buffer",
    "attachment:list",
    "attachment:delete",
    "attachment:open",
    "attachment:reveal",
    "todo-state:list",
    "todo-state:create",
    "todo-state:update",
    "todo-state:delete",
    "todo-state:reorder",
    "todo-project:list",
    "todo-project:create",
    "todo-project:update",
    "todo-project:delete",
    "todo-project:reorder",
    "todo-label:list",
    "todo-label:create",
    "todo-label:update",
    "todo-label:delete",
    "data-location:get",
    "data-location:choose",
    "data-location:move",
    "data-location:reveal",
    "sync:get-status",
    "sync:disable",
    "sync:list-notices",
    "sync:dismiss-notice",
    "sync:pending-renumber-count",
    "sync:renumber-legacy-ids",
    "shell:open-external",
    "notification:timer-complete",
    "claude-tracker:scan",
    "claude-tracker:track-selected",
    "claude-tracker:stop",
    "claude-tracker:pause",
    "claude-tracker:resume",
    "claude-tracker:scan-all",
    "claude-tracker:get-projects",
    "claude-tracker:get-for-session",
    "nvim-activity:list-by-date",
    "worklog:mark-logged",
    "worklog:log",
    "issues:list",
    "issues:provider-status",
    "issues:set-token",
    "issues:test-token",
    "issues:fetch-comments",
    "issues:delete-token",
    "linear:set-token",
    "linear:delete-token",
    "linear:test-connection",
    "linear:list-teams",
    "linear:set-team",
    "linear:get-team",
    "linear:fetch-issues",
    "linear:fetch-comments",
    "linear:provider-status",
    "jira:set-token",
    "jira:delete-token",
    "jira:test-connection",
    "jira:fetch-issues",
    "jira:fetch-comments",
    "jira:provider-status",
    "jira:set-auth-type",
    "jira:set-domain",
    "jira:set-email",
    "jira:set-project-key",
    "jira:set-jql-filter",
    "music:play",
    "music:stop",
    "music:meta",
    "music:library:list",
    "music:library:delete",
    "music:library:clear",
    "music:playlist:create",
    "music:playlist:rename",
    "music:playlist:delete",
    "music:playlist:list",
    "music:playlist:tracks",
    "music:playlist:add-track",
    "music:playlist:remove-track",
    "music:playlist:reorder",
    "music:cache:stats",
    "music:cache:clear",
    "music:cache:set-limit",
    "music:binary:status",
    "music:binary:info",
    "music:binary:download",
    "music:import:cancel",
    "music:reset",
    "music:integrity:check",
    "music:integrity:repair",
];

/// Who answers a channel that [`SERVICE_CHANNELS`] does not list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deferred {
    /// The desktop widget and its avatars.
    Widget,
}

impl Deferred {
    /// The plan phase that ports it.
    pub fn phase(self) -> u8 {
        match self {
            Deferred::Widget => 11,
        }
    }
}

/// The later-phase owner of `channel`, or `None` for a channel this phase owns or nobody knows.
pub fn deferred_owner(channel: &str) -> Option<Deferred> {
    if SERVICE_CHANNELS.contains(&channel) {
        return None;
    }
    let (prefix, _) = channel.split_once(':')?;
    match prefix {
        "widget" => Some(Deferred::Widget),
        _ => None,
    }
}
