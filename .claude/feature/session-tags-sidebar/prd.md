# PRD: Session Tags & Sidebar

| Field   | Value                          |
|---------|--------------------------------|
| Version | 1.0                            |
| Date    | 2026-02-20                     |
| Author  | Athena (PM Agent)              |
| Status  | Draft                          |

---

## Executive Summary

LizMeter currently stores session history as a flat chronological list with no categorization. Users have no way to label, group, or filter their focus sessions by project, context, or activity type. Additionally, the session history and timer share a single narrow column layout, limiting how much information can be displayed at once.

This feature introduces **tags** as first-class entities that can be assigned to sessions, and a **collapsible sidebar** that consolidates the current session panel, session history, tag management, and tag-based filtering into a structured, high-quality UI surface. The sidebar transforms LizMeter from a single-panel timer into a richer productivity workspace while preserving the clean Tokyo Night aesthetic.

---

## Goals

1. **Categorization** -- Enable users to tag sessions with reusable, color-coded labels (e.g., "Deep Work", "Code Review", "Study").
2. **Discoverability** -- Surface session history, current session state, and tag management in a persistent sidebar rather than buried below the timer.
3. **Filtering** -- Allow single-tag click-to-filter on the session history list so users can quickly review sessions for a specific project or activity.
4. **Workflow integration** -- Support tagging both during an active timer and retroactively on past sessions.
5. **Visual quality** -- Deliver a sidebar that is distinctive, production-grade, and cohesive with the Tokyo Night dark theme. Not generic -- it should feel intentional and polished.

---

## Non-Goals

- Multi-tag filter (AND/OR logic). Only single-tag click-to-filter is in scope.
- Tag hierarchy or nesting.
- Drag-and-drop tag reordering.
- Session search by title text.
- Tag import/export.
- Keyboard shortcuts for tag operations (may come later).
- Mobile or responsive layout (Electron desktop only).

---

## User Stories

### US-1: Create a tag
**As a** user, **I want to** create a new tag with a name, **so that** I can categorize my sessions.

**Acceptance Criteria:**
- User can create a tag from the Tag Management section of the sidebar.
- Tag name is required, non-empty, max 50 characters, trimmed of leading/trailing whitespace.
- A color from the Tokyo Night palette is auto-assigned on creation.
- Duplicate tag names (case-insensitive) are rejected with a clear error message.
- The new tag appears immediately in the tag list without page reload.

### US-2: Rename a tag
**As a** user, **I want to** rename an existing tag, **so that** I can fix typos or update naming conventions.

**Acceptance Criteria:**
- User can inline-edit a tag name from the Tag Management section.
- Same validation rules as creation (non-empty, max 50 chars, no duplicate names).
- Rename propagates visually to all sessions that carry that tag.

### US-3: Change tag color
**As a** user, **I want to** change a tag's color, **so that** I can personalize my tag palette.

**Acceptance Criteria:**
- User can pick from the 8 Tokyo Night palette colors (see Data Model).
- Color change is reflected immediately on all tag badges across the UI.

### US-4: Delete a tag
**As a** user, **I want to** delete a tag I no longer need, **so that** my tag list stays clean.

**Acceptance Criteria:**
- Deleting a tag removes it from all sessions (cascading delete on `session_tags` junction).
- A confirmation prompt is shown before deletion ("Delete tag 'X'? It will be removed from N sessions.").
- The tag disappears from the sidebar tag list, all session badges, and any active filter.

### US-5: Assign tags to the current session
**As a** user, **I want to** assign tags while my timer is running, **so that** I can categorize my work in context.

**Acceptance Criteria:**
- A tag picker is available in the Current Session panel of the sidebar.
- Tags can be added/removed while the timer is in `running`, `paused`, or `idle` state.
- When the session completes and is saved, the assigned tags are persisted via the junction table.
- Tag assignments for the current (unsaved) session are held in React state until save.

### US-6: Edit tags on past sessions
**As a** user, **I want to** add or remove tags on sessions in my history, **so that** I can retroactively organize past work.

**Acceptance Criteria:**
- Each session in the history list has a mechanism (e.g., click to expand, or a tag icon button) to open a tag picker.
- Adding/removing a tag on a past session immediately persists via IPC.
- The session item re-renders to show updated tag badges.

### US-7: Filter session history by tag
**As a** user, **I want to** click a tag to filter the history list, **so that** I can see only sessions for that project/activity.

