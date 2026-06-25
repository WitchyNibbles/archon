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
import { readFileSync } from "node:fs";

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
      page.locator("header").getByLabel("Run ID: sample-run-001")
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
    // The loader tries snapshot.live.json FIRST, then falls back to snapshot.json.
    // Stub the live path to 404 so the fallback is exercised — otherwise a stray
    // local web/public/snapshot.live.json (from a prior `forge snapshot` run) would
    // satisfy fetchLive() and the error panel would never render (silent pass).
    await page.route("**/snapshot.live.json", (route) =>
      route.fulfill({ status: 404, body: "Not Found" })
    );
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

    // The task card in qa_engineer column for sample-task-alpha should have
    // the passed badge (task-card__passed-badge) — actor is "qa_engineer"
    // Article aria-label: "Task sample-task-alpha: ..., gate state: passed"
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

/* ─── P1-S2b viewer done-bar (C5) ──────────────────────────────────────────── */

/**
 * Falsifiable viewer gate (C5).
 *
 * Asserts that, against the committed synthetic sample (snapshot.json):
 *   (a) A review_blocked run AND at least one of its blocking gates/roles is visible
 *       above the fold without scrolling — the blocker strip is the hero element.
 *   (b) A snapshot-age element (data-testid="snapshot-age") is present and contains
 *       readable age text ("snapshot … old").
 *
 * "Above the fold" is validated by checking the element's bounding box — top must be
 * within the viewport height (900px desktop). Playwright's isVisible() alone does
 * NOT prove above-the-fold placement; boundingBox() does.
 */
