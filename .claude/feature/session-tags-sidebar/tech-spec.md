# Technical Specification: Session Tags & Sidebar

| Field   | Value                          |
|---------|--------------------------------|
| Version | 1.0                            |
| Date    | 2026-02-20                     |
| Author  | Hephaestus (Technical Architect) |
| Status  | Complete                       |

---

## Overview

This spec details the implementation of session tagging and a collapsible sidebar for LizMeter. It adds two new database tables (`tags`, `session_tags`), seven new IPC channels, one modified IPC channel, nine new React components, two new hooks, and a layout restructure from a centered single-column to a flex-row layout with a right-side sidebar.

All PRD review notes (P1-1 through P1-6, P2-1 through P2-3) are addressed inline.

---

## Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| **Tags use TEXT (UUID) primary keys** | Consistent with existing `sessions.id` pattern. `crypto.randomUUID()` in main process. |
| **Tag colors stored as raw hex strings** | CSS variables `--tn-cyan`, `--tn-orange`, `--tn-magenta` do not exist in `index.html`. Inline styles cannot read CSS vars. All 8 colors are used as hex literals in both DB and UI. |
| **`PRAGMA foreign_keys = ON` added to `initDatabase()`** | Required per-connection; without it, `ON DELETE CASCADE` silently does nothing. Added immediately after DB open, before any DDL. (Addresses PRD review P1-2.) |
| **`ListSessionsResult.total` is the filtered count** | When `tagId` filter is active, `total` reflects the filtered set, not the global count. Required for correct pagination. (Addresses PRD review P1-1.) |
| **Two-step save-then-assign flow** | `session:save` returns a `Session` with `tags: []`. Tag assignment happens via separate `tag:assign` calls using the returned session ID. If the app crashes between save and assign, tags are lost but the session is preserved. Acceptable for v1. A future iteration may accept `tagIds` in `SaveSessionInput` for transactional save. (Addresses PRD review P1-3 and P1-4.) |
| **Layout shift from centered to flex-row** | The existing `maxWidth: 640px; margin: 0 auto` layout in `TomatoClock.tsx` is replaced by `AppLayout` which renders a flex row: main content (flex: 1, centered within its area) + sidebar (fixed width, right side). This is a deliberate layout-breaking change. (Addresses PRD review P2-3.) |
| **`SessionTag` is a projection of `Tag`** | `SessionTag` omits `createdAt` since it is never needed when rendering tag badges on sessions. `SessionTag` = `Pick<Tag, "id" | "name" | "color">`. (Addresses PRD review P2-1.) |
| **Tag list ordering: `created_at ASC`** | Intentional. New tags appear at the bottom, preserving the user's mental model of "first created = first in list." Alphabetical sorting may be added later. (Addresses PRD review P2-2.) |
| **Sidebar state persisted via settings table** | Uses existing `settings` table with key `sidebar.expanded`, value `"true"` or `"false"`. |

---

## Database Layer

### File: `electron/main/database.ts`

### PRAGMA Addition

Add immediately after `db = new Database(resolvedPath)` and before `db.pragma("journal_mode = WAL")`:

```typescript
db.pragma("foreign_keys = ON");
```

This must come before any `CREATE TABLE` statements so that FK constraints are enforced during table creation validation. The pragma is a per-connection setting and is not persisted in the database file.

### New DDL (appended to existing `db.exec()` block)

```sql
CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_tags (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_session_tags_tag_id ON session_tags(tag_id);
```

Migration strategy: `CREATE TABLE IF NOT EXISTS` is idempotent. No drop/recreate. Safe for existing databases.

### New Validation Constants

```typescript
const MAX_TAG_NAME_LENGTH = 50;

const TAG_COLORS: readonly string[] = [
  "#7aa2f7", // blue
  "#bb9af7", // purple
  "#9ece6a", // green
  "#e0af68", // yellow
  "#f7768e", // red
  "#7dcfff", // cyan
  "#ff9e64", // orange
  "#c678dd", // magenta
];
```

### New Database Functions

#### `createTag(input: CreateTagInput): Tag`

```typescript
export function createTag(input: CreateTagInput): Tag {
  const database = getDb();
  const name = input.name?.trim();
  if (!name || name.length === 0) {
    throw new Error("Tag name is required");
  }
  if (name.length > MAX_TAG_NAME_LENGTH) {
    throw new Error(`Tag name must be ${MAX_TAG_NAME_LENGTH} characters or fewer`);
  }

  const color = input.color && TAG_COLORS.includes(input.color)
    ? input.color
    : getNextAutoColor(database);

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  database.prepare(
    "INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)"
  ).run(id, name, color, createdAt);

  return { id, name, color, createdAt };
}
```

Auto-color cycling helper:

```typescript
function getNextAutoColor(database: Database.Database): string {
  const row = database.prepare("SELECT COUNT(*) as count FROM tags").get() as { count: number };
  return TAG_COLORS[row.count % TAG_COLORS.length];
}
```

#### `listTags(): Tag[]`

```typescript
export function listTags(): Tag[] {
  const database = getDb();
  return database.prepare(
    "SELECT id, name, color, created_at as createdAt FROM tags ORDER BY created_at ASC"
  ).all() as Tag[];
}
```

#### `updateTag(input: UpdateTagInput): Tag`

```typescript
export function updateTag(input: UpdateTagInput): Tag {
  const database = getDb();

  if (!input.id) throw new Error("Tag id is required");

  const existing = database.prepare(
    "SELECT id, name, color, created_at as createdAt FROM tags WHERE id = ?"
  ).get(input.id) as Tag | undefined;

  if (!existing) throw new Error(`Tag not found: ${input.id}`);

  const name = input.name !== undefined ? input.name.trim() : existing.name;
  const color = input.color !== undefined ? input.color : existing.color;

  if (!name || name.length === 0) {
    throw new Error("Tag name is required");
  }
  if (name.length > MAX_TAG_NAME_LENGTH) {
    throw new Error(`Tag name must be ${MAX_TAG_NAME_LENGTH} characters or fewer`);
  }
  if (input.color !== undefined && !TAG_COLORS.includes(color)) {
    throw new Error(`Invalid tag color: ${color}`);
  }

  database.prepare("UPDATE tags SET name = ?, color = ? WHERE id = ?").run(name, color, input.id);

  return { id: input.id, name, color, createdAt: existing.createdAt };
}
```

