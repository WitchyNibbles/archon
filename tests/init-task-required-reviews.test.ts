/**
 * TDD tests for the renderTaskPacketMarkdown required-reviews security fix.
 *
 * Bug: renderTaskPacketMarkdown emitted "- none" in the ## Required reviews section.
 * The Stop hook's parseRequiredReviews treats any entry exactly equal to "none" as an
 * explicit opt-out and returns [], so EVERY init-task packet was treated as requiring
 * no reviews in the offline / markdown-fallback enforcement path.
 *
 * Fix: emit the actual effective required review roles (the full trio) instead of "- none".
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hooksDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".claude",
  "hooks"
);

// Import parseRequiredReviews from the .mjs hook utility (same dynamic-import pattern
// used in hook-policy.test.ts and trust-fix-enforcement-gaps.test.ts).
const { parseRequiredReviews } = await import(`${hooksDir}/hook-utils.mjs`);

const { buildInitiativeRecords, renderTaskPacketMarkdown } = await import("../src/admin/init-task.ts");

// ---------------------------------------------------------------------------
// Minimal packet fixture — mirrors the pattern in review-tooling-fix.test.ts
// ---------------------------------------------------------------------------

function baseInitInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "fix-reviews-task",
    title: "Fix required reviews",
    ownerRole: "backend_engineer",
    goal: "Close the offline review-gate enforcement gap.",
    allowedWriteScope: ["src/admin/init-task.ts", "tests"],
    workspaceId: "ws1",
    projectId: "p1",
    runId: "run-uuid",
    taskUuid: "task-uuid",
    now: "2026-06-20T00:00:00.000Z",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 1. Core fix: parseRequiredReviews must return the full trio, not []
// ---------------------------------------------------------------------------

test("renderTaskPacketMarkdown: parseRequiredReviews returns full review trio, not []", () => {
  const { task, taskClass } = buildInitiativeRecords(baseInitInput());
  const markdown = renderTaskPacketMarkdown(task.packet, taskClass);

  const roles = parseRequiredReviews(markdown) as string[];

  // Must contain all three required gate reviewers
  assert.ok(
    roles.includes("reviewer"),
    `expected "reviewer" in parseRequiredReviews result, got: ${JSON.stringify(roles)}`
  );
  assert.ok(
    roles.includes("security_reviewer"),
    `expected "security_reviewer" in parseRequiredReviews result, got: ${JSON.stringify(roles)}`
  );
  assert.ok(
    roles.includes("qa_engineer"),
    `expected "qa_engineer" in parseRequiredReviews result, got: ${JSON.stringify(roles)}`
  );
});

test("renderTaskPacketMarkdown: parseRequiredReviews does NOT return empty array", () => {
  const { task, taskClass } = buildInitiativeRecords(baseInitInput());
  const markdown = renderTaskPacketMarkdown(task.packet, taskClass);

  const roles = parseRequiredReviews(markdown) as string[];

  assert.notDeepEqual(
    roles,
    [],
    "parseRequiredReviews must not return [] — that would bypass all offline review-gate enforcement"
  );
});

// ---------------------------------------------------------------------------
// 2. The "- none" opt-out sentinel must not appear in the rendered output
// ---------------------------------------------------------------------------

test("renderTaskPacketMarkdown: ## Required reviews section contains no '- none' line", () => {
  const { task, taskClass } = buildInitiativeRecords(baseInitInput());
  const markdown = renderTaskPacketMarkdown(task.packet, taskClass);

  const lines = markdown.split(/\r?\n/);

  // Find lines that are part of the Required reviews section
  let inSection = false;
  const sectionLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## Required reviews")) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("## ")) {
      break; // next section
    }
    if (inSection) {
      sectionLines.push(line);
    }
  }

  const hasNoneLine = sectionLines.some((l) => l.trim() === "- none");
  assert.equal(
    hasNoneLine,
    false,
    `## Required reviews section must not contain "- none". Section lines: ${JSON.stringify(sectionLines)}`
  );
});

// ---------------------------------------------------------------------------
// 3. The rendered section must list every role from the effective review trio
// ---------------------------------------------------------------------------

test("renderTaskPacketMarkdown: ## Required reviews section lists all three effective roles", () => {
  const { task, taskClass } = buildInitiativeRecords(baseInitInput());
  const markdown = renderTaskPacketMarkdown(task.packet, taskClass);

  // Extract the Required reviews section: everything between the header and
  // the next ## heading (or end of string). We must NOT use \s*$ in the
  // lookahead because it matches empty lines inside the section itself.
  const sectionMatch = markdown.match(/## Required reviews\n([\s\S]*?)(?=\n## |\s*$)/);
  assert.ok(sectionMatch, "## Required reviews section must be present");

  const sectionText = sectionMatch[1] ?? "";

  for (const role of ["reviewer", "security_reviewer", "qa_engineer"]) {
    assert.ok(
      sectionText.includes(role),
      `## Required reviews section must contain "${role}". Section text: ${JSON.stringify(sectionText)}`
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Verify across all task classes — the fix must hold regardless of class
// ---------------------------------------------------------------------------

const TASK_CLASSES = [
  "prototype_slice",
  "docs_only",
  "memory_curation",
  "state_sync",
  "scaffold_only",
] as const;

for (const cls of TASK_CLASSES) {
  test(`renderTaskPacketMarkdown[class=${cls}]: parseRequiredReviews returns non-empty trio`, () => {
    const { task, taskClass } = buildInitiativeRecords(baseInitInput({ class: cls }));
    const markdown = renderTaskPacketMarkdown(task.packet, taskClass);
    const roles = parseRequiredReviews(markdown) as string[];
    assert.notDeepEqual(roles, [], `class "${cls}" must not produce empty required reviews`);
    assert.ok(roles.includes("reviewer"), `class "${cls}" must include reviewer`);
    assert.ok(roles.includes("security_reviewer"), `class "${cls}" must include security_reviewer`);
    assert.ok(roles.includes("qa_engineer"), `class "${cls}" must include qa_engineer`);
  });
}

// ---------------------------------------------------------------------------
// 5. Verify cli.ts happy-path template already emits real roles (regression guard)
//
// cli.ts line 1985 already emits real roles. This test documents that and
// guards against future regressions. We replicate the tiny none/empty logic
// inline so this test file has no dependency on the hook for this assertion.
// ---------------------------------------------------------------------------

test("install/scaffold-templates.ts happy-path task template: ## Required reviews section emits real roles, not 'none'", async () => {
  // buildHappyPathFixtureTask was extracted from cli.ts to scaffold-templates.ts (S4).
  // We verify by inspecting the source text directly — the authoritative artifact.
  const { readFile } = await import("node:fs/promises");
  const scaffoldPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "install",
    "scaffold-templates.ts"
  );
  const src = await readFile(scaffoldPath, "utf8");

  // Find the Required reviews block in the happy-path fixture template.
  // We look for the block that contains the section header and verify it
  // lists real roles, not "none".
  const reviewsBlockMatch = src.match(/"## Required reviews"[\s\S]*?"## Rollback notes"/);
  assert.ok(reviewsBlockMatch,
    'scaffold-templates.ts must contain a "## Required reviews" block before "## Rollback notes"');

  const block = reviewsBlockMatch[0];
  assert.ok(!block.includes('"- none"') && !block.includes("- none"),
    'scaffold-templates.ts "## Required reviews" block must not contain "- none"');
  assert.ok(block.includes("reviewer"),
    'scaffold-templates.ts "## Required reviews" block must include "reviewer"');
  assert.ok(block.includes("security_reviewer"),
    'scaffold-templates.ts "## Required reviews" block must include "security_reviewer"');
  assert.ok(block.includes("qa_engineer"),
    'scaffold-templates.ts "## Required reviews" block must include "qa_engineer"');
});
