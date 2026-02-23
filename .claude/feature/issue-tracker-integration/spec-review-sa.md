# Spec Review — SA / Architecture Perspective

## Document Info
| Field | Value |
|-------|-------|
| **Reviewed** | tech-spec.md |
| **Against** | prd.md + actual codebase |
| **Reviewer** | Apollo (SA Agent) |
| **Date** | 2026-02-22 |
| **Verdict** | APPROVED WITH NOTES — minor revisions required |

---

## Review Summary

The architecture is sound. The provider abstraction (`IssueProvider` interface), safeStorage token isolation, denormalized session columns, and IPC patterns all align correctly with the existing codebase. Naming conventions match (`issues:list`, `issues:set-token`, etc.). The migration guard using `PRAGMA table_info` is correct.

Four issues require resolution before implementation begins. None require re-architecting — they are concrete gaps in the spec text.

---

## Architecture Assessment

### IssueProvider Interface
**Pass.** The interface is minimal and appropriate — `listIssues`, `validateToken`, `clearCache`, `destroy`. Adding Linear later requires only a new class implementing the same interface. No changes to IPC, UI, or session storage needed.

### safeStorage + File Token Storage
**Pass with note.** `safeStorage.encryptString()` → write `Buffer` to `{userData}/.github-token` is correct. Reading back: `safeStorage.decryptString(fs.readFileSync(tokenPath))`. This approach is simpler than storing a BLOB in SQLite and avoids encoding complexity.

**Note (Critical):** `loadToken()` does not wrap `safeStorage.decryptString()` in try/catch. On some Linux DEs, if the keyring becomes unavailable after the token was encrypted (e.g. user logs in without unlocking the keyring), `decryptString` throws and crashes the main process before `initDatabase()` completes. Fix: wrap in try/catch, return `null` on failure, log a warning.

### IPC Channels
**Pass.** The 4 new channels (`issues:list`, `issues:provider-status`, `issues:set-token`, `issues:delete-token`) follow the existing `noun:verb` convention established by `session:save`, `settings:get`, etc. The `issues` namespace on `ElectronAPI` matches the `session`, `tag`, `settings` pattern.

One addition needed: `shell:open-external` for the History page issue links. The spec identifies this as an open question. Given `shell.openExternal` is not currently exposed in the preload, a handler is needed. The spec correctly specifies protocol validation (`http://` or `https://` only) — this is the right security model.

### Database Migration
**Pass.** The `PRAGMA table_info(sessions)` guard before `ALTER TABLE ADD COLUMN` is idempotent and SQLite-safe. The three nullable columns (`issue_number`, `issue_title`, `issue_url`) correctly snapshot the issue at link time — no FK needed since issues are external.

### Component Design
**Pass.** `IssuePickerDropdown` pattern mirrors `TagPicker.tsx` (existing component), which is the right approach for design consistency. `useIssues` hook follows `useSessionHistory.ts` with the refresh token counter pattern.

---

## Critical Issues (Must Fix Before Implementation)

### 1. `initProviderFromDisk()` is never called at startup

The spec defines `electron/main/issue-providers/index.ts` with an `initProviderFromDisk()` function, but `electron/main/index.ts` is never mentioned in the modified-files list. Without an explicit call inside `app.whenReady()`, the provider will be `null` on every app launch — `issues:list` will always throw `"No token configured"` even for users who previously saved their token.

**Fix:** Add to `electron/main/index.ts` modified-files list and spec the call order:
```typescript
app.whenReady().then(async () => {
  initDatabase();
  registerIpcHandlers();
  initProviderFromDisk();  // ADD THIS — restores provider from saved token
  // ... window creation etc
});
```

### 2. `@octokit/rest` ESM/CJS compatibility must be explicitly resolved

`@octokit/rest` v21+ is ESM-only. The main process is compiled by `vite-plugin-electron` which uses Rollup. Without explicit configuration, the ESM import will fail at build time.

**Fix (one of two options — spec must pick one):**

**Option A — Pin to v20 (CJS-compatible):**
```bash
bun add @octokit/rest@^20
```
v20.1.1 is the last CJS-compatible release. Simple, no build config changes needed.

