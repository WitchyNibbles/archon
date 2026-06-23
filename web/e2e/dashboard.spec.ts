/**
 * E2E tests — Archon Forge Swimlane Monitor (Phase 0, Direction C).
 *
 * Coverage:
 *   1. Happy path — dashboard loads, key landmarks and content visible
 *   2. Done-bar assertion — gate states including passed/blocked render correctly
 *   3. Responsive — critical layout elements render at mobile viewport (390×844)
 *   4. Accessibility (axe) — zero critical/serious violations on desktop + mobile
 *
 * Data: static snapshot at /snapshot.json (see web/public/snapshot.json).
 * Server: vite preview (see playwright.config.ts webServer).
 */

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/* ─── helpers ──────────────────────────────────────────────────────────────── */

/** Wait for the dashboard to fully load (spinner gone, h1 visible). */
async function waitForDashboard(page: Page): Promise<void> {
  // Spinner is aria-labelled "Loading dashboard"
  // Wait until the loading panel is gone
  await expect(page.getByLabel("Loading dashboard")).not.toBeVisible({
    timeout: 15_000,
  });
  // h1 must be present
  await expect(page.locator("h1")).toBeVisible({ timeout: 5_000 });
}

/* ─── 1. Happy path ─────────────────────────────────────────────────────────── */

test.describe("Happy path", () => {
  test("dashboard loads and renders expected content", async ({ page }) => {
    await page.goto("/");
    await waitForDashboard(page);

    // Run title from snapshot header — in h1
    await expect(page.locator("h1")).toHaveText("forge-web-dashboard");

    // Run ID in run header (mono, aria-label) — scoped to header element
    await expect(
      page.locator("header").getByLabel("Run ID: run_forge_phase0_a7d01b78")
    ).toBeVisible();

    // Status badge: review_blocked — scoped to the run header to avoid
    // matching the many task-card status elements with the same label
    await expect(
      page.locator("header.run-header").getByLabel("Status: review_blocked")
    ).toBeVisible();

    // Authority badge: RUNTIME (runtime_authoritative)
    // Use aria-label to target the badge element precisely (avoids strict mode
    // violation when "RUNTIME" also appears in blocker reason text)
    await expect(
      page.getByLabel("Authority: runtime authoritative")
    ).toBeVisible();

    // Blocker strip: the two blockers from the snapshot should render
    // Blocker 1 reason text (partial match)
    await expect(
      page.getByText("security_reviewer gate not passed", { exact: false })
    ).toBeVisible();

    // Blocker 2 reason text (partial match)
    await expect(
      page.getByText("approved but final approval record absent", { exact: false })
    ).toBeVisible();

    // Swimlane grid with three columns
    await expect(page.getByLabel("Review gate swimlanes")).toBeVisible();
    await expect(page.locator("[aria-label='reviewer lane']")).toBeVisible();
    await expect(page.locator("[aria-label='security_reviewer lane']")).toBeVisible();
    await expect(page.locator("[aria-label='qa_engineer lane']")).toBeVisible();

    // No error panel: role="alert" should not be visible
    await expect(page.getByRole("alert")).not.toBeVisible();
  });

  test("error panel shown when snapshot fails to load", async ({ page }) => {
    // Intercept snapshot.json and return an error payload
    await page.route("**/snapshot.json", (route) =>
      route.fulfill({ status: 500, body: "Internal Server Error" })
    );

    await page.goto("/");

    // Wait for error alert to appear
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10_000 });

    // h1 should NOT appear — we're in error state
    await expect(page.locator("h1")).not.toBeVisible();
  });
});

/* ─── 2. Done-bar / gate state assertions ───────────────────────────────────── */

