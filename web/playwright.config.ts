/**
 * Playwright config — Archon Forge web dashboard (Phase 0, Direction C).
 *
 * Port strategy: we use an env-var PORT (defaulting to a high ephemeral
 * number 51743) so the port is never hard-coded to 5173. If the env var
 * PLAYWRIGHT_PORT is set (e.g. in CI), that port is used instead, which
 * allows running multiple parallel test suites without conflicts.
 *
 * Scope: web/** only. Root package.json is never touched.
 */

import { defineConfig, devices } from "@playwright/test";

/* Pick an OS-level ephemeral port. Default: 51743 (well above registered range).
 * Override with PLAYWRIGHT_PORT env var to avoid conflicts in parallel CI. */
const port = parseInt(process.env["PLAYWRIGHT_PORT"] ?? "51743", 10);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: process.env["CI"] ? 1 : undefined,

  /* Reporter: list in local runs, github in CI */
  reporter: process.env["CI"] ? "github" : "list",

  use: {
    baseURL,
    /* Screenshots on failure only — artifacts in test-results/ */
    screenshot: "only-on-failure",
    /* Traces on retry only */
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],

  outputDir: "test-results",

  webServer: {
    /*
     * Build first, then preview on the ephemeral port.
     * PLAYWRIGHT_PORT env var controls the port; default is 51743.
     * This avoids hardcoding 5173 (vite dev default) — the preview
     * server uses a dedicated port that only Playwright uses.
     */
    command: `npm run build && npx vite preview --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    /*
     * Allow up to 60 s for tsc + vite build on first run.
     */
    timeout: 60_000,
  },
});