test.describe("P1-S2b viewer done-bar (C5)", () => {
  test("blocked run and blocking gate are visible above the fold", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForDashboard(page);

    // (a1) A review_blocked run must be shown — verify via the run header status badge.
    // The sample snapshot has status: "review_blocked".
    const statusBadge = page.locator("header.run-header").getByLabel(
      "Status: review_blocked"
    );
    await expect(statusBadge).toBeVisible();

    // Confirm it is above the fold: bounding box y (top edge) must be < viewport height.
    // Playwright boundingBox() returns { x, y, width, height } — y is the top edge.
    const headerBox = await statusBadge.boundingBox();
    expect(headerBox).not.toBeNull();
    const viewportHeight = page.viewportSize()?.height ?? 900;
    expect(headerBox!.y).toBeLessThan(viewportHeight);

    // (a2) The blocker strip (HERO element) must be visible — it shows the blocking
    // gate/role (security_reviewer, approval_missing, etc.).
    const blockerStrip = page.getByRole("region", { name: "Active blockers" });
    await expect(blockerStrip).toBeVisible();

    const stripBox = await blockerStrip.boundingBox();
    expect(stripBox).not.toBeNull();
    expect(stripBox!.y).toBeLessThan(viewportHeight);

    // (a3) At least one blocking gate reason referencing a gate role is visible
    // in the blocker strip — proves the blocker content is above the fold.
    const blockerReasonEl = page.getByText(
      "security_reviewer gate not passed",
      { exact: false }
    );
    await expect(blockerReasonEl).toBeVisible();

    const reasonBox = await blockerReasonEl.boundingBox();
    expect(reasonBox).not.toBeNull();
    expect(reasonBox!.y).toBeLessThan(viewportHeight);
  });

  test("snapshot-age element is present with readable age text", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForDashboard(page);

    // (b) The SnapshotAge component must render with data-testid="snapshot-age".
    const ageEl = page.getByTestId("snapshot-age");
    await expect(ageEl).toBeVisible();

    // The element must contain the word "snapshot" as the semantic prefix and "old"
    // as the suffix — making it a complete readable sentence ("snapshot Xm old").
    const ageText = await ageEl.textContent();
    expect(ageText).toMatch(/snapshot/i);
    expect(ageText).toMatch(/old/i);

    // The aria-label must include "Snapshot generated" so screen readers
    // get a clear accessible name — not just the visual shorthand.
    const ariaLabel = await ageEl.getAttribute("aria-label");
    expect(ariaLabel).toMatch(/Snapshot generated/i);

    // The <time> element with a datetime attribute must be present inside
    // the age element for machine-readable semantics (WCAG 1.3.1).
    const timeEl = ageEl.locator("time");
    await expect(timeEl).toBeAttached();
    const datetime = await timeEl.getAttribute("datetime");
    expect(datetime).not.toBeNull();
    // datetime must be a parseable ISO string
    const parsed = new Date(datetime!);
    expect(isNaN(parsed.getTime())).toBe(false);
  });

  test("snapshot-age reads 'just now' cleanly for a future-dated snapshot (no 'just now ago'/'just now old')", async ({
    page,
  }) => {
    // Regression guard: when the snapshot is future-dated (clock skew),
    // formatRelativeAge returns the complete phrase "just now"; the component
    // must NOT append " ago"/" old" (that yields incoherent text read verbatim
    // by screen readers — WCAG 1.3.1). Serve a future generatedAt to hit it.
    const sample = JSON.parse(
      readFileSync(new URL("../public/snapshot.json", import.meta.url), "utf8")
    ) as Record<string, unknown>;
    const future = new Date(Date.now() + 60_000).toISOString();
    await page.route("**/snapshot.live.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...sample, generatedAt: future }),
      })
    );

    await page.goto("/");
    await waitForDashboard(page);

    const ageEl = page.getByTestId("snapshot-age");
    await expect(ageEl).toBeVisible();

    const ariaLabel = await ageEl.getAttribute("aria-label");
    expect(ariaLabel).toBe("Snapshot generated just now");
    expect(ariaLabel).not.toMatch(/just now ago/i);

    const ageText = await ageEl.textContent();
    expect(ageText).toMatch(/just now/i);
    expect(ageText).not.toMatch(/just now old/i);
  });

  test("snapshot-age is visually distinct from authority badge and data timestamp", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForDashboard(page);

    // Authority badge: has aria-label "Authority: runtime authoritative"
    // and renders as a .badge-pill element (indigo pill).
    const authorityBadge = page.getByLabel("Authority: runtime authoritative");
    await expect(authorityBadge).toBeVisible();

    // Data timestamp: aria-label "Last updated: ..."
    const dataTimestamp = page.getByLabel(/Last updated:/);
    await expect(dataTimestamp).toBeVisible();

    // Snapshot age: aria-label "Snapshot generated X ago"
    const snapshotAge = page.getByLabel(/Snapshot generated/);
    await expect(snapshotAge).toBeVisible();

    // All three must be distinct DOM elements with distinct accessible names.
    // We verify via aria-label content — each carries a different label that
    // cannot be confused with the others semantically.
    const authorityAriaLabel = await authorityBadge.getAttribute("aria-label");
    const timestampAriaLabel = await dataTimestamp.getAttribute("aria-label");
    const ageAriaLabel = await snapshotAge.getAttribute("aria-label");

    expect(authorityAriaLabel).toMatch(/Authority:/i);
    expect(timestampAriaLabel).toMatch(/Last updated:/i);
    expect(ageAriaLabel).toMatch(/Snapshot generated/i);

    // Labels must all differ from one another
    expect(authorityAriaLabel).not.toBe(ageAriaLabel);
    expect(timestampAriaLabel).not.toBe(ageAriaLabel);
    expect(authorityAriaLabel).not.toBe(timestampAriaLabel);

    // The snapshot-age element must NOT carry the word "RUNTIME" or "ADVISORY"
    // (those belong to the authority badge only).
    const ageText = await snapshotAge.textContent();
    expect(ageText).not.toMatch(/RUNTIME|ADVISORY/i);

    // The snapshot-age must contain "snapshot" prefix (semantic differentiator)
    expect(ageText).toMatch(/snapshot/i);
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

/* ─── 5. forgeDashboardBlockerClarity — advisory/sealed rendering ────────── */

/**
 * Helpers to build synthetic snapshot payloads for the advisory/sealed tests.
 * These route the live JSON via page.route() so they work against the running
 * vite preview server with no DB needed.
 */

function readCommittedSample(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("../public/snapshot.json", import.meta.url), "utf8")
  ) as Record<string, unknown>;
}

/** Serve a custom snapshot payload for both live and sample paths. */
async function serveSnapshot(page: Parameters<typeof test>[1]["page"], payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload);
  await page.route("**/snapshot.live.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body })
  );
  await page.route("**/snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body })
  );
}