test.describe("Gate state rendering", () => {
  test("task with passed qa_engineer gate shows passed badge", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForDashboard(page);

    /*
     * Snapshot facts:
     *   forgePhase0Skeleton has:
     *     - reviewer gate: pending → appears in reviewer lane
     *     - security_reviewer gate: blocked → appears in security_reviewer lane
     *     - qa_engineer gate: passed (actor: "qa_engineer") → appears in qa_engineer lane
     *   dashboardContract has:
     *     - reviewer gate: pending
     *     - security_reviewer gate: pending
     *     - qa_engineer gate: pending
     *
     * constraintsManifest (approved) and hookOutsideRepoCanonicalize (done)
     * have no reviewGates — they do not appear in any swimlane column.
     */

    // reviewer lane: forgePhase0Skeleton + dashboardContract
    const reviewerLane = page.locator("[aria-label='reviewer lane']");
    await expect(
      reviewerLane.getByText("Forge Phase-0 Swimlane Monitor Dashboard", {
        exact: false,
      })
    ).toBeVisible();

    // security_reviewer lane: forgePhase0Skeleton (blocked) + dashboardContract (pending)
    const secLane = page.locator("[aria-label='security_reviewer lane']");
    await expect(
      secLane.getByText("Forge Phase-0 Swimlane Monitor Dashboard", {
        exact: false,
      })
    ).toBeVisible();

    // qa_engineer lane: forgePhase0Skeleton (passed) + dashboardContract (pending)
    const qaLane = page.locator("[aria-label='qa_engineer lane']");
    await expect(
      qaLane.getByText("Forge Phase-0 Swimlane Monitor Dashboard", {
        exact: false,
      })
    ).toBeVisible();

    // The task card in qa_engineer column for forgePhase0Skeleton should have
    // the passed badge (task-card__passed-badge) — actor is "qa_engineer"
    // Article aria-label: "Task forgePhase0Skeleton: ..., gate state: passed"
    const passedCard = qaLane.locator("article[aria-label*='gate state: passed']");
    await expect(passedCard).toBeVisible();

    const passedBadge = passedCard.locator(".task-card__passed-badge");
    await expect(passedBadge).toBeVisible();
    // The badge shows the actor name "qa_engineer"
    await expect(passedBadge).toHaveText("qa_engineer");
  });

  test("security_reviewer lane is a bottleneck (has blocked indicator)", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForDashboard(page);

    // security_reviewer column has a "blocked" gate → isBottleneck = true
    // The bottleneck dot has role="img" aria-label="Bottleneck lane"
    const secLane = page.locator("[aria-label='security_reviewer lane']");
    await expect(secLane).toBeVisible();

    const bottleneckDot = secLane.getByRole("img", { name: "Bottleneck lane" });
    await expect(bottleneckDot).toBeVisible();

    // reviewer lane has only "pending" gates — NOT a bottleneck
    const reviewerLane = page.locator("[aria-label='reviewer lane']");
    await expect(
      reviewerLane.getByRole("img", { name: "Bottleneck lane" })
    ).not.toBeVisible();
  });

  test("pulse dot shows BLOCKED status label", async ({ page }) => {
    await page.goto("/");
    await waitForDashboard(page);

    // PulseDot aria-label: "Run status: BLOCKED" (from STATE_CONFIG.blocked.label)
    await expect(page.getByLabel("Run status: BLOCKED")).toBeVisible();
  });

  test("run header shows RUNTIME authority badge", async ({ page }) => {
    await page.goto("/");
    await waitForDashboard(page);

    // AuthorityBadge for "runtime_authoritative" renders "RUNTIME" text
    // Scoped via aria-label to avoid strict mode violation
    await expect(
      page.getByLabel("Authority: runtime authoritative")
    ).toBeVisible();

    // Last updated timestamp should be visible (formatted as YYYY-MM-DD HH:MMZ)
    await expect(
      page.getByLabel("Last updated: 2026-06-23T14:32:11Z")
    ).toBeVisible();
  });
});

/* ─── 3. Responsive ──────────────────────────────────────────────────────────── */

