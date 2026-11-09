//! What the Issues page decides without a window: which provider tabs show, how an issue of each
//! provider becomes one card, what the search keeps, and the wording of the empty states.

use lizmeter_core::{Issue, IssueProviderStatus, JiraIssue, LinearIssue};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Tab {
    Github,
    Linear,
    Jira,
}

impl Tab {
    pub fn label(self) -> &'static str {
        match self {
            Tab::Github => "GitHub",
            Tab::Linear => "Linear",
            Tab::Jira => "Jira",
        }
    }
}

/// The tabs that have a working configuration, in the order the page lists them.
pub fn available_tabs(status: &IssueProviderStatus) -> Vec<Tab> {
    let mut tabs = vec![];
    if status.configured {
        tabs.push(Tab::Github);
    }
    if status.linear_configured && status.linear_team_selected {
        tabs.push(Tab::Linear);
    }
    if status.jira_configured && status.jira_domain_set {
        tabs.push(Tab::Jira);
    }
    tabs
}

/// The tab shown: the chosen one when it is available, else the first. `None` when nothing is configured.
pub fn effective_tab(available: &[Tab], active: Tab) -> Option<Tab> {
    if available.contains(&active) { Some(active) } else { available.first().copied() }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateKind {
    Started,
    Unstarted,
    Backlog,
}

/// How an issue's own comments are fetched when its card opens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommentsOf {
    Github { repo: String, number: i64 },
    Linear { id: String },
    Jira { key: String },
}

/// One card of the list, whichever provider it came from.
#[derive(Clone, Debug, PartialEq)]
pub struct Card {
    /// Keys the open card: `repo#number` for GitHub, the provider id otherwise.
    pub id: String,
    pub number: String,
    pub state: String,
    pub state_kind: StateKind,
    pub title: String,
    pub repo: Option<String>,
    /// Linear: the numeric priority, shown as a coloured badge when above 0.
    pub priority: Option<(String, i64)>,
    /// GitHub labels as `(name, hex color without #)`.
    pub labels: Vec<(String, String)>,
    pub assignee: Option<String>,
    pub url: String,
    pub comments: CommentsOf,
    /// Lowercased fields the search matches against.
    pub haystack: Vec<String>,
}

pub fn priority_label(priority: i64) -> &'static str {
    match priority {
        1 => "Urgent",
        2 => "High",
        3 => "Medium",
        4 => "Low",
        _ => "No priority",
    }
}

pub fn github_card(i: &Issue) -> Card {
    let number = format!("#{}", i.number);
    Card {
        id: format!("{}#{}", i.repo, i.number),
        state_kind: if i.state == "open" { StateKind::Started } else { StateKind::Backlog },
        haystack: vec![i.title.to_lowercase(), i.repo.to_lowercase(), number.clone()],
        number,
        state: i.state.clone(),
        title: i.title.clone(),
        repo: Some(i.repo.clone()),
        priority: None,
        labels: i.labels.iter().map(|l| (l.name.clone(), l.color.clone())).collect(),
        assignee: None,
        url: i.url.clone(),
        comments: CommentsOf::Github { repo: i.repo.clone(), number: i.number },
    }
}

pub fn linear_card(i: &LinearIssue) -> Card {
    Card {
        id: i.id.clone(),
        number: i.identifier.clone(),
        state: i.state.name.clone(),
        state_kind: match i.state.kind.as_str() {
            "started" => StateKind::Started,
            "backlog" => StateKind::Backlog,
            _ => StateKind::Unstarted,
        },
        title: i.title.clone(),
        repo: None,
        priority: (i.priority > 0).then(|| (priority_label(i.priority).to_string(), i.priority)),
        labels: vec![],
        assignee: None,
        url: i.url.clone(),
        comments: CommentsOf::Linear { id: i.id.clone() },
        haystack: vec![i.title.to_lowercase(), i.identifier.to_lowercase()],
    }
}

pub fn jira_card(i: &JiraIssue) -> Card {
    Card {
        id: i.id.clone(),
        number: i.key.clone(),
        state: i.status.clone(),
        state_kind: StateKind::Started,
        title: i.title.clone(),
        repo: None,
        priority: i.priority.clone().filter(|p| !p.is_empty()).map(|p| (p, 0)),
        labels: vec![],
        assignee: i.assignee.clone().filter(|a| !a.is_empty()),
        url: i.url.clone(),
        comments: CommentsOf::Jira { key: i.key.clone() },
        haystack: vec![i.title.to_lowercase(), i.key.to_lowercase()],
    }
}