#### `deleteTag(id: string): { deletedFromSessions: number }`

```typescript
export function deleteTag(id: string): { deletedFromSessions: number } {
  const database = getDb();

  const countRow = database.prepare(
    "SELECT COUNT(*) as count FROM session_tags WHERE tag_id = ?"
  ).get(id) as { count: number };

  database.prepare("DELETE FROM tags WHERE id = ?").run(id);
  // CASCADE handles session_tags cleanup

  return { deletedFromSessions: countRow.count };
}
```

#### `assignTag(sessionId: string, tagId: string): void`

```typescript
export function assignTag(sessionId: string, tagId: string): void {
  const database = getDb();
  database.prepare(
    "INSERT OR IGNORE INTO session_tags (session_id, tag_id) VALUES (?, ?)"
  ).run(sessionId, tagId);
}
```

#### `unassignTag(sessionId: string, tagId: string): void`

```typescript
export function unassignTag(sessionId: string, tagId: string): void {
  const database = getDb();
  database.prepare(
    "DELETE FROM session_tags WHERE session_id = ? AND tag_id = ?"
  ).run(sessionId, tagId);
}
```

#### `getSessionTags(sessionId: string): SessionTag[]`

```typescript
export function getSessionTags(sessionId: string): SessionTag[] {
  const database = getDb();
  return database.prepare(`
    SELECT t.id, t.name, t.color
    FROM tags t
    INNER JOIN session_tags st ON st.tag_id = t.id
    WHERE st.session_id = ?
    ORDER BY t.created_at ASC
  `).all(sessionId) as SessionTag[];
}
```

#### `countSessionsWithTag(tagId: string): { count: number }`

```typescript
export function countSessionsWithTag(tagId: string): { count: number } {
  const database = getDb();
  return database.prepare(
    "SELECT COUNT(*) as count FROM session_tags WHERE tag_id = ?"
  ).get(tagId) as { count: number };
}
```

#### Modified: `listSessions(input: ListSessionsInput): ListSessionsResult`

The function gains an optional `tagId` filter. When present, sessions are filtered via a JOIN on `session_tags`. Tags are populated per-session via a post-processing step (not `GROUP_CONCAT`, to avoid JSON parsing complexity).

```typescript
export function listSessions(input: ListSessionsInput): ListSessionsResult {
  const database = getDb();
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;

  let sessions: Session[];
  let total: number;

  if (input.tagId) {
    // Filtered query
    sessions = database.prepare(`
      SELECT s.id, s.title, s.timer_type as timerType,
             s.planned_duration_seconds as plannedDurationSeconds,
             s.actual_duration_seconds as actualDurationSeconds,
             s.completed_at as completedAt
      FROM sessions s
      INNER JOIN session_tags st ON st.session_id = s.id
      WHERE st.tag_id = ?
      ORDER BY s.completed_at DESC
      LIMIT ? OFFSET ?
    `).all(input.tagId, limit, offset) as Session[];

    const totalRow = database.prepare(
      "SELECT COUNT(*) as count FROM session_tags WHERE tag_id = ?"
    ).get(input.tagId) as { count: number };
    total = totalRow.count;  // FILTERED count (PRD review P1-1)
  } else {
    // Unfiltered query (existing behavior)
    sessions = database.prepare(`
      SELECT id, title, timer_type as timerType,
             planned_duration_seconds as plannedDurationSeconds,
             actual_duration_seconds as actualDurationSeconds,
             completed_at as completedAt
      FROM sessions
      ORDER BY completed_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as Session[];

    const totalRow = database.prepare(
      "SELECT COUNT(*) as count FROM sessions"
    ).get() as { count: number };
    total = totalRow.count;
  }

  // Post-process: attach tags array to each session
  const getTagsStmt = database.prepare(`
    SELECT t.id, t.name, t.color
    FROM tags t
    INNER JOIN session_tags st ON st.tag_id = t.id
    WHERE st.session_id = ?
    ORDER BY t.created_at ASC
  `);

  for (const session of sessions) {
    (session as Session).tags = getTagsStmt.all(session.id) as SessionTag[];
  }

  return { sessions, total };
}
```

#### Modified: `saveSession(input: SaveSessionInput): Session`

Return value gains `tags: []` to satisfy the updated `Session` type (PRD review P1-4):

```typescript
return {
  id,
  title,
  timerType: input.timerType,
  plannedDurationSeconds: input.plannedDurationSeconds,
  actualDurationSeconds: input.actualDurationSeconds,
  completedAt,
  tags: [],  // NEW: tags assigned post-save via tag:assign
};
```

---

## IPC Layer

### File: `electron/main/ipc-handlers.ts`

### New Channels (7)

#### `tag:create`

```typescript
ipcMain.handle("tag:create", (_event, input: CreateTagInput) => {
  return createTag(input);
});
```

- **Input**: `CreateTagInput` (`{ name: string; color?: string }`)
- **Output**: `Tag`
- **Errors**: Empty name, name too long, duplicate name (UNIQUE constraint)

#### `tag:list`

```typescript
ipcMain.handle("tag:list", () => {
  return listTags();
});
```

- **Input**: none
- **Output**: `Tag[]`

#### `tag:update`

```typescript
ipcMain.handle("tag:update", (_event, input: UpdateTagInput) => {
  return updateTag(input);
});
```

- **Input**: `UpdateTagInput` (`{ id: string; name?: string; color?: string }`)
- **Output**: `Tag`
- **Errors**: Tag not found, empty name, name too long, invalid color, duplicate name

#### `tag:delete`

```typescript
ipcMain.handle("tag:delete", (_event, id: string) => {
  return deleteTag(id);
});
```

- **Input**: `string` (tag id)
- **Output**: `{ deletedFromSessions: number }`

#### `tag:assign`

```typescript
ipcMain.handle("tag:assign", (_event, input: TagAssignInput) => {
  return assignTag(input.sessionId, input.tagId);
});
```

- **Input**: `TagAssignInput` (`{ sessionId: string; tagId: string }`)
- **Output**: `void`
- **Behavior**: No-op if already assigned (`INSERT OR IGNORE`)

#### `tag:unassign`

```typescript
ipcMain.handle("tag:unassign", (_event, input: TagAssignInput) => {
  return unassignTag(input.sessionId, input.tagId);
});
```

- **Input**: `TagAssignInput` (`{ sessionId: string; tagId: string }`)
- **Output**: `void`
- **Behavior**: No-op if not assigned

#### `tag:count`

```typescript
ipcMain.handle("tag:count", (_event, id: string) => {
  return countSessionsWithTag(id);
});
```

- **Input**: `string` (tag id)
- **Output**: `{ count: number }`

### Modified Channel (1)

#### `session:list`

No handler code change needed -- the existing handler passes `input` to `listSessions()`, which now accepts the optional `tagId` field. The `ListSessionsInput` type change is sufficient.

### Preload Exposure

#### File: `electron/preload/index.ts`

Add `tag` namespace alongside existing `session`, `settings`, `window`:

```typescript
tag: {
  create: (input: CreateTagInput) => ipcRenderer.invoke("tag:create", input),
  list: () => ipcRenderer.invoke("tag:list"),
  update: (input: UpdateTagInput) => ipcRenderer.invoke("tag:update", input),
  delete: (id: string) => ipcRenderer.invoke("tag:delete", id),
  assign: (input: TagAssignInput) => ipcRenderer.invoke("tag:assign", input),
  unassign: (input: TagAssignInput) => ipcRenderer.invoke("tag:unassign", input),
  count: (id: string) => ipcRenderer.invoke("tag:count", id),
},
```

Import types: `CreateTagInput`, `UpdateTagInput`, `TagAssignInput` from `../../src/shared/types.ts`.

### Error Handling

All IPC handlers rely on Electron's built-in error propagation: if the handler throws, the renderer's `ipcRenderer.invoke` promise rejects with the error message. The existing pattern (no try/catch in handlers, error caught in renderer hooks) is maintained. SQLite UNIQUE constraint violations produce descriptive error messages ("UNIQUE constraint failed: tags.name").

---

## Type System Changes

### File: `src/shared/types.ts`

### New Types

```typescript
// --- Tag Types ---

