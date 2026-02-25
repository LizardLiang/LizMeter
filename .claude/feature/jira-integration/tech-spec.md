# Technical Specification: Jira Integration

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Jira Integration |
| **Author** | Hephaestus (Tech Spec Agent) |
| **Date** | 2026-02-23 |
| **PRD** | prd.md v1.1 |

---

## 1. Overview

Add Jira Cloud as a third issue provider following the same patterns as GitHub (`github-provider.ts`) and Linear (`linear-provider.ts`). Jira uses its own class like Linear (not the generic `IssueProvider` interface, since that interface is GitHub-specific with `Issue[]` return types). Jira gets its own IPC namespace (`jira:*`), provider class, hook, preload API section, and settings UI section.

---

## 2. Architecture

### Current Provider Pattern

Each provider follows the same architecture:
```
Provider class (electron/main/issue-providers/)
  → IPC handlers (electron/main/ipc-handlers.ts)
  → Preload bridge (electron/preload/index.ts)
  → React hook (src/renderer/src/hooks/)
  → UI components (SettingsPage.tsx, IssuesPage.tsx, IssuePickerDropdown.tsx, ProviderTabs.tsx)
```

**Key insight from codebase analysis:** Linear does NOT use the `IssueProvider` interface. It has its own `LinearProvider` class with its own types (`LinearIssue`, `LinearTeam`, etc.). Jira should follow this same pattern — its own `JiraProvider` class with its own types (`JiraIssue`).

### Token Storage

Tokens use encrypted file storage via `electron/main/issue-providers/token-storage.ts` with `safeStorage`. The `Provider` type is `"github" | "linear"`. We add `"jira"` to this union. Jira requires 3 credentials (domain, email, API token) — only the API token goes to safeStorage. Domain and email are stored in the `settings` table via `setSettingValue`.

---

## 3. Files to Create

### 3.1 `electron/main/issue-providers/jira-provider.ts`

```typescript
import type { JiraIssue } from "../../../src/shared/types.ts";
import { IssueProviderError } from "./types.ts";

interface RawJiraIssue {
  id: string;
  key: string;          // e.g. "PROJ-123"
  fields: {
    summary: string;
    status: { name: string };
    priority?: { name: string } | null;
    assignee?: { displayName: string } | null;
    issuetype?: { name: string } | null;
    labels: string[];
  };
}

function mapToJiraIssue(raw: RawJiraIssue, domain: string): JiraIssue {
  return {
    id: raw.id,
    key: raw.key,
    title: raw.fields.summary,
    url: `https://${domain}/browse/${raw.key}`,
    status: raw.fields.status.name,
    priority: raw.fields.priority?.name ?? null,
    assignee: raw.fields.assignee?.displayName ?? null,
    issueType: raw.fields.issuetype?.name ?? null,
    labels: raw.fields.labels ?? [],
  };
}

export class JiraProvider {
  private domain: string;
  private authHeader: string;
  private cache = new Map<string, JiraIssue[]>();

  constructor(domain: string, email: string, apiToken: string) {
    this.domain = domain;
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }

  async testConnection(): Promise<{ displayName: string }> {
    const response = await this.request("/rest/api/3/myself");
    const data = await response.json();
    return { displayName: data.displayName };
  }

  async fetchIssues(projectKey: string | null, jqlFilter: string | null, forceRefresh = false): Promise<JiraIssue[]> {
    const cacheKey = jqlFilter ?? projectKey ?? "__all__";
    if (forceRefresh) this.cache.delete(cacheKey);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let jql: string;
    if (jqlFilter) {
      jql = jqlFilter;
    } else if (projectKey) {
      jql = `project = ${projectKey} ORDER BY updated DESC`;
    } else {
      jql = "assignee = currentUser() ORDER BY updated DESC";
    }

    const params = new URLSearchParams({
      jql,
      maxResults: "50",
      fields: "summary,status,priority,assignee,issuetype,labels",
    });

    const response = await this.request(`/rest/api/3/search?${params}`);
    const data = await response.json();
    const issues = (data.issues ?? []).map((raw: RawJiraIssue) => mapToJiraIssue(raw, this.domain));
    this.cache.set(cacheKey, issues);
    return issues;
  }

