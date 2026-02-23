# Technical Specification: Issue Tracker Integration

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | issue-tracker-integration |
| **Author** | Hephaestus (Tech Spec Agent) |
| **Status** | Draft |
| **Date** | 2026-02-22 |
| **PRD** | prd.md v1.0 (Approved with Notes) |

---

## 1. Overview

Add GitHub Issues integration to LizMeter so users can browse assigned issues, link them to Pomodoro sessions before starting, and see the linkage in history. A `IssueProvider` abstraction layer is built in from the start so Linear can be added later.

Key constraints from codebase analysis:
- `TomatoClock.tsx` owns `activePage: NavPage` state and renders all pages — **not** `App.tsx`
- `NavPage` union is defined in `NavSidebar.tsx`: currently `"timer" | "history" | "stats" | "tags" | "settings"`
- `ElectronAPI` uses namespaced objects (`session`, `settings`, `tag`, `window`)
- `SaveSessionInput` and `Session` types are in `src/shared/types.ts`
- Token stored as an encrypted file (not SQLite) — `safeStorage` returns a `Buffer`

---

## 2. Architecture

### Process Flow
```
Renderer (React 19)
  IssuesPage            — browse assigned issues, manual refresh
  IssuePickerDropdown   — select issue before starting timer (in TomatoClock)
  SettingsPage          — token entry/removal (extend existing page)
  HistoryPage           — show linked issue badge (extend existing)
        |
        | window.electronAPI.issues.*  (contextBridge)
        v
Preload (electron/preload/index.ts)
  issues: { list, providerStatus, setToken, deleteToken }
        |
        | ipcMain.handle("issues:*")
        v
Main Process
  issue-providers/GitHubProvider   — octokit, cache, error mapping
  issue-providers/token-storage    — safeStorage encrypt/decrypt
        |
        | better-sqlite3 (issue columns on sessions table)
        v
SQLite
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| `@octokit/rest` for GitHub | Official SDK, typed, handles retries |
| `safeStorage` + file for token | Built-in Electron, OS-keychain backed, no extra deps, avoids BLOB in SQLite |
| Token never crosses IPC | Raw PAT enters only via `issues:set-token`, is encrypted immediately in main; renderer never sees it |
| Denormalized issue cols on sessions | No separate issues table; issues are external — snapshot is sufficient |
| In-memory cache in GitHubProvider | Avoids redundant API calls within one app session; cleared on explicit refresh or token change |
| Issue linkage only on completion | Reset/abandon clears the picker selection; issue ref only saved when `session:save` is called |
| Auto-fill session title from issue | Selected issue title populates the title field; user can override before starting |

---

## 3. Database Schema Changes

### Migrations (in `electron/main/database.ts` `initDatabase()`)

```sql
-- Run after existing CREATE TABLE statements
-- Guarded by PRAGMA table_info check to be idempotent
ALTER TABLE sessions ADD COLUMN issue_number INTEGER;
ALTER TABLE sessions ADD COLUMN issue_title  TEXT;
ALTER TABLE sessions ADD COLUMN issue_url    TEXT;
```

All columns are nullable — existing rows get `NULL`, no data migration needed.

### Guard pattern (idempotent migration):
```typescript
const cols = (db.pragma("table_info(sessions)") as Array<{ name: string }>).map((c) => c.name);
if (!cols.includes("issue_number")) {
  db.exec("ALTER TABLE sessions ADD COLUMN issue_number INTEGER");
  db.exec("ALTER TABLE sessions ADD COLUMN issue_title TEXT");
  db.exec("ALTER TABLE sessions ADD COLUMN issue_url TEXT");
}
```

### Token File
```
{app.getPath("userData")}/.github-token   (encrypted Buffer from safeStorage)
```
Deleted on token removal. Never stored in SQLite.

---

## 4. TypeScript Types (`src/shared/types.ts`)

### New types to add

```typescript
// --- Issue Tracker Types ---

export interface Issue {
  number: number;
  title: string;
  url: string;           // html_url
  repo: string;          // "owner/repo"
  state: "open" | "closed";
  labels: IssueLabel[];
  updatedAt: string;     // ISO 8601
}

export interface IssueLabel {
  name: string;
  color: string;         // hex without #, e.g. "7aa2f7"
}