export interface Tag {
  id: string;        // UUID v4
  name: string;
  color: string;     // hex value, e.g. "#7aa2f7"
  createdAt: string; // ISO 8601
}

/** Projection of Tag for embedding in Session responses (omits createdAt) */
export type SessionTag = Pick<Tag, "id" | "name" | "color">;

export interface CreateTagInput {
  name: string;
  color?: string; // optional; auto-assigned if omitted
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
```

### Modified Types

```typescript
export interface Session {
  id: string;
  title: string;
  timerType: TimerType;
  plannedDurationSeconds: number;
  actualDurationSeconds: number;
  completedAt: string;
  tags: SessionTag[];  // NEW
}

export interface ListSessionsInput {
  limit?: number;
  offset?: number;
  tagId?: string;  // NEW: filter by tag
}
```

### Extended ElectronAPI

```typescript
export interface ElectronAPI {
  platform: string;
  session: {
    save: (input: SaveSessionInput) => Promise<Session>;
    list: (input: ListSessionsInput) => Promise<ListSessionsResult>;
    delete: (id: string) => Promise<void>;
  };
  settings: {
    get: () => Promise<TimerSettings>;
    save: (settings: TimerSettings) => Promise<void>;
  };
  tag: {                                                      // NEW
    create: (input: CreateTagInput) => Promise<Tag>;
    list: () => Promise<Tag[]>;
    update: (input: UpdateTagInput) => Promise<Tag>;
    delete: (id: string) => Promise<{ deletedFromSessions: number }>;
    assign: (input: TagAssignInput) => Promise<void>;
    unassign: (input: TagAssignInput) => Promise<void>;
    count: (id: string) => Promise<{ count: number }>;
  };
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
  };
}
```

---

## Component Architecture

### Component Tree (Updated)

```
App
 └── AppLayout                        (NEW)
      ├── MainContent                  (NEW wrapper div)
      │    └── TomatoClock             (MODIFIED: removes SessionHistory, keeps TimerView)
      │         └── TimerView          (EXISTING, unchanged)
      └── Sidebar                      (NEW, right side, collapsible)
           ├── SidebarToggle           (NEW, expand/collapse button)
           ├── CurrentSessionPanel     (NEW, shows timer state + tag picker)
           │    └── TagPicker          (NEW)
           ├── TagManager              (NEW, tag CRUD list)
           │    ├── TagBadge           (NEW, reusable pill)
           │    └── TagColorPicker     (NEW, 8-color palette popover)
           └── SessionHistoryPanel     (NEW, wraps existing SessionHistory)
                ├── SessionHistory     (EXISTING, modified props)
                │    └── SessionHistoryItem (EXISTING, gains tag badges + tag picker trigger)
                └── TagPicker          (NEW, reused for retroactive tagging)
