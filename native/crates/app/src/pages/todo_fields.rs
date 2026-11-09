//! The property fields the create dialog and the detail page share: state, priority, project,
//! labels, milestone, start and due date.

use super::todo_widgets::*;
use crate::select::{SelectBox, SelectOption};
use gpui::*;
use lizmeter_core::*;

pub struct FormFields {
    pub state: Entity<SelectBox>,
    pub priority: Entity<SelectBox>,
    pub project: Entity<Combobox>,
    pub label: Entity<Combobox>,
    pub milestone: Entity<Combobox>,
    pub start: Entity<DatePicker>,
    pub due: Entity<DatePicker>,
}

impl FormFields {
    pub fn new<T: 'static>(prefix: &'static str, window: &mut Window, cx: &mut Context<T>) -> Self {
        let state = cx.new(|cx| SelectBox::new(format!("{prefix}-state"), "", 60.0, 4000.0, false, cx).filled());
        let priority = cx.new(|cx| SelectBox::new(format!("{prefix}-priority"), "", 60.0, 4000.0, false, cx).filled());
        let project = cx.new(|cx| Combobox::new(format!("{prefix}-project"), "", 60, false, window, cx));
        let label = cx.new(|cx| Combobox::new(format!("{prefix}-label"), "", 40, true, window, cx));
        let milestone = cx.new(|cx| Combobox::new(format!("{prefix}-milestone"), "", 120, false, window, cx));
        let start = cx.new(|cx| DatePicker::new(format!("{prefix}-start"), cx));
        let due = cx.new(|cx| DatePicker::new(format!("{prefix}-due"), cx));
        let options = TODO_PRIORITY_LABELS.iter().enumerate().map(|(i, l)| SelectOption::new(i.to_string(), *l, None)).collect();
        priority.update(cx, |p, cx| p.set_options(options, "0", cx));
        Self { state, priority, project, label, milestone, start, due }
    }

    pub fn any_open(&self, cx: &App) -> bool {
        self.state.read(cx).is_open() || self.priority.read(cx).is_open() || self.project.read(cx).is_open() || self.label.read(cx).is_open() || self.milestone.read(cx).is_open() || self.start.read(cx).is_open() || self.due.read(cx).is_open()
    }

    pub fn set_states<T: 'static>(&self, states: &[TodoState], selected: i64, cx: &mut Context<T>) {
        let options = states.iter().map(|s| SelectOption::new(s.id.to_string(), &s.label, Some(s.color.clone()))).collect();
        self.state.update(cx, |s, cx| s.set_options(options, &selected.to_string(), cx));
    }

    pub fn set_priority<T: 'static>(&self, priority: i64, cx: &mut Context<T>) {
        let options = TODO_PRIORITY_LABELS.iter().enumerate().map(|(i, l)| SelectOption::new(i.to_string(), *l, None)).collect();
        self.priority.update(cx, |s, cx| s.set_options(options, &priority.to_string(), cx));
    }

    pub fn set_suggestions<T: 'static>(&self, projects: &[TodoProject], labels: &[String], milestones: &[String], cx: &mut Context<T>) {
        let names = projects.iter().map(|p| p.name.clone()).collect();
        self.project.update(cx, |c, cx| c.set_options(names, cx));
        self.label.update(cx, |c, cx| c.set_options(labels.to_vec(), cx));
        self.milestone.update(cx, |c, cx| c.set_options(milestones.to_vec(), cx));
    }
}

/// A labelled field of the form.
pub fn field(label: &str, child: impl IntoElement) -> Div {
    div().flex().flex_col().min_w_0().mb(px(12.0)).child(field_label(label)).child(child)
}

/// How many columns `repeat(auto-fit, minmax(9rem, 1fr))` makes of `inner_w` with a 10px gap.
pub fn grid_columns(inner_w: f32) -> usize {
    (((inner_w + 10.0) / (144.0 + 10.0)).floor() as usize).max(1)
}

/// Lays the fields out in the auto-fit grid. A wide item takes a whole row.
pub fn grid(items: Vec<(bool, AnyElement)>, inner_w: f32) -> Div {
    let cols = grid_columns(inner_w);
    let col_w = (inner_w - 10.0 * (cols as f32 - 1.0)) / cols as f32;
    let mut rows: Vec<Div> = vec![];
    let mut current: Option<(Div, usize)> = None;
    for (wide, el) in items {
        if wide {
            if let Some((r, _)) = current.take() {
                rows.push(r);
            }
            rows.push(div().flex().flex_row().w_full().child(div().w_full().child(el)));
            continue;
        }
        let (r, n) = current.take().unwrap_or((div().flex().flex_row().gap(px(10.0)), 0));
        let r = r.child(div().w(px(col_w)).flex_shrink_0().child(el));
        if n + 1 == cols {
            rows.push(r);
        } else {
            current = Some((r, n + 1));
        }
    }
    if let Some((r, _)) = current {
        rows.push(r);
    }
    div().flex().flex_col().gap(px(10.0)).children(rows)
}

#[cfg(test)]
mod tests {
    use super::grid_columns;

    #[test]
    fn the_grid_fits_as_many_9rem_columns_as_the_width_allows() {
        assert_eq!(grid_columns(100.0), 1);
        assert_eq!(grid_columns(144.0), 1);
        assert_eq!(grid_columns(298.0), 2);
        assert_eq!(grid_columns(504.0), 3);
        assert_eq!(grid_columns(592.0), 3);
    }
}