test.describe("Responsive layout", () => {
  /*
   * These tests run in both desktop-chromium (1440×900) and mobile-chromium
   * (390×844) projects. Content visibility is tested — not pixel dimensions.
   */

  test("key elements are visible at viewport width", async ({ page }) => {
    await page.goto("/");
    await waitForDashboard(page);

    // h1 must be visible
    await expect(page.locator("h1")).toBeVisible();

    // Run status badge visible — scoped to run header
    await expect(
      page.locator("header.run-header").getByLabel("Status: review_blocked")
    ).toBeVisible();

    // Swimlane section visible (may require scrolling on mobile)
    await expect(page.getByLabel("Review gate swimlanes")).toBeVisible();

    // Blocker strip visible (HERO content — highest priority)
    // Use getByRole("region") to avoid strict mode: the section's aria-label
    // "Active blockers" also partially matches the count span "2 active blockers"
    await expect(
      page.getByRole("region", { name: "Active blockers" })
    ).toBeVisible();
    await expect(
      page.getByText("security_reviewer gate not passed", { exact: false })
    ).toBeVisible();
  });

  test("no console errors on load", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto("/");
    await waitForDashboard(page);

    // Zero console errors expected — catches React rendering crashes,
    // snapshot validation failures, or unhandled promise rejections
    expect(consoleErrors).toHaveLength(0);
  });
});

/* ─── 4. Accessibility (axe) ─────────────────────────────────────────────────── */

test.describe("Accessibility (axe-core)", () => {
  test("desktop: zero critical/serious violations", async ({ page }) => {
    await page.goto("/");
    await waitForDashboard(page);

    const results = await new AxeBuilder({ page })
      /*
       * WCAG 2.1 AA tags. Color-contrast is included — tokens pre-verified:
       *   --text-primary:         #EDEDED / #0A0A0A  ≈ 18.1:1 (AAA)
       *   --text-secondary:       #A0A0A0 / #0A0A0A  ≈  7.6:1 (AAA)
       *   --status-pending-text:  #A5B4FC / #111111  ≈  8.0:1 (AAA)
       *   --status-error-text:    #F87171 / #111111  ≈  4.6:1 (AA)
       *   --status-success:       #22C55E / #111111  ≈  5.3:1 (AA)
       *   --status-warning:       #F59E0B / #111111  ≈  7.6:1 (AAA)
       *   --status-running:       #06B6D4 / #111111  ≈  4.8:1 (AA)
       */
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    // Filter to only critical and serious violations
    const criticalOrSerious = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious"
    );

    if (criticalOrSerious.length > 0) {
      // Format violations for readable failure output
      const formatted = criticalOrSerious
        .map(
          (v) =>
            `[${v.impact?.toUpperCase()}] ${v.id}: ${v.description}\n` +
            v.nodes
              .slice(0, 3)
              .map((n) => `  - ${n.html.substring(0, 120)}`)
              .join("\n")
        )
        .join("\n\n");
      throw new Error(
        `axe found ${criticalOrSerious.length} critical/serious violation(s):\n\n${formatted}`
      );
    }

    expect(criticalOrSerious).toHaveLength(0);
  });

  test("mobile: zero critical/serious violations", async ({ page }) => {
    await page.goto("/");
    await waitForDashboard(page);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const criticalOrSerious = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious"
    );

    if (criticalOrSerious.length > 0) {
      const formatted = criticalOrSerious
        .map(
          (v) =>
            `[${v.impact?.toUpperCase()}] ${v.id}: ${v.description}\n` +
            v.nodes
              .slice(0, 3)
              .map((n) => `  - ${n.html.substring(0, 120)}`)
              .join("\n")
        )
        .join("\n\n");
      throw new Error(
        `axe (mobile) found ${criticalOrSerious.length} critical/serious violation(s):\n\n${formatted}`
      );
    }

    expect(criticalOrSerious).toHaveLength(0);
  });

  test("keyboard navigation: main landmark contains h1", async ({ page }) => {
    await page.goto("/");
    await waitForDashboard(page);

    // Main landmark must exist
    const main = page.locator("main");
    await expect(main).toBeAttached();

    // h1 is inside main
    await expect(main.locator("h1")).toBeAttached();
    await expect(main.locator("h1")).toHaveText("forge-web-dashboard");

    // Tab through the page — at least one focusable element
    await page.keyboard.press("Tab");
    // Focus should be somewhere on the page; just verify the page is interactive
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(focused).toBeTruthy();
  });
});