**Acceptance Criteria:**
- Clicking a tag badge in the sidebar (either in tag management or on a session) activates single-tag filter.
- The session history list shows only sessions with that tag.
- The active filter is visually indicated (highlighted tag, filter indicator).
- Clicking the same tag again deactivates the filter (shows all sessions).
- Pagination/offset resets to 0 when filter is activated or deactivated.

### US-8: Toggle the sidebar
**As a** user, **I want to** collapse and expand the sidebar, **so that** I can focus on the timer when I don't need the sidebar.

**Acceptance Criteria:**
- A toggle button is visible in both collapsed and expanded states.
- Collapsed state shows a thin vertical strip (40-48px) with icon buttons for expand, and optionally mini-icons for sections.
- Expanded state shows the full sidebar (280-320px width).
- Collapse/expand animates smoothly (CSS transition, ~200ms).
- Sidebar state (expanded/collapsed) is persisted across app restarts via the settings table.
- The timer/main content area adjusts its layout to fill available space.

---

## Functional Requirements

### P0 -- Must Have

| ID   | Requirement |
|------|-------------|
| F-01 | **Tags table** -- `tags` table with `id` (TEXT PK, UUID), `name` (TEXT UNIQUE), `color` (TEXT), `created_at` (TEXT ISO 8601). |
| F-02 | **Junction table** -- `session_tags` table with `session_id` (TEXT FK), `tag_id` (TEXT FK), composite PK. Cascade delete on both FKs. |
| F-03 | **Tag CRUD IPC** -- `tag:create`, `tag:list`, `tag:update`, `tag:delete` channels with full validation in main process. |
| F-04 | **Tag assignment IPC** -- `tag:assign` and `tag:unassign` channels to link/unlink a tag to a session. |
| F-05 | **Session list with tags** -- Existing `session:list` response must include an array of tags for each session (join query). |
| F-06 | **Filter by tag IPC** -- `session:list` accepts an optional `tagId` filter parameter. When present, only sessions with that tag are returned. |
| F-07 | **Sidebar component** -- Collapsible sidebar with 4 sections: Current Session, Session History, Tag Management, Tag Filter. |
| F-08 | **TagBadge component** -- Reusable pill/badge showing tag name + color dot. Clickable for filter. |
| F-09 | **TagPicker component** -- Dropdown/popover for selecting tags to assign to a session. Shows all tags with checkboxes. |
| F-10 | **Current Session panel** -- Shows timer status, title, assigned tags (editable via TagPicker) for the in-progress session. |
| F-11 | **Sidebar toggle** -- Button to expand/collapse sidebar with smooth animation. |

### P1 -- Should Have

| ID   | Requirement |
|------|-------------|
| F-12 | **Tag color picker** -- UI to change a tag's color from the 8-color Tokyo Night palette. |
| F-13 | **Delete confirmation** -- Modal or inline confirmation before tag deletion, showing affected session count. |
| F-14 | **Sidebar state persistence** -- Remember expanded/collapsed state across app restarts (stored in settings table). |
| F-15 | **Auto-assign color** -- Cycle through palette colors for newly created tags so adjacent tags get distinct colors. |
| F-16 | **Inline tag rename** -- Double-click or edit icon to rename a tag in the Tag Management section. |

### P2 -- Nice to Have

| ID   | Requirement |
|------|-------------|
| F-17 | **Tag count badges** -- Show session count next to each tag in the management section. |
| F-18 | **Empty state illustrations** -- Friendly empty states for "no sessions", "no tags", "no results for filter". |
| F-19 | **Sidebar section collapse** -- Individual sections within the sidebar can be collapsed independently. |

---

## Non-Functional Requirements

| ID    | Requirement |
|-------|-------------|
| NF-01 | **Performance** -- Tag list queries must return in <50ms for up to 100 tags. Session list with tag join must return in <100ms for 1000 sessions. |
| NF-02 | **Data integrity** -- All tag/session_tag mutations wrapped in SQLite transactions. Foreign key enforcement enabled (`PRAGMA foreign_keys = ON`). |
| NF-03 | **Type safety** -- All new types added to `src/shared/types.ts`. ElectronAPI interface extended. No `any` types. |
| NF-04 | **Test coverage** -- Database functions: unit tests with `:memory:` DB via sql.js shim. Renderer components: Vitest + jsdom with mocked electronAPI. |
| NF-05 | **Visual consistency** -- All new UI uses inline `React.CSSProperties`. Colors reference Tokyo Night CSS variables. No new CSS files. |
| NF-06 | **Accessibility** -- Sidebar toggle, tag buttons, and picker elements have `aria-label` attributes. Focus management on popover open/close. |
| NF-07 | **Code style** -- All new code passes `bun run lint` and `bun run fmt:check`. Named exports only. Explicit `.ts`/`.tsx` import extensions. |

