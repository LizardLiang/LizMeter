import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Per-test timeout (ms). Electron startup is included in beforeAll, not here.
  timeout: 30000,
  // Give beforeAll hooks longer to complete (Electron needs time to launch)
  globalTimeout: 300000,
  retries: 0,
  // Run test files sequentially — each file launches its own Electron instance
  // Running in parallel would spawn too many Electron processes
  workers: 1,
  use: {
    trace: "on-first-retry",
    // Extra timeout for actions in Electron (click, fill, etc.)
    actionTimeout: 10000,
  },
});