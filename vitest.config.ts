import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "better-sqlite3": path.resolve("./src/test/better-sqlite3-shim.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    environmentMatchGlobs: [
      ["src/main/**", "node"],
    ],
  },
});