---

## Data Model Changes

### New Table: `tags`

```sql
CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,   -- UUID v4
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color      TEXT NOT NULL,      -- one of the 8 palette hex values
  created_at TEXT NOT NULL       -- ISO 8601
);
```

### New Table: `session_tags`

```sql
CREATE TABLE IF NOT EXISTS session_tags (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_session_tags_tag_id ON session_tags(tag_id);
```

### Schema Migration

Add to `initDatabase()` after existing `CREATE TABLE IF NOT EXISTS` statements. The `IF NOT EXISTS` clauses make this safe for existing databases. `PRAGMA foreign_keys = ON` must be set after opening the connection (it is a per-connection setting, not persisted).

### Tokyo Night Tag Color Palette (8 colors)

| Key      | Hex       | Swatch Description |
|----------|-----------|--------------------|
| blue     | `#7aa2f7` | Tokyo Night blue   |
| purple   | `#bb9af7` | Tokyo Night purple |
| green    | `#9ece6a` | Tokyo Night green  |
| yellow   | `#e0af68` | Tokyo Night yellow |
| red      | `#f7768e` | Tokyo Night red    |
| cyan     | `#7dcfff` | Bright cyan        |
| orange   | `#ff9e64` | Warm orange        |
| magenta  | `#c678dd` | Soft magenta       |

Auto-assignment cycles through this list in order. The `color` column stores the hex value directly.

### Modified Type: `Session`

```typescript
// Existing fields unchanged; add:
export interface SessionTag {
  id: string;
  name: string;
  color: string;
}

export interface Session {
  // ... existing fields ...
  tags: SessionTag[];  // NEW -- populated by join query
}
```

### New Types

```typescript
export interface Tag {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface CreateTagInput {
  name: string;
  color?: string; // optional override; auto-assigned if omitted
}

export interface UpdateTagInput {
  id: string;
  name?: string;
  color?: string;
}

export interface TagAssignInput {
  sessionId: string;
  tagId: string;
}

export interface ListSessionsInput {
  limit?: number;
  offset?: number;
  tagId?: string;  // NEW -- filter by tag
}
```

---

## IPC Channel Changes

### New Channels

| Channel          | Direction         | Input              | Output            | Description |
|------------------|-------------------|--------------------|-------------------|-------------|
| `tag:create`     | renderer -> main  | `CreateTagInput`   | `Tag`             | Create a new tag. Auto-assigns color if not provided. |
| `tag:list`       | renderer -> main  | `void`             | `Tag[]`           | List all tags, ordered by `created_at ASC`. |
| `tag:update`     | renderer -> main  | `UpdateTagInput`   | `Tag`             | Rename or recolor a tag. |
| `tag:delete`     | renderer -> main  | `string` (tag id)  | `{ deletedFromSessions: number }` | Delete tag and return count of sessions affected. |
| `tag:assign`     | renderer -> main  | `TagAssignInput`   | `void`            | Assign a tag to a session. No-op if already assigned. |
| `tag:unassign`   | renderer -> main  | `TagAssignInput`   | `void`            | Remove a tag from a session. No-op if not assigned. |
| `tag:count`      | renderer -> main  | `string` (tag id)  | `{ count: number }` | Count sessions with this tag (for delete confirmation). |

### Modified Channels

| Channel          | Change |
|------------------|--------|
| `session:list`   | Input gains optional `tagId: string`. When present, results are filtered to sessions that have that tag via a JOIN on `session_tags`. Response `Session` objects gain a `tags: SessionTag[]` array. |
| `session:save`   | No change to the channel itself. Tag assignment for the current session happens via separate `tag:assign` calls after save returns the session ID. |
| `session:delete` | No change needed -- `ON DELETE CASCADE` on `session_tags.session_id` handles cleanup. |

### ElectronAPI Extension

```typescript
export interface ElectronAPI {
  // ... existing ...
  tag: {
    create: (input: CreateTagInput) => Promise<Tag>;
    list: () => Promise<Tag[]>;
    update: (input: UpdateTagInput) => Promise<Tag>;
    delete: (id: string) => Promise<{ deletedFromSessions: number }>;
    assign: (input: TagAssignInput) => Promise<void>;
    unassign: (input: TagAssignInput) => Promise<void>;
    count: (id: string) => Promise<{ count: number }>;
  };
}
```