```

### Component Specifications

#### 1. AppLayout

**File**: `src/renderer/src/components/AppLayout.tsx`

```typescript
interface AppLayoutProps {
  children: React.ReactNode;      // main content
  sidebar: React.ReactNode;       // sidebar content
  sidebarExpanded: boolean;
}
```

- **Styling**: `display: "flex"`, `flexDirection: "row"`, `height: "100%"`
- **Main content area**: `flex: 1`, `minWidth: 0`, `overflow: "auto"`
- **No IPC calls**
- **Layout**: Replaces the centered `maxWidth: 640px` approach. Main content area centers the `TomatoClock` within itself using `maxWidth: 640px; margin: 0 auto` internally, so timer positioning is preserved.

#### 2. Sidebar

**File**: `src/renderer/src/components/Sidebar.tsx`

```typescript
interface SidebarProps {
  expanded: boolean;
  onToggle: () => void;
  // Timer state for CurrentSessionPanel:
  timerStatus: TimerStatus;
  timerType: TimerType;
  title: string;
  pendingTagIds: string[];
  onPendingTagsChange: (tagIds: string[]) => void;
  // Tag management:
  tags: Tag[];
  onCreateTag: (input: CreateTagInput) => Promise<Tag>;
  onUpdateTag: (input: UpdateTagInput) => Promise<Tag>;
  onDeleteTag: (id: string) => Promise<{ deletedFromSessions: number }>;
  onCountTag: (id: string) => Promise<{ count: number }>;
  onTagsRefresh: () => void;
  // Session history:
  sessions: Session[];
  historyLoading: boolean;
  historyError: string | null;
  onDeleteSession: (id: string) => void;
  onLoadMore: () => void;
  total: number;
  // Tag filtering:
  activeFilterTagId: string | null;
  onFilterByTag: (tagId: string | null) => void;
  // Tag assignment on past sessions:
  onAssignTag: (input: TagAssignInput) => Promise<void>;
  onUnassignTag: (input: TagAssignInput) => Promise<void>;
}
```

- **Expanded width**: `260px`
- **Collapsed width**: `48px`
- **Transition**: `width 220ms cubic-bezier(0.4, 0, 0.2, 1)`
- **Background**: `#16213e`
- **Left border**: `1px solid #292e42`
- **Position**: Right side of flex row (`order: 2` is implicit as second child)
- **Overflow**: `overflowY: "auto"` when expanded
- **Collapsed view**: Shows vertical icon strip (toggle, session, tags, history icons) using Unicode/SVG icons
- **Content opacity**: `opacity: expanded ? 1 : 0`, `transition: "opacity 150ms ease"`

#### 3. SidebarToggle

**File**: `src/renderer/src/components/SidebarToggle.tsx`

```typescript
interface SidebarToggleProps {
  expanded: boolean;
  onToggle: () => void;
}
```

- **Renders**: A button with a chevron icon (pointing left when expanded, right when collapsed)
- **Position**: Top of the sidebar
- **Styling**: `width: "100%"`, `height: "36px"`, `background: "transparent"`, `border: "none"`, `color: "#565f89"`, hover color `#7aa2f7`
- **Aria**: `aria-label="Toggle sidebar"`

#### 4. CurrentSessionPanel

**File**: `src/renderer/src/components/CurrentSessionPanel.tsx`

```typescript
interface CurrentSessionPanelProps {
  timerStatus: TimerStatus;
  timerType: TimerType;
  title: string;
  pendingTagIds: string[];
  tags: Tag[];
  onPendingTagsChange: (tagIds: string[]) => void;
}
```

- **Displays** (when expanded):
  - **Idle**: "No active session" in muted text
  - **Running**: Pulsing dot + "Running" + session title (or "(untitled)") + timer type badge + assigned tags via `TagBadge` components + `TagPicker` trigger
  - **Paused**: Yellow dot + "Paused" + same as running
  - **Completed**: Green dot + "Completed" + session title
- **Tag assignment**: Uses `TagPicker` component. Selected tag IDs are stored in `pendingTagIds` (React state in parent), not persisted until session save.
- **Section header**: "CURRENT SESSION", uppercase, `#565f89`, `11px`, `letterSpacing: "0.08em"`

#### 5. SessionHistoryPanel

**File**: `src/renderer/src/components/SessionHistoryPanel.tsx`

```typescript
interface SessionHistoryPanelProps {
  sessions: Session[];
  isLoading: boolean;
  error: string | null;
  onDelete: (id: string) => void;
  onLoadMore: () => void;
  total: number;
  tags: Tag[];
  activeFilterTagId: string | null;
  onFilterByTag: (tagId: string | null) => void;
  onAssignTag: (input: TagAssignInput) => Promise<void>;
  onUnassignTag: (input: TagAssignInput) => Promise<void>;
  onHistoryRefresh: () => void;
}
```

- **Wraps** the existing `SessionHistory` component but adds:
  - Filter indicator bar: shows active tag filter with "clear" button
  - Tag assignment capability on each session item
- **Section header**: "SESSION HISTORY"

#### 6. TagManager

**File**: `src/renderer/src/components/TagManager.tsx`

```typescript
interface TagManagerProps {
  tags: Tag[];
  onCreateTag: (input: CreateTagInput) => Promise<Tag>;
  onUpdateTag: (input: UpdateTagInput) => Promise<Tag>;
  onDeleteTag: (id: string) => Promise<{ deletedFromSessions: number }>;
  onCountTag: (id: string) => Promise<{ count: number }>;
  onTagsRefresh: () => void;
  activeFilterTagId: string | null;
  onFilterByTag: (tagId: string | null) => void;
}
```

- **Displays**: List of all tags as `TagBadge` components with edit/delete actions
- **Create**: Inline input at bottom with "+" button. Auto-assigns color.
- **Rename**: Double-click tag name to enter inline edit mode
- **Delete**: Click delete icon, shows confirmation with session count (fetched via `tag:count`)
- **Color change**: Click color dot to open `TagColorPicker`
- **Filter**: Click tag badge body to toggle filter
- **Section header**: "TAGS"
- **State**: Local `useState` for `editingTagId`, `newTagName`, `deleteConfirmId`, `deleteSessionCount`

#### 7. TagBadge

**File**: `src/renderer/src/components/TagBadge.tsx`

```typescript
interface TagBadgeProps {
  tag: SessionTag;
  isActive?: boolean;     // true when this tag is the active filter
  onClick?: () => void;   // filter toggle
  onRemove?: () => void;  // show "x" button to unassign
  size?: "sm" | "md";     // sm for history items, md for tag manager
}
```