  private async request(path: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`https://${this.domain}${path}`, {
        headers: {
          "Authorization": this.authHeader,
          "Accept": "application/json",
        },
      });
    } catch {
      throw new IssueProviderError(
        `Could not reach ${this.domain}. Check the domain and your internet connection.`,
        "NETWORK_ERROR",
      );
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new IssueProviderError(
          "Jira credentials are invalid. Check your email and API token.",
          "AUTH_FAILED",
        );
      }
      if (response.status === 403) {
        throw new IssueProviderError(
          "Access denied. Your API token may lack permissions for this resource.",
          "AUTH_FAILED",
        );
      }
      if (response.status === 429) {
        throw new IssueProviderError(
          "Jira API rate limit reached. Try again in a few minutes.",
          "RATE_LIMITED",
        );
      }
      // For 400 errors (bad JQL), try to extract Jira's error message
      if (response.status === 400) {
        try {
          const errBody = await response.json();
          const msgs = errBody.errorMessages ?? [];
          throw new IssueProviderError(
            msgs.length > 0 ? msgs[0] : "Invalid request to Jira API",
            "QUERY_ERROR",
          );
        } catch (e) {
          if (e instanceof IssueProviderError) throw e;
        }
      }
      throw new IssueProviderError(
        `Jira API error: ${response.status} ${response.statusText}`,
        "NETWORK_ERROR",
      );
    }

    return response;
  }

  clearCache(): void {
    this.cache.clear();
  }

  destroy(): void {
    this.cache.clear();
  }
}
```

### 3.2 `src/renderer/src/hooks/useJiraIssues.ts`

```typescript
import { useCallback, useEffect, useState } from "react";
import type { JiraIssue } from "../../../shared/types.ts";