---

## UI Components

### Component Tree

```
App
 └── AppLayout                    (NEW -- flex row: sidebar + main content)
      ├── Sidebar                 (NEW -- collapsible, 280-320px expanded / 44px collapsed)
      │    ├── SidebarToggle      (NEW -- expand/collapse button)
      │    ├── CurrentSessionPanel (NEW -- timer status + tag picker)
      │    ├── TagManager         (NEW -- CRUD list of all tags)
      │    │    ├── TagBadge      (NEW -- reusable pill component)
      │    │    └── TagColorPicker (NEW -- palette grid popover)
      │    └── SessionHistory     (MOVED from TomatoClock into sidebar)
      │         ├── SessionHistoryItem (EXISTING -- gains tag badges + tag edit)
      │         └── TagPicker     (NEW -- checkbox popover for assigning tags)
      └── MainContent             (NEW -- wraps TomatoClock timer area)
           └── TimerView          (EXISTING -- unchanged)
```

### Sidebar Design Specifications

**Expanded state (280-320px):**
- Background: `var(--tn-panel)` (`#16213e`)
- Left border: 1px solid `var(--tn-border)` (`#292e42`)
- Position: right side of the app (sidebar-right pattern)
- Sections separated by subtle 1px dividers
- Section headers: uppercase, letter-spaced, `var(--tn-muted)` color, 11px font
- Smooth scroll within each section independently (overflow-y: auto)

**Collapsed state (44px):**
- Shows vertical icon strip: toggle icon, session icon, tag icon, history icon
- Icons use `var(--tn-muted)`, hover to `var(--tn-blue)`
- Tooltip on hover showing section name

**Animation:**
- Width transition: `width 200ms cubic-bezier(0.4, 0, 0.2, 1)`
- Content fades in/out: `opacity 150ms ease`

### TagBadge Design

- Pill shape: `border-radius: 12px`, `padding: 2px 10px 2px 8px`
- Color dot (6px circle) on the left, tag name on the right
- Font: 11px, `var(--tn-text-dim)`
- Background: tag color at 15% opacity
- Border: 1px solid tag color at 30% opacity
- Hover: background opacity increases to 25%
- Active filter state: background at 35%, border at 60%, text brightens to `var(--tn-text)`

### TagPicker Design

- Popover anchored to a "+" button or tag icon
- Lists all tags with checkboxes
- Checked tags are currently assigned
- Inline "Create new tag" input at the bottom
- Max height with scroll for many tags

---

## Open Questions

| #  | Question | Proposed Answer | Status |
|----|----------|-----------------|--------|
| 1  | Should sidebar be on the left or right? | Right side -- timer is the primary content and should stay left-anchored for a left-to-right reading flow. | **Decided: Right** |
| 2  | Max number of tags per session? | No hard limit for v1. Revisit if performance degrades. | **Decided: No limit** |
| 3  | Should tag assignment trigger session history refresh? | Yes -- refresh the visible list after any tag assign/unassign to show updated badges. | **Decided: Yes** |
| 4  | What happens to the active tag filter when the filtered tag is deleted? | Clear the filter and show all sessions. | **Decided: Clear filter** |
| 5  | Should the "current session" tags auto-clear when the timer resets? | Yes -- resetting the timer clears the pending tag selection for the next session. | **Decided: Yes** |

---

## Implementation Notes

- **Database migration**: The new tables use `CREATE TABLE IF NOT EXISTS`, making the migration idempotent. No separate migration system needed at this scale.
- **Foreign keys**: Must add `db.pragma("foreign_keys = ON")` in `initDatabase()` immediately after opening the connection, before any table creation. This is critical for cascade deletes.
- **Session list query change**: The `listSessions` function must be updated to LEFT JOIN through `session_tags` and `tags` to populate the `tags` array on each session. Use `GROUP_CONCAT` or post-process in JS to aggregate tags per session.
- **Sidebar state hook**: Create a `useSidebar` hook that manages expanded/collapsed state, loads/saves to settings via IPC (`settings.sidebar_expanded` key).
- **Current session tags**: Held in local React state (e.g., `useState<string[]>([])` for tag IDs) until the session is saved, then persisted via `tag:assign` calls.
- **Testing**: Database tag functions tested via `:memory:` DB with sql.js shim. Sidebar/TagBadge/TagPicker tested with mocked `window.electronAPI.tag.*`.