test.describe("forgeDashboardBlockerClarity — advisory section", () => {
  test("real blockers appear in the HERO panel (Active Blockers), not advisory", async ({ page }) => {
    // The committed sample has advisory:false blockers — they should appear in hero.
    await page.goto("/");
    await waitForDashboard(page);

    // HERO section is visible
    const heroSection = page.getByRole("region", { name: "Active blockers" });
    await expect(heroSection).toBeVisible();

    // The real blockers from snapshot are in the hero panel
    await expect(
      page.getByText("security_reviewer gate not passed", { exact: false })
    ).toBeVisible();

    // Advisory section must NOT be present when there are no advisory blockers
    await expect(
      page.getByRole("region", { name: /Advisories/i })
    ).not.toBeVisible();
  });

  test("advisory blockers render in a SEPARATE de-emphasised section", async ({ page }) => {
    const sample = readCommittedSample();

    // Inject a snapshot with one real + one advisory blocker
    const withAdvisory = {
      ...sample,
      blockers: [
        {
          id: "real-blocker-001",
          kind: "review_missing",
          reason: "security_reviewer gate not passed. No ReviewRecord found.",
          nextActions: ["Invoke security_reviewer agent"],
          taskId: "sample-task-alpha",
          advisory: false,
        },
        {
          id: "advisory-blocker-001",
          kind: "reasoning_quality",
          reason: "Task sample-task-alpha: reasoning-quality check failed — task records no reasoning verdict.",
          nextActions: ["Update task reasoning quality record"],
          taskId: "sample-task-alpha",
          advisory: true,
        },
      ],
    };

    await serveSnapshot(page, withAdvisory);
    await page.goto("/");
    await waitForDashboard(page);

    // Hero section shows the real blocker count (1)
    const heroSection = page.getByRole("region", { name: "Active blockers" });
    await expect(heroSection).toBeVisible();
    await expect(
      page.getByText("security_reviewer gate not passed", { exact: false })
    ).toBeVisible();

    // Advisory section is rendered separately
    const advisorySection = page.getByRole("region", { name: /Advisories/i });
    await expect(advisorySection).toBeVisible();
    await expect(
      page.getByText("reasoning-quality check failed", { exact: false })
    ).toBeVisible();

    // The advisory reason must NOT appear inside the hero section
    const advisoryReasonInHero = heroSection.getByText(
      "reasoning-quality check failed",
      { exact: false }
    );
    await expect(advisoryReasonInHero).not.toBeVisible();
  });

  test("hero shows only real blockers when advisory blockers exist alongside them", async ({ page }) => {
    const sample = readCommittedSample();

    const mixedSnapshot = {
      ...sample,
      blockers: [
        {
          id: "real-001",
          kind: "review_missing",
          reason: "reviewer gate not passed",
          nextActions: [],
          advisory: false,
        },
        {
          id: "advisory-001",
          kind: "reasoning_quality",
          reason: "strict reasoning policy not met",
          nextActions: [],
          advisory: true,
        },
        {
          id: "advisory-002",
          kind: "reasoning_quality",
          reason: "not yet ready for routing",
          nextActions: [],
          advisory: true,
        },
      ],
    };

    await serveSnapshot(page, mixedSnapshot);
    await page.goto("/");
    await waitForDashboard(page);

    // Advisory section shows count 2
    const advisorySection = page.getByRole("region", { name: /Advisories/i });
    await expect(advisorySection).toBeVisible();
    // The advisory count badge should contain "2"
    await expect(
      advisorySection.getByText("2", { exact: true })
    ).toBeVisible();

    // Hero section shows count 1
    const heroSection = page.getByRole("region", { name: "Active blockers" });
    await expect(
      heroSection.getByText("1", { exact: true })
    ).toBeVisible();
  });

  test("advisory section is absent when all blockers are real (no advisory:true)", async ({ page }) => {
    // The committed sample has no advisory blockers — advisory strip must not render.
    await page.goto("/");
    await waitForDashboard(page);

    await expect(
      page.getByRole("region", { name: /Advisories/i })
    ).not.toBeVisible();
  });

  test("hero shows empty state when all blockers are advisory", async ({ page }) => {
    const sample = readCommittedSample();

    const allAdvisory = {
      ...sample,
      header: { ...(sample.header as Record<string, unknown>), sealed: false },
      blockers: [
        {
          id: "advisory-001",
          kind: "reasoning_quality",
          reason: "reasoning-quality check failed",
          nextActions: [],
          advisory: true,
        },
      ],
    };

    await serveSnapshot(page, allAdvisory);
    await page.goto("/");
    await waitForDashboard(page);

    // Hero shows "No active blockers"
    const heroSection = page.getByRole("region", { name: "Active blockers" });
    await expect(heroSection).toBeVisible();
    await expect(heroSection.getByText("No active blockers")).toBeVisible();

    // Advisory section still renders with the advisory
    const advisorySection = page.getByRole("region", { name: /Advisories/i });
    await expect(advisorySection).toBeVisible();
  });

  test("advisory section: axe 0 critical/serious violations", async ({ page }) => {
    const sample = readCommittedSample();

    const withAdvisory = {
      ...sample,
      blockers: [
        {
          id: "real-001",
          kind: "review_missing",
          reason: "security_reviewer gate not passed",
          nextActions: ["Invoke security_reviewer"],
          taskId: "sample-task-alpha",
          advisory: false,
        },
        {
          id: "advisory-001",
          kind: "reasoning_quality",
          reason: "reasoning-quality check failed",
          nextActions: [],
          taskId: "sample-task-alpha",
          advisory: true,
        },
      ],
    };

    await serveSnapshot(page, withAdvisory);
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
            v.nodes.slice(0, 3).map((n) => `  - ${n.html.substring(0, 120)}`).join("\n")
        )
        .join("\n\n");
      throw new Error(
        `axe (advisory section) found ${criticalOrSerious.length} critical/serious violation(s):\n\n${formatted}`
      );
    }

    expect(criticalOrSerious).toHaveLength(0);
  });
});