- **Pill shape**: `borderRadius: "12px"`
- **Padding**: `sm`: `"1px 8px 1px 6px"`, `md`: `"2px 10px 2px 8px"`
- **Color dot**: `6px` circle on the left, colored with `tag.color`
- **Font**: `sm`: `"0.6875rem"`, `md`: `"0.75rem"`, color `#a9b1d6`
- **Background**: `{tag.color}26` (15% opacity hex suffix)
- **Border**: `1px solid {tag.color}4D` (30% opacity)
- **Hover**: background `{tag.color}40` (25% opacity)
- **Active filter state**: background `{tag.color}59` (35%), border `{tag.color}99` (60%), text `#c0caf5`
- **Remove button**: Small "x" on the right, visible only when `onRemove` is provided, color `#565f89`, hover `#f7768e`

#### 8. TagPicker

**File**: `src/renderer/src/components/TagPicker.tsx`

```typescript
interface TagPickerProps {
  tags: Tag[];
  selectedTagIds: string[];
  onToggleTag: (tagId: string) => void;
  onCreateTag?: (input: CreateTagInput) => Promise<Tag>;
  anchorRef?: React.RefObject<HTMLElement>;
}
```

- **Renders**: Popover anchored below trigger button
- **Content**: Scrollable list of all tags with checkboxes. Checked = assigned.
- **Inline create**: Text input + "Create" button at bottom (if `onCreateTag` provided)
- **Max height**: `240px`, `overflowY: "auto"`
- **Background**: `#1f2335`
- **Border**: `1px solid #292e42`
- **Border radius**: `8px`
- **Shadow**: `0 4px 12px rgba(0, 0, 0, 0.3)`
- **State**: Local `useState<boolean>` for `isOpen`, `useState<string>` for `newTagName`
- **Close**: Click outside (via `useEffect` with document click listener) or Escape key
- **Aria**: `aria-label="Select tags"`, focus trap

#### 9. TagColorPicker

**File**: `src/renderer/src/components/TagColorPicker.tsx`

```typescript
interface TagColorPickerProps {
  currentColor: string;
  onSelectColor: (color: string) => void;
}
```

- **Renders**: Grid of 8 color swatches (4x2)
- **Swatch size**: `24px` circles
- **Colors** (all raw hex):
  - `#7aa2f7` (blue)
  - `#bb9af7` (purple)
  - `#9ece6a` (green)
  - `#e0af68` (yellow)
  - `#f7768e` (red)
  - `#7dcfff` (cyan)
  - `#ff9e64` (orange)
  - `#c678dd` (magenta)
- **Selected indicator**: White checkmark or ring border (`2px solid #c0caf5`)
- **Background**: `#1f2335` with `8px` border-radius
- **State**: Stateless; controlled via props

---

## State Management

### Sidebar Open/Closed State

**Location**: New `useSidebar` hook in `src/renderer/src/hooks/useSidebar.ts`

```typescript
export interface UseSidebarReturn {
  expanded: boolean;
  toggle: () => void;
  isLoading: boolean;
}

export function useSidebar(): UseSidebarReturn {
  const [expanded, setExpanded] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  // Load persisted state on mount
  useEffect(() => {
    window.electronAPI.settings.get()
      .then(() => {
        // settings table doesn't have sidebar key yet, use a dedicated IPC or
        // extend settings:get. For simplicity, use a separate settings key.
        // Actually, we piggyback on the existing settings table via a new key.
      });
    // Implementation: read "sidebar.expanded" from settings on mount
    // For now, default to true (expanded)
    setIsLoading(false);
  }, []);

  const toggle = useCallback(() => {
    setExpanded(prev => {
      const next = !prev;
      // Persist to settings (fire-and-forget)
      // This requires a generic setting save, which we can do via
      // settings:save if we extend it, or just accept the existing
      // settings table by adding a direct IPC.
      return next;
    });
  }, []);

  return { expanded, toggle, isLoading };
}
```

**Implementation note**: The existing `settings:get` / `settings:save` only handle `TimerSettings`. For sidebar state, we add two functions to `database.ts`:

```typescript
export function getSetting(key: string): string | null {
  const database = getDb();
  const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const database = getDb();
  database.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}
```

And two new IPC channels:

```typescript
ipcMain.handle("settings:get-key", (_event, key: string) => getSetting(key));
ipcMain.handle("settings:set-key", (_event, key: string, value: string) => setSetting(key, value));
```

Preload:

```typescript
settings: {
  get: () => ipcRenderer.invoke("settings:get"),
  save: (settings: TimerSettings) => ipcRenderer.invoke("settings:save", settings),
  getKey: (key: string) => ipcRenderer.invoke("settings:get-key", key),  // NEW
  setKey: (key: string, value: string) => ipcRenderer.invoke("settings:set-key", key, value),  // NEW
},
```

ElectronAPI addition:

```typescript
settings: {
  get: () => Promise<TimerSettings>;
  save: (settings: TimerSettings) => Promise<void>;
  getKey: (key: string) => Promise<string | null>;    // NEW
  setKey: (key: string, value: string) => Promise<void>;  // NEW
};
```

The `useSidebar` hook then uses `settings.getKey("sidebar.expanded")` on mount and `settings.setKey("sidebar.expanded", ...)` on toggle.

### Active Tag Filter

**Location**: `useState<string | null>` in `App.tsx`, passed down to `Sidebar` and to `useSessionHistory`.

When the filter changes:
1. `setActiveFilterTagId(tagId)` updates state in App
2. `useSessionHistory` receives the `tagId` and re-fetches with `{ tagId }` in `ListSessionsInput`
3. Pagination offset resets to 0

### Tag List State

**Location**: New `useTagManager` hook in `src/renderer/src/hooks/useTagManager.ts`