**Option B — Use ESM interop in vite.config.ts:**
```typescript
// vite.config.ts — inside electron({ main: { ... } })
ssr: {
  noExternal: ["@octokit/rest"],
}
```
This tells Vite to bundle `@octokit/rest` into the main process output rather than leaving it as an external require. More complex but keeps the latest version.

**Recommendation: Option A (pin to v20).** Lower risk for an Electron app, well-documented, no build config changes.

### 3. `safeStorage.decryptString` needs try/catch in `loadToken()`

See Architecture Assessment above. Add:
```typescript
export function loadToken(): string | null {
  try {
    const buf = fs.readFileSync(tokenPath());
    return safeStorage.decryptString(buf);
  } catch {
    return null;  // keyring unavailable or file corrupt
  }
}
```

### 4. `useIssues` hook: object dependency in `useEffect` risks infinite re-render

The hook as specced has `input` (an `IssuesListInput` object) as a `useEffect` dependency. If the caller passes an inline object literal (`useIssues({ repo: "foo/bar" })`), every render creates a new object reference, causing the effect to re-run infinitely.

**Fix:** Use `JSON.stringify` as a stable dependency key:
```typescript
useEffect(() => {
  // ... fetch logic
}, [status.configured, JSON.stringify(input), refreshToken]);
```
Or document that callers must wrap the input in `useMemo`.

---

## Major Issues (Should Fix)

### 5. `@me` assignee in `listForRepo` needs authenticated username

The spec notes in Open Questions that `listForRepo` requires the username string (not `@me`) for the `assignee` param. This needs a concrete resolution:

**Fix:** Cache `authenticatedUsername` in `GitHubProvider`:
```typescript
private authenticatedUsername: string | null = null;

private async getUsername(): Promise<string> {
  if (!this.authenticatedUsername) {
    const { data } = await this.octokit.rest.users.getAuthenticated();
    this.authenticatedUsername = data.login;
  }
  return this.authenticatedUsername;
}
```
Call `getUsername()` before repo-scoped `listForRepo`. Reset on `destroy()`.

---

## Minor Issues

### 6. `safeStorage.isEncryptionAvailable()` check not specified

On Linux without a configured keyring, `safeStorage.isEncryptionAvailable()` returns `false` and `encryptString` stores data without encryption. The spec mentions this in a security note but doesn't specify what to do.

**Recommendation:** In `saveToken()`, check `safeStorage.isEncryptionAvailable()`. If `false`, show a warning in the Settings UI ("Your token will be stored without encryption on this system — consider setting up a system keyring"). Do not silently proceed with unencrypted storage.

### 7. Cache max-size not bounded

The `Map<string, Issue[]>` in `GitHubProvider` has no eviction policy. At desktop scale (single user, few repos) this is not a problem, but document the known limitation.

### 8. `useIssues` debounce for repo filter

If `IssuesPage` calls `useIssues({ repo: selectedRepo })` and the user types in the repo filter field, each keystroke triggers a re-render. The filter should only apply after the user finishes typing (300ms debounce in the component, not the hook).

---

## Findings Summary

| Severity | Count | Items |
|----------|-------|-------|
| Critical | 4 | `initProviderFromDisk` not called; ESM/CJS unresolved; `loadToken` no try/catch; `useIssues` infinite loop |
| Major | 1 | `@me` username in repo-scoped queries |
| Minor | 3 | `isEncryptionAvailable` check; cache size; debounce |

---

## Verdict

**APPROVED WITH NOTES**

The core architecture is sound. The four critical issues are all spec text gaps — concrete and fixable without rearchitecting. Recommend updating `tech-spec.md` with:

1. Add `electron/main/index.ts` to modified-files list with `initProviderFromDisk()` call
2. Resolve `@octokit/rest` version — pin to v20 (Option A, recommended)
3. Add try/catch to `loadToken()` code sample
4. Document the `JSON.stringify` dependency pattern for `useIssues`
5. Add `getUsername()` caching pattern to `GitHubProvider`

These are implementation-guidance fixes. Ares can address them during implementation without a full spec re-review. Approving with notes — proceed to Stage 6 (Test Plan).