export interface UseJiraIssuesReturn {
  issues: JiraIssue[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useJiraIssues(): UseJiraIssuesReturn {
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const fetchIssues = useCallback(async (forceRefresh: boolean) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.jira.fetchIssues({ forceRefresh });
      setIssues(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch Jira issues");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchIssues(refreshToken > 0);
  }, [fetchIssues, refreshToken]);

  const refresh = useCallback(() => {
    setRefreshToken((t) => t + 1);
  }, []);

  return { issues, isLoading, error, refresh };
}
```

---

## 4. Files to Modify

### 4.1 `src/shared/types.ts`

**Add JiraIssue type** (after LinearTeam):
```typescript
export interface JiraIssue {
  id: string;          // Jira internal ID
  key: string;         // e.g. "PROJ-123"
  title: string;       // fields.summary
  url: string;         // https://{domain}/browse/{key}
  status: string;      // fields.status.name e.g. "In Progress"
  priority: string | null;  // fields.priority.name
  assignee: string | null;  // fields.assignee.displayName
  issueType: string | null; // fields.issuetype.name
  labels: string[];
}

export interface JiraProviderStatus {
  configured: boolean;       // API token exists in safeStorage
  domainSet: boolean;        // jira_domain exists in settings
  projectKeySet: boolean;    // jira_project_key exists in settings (optional)
}
```

**Extend IssueRef union** (add Jira variant):
```typescript
export type IssueRef =
  | { provider: "github"; number: number; title: string; url: string; }
  | { provider: "linear"; identifier: string; title: string; url: string; }
  | { provider: "jira"; key: string; title: string; url: string; };
```

**Extend Session.issueProvider and SaveSessionInput.issueProvider:**
```typescript
// In Session:
issueProvider: "github" | "linear" | "jira" | null;
// In SaveSessionInput:
issueProvider?: "github" | "linear" | "jira";
```

**Add jira to ElectronAPI interface:**
```typescript
jira: {
  setToken: (input: { token: string }) => Promise<void>;
  deleteToken: () => Promise<void>;
  testConnection: () => Promise<{ displayName: string }>;
  fetchIssues: (input: { forceRefresh?: boolean }) => Promise<JiraIssue[]>;
  providerStatus: () => Promise<JiraProviderStatus>;
  setDomain: (input: { domain: string }) => Promise<void>;
  setEmail: (input: { email: string }) => Promise<void>;
  setProjectKey: (input: { projectKey: string }) => Promise<void>;
  setJqlFilter: (input: { jql: string }) => Promise<void>;
};
```

### 4.2 `electron/main/issue-providers/token-storage.ts`

**Extend Provider type:**
```typescript
type Provider = "github" | "linear" | "jira";
```

### 4.3 `electron/main/issue-providers/index.ts`

**Add Jira provider singleton:**
```typescript
import { JiraProvider } from "./jira-provider.ts";

let jiraProvider: JiraProvider | null = null;

export function initJiraProviderFromDisk(): void {
  const token = loadToken("jira");
  const domain = /* import getSettingValue */ getSettingValue("jira_domain");
  const email = /* import getSettingValue */ getSettingValue("jira_email");
  if (token && domain && email) {
    jiraProvider = new JiraProvider(domain, email, token);
  }
}

export function getJiraProvider(): JiraProvider | null {
  return jiraProvider;
}

export function setJiraProvider(provider: JiraProvider | null): void {
  jiraProvider = provider;
}
```

**Add to imports:** `getSettingValue` from `../database.ts`

### 4.4 `electron/main/ipc-handlers.ts`

**Add imports:**
```typescript
import { JiraProvider } from "./issue-providers/jira-provider.ts";
import { getJiraProvider, setJiraProvider } from "./issue-providers/index.ts";
```

**Add Jira IPC handlers** (after Linear handlers, ~line 188):
```typescript
// Jira IPC handlers
ipcMain.handle("jira:set-token", (_event, input: { token: string }) => {
  if (!input.token || input.token.trim().length === 0) {
    throw new Error("Token cannot be empty");
  }
  const trimmed = input.token.trim();
  saveToken(trimmed, "jira");
  // Reconstruct provider if domain and email are already set
  const domain = getSettingValue("jira_domain");
  const email = getSettingValue("jira_email");
  if (domain && email) {
    setJiraProvider(new JiraProvider(domain, email, trimmed));
  }
});

ipcMain.handle("jira:delete-token", () => {
  getJiraProvider()?.destroy();
  setJiraProvider(null);
  deleteToken("jira");
  deleteSettingValue("jira_domain");
  deleteSettingValue("jira_email");
  deleteSettingValue("jira_project_key");
  deleteSettingValue("jira_jql_filter");
});

ipcMain.handle("jira:test-connection", async () => {
  const provider = getJiraProvider();
  if (!provider) throw new IssueProviderError("No Jira credentials configured", "NO_TOKEN");
  return provider.testConnection();
});

ipcMain.handle("jira:fetch-issues", async (_event, input: { forceRefresh?: boolean }) => {
  const provider = getJiraProvider();
  if (!provider) throw new IssueProviderError("No Jira credentials configured", "NO_TOKEN");
  const projectKey = getSettingValue("jira_project_key");
  const jqlFilter = getSettingValue("jira_jql_filter");
  return provider.fetchIssues(projectKey, jqlFilter, input?.forceRefresh ?? false);
});

ipcMain.handle("jira:provider-status", (): JiraProviderStatus => {
  const configured = hasToken("jira");
  const domain = getSettingValue("jira_domain");
  const projectKey = getSettingValue("jira_project_key");
  return {
    configured,
    domainSet: configured && domain !== null,
    projectKeySet: configured && projectKey !== null,
  };
});

ipcMain.handle("jira:set-domain", (_event, input: { domain: string }) => {
  setSettingValue("jira_domain", input.domain.trim());
  // Reconstruct provider with new domain
  reconstructJiraProvider();
});

ipcMain.handle("jira:set-email", (_event, input: { email: string }) => {
  setSettingValue("jira_email", input.email.trim());
  reconstructJiraProvider();
});

ipcMain.handle("jira:set-project-key", (_event, input: { projectKey: string }) => {
  if (input.projectKey.trim()) {
    setSettingValue("jira_project_key", input.projectKey.trim());
  } else {
    deleteSettingValue("jira_project_key");
  }
});

ipcMain.handle("jira:set-jql-filter", (_event, input: { jql: string }) => {
  if (input.jql.trim()) {
    setSettingValue("jira_jql_filter", input.jql.trim());
  } else {
    deleteSettingValue("jira_jql_filter");
  }
});
```

**Helper function** (inside `registerIpcHandlers` or at module scope):
```typescript
function reconstructJiraProvider(): void {
  const token = loadToken("jira");
  const domain = getSettingValue("jira_domain");
  const email = getSettingValue("jira_email");
  if (token && domain && email) {
    getJiraProvider()?.destroy();
    setJiraProvider(new JiraProvider(domain, email, token));
  }
}
```

**Update `issues:provider-status`** (add `jiraConfigured`):
```typescript
// Extend the IssueProviderStatus type and add:
jiraConfigured: hasToken("jira"),
jiraDomainSet: hasToken("jira") && getSettingValue("jira_domain") !== null,
```

### 4.5 `electron/preload/index.ts`

**Add jira section:**
```typescript
jira: {
  setToken: (input: { token: string }) => ipcRenderer.invoke("jira:set-token", input),
  deleteToken: () => ipcRenderer.invoke("jira:delete-token"),
  testConnection: () => ipcRenderer.invoke("jira:test-connection"),
  fetchIssues: (input: { forceRefresh?: boolean }) => ipcRenderer.invoke("jira:fetch-issues", input),
  providerStatus: () => ipcRenderer.invoke("jira:provider-status"),
  setDomain: (input: { domain: string }) => ipcRenderer.invoke("jira:set-domain", input),
  setEmail: (input: { email: string }) => ipcRenderer.invoke("jira:set-email", input),
  setProjectKey: (input: { projectKey: string }) => ipcRenderer.invoke("jira:set-project-key", input),
  setJqlFilter: (input: { jql: string }) => ipcRenderer.invoke("jira:set-jql-filter", input),
},
```

### 4.6 `electron/main/database.ts`

**Add `"jira"` to `VALID_ISSUE_PROVIDERS`:**
```typescript
const VALID_ISSUE_PROVIDERS = new Set(["github", "linear", "jira"]);
```

### 4.7 `electron/main/index.ts`

**Add initialization call** (alongside `initProviderFromDisk` and `initLinearProviderFromDisk`):
```typescript
import { initJiraProviderFromDisk } from "./issue-providers/index.ts";
// In the app.whenReady() or similar:
initJiraProviderFromDisk();
```

### 4.8 `src/renderer/src/components/ProviderTabs.tsx`

**Extend ProviderTabId:**
```typescript
export type ProviderTabId = "github" | "linear" | "jira";
```

**Add label:**
```typescript
const PROVIDER_LABELS: Record<ProviderTabId, string> = {
  github: "GitHub",
  linear: "Linear",
  jira: "Jira",
};
```

### 4.9 `src/renderer/src/components/IssuesPage.tsx`

**Add JiraIssueList component** (similar to LinearIssueList):
- Import `useJiraIssues` hook
- Import `JiraIssue` type
- Create `JiraIssueList` functional component with search, loading, error, issue cards
- Create `JiraIssueCard` — show `issue.key`, `issue.title`, `issue.status`, optional `issue.priority`, `issue.assignee`
- Click opens `issue.url` via `shell.openExternal`

**Update `IssuesPage` to include Jira tab:**
- Check `jiraConfigured` from a new `useJiraStatus` or extend the existing status check
- Add `"jira"` to `availableProviders` when configured
- Render `<JiraIssueList />` when `effectiveTab === "jira"`

### 4.10 `src/renderer/src/components/IssuePickerDropdown.tsx`

**Add Jira to the picker:**
- Import `useJiraIssues` and `JiraIssue` type
- Add Jira filtering logic
- Add `handleSelectJira` function creating `IssueRef` with `provider: "jira"` and `key: issue.key`
- Add Jira issue rendering in dropdown list
- Update `selectedIssue` display for Jira (show `issue.key` like `PROJ-123`)

### 4.11 `src/renderer/src/components/SettingsPage.tsx`

**Add Jira settings section** (after Linear section):
- New state variables: `jiraStatus`, `jiraDomain`, `jiraEmail`, `jiraTokenInput`, `jiraProjectKey`, `jiraJqlFilter`, `jiraTesting`, `jiraTestResult`
- Load Jira status on mount via `window.electronAPI.jira.providerStatus()`
- When not configured: show form with domain, email, token, project key (optional), JQL (optional)
- When configured: show "Connected" with Test Connection and Disconnect buttons
- Save each field via its IPC handler (`jira:set-domain`, `jira:set-email`, etc.)
- Token saved via `jira:set-token`, after which auto-test-connection
- Help link: `https://id.atlassian.com/manage-profile/security/api-tokens`

### 4.12 `src/renderer/src/components/SessionHistoryItem.tsx`

**Update issue display for Jira:**
- When `issueProvider === "jira"`, display the key (stored in session) instead of `#number`

---

## 5. Settings Storage

| Key | Storage Location | Purpose |
|-----|-----------------|---------|
| Jira API token | `safeStorage` file (`.jira-token`) | Encrypted credential |
| `jira_domain` | `settings` table | e.g. "mycompany.atlassian.net" |
| `jira_email` | `settings` table | e.g. "user@company.com" |
| `jira_project_key` | `settings` table | e.g. "PROJ" (optional) |
| `jira_jql_filter` | `settings` table | Custom JQL (optional) |

---

## 6. Jira REST API v3 Details

| Endpoint | Purpose | Method |
|----------|---------|--------|
| `/rest/api/3/myself` | Test connection, get display name | GET |
| `/rest/api/3/search?jql=...&maxResults=50&fields=summary,status,priority,assignee,issuetype,labels` | Fetch/search issues | GET |

**Auth header:** `Authorization: Basic base64(email:apiToken)`

**JQL construction priority:**
1. If `jira_jql_filter` is set → use it directly
2. Else if `jira_project_key` is set → `project = {key} ORDER BY updated DESC`
3. Else → `assignee = currentUser() ORDER BY updated DESC`

---

## 7. Error Handling

Uses existing `IssueProviderError` class with codes:

| HTTP Status | Error Code | User Message |
|-------------|------------|-------------|
| Network failure | `NETWORK_ERROR` | "Could not reach {domain}..." |
| 401 | `AUTH_FAILED` | "Jira credentials are invalid..." |
| 403 | `AUTH_FAILED` | "Access denied..." |
| 429 | `RATE_LIMITED` | "Jira API rate limit reached..." |
| 400 | `QUERY_ERROR` | Jira's error message (bad JQL) |

---

## 8. Testing Strategy

### Unit Tests: `electron/main/issue-providers/__tests__/jira-provider.test.ts`
- Mock `fetch` globally
- Test `mapToJiraIssue` mapping
- Test JQL construction (with/without project key, with/without JQL filter)
- Test auth header construction (base64)
- Test error handling (401, 403, 429, 400, network)
- Test caching behavior

### Renderer Tests
- Test `useJiraIssues` hook with mocked `window.electronAPI.jira`
- Test `ProviderTabs` renders Jira tab
- Test `IssuePickerDropdown` shows Jira issues and creates correct `IssueRef`

---

## 9. Implementation Order

1. `src/shared/types.ts` — Add JiraIssue, JiraProviderStatus, extend IssueRef, extend issueProvider unions
2. `electron/main/issue-providers/token-storage.ts` — Add `"jira"` to Provider type
3. `electron/main/issue-providers/jira-provider.ts` — New file, JiraProvider class
4. `electron/main/issue-providers/index.ts` — Add Jira provider singleton + init
5. `electron/main/database.ts` — Add `"jira"` to VALID_ISSUE_PROVIDERS
6. `electron/main/ipc-handlers.ts` — Add all `jira:*` IPC handlers
7. `electron/preload/index.ts` — Add `jira` section to contextBridge
8. `electron/main/index.ts` — Call `initJiraProviderFromDisk()`
9. `src/renderer/src/hooks/useJiraIssues.ts` — New file, hook
10. `src/renderer/src/components/ProviderTabs.tsx` — Add "jira" tab
11. `src/renderer/src/components/SettingsPage.tsx` — Add Jira settings section
12. `src/renderer/src/components/IssuesPage.tsx` — Add JiraIssueList + tab
13. `src/renderer/src/components/IssuePickerDropdown.tsx` — Add Jira to picker
14. Tests