```typescript
export interface UseTagManagerReturn {
  tags: Tag[];
  isLoading: boolean;
  error: string | null;
  createTag: (input: CreateTagInput) => Promise<Tag>;
  updateTag: (input: UpdateTagInput) => Promise<Tag>;
  deleteTag: (id: string) => Promise<{ deletedFromSessions: number }>;
  countTag: (id: string) => Promise<{ count: number }>;
  refresh: () => void;
}

export function useTagManager(): UseTagManagerReturn {
  const [tags, setTags] = useState<Tag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    setIsLoading(true);
    window.electronAPI.tag.list()
      .then(setTags)
      .catch(err => setError(err instanceof Error ? err.message : "Failed to load tags"))
      .finally(() => setIsLoading(false));
  }, [refreshToken]);

  const createTag = useCallback(async (input: CreateTagInput): Promise<Tag> => {
    const tag = await window.electronAPI.tag.create(input);
    setRefreshToken(t => t + 1);
    return tag;
  }, []);

  const updateTag = useCallback(async (input: UpdateTagInput): Promise<Tag> => {
    const tag = await window.electronAPI.tag.update(input);
    setRefreshToken(t => t + 1);
    return tag;
  }, []);

  const deleteTag = useCallback(async (id: string) => {
    const result = await window.electronAPI.tag.delete(id);
    setRefreshToken(t => t + 1);
    return result;
  }, []);

  const countTag = useCallback(async (id: string) => {
    return window.electronAPI.tag.count(id);
  }, []);

  const refresh = useCallback(() => setRefreshToken(t => t + 1), []);

  return { tags, isLoading, error, createTag, updateTag, deleteTag, countTag, refresh };
}
```

### Pending Tags for Current Session

**Location**: `useState<string[]>` in `App.tsx` (or `TomatoClock.tsx`).

- Set to `[]` when timer resets or enters idle (via `useEffect` watching `state.status`)
- On session completion, after `session:save` returns the session ID, loop through `pendingTagIds` and call `tag:assign` for each
- The `useTimer` hook's save effect needs to be modified to return the saved session's ID so the parent can assign tags

**Modified `useTimer` approach**: Instead of modifying `useTimer` (which handles save internally), use a callback pattern:

Add an `onSessionSaved?: (session: Session) => void` callback to `useTimer`:

```typescript
export function useTimer(settings: TimerSettings, onSessionSaved?: (session: Session) => void): UseTimerReturn
```

Inside the save effect, after successful save, call `onSessionSaved(savedSession)`. The parent (`TomatoClock.tsx` or `App.tsx`) provides the callback, which assigns pending tags.

### Tag Filter + useSessionHistory Integration

**Modified `useSessionHistory`**: Accept optional `tagId` parameter.

```typescript
export function useSessionHistory(tagId?: string | null): UseSessionHistoryReturn
```

- Pass `tagId` to `window.electronAPI.session.list({ limit, offset, tagId: tagId ?? undefined })`
- When `tagId` changes, reset offset to 0 and re-fetch
- Add `tagId` to the `useEffect` dependency array for the initial fetch

---

## Frontend Design Spec

### Layout

```
+----------------------------------------------+
| [Title Bar]                                   |
+----------------------------------------------+
|                                    |          |
|       Main Content                 | Sidebar  |
|       (flex: 1)                    | (260px)  |
|                                    |          |
|    +------------------------+      |  Toggle  |
|    |   Tomato Clock         |      |  Current |
|    |   (max-width: 640px)   |      |  Tags    |
|    |   (margin: 0 auto)     |      |  History |
|    +------------------------+      |          |
|                                    |          |
+----------------------------------------------+
```

### Sidebar Dimensions

| State      | Width  | Content Visibility |
|------------|--------|--------------------|
| Expanded   | 260px  | Full content       |
| Collapsed  | 48px   | Icon strip only    |

### Transitions

| Property | Duration | Easing | Target |
|----------|----------|--------|--------|
| `width`  | 220ms | `cubic-bezier(0.4, 0, 0.2, 1)` | Sidebar container |
| `opacity` | 150ms | `ease` | Sidebar content (0 when collapsed, 1 when expanded) |

### Tag Color Palette (8 colors, all raw hex)

| Name     | Hex       | Usage |
|----------|-----------|-------|
| Blue     | `#7aa2f7` | Tag color option 1 |
| Purple   | `#bb9af7` | Tag color option 2 |
| Green    | `#9ece6a` | Tag color option 3 |
| Yellow   | `#e0af68` | Tag color option 4 |
| Red      | `#f7768e` | Tag color option 5 |
| Cyan     | `#7dcfff` | Tag color option 6 |
| Orange   | `#ff9e64` | Tag color option 7 |
| Magenta  | `#c678dd` | Tag color option 8 |

These are used as raw hex values in inline styles. No CSS variables are added to `index.html` for the three missing colors (cyan, orange, magenta). (Addresses PRD review P1-5.)

### TagBadge Visual Spec

```
  ┌─────────────────────────────┐
  │  ● Tag Name           [x]  │
  └─────────────────────────────┘

  ● = 6px circle, filled with tag.color
  Background: {color}26 (15% opacity)
  Border: 1px solid {color}4D (30% opacity)
  Text: #a9b1d6 (dim text)
  Border-radius: 12px
  Font-size: 0.6875rem (sm) / 0.75rem (md)

  Hover:     bg {color}40 (25%)
  Active:    bg {color}59 (35%), border {color}99 (60%), text #c0caf5
```

### CurrentSessionPanel States

| Timer Status | Indicator | Title Display | Tags |
|-------------|-----------|---------------|------|
| `idle`      | Gray dot `#565f89` | "No active session" | Hidden |
| `running`   | Pulsing blue dot `#7aa2f7` | Session title or "(untitled)" | Editable via TagPicker |
| `paused`    | Yellow dot `#e0af68` | Session title or "(untitled)" | Editable via TagPicker |
| `completed` | Green dot `#9ece6a` | Session title | Read-only badges |

### Collapsed Sidebar Icons

Four icon buttons in vertical strip, each `48px x 36px`:
1. Toggle chevron (expand)
2. Timer icon (current session)
3. Tag icon (tags)
4. Clock icon (history)

Colors: `#565f89` default, `#7aa2f7` on hover.
On click in collapsed state: expand sidebar and scroll to that section.

