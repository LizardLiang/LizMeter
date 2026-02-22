// electron/main/issue-providers/token-storage.ts
// Encrypted GitHub PAT storage using Electron safeStorage (OS keychain-backed)

import { app, safeStorage } from "electron";
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
    // keyring unavailable, file corrupt, or file does not exist
    return null;
  }
}

export function deleteToken(): void {
  try {
    fs.unlinkSync(tokenPath());
  } catch {
    // no-op if file does not exist
  }
}

export function hasToken(): boolean {
  return fs.existsSync(tokenPath());
}
