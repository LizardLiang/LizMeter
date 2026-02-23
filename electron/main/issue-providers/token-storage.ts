// electron/main/issue-providers/token-storage.ts
// Encrypted token storage using Electron safeStorage (OS keychain-backed)
// Supports multiple providers via parameterized file names.

import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

type Provider = "github" | "linear";

function tokenPath(provider: Provider = "github"): string {
  return path.join(app.getPath("userData"), `.${provider}-token`);
}

export function saveToken(token: string, provider: Provider = "github"): void {
  const encrypted = safeStorage.encryptString(token);
  fs.writeFileSync(tokenPath(provider), encrypted);
}

export function loadToken(provider: Provider = "github"): string | null {
  try {
    const buf = fs.readFileSync(tokenPath(provider));
    return safeStorage.decryptString(buf);
  } catch {
    // keyring unavailable, file corrupt, or file does not exist
    return null;
  }
}

export function deleteToken(provider: Provider = "github"): void {
  try {
    fs.unlinkSync(tokenPath(provider));
  } catch {
    // no-op if file does not exist
  }
}

export function hasToken(provider: Provider = "github"): boolean {
  return fs.existsSync(tokenPath(provider));
}