export interface IssueProviderStatus {
  configured: boolean;
  provider: "github" | null;
}

export interface IssuesListInput {
  repo?: string;          // optional "owner/repo" filter
  forceRefresh?: boolean; // if true, clears cache before fetching
}

export interface IssuesListResult {
  issues: Issue[];
}

export interface IssuesSetTokenInput {
  token: string;
  provider: "github";
}
```

### Extend existing `SaveSessionInput`

```typescript
export interface SaveSessionInput {
  title: string;
  timerType: TimerType;
  plannedDurationSeconds: number;
  actualDurationSeconds: number;
  // NEW — all optional:
  issueNumber?: number;
  issueTitle?: string;
  issueUrl?: string;
}
```

### Extend existing `Session`

```typescript
export interface Session {
  id: string;
  title: string;
  timerType: TimerType;
  plannedDurationSeconds: number;
  actualDurationSeconds: number;
  completedAt: string;
  tags: Tag[];
  // NEW — all optional/nullable:
  issueNumber: number | null;
  issueTitle: string | null;
  issueUrl: string | null;
}
```

### Extend `ElectronAPI` — add `issues` namespace

```typescript
export interface ElectronAPI {
  platform: string;
  session: { /* unchanged */ };
  settings: { /* unchanged */ };
  tag: { /* unchanged */ };
  window: { /* unchanged */ };
  // NEW:
  issues: {
    list: (input: IssuesListInput) => Promise<IssuesListResult>;
    providerStatus: () => Promise<IssueProviderStatus>;
    setToken: (input: IssuesSetTokenInput) => Promise<void>;
    deleteToken: () => Promise<void>;
  };
}
```

---

## 5. IPC Channels

| Channel | Handler Args | Return | Purpose |
|---------|-------------|--------|---------|
| `issues:list` | `IssuesListInput` | `IssuesListResult` | Fetch assigned open issues; in-memory cache |
| `issues:provider-status` | — | `IssueProviderStatus` | Check if token is configured; no API call |
| `issues:set-token` | `IssuesSetTokenInput` | `void` | Encrypt + store token, instantiate provider |
| `issues:delete-token` | — | `void` | Delete token file, destroy provider instance |
| `session:save` | `SaveSessionInput` (extended) | `Session` | Existing channel — now also writes issue cols |

---

## 6. Provider Architecture

### `electron/main/issue-providers/types.ts`
```typescript
export interface IssueProvider {
  readonly providerName: string;       // "github"
  listIssues(input: IssuesListInput): Promise<Issue[]>;
  clearCache(): void;
  destroy(): void;
}

export class IssueProviderError extends Error {
  constructor(
    message: string,
    public readonly code: "NO_TOKEN" | "AUTH_FAILED" | "NETWORK_ERROR" | "RATE_LIMITED",
  ) {
    super(message);
    this.name = "IssueProviderError";
  }
}
```

### `electron/main/issue-providers/github-provider.ts`
- Constructor accepts `token: string`; creates `new Octokit({ auth: token })`
- `listIssues({ repo, forceRefresh })`:
  - If `forceRefresh`, clear cache entry first
  - Check in-memory `Map<string, Issue[]>` cache (key = `repo ?? "__all__"`)
  - No cache hit → call `octokit.rest.issues.listForAuthenticatedUser({ filter: "assigned", state: "open", sort: "updated", direction: "desc", per_page: 100 })` (or repo-scoped endpoint if `repo` provided)
  - Filter out PR items (`item.pull_request !== undefined`)
  - Map to `Issue[]`, store in cache, return
  - Error mapping: 401 → `AUTH_FAILED`, 403 + rate-limit header → `RATE_LIMITED`, others → `NETWORK_ERROR`

### `electron/main/issue-providers/token-storage.ts`
```typescript
import { safeStorage, app } from "electron";
import fs from "node:fs";
import path from "node:path";

function tokenPath(): string {
  return path.join(app.getPath("userData"), ".github-token");
}

export function saveToken(token: string): void {
  const encrypted = safeStorage.encryptString(token);
  fs.writeFileSync(tokenPath(), encrypted);
}