---

## Files Modified/Created

### New Files (12)

| File | Description |
|------|-------------|
| `src/renderer/src/components/AppLayout.tsx` | Flex-row layout wrapper (main + sidebar) |
| `src/renderer/src/components/Sidebar.tsx` | Collapsible sidebar container |
| `src/renderer/src/components/SidebarToggle.tsx` | Expand/collapse toggle button |
| `src/renderer/src/components/CurrentSessionPanel.tsx` | Active session status + tag picker |
| `src/renderer/src/components/SessionHistoryPanel.tsx` | Session history wrapper for sidebar context |
| `src/renderer/src/components/TagManager.tsx` | Tag CRUD management section |
| `src/renderer/src/components/TagBadge.tsx` | Reusable tag pill/badge |
| `src/renderer/src/components/TagPicker.tsx` | Tag selection popover with checkboxes |
| `src/renderer/src/components/TagColorPicker.tsx` | 8-color palette grid |
| `src/renderer/src/hooks/useTagManager.ts` | Tag CRUD hook |
| `src/renderer/src/hooks/useSidebar.ts` | Sidebar expanded/collapsed state + persistence |
| `electron/main/__tests__/database-tags.test.ts` | Database tests for tag operations |

### Modified Files (9)

| File | Change |
|------|--------|
| `electron/main/database.ts` | Add `PRAGMA foreign_keys = ON`, `tags`/`session_tags` DDL, tag CRUD functions, modified `listSessions`/`saveSession`, `getSetting`/`setSetting` |
| `electron/main/ipc-handlers.ts` | Register 7 new tag handlers + 2 settings key handlers |
| `electron/preload/index.ts` | Expose `tag.*` and `settings.getKey`/`settings.setKey` methods |
| `src/shared/types.ts` | Add `Tag`, `SessionTag`, `CreateTagInput`, `UpdateTagInput`, `TagAssignInput`; modify `Session`, `ListSessionsInput`, `ElectronAPI` |
| `src/renderer/src/App.tsx` | Replace `<TomatoClock />` with `<AppLayout>` + sidebar state management |
| `src/renderer/src/components/TomatoClock.tsx` | Remove `SessionHistory` rendering, remove container `maxWidth` (moved to `AppLayout`), accept new props for tag callbacks |
| `src/renderer/src/hooks/useSessionHistory.ts` | Accept optional `tagId` parameter, pass to IPC, reset offset on filter change |
| `src/renderer/src/hooks/useTimer.ts` | Add `onSessionSaved` callback parameter, call after successful save |
| `src/renderer/src/components/SessionHistoryItem.tsx` | Add tag badges display, tag picker trigger for retroactive tagging |
| `src/renderer/src/electron-api.d.ts` | Update `Window.electronAPI` type to match extended `ElectronAPI` |

### Test Files (new and modified)

| File | Change |
|------|--------|
| `electron/main/__tests__/database-tags.test.ts` | NEW: tests for all tag DB functions |
| `electron/main/__tests__/database.test.ts` | MODIFIED: update `listSessions` / `saveSession` tests to expect `tags` field |
| `src/renderer/src/components/__tests__/TagBadge.test.tsx` | NEW |
| `src/renderer/src/components/__tests__/TagManager.test.tsx` | NEW |
| `src/renderer/src/components/__tests__/TagPicker.test.tsx` | NEW |
| `src/renderer/src/components/__tests__/Sidebar.test.tsx` | NEW |
| `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` | MODIFIED: sessions now have `tags` array |
| `src/renderer/src/components/__tests__/SessionHistory.test.tsx` | MODIFIED: sessions now have `tags` array |
| `src/renderer/src/hooks/__tests__/useTagManager.test.ts` | NEW |
| `src/renderer/src/hooks/__tests__/useSessionHistory.test.ts` | MODIFIED: test tag filter behavior |

---

## Testing Strategy

### Database Tests (`electron/main/__tests__/database-tags.test.ts`)

Environment: `// @vitest-environment node`

Setup: `beforeEach(() => initDatabase(":memory:"))`, `afterEach(() => closeDatabase())`

Test cases:

| ID | Test |
|----|------|
| TC-301 | `createTag` creates tag with auto-assigned color |
| TC-302 | `createTag` with explicit color |
| TC-303 | `createTag` rejects empty name |
| TC-304 | `createTag` rejects duplicate name (case-insensitive) |
| TC-305 | `createTag` trims and validates name length |
| TC-306 | `createTag` auto-color cycles through palette |
| TC-307 | `listTags` returns tags ordered by created_at ASC |
| TC-308 | `updateTag` renames a tag |
| TC-309 | `updateTag` recolors a tag |
| TC-310 | `updateTag` rejects invalid color |
| TC-311 | `updateTag` rejects non-existent tag |
| TC-312 | `deleteTag` removes tag and returns session count |
| TC-313 | `deleteTag` cascades to session_tags |
| TC-314 | `assignTag` creates junction record |
| TC-315 | `assignTag` is idempotent (INSERT OR IGNORE) |
| TC-316 | `unassignTag` removes junction record |
| TC-317 | `getSessionTags` returns tags for a session |
| TC-318 | `countSessionsWithTag` returns correct count |
| TC-319 | `listSessions` includes tags array per session |
| TC-320 | `listSessions` filters by tagId |
| TC-321 | `listSessions` with tagId returns filtered total count |
| TC-322 | `PRAGMA foreign_keys` is enabled (verify cascade works) |
| TC-323 | Deleting a session cascades to session_tags |
| TC-324 | `saveSession` returns tags as empty array |
| TC-325 | `getSetting` / `setSetting` basic round-trip |

### Existing Database Tests (`database.test.ts`)

**Modifications**:
- Update mock `Session` objects to include `tags: []`
- Update `listSessions` assertions to check for `tags` array on each session
- `saveSession` return value assertions updated to include `tags: []`

### Component Tests

All use jsdom environment, mock `window.electronAPI` via `vi.stubGlobal`.

