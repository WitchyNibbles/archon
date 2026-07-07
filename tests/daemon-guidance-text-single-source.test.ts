import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { formatMissingReviewActorHint, MISSING_REVIEW_ACTOR_HINT_WORDS } from "../src/daemon-guidance-text.ts";

// ---------------------------------------------------------------------------
// Round-14 MEDIUM fix: daemon/supervisor.ts previously carried its OWN local
// `formatMissingReviewActorHint` duplicate alongside the shared
// daemon-guidance-text.ts export — the shared import was dead code, and the
// round-13 "single-sourced" claim was false. Cross-module check, the same
// pattern setup-playwright.test.ts uses to pin setup-playwright.ts and
// merge.ts together: (1) supervisor.ts's own SOURCE must import the shared
// function and must NOT redefine it locally, so a future edit can't silently
// reintroduce the duplicate; (2) the shared function's real output and the
// shared constant's static words must agree.
// ---------------------------------------------------------------------------

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("daemon/supervisor.ts imports formatMissingReviewActorHint from daemon-guidance-text.ts and does not redefine it locally", async () => {
  const supervisorSource = await readFile(resolve(repoRoot, "src/daemon/supervisor.ts"), "utf8");
  assert.match(
    supervisorSource,
    /import\s*\{\s*formatMissingReviewActorHint\s*\}\s*from\s*["']\.\.\/daemon-guidance-text\.ts["']/,
    "supervisor.ts must import the shared formatMissingReviewActorHint, not keep its own copy"
  );
  assert.doesNotMatch(
    supervisorSource,
    /function\s+formatMissingReviewActorHint\s*\(/,
    "supervisor.ts must not redefine formatMissingReviewActorHint locally — that is exactly the dead-code duplicate round 14 closed"
  );
});

test("formatMissingReviewActorHint's real output and MISSING_REVIEW_ACTOR_HINT_WORDS's static words agree", () => {
  const rendered = formatMissingReviewActorHint("qa_engineer");
  const staticPrefix = MISSING_REVIEW_ACTOR_HINT_WORDS.split("<role>")[0]!;
  assert.ok(
    rendered.startsWith(staticPrefix),
    `rendered hint "${rendered}" must start with the shared constant's static prefix "${staticPrefix}"`
  );
  assert.equal(rendered, "provide --review-actor qa_engineer=<actor>");
});