/// The cards the search keeps (a blank search keeps all).
pub fn filter_cards<'a>(cards: &'a [Card], search: &str) -> Vec<&'a Card> {
    let q = search.trim().to_lowercase();
    if q.is_empty() {
        return cards.iter().collect();
    }
    cards.iter().filter(|c| c.haystack.iter().any(|h| h.contains(&q))).collect()
}

/// `(title, description)` of the empty list of a provider.
pub fn empty_text(tab: Tab) -> (&'static str, &'static str) {
    match tab {
        Tab::Github => ("No open issues assigned to you", "Visit GitHub to check your assignments."),
        Tab::Linear => ("No open issues in this team", "All caught up, or no issues match the active filters."),
        Tab::Jira => ("No issues found", "Check your project key or JQL filter in Settings."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lizmeter_core::{IssueLabel, LinearIssueState};

    fn status(github: bool, linear: (bool, bool), jira: (bool, bool)) -> IssueProviderStatus {
        IssueProviderStatus {
            configured: github,
            provider: github.then(|| "github".to_string()),
            linear_configured: linear.0,
            linear_team_selected: linear.1,
            jira_configured: jira.0,
            jira_domain_set: jira.1,
        }
    }

    #[test]
    fn nothing_configured_shows_no_tab() {
        let none = status(false, (false, false), (false, false));
        assert!(available_tabs(&none).is_empty());
        assert_eq!(effective_tab(&[], Tab::Github), None);
    }

    #[test]
    fn linear_needs_a_team_and_jira_needs_a_domain() {
        let st = status(false, (true, false), (true, false));
        assert!(available_tabs(&st).is_empty());
        let st = status(true, (true, true), (true, true));
        assert_eq!(available_tabs(&st), [Tab::Github, Tab::Linear, Tab::Jira]);
    }

    #[test]
    fn an_unavailable_choice_falls_back_to_the_first_tab() {
        let tabs = [Tab::Linear, Tab::Jira];
        assert_eq!(effective_tab(&tabs, Tab::Github), Some(Tab::Linear));
        assert_eq!(effective_tab(&tabs, Tab::Jira), Some(Tab::Jira));
    }

    #[test]
    fn github_search_matches_title_repo_and_number() {
        let issue = Issue {
            number: 42,
            title: "Fix the Timer".into(),
            url: "u".into(),
            repo: "Lizard/LizMeter".into(),
            state: "open".into(),
            labels: vec![IssueLabel { name: "bug".into(), color: "d73a4a".into() }],
            updated_at: String::new(),
        };
        let cards = [github_card(&issue)];
        assert_eq!(filter_cards(&cards, "timer").len(), 1);
        assert_eq!(filter_cards(&cards, "lizmeter").len(), 1);
        assert_eq!(filter_cards(&cards, "#42").len(), 1);
        assert_eq!(filter_cards(&cards, "  ").len(), 1);
        assert_eq!(filter_cards(&cards, "zzz").len(), 0);
        assert_eq!(cards[0].state_kind, StateKind::Started);
        assert_eq!(cards[0].id, "Lizard/LizMeter#42");
    }

    #[test]
    fn linear_cards_badge_a_priority_above_zero_and_colour_by_state_type() {
        let mk = |priority, kind: &str| LinearIssue {
            id: "i".into(),
            identifier: "LIZ-7".into(),
            title: "t".into(),
            url: "u".into(),
            priority,
            state: LinearIssueState { name: "Todo".into(), kind: kind.into() },
            updated_at: String::new(),
        };
        assert_eq!(linear_card(&mk(0, "started")).priority, None);
        assert_eq!(linear_card(&mk(2, "started")).priority, Some(("High".to_string(), 2)));
        assert_eq!(linear_card(&mk(0, "backlog")).state_kind, StateKind::Backlog);
        assert_eq!(linear_card(&mk(0, "triage")).state_kind, StateKind::Unstarted);
        assert_eq!(priority_label(9), "No priority");
    }

    #[test]
    fn jira_cards_keep_priority_and_assignee_chips_only_when_set() {
        let mk = |priority: Option<&str>, assignee: Option<&str>| JiraIssue {
            id: "1".into(),
            key: "PROJ-1".into(),
            title: "t".into(),
            url: "u".into(),
            status: "In Progress".into(),
            priority: priority.map(String::from),
            assignee: assignee.map(String::from),
            issue_type: None,
            labels: vec![],
        };
        let card = jira_card(&mk(Some("High"), Some("Liz")));
        assert_eq!(card.priority, Some(("High".to_string(), 0)));
        assert_eq!(card.assignee.as_deref(), Some("Liz"));
        let bare = jira_card(&mk(None, Some("")));
        assert!(bare.priority.is_none() && bare.assignee.is_none());
    }
}