test.describe("forgeDashboardBlockerClarity — sealed badge", () => {
  test("sealed badge is NOT shown for a non-sealed run", async ({ page }) => {
    // Committed sample: sealed: false
    await page.goto("/");
    await waitForDashboard(page);

    await expect(page.getByTestId("sealed-badge")).not.toBeVisible();
  });

  test("sealed badge IS shown when header.sealed = true", async ({ page }) => {
    const sample = readCommittedSample();

    const sealedSnapshot = {
      ...sample,
      header: {
        ...(sample.header as Record<string, unknown>),
        sealed: true,
      },
      blockers: [],
      pulse: { pulseState: "complete", activeLockCount: 0, lockedTaskIds: [] },
    };

    await serveSnapshot(page, sealedSnapshot);
    await page.goto("/");
    await waitForDashboard(page);

    // Sealed badge must appear
    const sealedBadge = page.getByTestId("sealed-badge");
    await expect(sealedBadge).toBeVisible();
    await expect(sealedBadge).toHaveText("Sealed");

    // Authority badge must still be present alongside the sealed badge
    await expect(
      page.getByLabel("Authority: runtime authoritative")
    ).toBeVisible();
  });

  test("sealed badge aria-label is accessible", async ({ page }) => {
    const sample = readCommittedSample();

    const sealedSnapshot = {
      ...sample,
      header: { ...(sample.header as Record<string, unknown>), sealed: true },
      blockers: [],
      pulse: { pulseState: "complete", activeLockCount: 0, lockedTaskIds: [] },
    };

    await serveSnapshot(page, sealedSnapshot);
    await page.goto("/");
    await waitForDashboard(page);

    const badge = page.getByTestId("sealed-badge");
    await expect(badge).toBeVisible();
    const ariaLabel = await badge.getAttribute("aria-label");
    expect(ariaLabel).toMatch(/sealed/i);
    expect(ariaLabel).toMatch(/all tasks complete/i);
  });

  test("sealed run: axe 0 critical/serious violations", async ({ page }) => {
    const sample = readCommittedSample();

    const sealedSnapshot = {
      ...sample,
      header: { ...(sample.header as Record<string, unknown>), sealed: true },
      blockers: [],
      pulse: { pulseState: "complete", activeLockCount: 0, lockedTaskIds: [] },
    };

    await serveSnapshot(page, sealedSnapshot);
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
            v.nodes.slice(0, 3).map((n) => `  - ${n.html.substring(0, 120)}`).join("\n")
        )
        .join("\n\n");
      throw new Error(
        `axe (sealed run) found ${criticalOrSerious.length} critical/serious violation(s):\n\n${formatted}`
      );
    }

    expect(criticalOrSerious).toHaveLength(0);
  });
});
