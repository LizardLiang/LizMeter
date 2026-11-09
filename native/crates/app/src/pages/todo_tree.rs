//! Pure helpers behind todo nesting (`utils/todoTree.ts`): which todos the pickers may offer.

use lizmeter_core::Todo;
use std::collections::{HashMap, HashSet};

/// Every todo below `root`, at any depth. The visited set also stops a cycle from looping.
pub fn descendant_ids(todos: &[Todo], root: i64) -> HashSet<i64> {
    let mut by_parent: HashMap<i64, Vec<i64>> = HashMap::new();
    for t in todos {
        if let Some(p) = t.parent_id {
            by_parent.entry(p).or_default().push(t.id);
        }
    }
    let mut found = HashSet::new();
    let mut queue = vec![root];
    while let Some(current) = queue.pop() {
        for &child in by_parent.get(&current).into_iter().flatten() {
            if found.insert(child) {
                queue.push(child);
            }
        }
    }
    found
}

/// Every todo above `start`, nearest first, bounded by the same visited guard.
pub fn ancestor_ids(todos: &[Todo], start: i64) -> HashSet<i64> {
    let by_id: HashMap<i64, &Todo> = todos.iter().map(|t| (t.id, t)).collect();
    let mut found = HashSet::new();
    let mut cursor = by_id.get(&start).and_then(|t| t.parent_id);
    while let Some(id) = cursor {
        if !found.insert(id) {
            break;
        }
        cursor = by_id.get(&id).and_then(|t| t.parent_id);
    }
    found
}

/// Todos that `child` could be nested under: not itself, nothing already in its subtree and not
/// the parent it already has. `child` is `None` while creating, where nothing is excluded yet.
pub fn linkable_parents(todos: &[Todo], child: Option<i64>, current_parent: Option<i64>) -> Vec<Todo> {
    let blocked = child.map(|c| descendant_ids(todos, c)).unwrap_or_default();
    todos.iter().filter(|t| Some(t.id) != child && Some(t.id) != current_parent && !blocked.contains(&t.id)).cloned().collect()
}

/// Todos that could become a sub-issue of `parent`: not itself, not one already filed there and
/// none of its ancestors. Moving a grandchild up to a direct child shortens the chain.
pub fn linkable_children(todos: &[Todo], parent: i64) -> Vec<Todo> {
    let blocked = ancestor_ids(todos, parent);
    todos.iter().filter(|t| t.id != parent && t.parent_id != Some(parent) && !blocked.contains(&t.id)).cloned().collect()
}

#[cfg(test)]
pub mod fixture {
    use lizmeter_core::{Todo, TodoSource, TodoState};

    pub fn todo(id: i64, parent: Option<i64>) -> Todo {
        Todo {
            id,
            title: format!("t{id}"),
            notes: None,
            state: TodoState { id: 1, label: "Todo".into(), color: "#7aa2f7".into(), position: 0, is_completed: false, is_default: true, created_at: String::new() },
            project: None,
            labels: vec![],
            milestone: None,
            priority: 0,
            start_date: None,
            due_date: None,
            source: TodoSource::User,
            source_label: None,
            parent_id: parent,
            parent_title: None,
            child_count: 0,
            completed_child_count: 0,
            created_at: String::new(),
            completed_at: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ancestor_ids, descendant_ids, linkable_children, linkable_parents};
    use super::fixture::todo;
    use lizmeter_core::Todo;

    // 1 -> 2 -> 3, and 4 alone.
    fn tree() -> Vec<Todo> {
        vec![todo(1, None), todo(2, Some(1)), todo(3, Some(2)), todo(4, None)]
    }

    #[test]
    fn walks_find_the_whole_subtree_and_the_whole_chain() {
        assert_eq!(descendant_ids(&tree(), 1), [2, 3].into());
        assert_eq!(ancestor_ids(&tree(), 3), [2, 1].into());
    }

    #[test]
    fn a_cycle_cannot_loop_the_walks() {
        let cyclic = vec![todo(1, Some(2)), todo(2, Some(1))];
        assert_eq!(descendant_ids(&cyclic, 1), [1, 2].into());
        assert_eq!(ancestor_ids(&cyclic, 1), [2, 1].into());
    }

    #[test]
    fn a_parent_cannot_be_the_todo_its_own_subtree_or_its_current_parent() {
        let ids: Vec<i64> = linkable_parents(&tree(), Some(1), None).iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![4]);
        let ids: Vec<i64> = linkable_parents(&tree(), Some(3), Some(2)).iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![1, 4]);
        assert_eq!(linkable_parents(&tree(), None, None).len(), 4);
    }

    #[test]
    fn a_child_cannot_be_an_ancestor_or_already_a_child() {
        let ids: Vec<i64> = linkable_children(&tree(), 2).iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![4]);
        let ids: Vec<i64> = linkable_children(&tree(), 1).iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![3, 4]);
    }
}
