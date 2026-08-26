import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "better-sqlite3": path.resolve("./src/test/better-sqlite3-shim.ts"),
    },
    // Vitest resolves independently of vite.config.ts, so the CodeMirror dedupe has to be
    // repeated here or the live-preview tests hit the same duplicate-instance error.
    dedupe: [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@lezer/common",
      "@lezer/highlight",
    ],
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "electron/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    // Must stay above the 5000ms asyncUtilTimeout in src/test/setup.ts. Left at the 5000ms
    // default the two expire together, so a `findBy*` that needs one extra retry under load
    // kills the test with a bare "Test timed out" instead of Testing Library's actual
    // "unable to find element" message -- which reads as a random flake in a different test
    // each run. The headroom does not make any assertion more lenient.
    testTimeout: 15000,
    environmentMatchGlobs: [
      ["electron/main/**", "node"],
    ],
    coverage: {
      provider: "v8",
      exclude: [
        "**/*.module.scss",
        "**/*.scss",
        "**/node_modules/**",
        "**/dist/**",
        "**/dist-electron/**",
        "src/test/**",
        "**/*.config.*",
        "**/*.d.ts",
      ],
    },
  },
});