| Component | Test Scenarios |
|-----------|----------------|
| `TagBadge` | Renders name + color dot, click triggers `onClick`, hover changes style, active state styling, remove button visibility |
| `TagManager` | Renders tag list, create tag via input, inline rename, delete with confirmation, color picker toggle, filter click |
| `TagPicker` | Opens/closes popover, checkbox toggle, inline create, close on outside click |
| `Sidebar` | Renders expanded/collapsed, toggle changes width, sections visible when expanded, icon strip when collapsed |
| `SessionHistoryItem` | Renders tag badges, tag picker trigger visible |

### Hook Tests

| Hook | Test Scenarios |
|------|----------------|
| `useTagManager` | Loads tags on mount, createTag calls IPC and refreshes, deleteTag calls IPC and refreshes, error handling |
| `useSidebar` | Loads persisted state, toggle updates state and persists, default to expanded |
| `useSessionHistory` (modified) | Passes tagId to IPC, resets offset when tagId changes |

### E2E Test Scenarios (Playwright)

| Scenario | Steps |
|----------|-------|
| Create and assign tag | Create tag via sidebar, start session, assign tag, complete session, verify tag in history |
| Filter by tag | Create 2 tags, save sessions with different tags, click tag to filter, verify filtered results |
| Delete tag cascade | Create tag, assign to session, delete tag, verify tag removed from session |
| Sidebar toggle | Click collapse, verify width, click expand, verify content |
| Retroactive tagging | Complete session, open tag picker on history item, assign tag, verify badge |

---

## Implementation Order

The implementation follows a bottom-up approach to avoid broken builds at any step.

| Step | Task | Dependencies | Files |
|------|------|--------------|-------|
| 1 | **Type system changes** | None | `src/shared/types.ts` |
| 2 | **Database schema + tag CRUD functions** | Step 1 | `electron/main/database.ts` |
| 3 | **Database tag tests** | Steps 1-2 | `electron/main/__tests__/database-tags.test.ts` |
| 4 | **Update existing DB tests** | Steps 1-2 | `electron/main/__tests__/database.test.ts` |
| 5 | **IPC handlers for tags** | Steps 1-2 | `electron/main/ipc-handlers.ts` |
| 6 | **Preload bridge for tags** | Steps 1, 5 | `electron/preload/index.ts` |
| 7 | **Update electron-api.d.ts** | Step 1 | `src/renderer/src/electron-api.d.ts` |
| 8 | **TagBadge component** | Step 1 | `src/renderer/src/components/TagBadge.tsx` |
| 9 | **TagColorPicker component** | None | `src/renderer/src/components/TagColorPicker.tsx` |
| 10 | **TagPicker component** | Steps 1, 8 | `src/renderer/src/components/TagPicker.tsx` |
| 11 | **useTagManager hook** | Steps 1, 6 | `src/renderer/src/hooks/useTagManager.ts` |
| 12 | **useSidebar hook** | Steps 1, 6 | `src/renderer/src/hooks/useSidebar.ts` |
| 13 | **Modify useSessionHistory** | Step 1 | `src/renderer/src/hooks/useSessionHistory.ts` |
| 14 | **Modify useTimer** (add onSessionSaved) | Step 1 | `src/renderer/src/hooks/useTimer.ts` |
| 15 | **TagManager component** | Steps 8, 9, 10, 11 | `src/renderer/src/components/TagManager.tsx` |
| 16 | **CurrentSessionPanel component** | Steps 8, 10 | `src/renderer/src/components/CurrentSessionPanel.tsx` |
| 17 | **Update SessionHistoryItem** (add tag badges) | Step 8 | `src/renderer/src/components/SessionHistoryItem.tsx` |
| 18 | **SessionHistoryPanel component** | Steps 10, 17 | `src/renderer/src/components/SessionHistoryPanel.tsx` |
| 19 | **SidebarToggle component** | None | `src/renderer/src/components/SidebarToggle.tsx` |
| 20 | **Sidebar component** | Steps 15, 16, 18, 19 | `src/renderer/src/components/Sidebar.tsx` |
| 21 | **AppLayout component** | None | `src/renderer/src/components/AppLayout.tsx` |
| 22 | **Restructure App.tsx** | Steps 11, 12, 13, 14, 20, 21 | `src/renderer/src/App.tsx` |
| 23 | **Modify TomatoClock.tsx** | Steps 14, 22 | `src/renderer/src/components/TomatoClock.tsx` |
| 24 | **Component tests** | Steps 8-23 | `src/renderer/src/components/__tests__/*.test.tsx` |
| 25 | **Hook tests** | Steps 11-14 | `src/renderer/src/hooks/__tests__/*.test.ts` |
| 26 | **Update existing component tests** | Steps 17, 22 | Various `__tests__/` files |
| 27 | **Lint + format pass** | All above | All new/modified files |
| 28 | **E2E tests** | All above | Playwright tests |

---

## Open Questions

| # | Question | Status |
|---|----------|--------|
| 1 | Should `useSidebar` persist state via the existing `settings:save` (which only handles `TimerSettings`) or via new generic `settings:get-key` / `settings:set-key` channels? | **Decided: New generic key/value channels.** The existing settings interface is typed specifically for timer durations. Adding generic key/value operations avoids polluting `TimerSettings` with unrelated fields. |
| 2 | Should tag assignment errors during the post-save flow silently fail or show an error? | **Decided: Show a non-blocking error toast.** Since the session is already saved, tag assignment failure is recoverable (user can retroactively add tags). Display an error message but do not block dismissal. |
| 3 | Should the sidebar be resizable (drag to resize)? | **Decided: No.** Fixed 260px/48px for v1. Resizable sidebar adds complexity (drag handle, min/max constraints, persistence) without clear user value at this stage. |
| 4 | Maximum total tag count? | **Decided: No hard limit for v1.** The `TagPicker` has a scrollable area with `maxHeight: 240px`. If users create 100+ tags, the picker remains usable via scroll. Search/filter within the picker is deferred to a future iteration. (Addresses PRD review P1-6.) |