export function loadToken(): string | null {
  try {
    const buf = fs.readFileSync(tokenPath());
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

export function deleteToken(): void {
  try { fs.unlinkSync(tokenPath()); } catch { /* no-op if missing */ }
}

export function hasToken(): boolean {
  return fs.existsSync(tokenPath());
}
```

### `electron/main/issue-providers/index.ts`
- Exports `initProviderFromDisk()` — called at app start; loads token if file exists, creates `GitHubProvider`
- Exports `getProvider(): IssueProvider | null`
- Exports `setProvider(provider: IssueProvider | null)`

---

## 7. Main Process Changes

### `electron/main/database.ts`

1. Add idempotent migration in `initDatabase()` (see §3)
2. Extend `saveSession()` INSERT to include `issue_number`, `issue_title`, `issue_url`
3. Extend `SessionRow` internal interface and `listSessions()` SELECT to include these columns
4. Return them on the `Session` object (null when absent)

### `electron/main/ipc-handlers.ts`

Add after existing handlers:
```typescript
import { getProvider, setProvider } from "./issue-providers/index.ts";
import { GitHubProvider } from "./issue-providers/github-provider.ts";
import { IssueProviderError } from "./issue-providers/types.ts";
import { saveToken, deleteToken, hasToken } from "./issue-providers/token-storage.ts";
import type { IssuesListInput, IssuesSetTokenInput, IssueProviderStatus } from "../../src/shared/types.ts";

ipcMain.handle("issues:list", async (_event, input: IssuesListInput) => {
  const provider = getProvider();
  if (!provider) throw new IssueProviderError("No token configured", "NO_TOKEN");
  return { issues: await provider.listIssues(input) };
});

ipcMain.handle("issues:provider-status", (): IssueProviderStatus => ({
  configured: hasToken(),
  provider: hasToken() ? "github" : null,
}));

ipcMain.handle("issues:set-token", (_event, input: IssuesSetTokenInput) => {
  saveToken(input.token);
  const provider = new GitHubProvider(input.token);
  setProvider(provider);
});

ipcMain.handle("issues:delete-token", () => {
  getProvider()?.destroy();
  setProvider(null);
  deleteToken();
});
```

### `electron/preload/index.ts`

Add `issues` namespace to the `contextBridge.exposeInMainWorld` call:
```typescript
issues: {
  list: (input: IssuesListInput) => ipcRenderer.invoke("issues:list", input),
  providerStatus: () => ipcRenderer.invoke("issues:provider-status"),
  setToken: (input: IssuesSetTokenInput) => ipcRenderer.invoke("issues:set-token", input),
  deleteToken: () => ipcRenderer.invoke("issues:delete-token"),
},
```

---

## 8. Renderer Changes

### `src/renderer/src/components/NavSidebar.tsx`

- Add `"issues"` to `NavPage` union: `"timer" | "history" | "stats" | "tags" | "settings" | "issues"`
- Add a new nav item to `NAV_ITEMS` array:
  ```typescript
  { id: "issues", label: "Issues", Icon: IssuesIcon }
  ```
- Add `IssuesIcon` SVG (use a standard bug/issue icon — circle with two dots inside, or similar)

### `src/renderer/src/components/TomatoClock.tsx`

- Import `IssuesPage` component
- Render `<IssuesPage />` when `activePage === "issues"`
- Add `pendingIssue: Issue | null` state
- Pass `pendingIssue` and `onIssueSelect` to the timer view area
- When `status === "completed"` and saving session, include `issueNumber`, `issueTitle`, `issueUrl` from `pendingIssue`
- Clear `pendingIssue` on timer reset and after session save

### `src/renderer/src/hooks/useIssues.ts` (new)

```typescript
import { useState, useEffect, useCallback } from "react";
import type { Issue, IssueProviderStatus, IssuesListInput } from "../../../shared/types.ts";

export interface UseIssuesReturn {
  issues: Issue[];
  status: IssueProviderStatus;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useIssues(input?: IssuesListInput): UseIssuesReturn {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [status, setStatus] = useState<IssueProviderStatus>({ configured: false, provider: null });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    void window.electronAPI.issues.providerStatus().then(setStatus);
  }, [refreshToken]);

  useEffect(() => {
    if (!status.configured) {
      setIssues([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    const req: IssuesListInput = input?.forceRefresh
      ? { ...input, forceRefresh: true }
      : input ?? {};
    void window.electronAPI.issues
      .list(req)
      .then((res) => setIssues(res.issues))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to fetch issues"))
      .finally(() => setIsLoading(false));
  }, [status.configured, refreshToken]);

  const refresh = useCallback(() => {
    setRefreshToken((t) => t + 1);
  }, []);

  return { issues, status, isLoading, error, refresh };
}
```

### `src/renderer/src/components/IssuesPage.tsx` (new)

States:
1. No token → empty state with "Configure GitHub token in Settings" + link to settings
2. Loading → spinner (Tokyo Night themed, consistent with rest of app)
3. Loaded, empty → "No open issues assigned to you"
4. Loaded → issue list rows
5. Error → error message + Retry button

Issue row shows: `#number`, `title`, `repo`, label chips (colored), `Refresh` button in header.

Clicking a row does nothing (issues page is read-only browse; issue linking happens in Timer page).

**Props:**
```typescript
interface Props {
  onNavigate: (page: NavPage) => void;
}
```
(Needs `onNavigate` to link to Settings from the empty state.)

### `src/renderer/src/components/IssuePickerDropdown.tsx` (new)

**Props:**
```typescript
interface Props {
  selectedIssue: Issue | null;
  onSelect: (issue: Issue | null) => void;
}
```

Behavior:
- Hidden when `status.configured === false` (check via `useIssues`)
- Shows "🔗 Link issue" button when no issue selected
- Click → opens dropdown with search input + issue list
- Typing filters by title or `#number` substring (client-side)
- Selecting an issue: calls `onSelect(issue)`, closes dropdown
- Selected state: shows `#42 Issue title` chip with an ×  clear button
- Clear button: calls `onSelect(null)`
- Keyboard: arrow keys navigate list, Enter selects, Escape closes

Pattern modeled on `TagPicker.tsx` (existing component with similar toggle+list+chip pattern).

### `src/renderer/src/components/HistoryPage.tsx` (modify)

In each session row, after the existing tag chips, add:
```tsx
{session.issueNumber && (
  <a
    className={styles.issueLink}
    onClick={() => window.electronAPI.shell.openExternal(session.issueUrl!)}
    title={session.issueTitle ?? ""}
  >
    #{session.issueNumber}
  </a>
)}
```

Note: `shell.openExternal` must be exposed in the preload. Check if it already exists; if not, add:
```typescript
// in preload/index.ts
shell: {
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
},
```
And in `ipc-handlers.ts`:
```typescript
import { shell } from "electron";
ipcMain.handle("shell:open-external", (_event, url: string) => {
  // Validate protocol to prevent injection
  if (url.startsWith("https://") || url.startsWith("http://")) {
    void shell.openExternal(url);
  }
});
```
Add `shell` to `ElectronAPI` in types.ts.

### `SettingsPage.tsx` (modify — extend existing)

Add an "Issue Tracker" section:
- If token configured: shows "GitHub — Connected ✓" + "Remove token" button
- If not configured: shows a password `<input>` for the token + "Save" button + helper text linking to github.com/settings/tokens
- On save: calls `window.electronAPI.issues.setToken({ token, provider: "github" })`, refreshes status
- On remove: calls `window.electronAPI.issues.deleteToken()`, refreshes status
- Token input is `type="password"` (masked)

---

## 9. Files Summary

### New Files
| Path | Purpose |
|------|---------|
| `electron/main/issue-providers/types.ts` | `IssueProvider` interface + `IssueProviderError` |
| `electron/main/issue-providers/token-storage.ts` | safeStorage encrypt/decrypt/delete/check |
| `electron/main/issue-providers/github-provider.ts` | `GitHubProvider` class |
| `electron/main/issue-providers/index.ts` | Provider manager (init, get, set) |
| `src/renderer/src/hooks/useIssues.ts` | Hook for issue list + provider status |
| `src/renderer/src/components/IssuesPage.tsx` | Issues browser page |
| `src/renderer/src/components/IssuesPage.module.scss` | Styles |
| `src/renderer/src/components/IssuePickerDropdown.tsx` | Timer-area issue picker |
| `src/renderer/src/components/IssuePickerDropdown.module.scss` | Styles |

### Modified Files
| Path | Changes |
|------|---------|
| `src/shared/types.ts` | Add `Issue`, `IssueLabel`, `IssueProviderStatus`, input/result types; extend `SaveSessionInput`, `Session`, `ElectronAPI` |
| `electron/main/database.ts` | Idempotent migration; extend INSERT + SELECT + `SessionRow` for issue cols |
| `electron/main/ipc-handlers.ts` | Register 4 new `issues:*` handlers + `shell:open-external`; extend `session:save` |
| `electron/preload/index.ts` | Expose `issues` + `shell` namespaces |
| `src/renderer/src/components/NavSidebar.tsx` | Add `"issues"` to `NavPage`; add nav item |
| `src/renderer/src/components/TomatoClock.tsx` | Add `IssuesPage` route; add `pendingIssue` state; pass to `IssuePickerDropdown`; include in save payload |
| `src/renderer/src/components/HistoryPage.tsx` | Render issue badge with link on rows that have `issueNumber` |
| `src/renderer/src/components/SettingsPage.tsx` | Add Issue Tracker token section |
| `package.json` | Add `@octokit/rest` dependency |

---

## 10. Dependency

```bash
bun add @octokit/rest
```

This is the only new production dependency. No new dev dependencies required.

---

## 11. Error Handling

### Main Process
All `issues:*` handlers `try/catch` and rethrow `IssueProviderError`. Electron serializes the error to the renderer, where it surfaces as a rejected Promise. The renderer catches it in the hook and sets `error` state.

### Error Code → UI Message Mapping
| Code | User Message |
|------|-------------|
| `NO_TOKEN` | "Configure a GitHub token in Settings to see issues." |
| `AUTH_FAILED` | "Token is invalid or has been revoked. Update it in Settings." |
| `RATE_LIMITED` | "GitHub API rate limit reached. Try again in a few minutes." |
| `NETWORK_ERROR` | "Could not reach GitHub. Check your internet connection." |

### Session Save
If `session:save` fails (existing error path), the issue reference is not saved — this is acceptable since the session itself failed to save. Existing error handling in `TomatoClock.tsx` applies.

---

## 12. Security

1. **Token isolation**: The raw PAT is sent once over IPC (`issues:set-token`), encrypted immediately with `safeStorage.encryptString()`, written to file, and the plaintext discarded. No handler ever returns the token.
2. **`shell.openExternal` validation**: Only `http://` and `https://` URLs allowed — prevents `file://` or custom protocol injection.
3. **Input validation on `issues:set-token`**: Reject empty or obviously invalid tokens before touching the filesystem.
4. **safeStorage fallback**: If `safeStorage.isEncryptionAvailable()` returns `false` (some Linux DEs without keyring), display a warning in Settings that the token will be stored unencrypted, and require user acknowledgment before saving.

---

## 13. Testing Strategy

### Unit Tests (Vitest)
| File | What to test |
|------|-------------|
| `electron/main/issue-providers/__tests__/github-provider.test.ts` | Mock `@octokit/rest`; test PR filtering, cache hit/miss, error code mapping (401, 403, network) |
| `electron/main/issue-providers/__tests__/token-storage.test.ts` | Mock `safeStorage` and `fs`; test save/load/delete/hasToken |
| `src/renderer/src/hooks/__tests__/useIssues.test.ts` | Mock `window.electronAPI.issues`; test loading state, error state, refresh token counter |
| `src/renderer/src/components/__tests__/IssuePickerDropdown.test.tsx` | Render with mock issues, test search filter, select, clear, keyboard nav |

### Integration Tests (Vitest + sql.js shim)
- `initDatabase(":memory:")` followed by migration guard → verify `issue_number` column exists
- `saveSession({ ..., issueNumber: 42, issueTitle: "Fix bug", issueUrl: "https://github.com/..." })` → `listSessions()` → verify fields returned correctly

---

## 14. Open Questions

| Question | Recommendation |
|----------|---------------|
| Does `shell.openExternal` already exist in the preload? | Check preload/index.ts; if not present, add it as described in §8 |
| Repo-scoped `listForRepo` — `assignee` param needs username string, not `@me` | On first call, fetch `octokit.rest.users.getAuthenticated()`, cache the login, use for repo-scoped queries |
| `safeStorage.isEncryptionAvailable()` === false on some Linux | Show warning in Settings; require user consent before storing unencrypted |