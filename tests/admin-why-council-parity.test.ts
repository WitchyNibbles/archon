import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { APPROVED_COUNCIL_OUTCOMES } from "../src/admin/why.ts";

// Audit F9 review (MEDIUM x2 — reviewer + qa independently): why.ts hand-mirrors
// APPROVED_COUNCIL_OUTCOMES from .claude/hooks/hook-policy.mjs with only a
// comment promising lockstep. Per this repo's own carried lesson ("audit tables
// that humans maintain need a machine cross-check" — .archon/memory/lessons-
// learned.md), that comment must be backed by a test that actually compares the
// two sets, or the tables WILL drift silently and `why` will disagree with the
// Stop-hook gate about whether a council outcome is approved-class.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function extractApprovedCouncilOutcomesFromSource(source: string): Set<string> {
  const match = source.match(/APPROVED_COUNCIL_OUTCOMES\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(match, "APPROVED_COUNCIL_OUTCOMES literal not found in hook-policy.mjs");
  const listBody = match![1]!;
  const tokens = [...listBody.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]!);
  assert.ok(tokens.length > 0, "no string tokens parsed from APPROVED_COUNCIL_OUTCOMES literal");
  return new Set(tokens);
}

test("parity: why.ts APPROVED_COUNCIL_OUTCOMES matches hook-policy.mjs's set exactly", async () => {
  const hookPolicySource = await readFile(
    resolve(repoRoot, ".claude/hooks/hook-policy.mjs"),
    "utf8"
  );
  const hookSet = extractApprovedCouncilOutcomesFromSource(hookPolicySource);
  const whySet = APPROVED_COUNCIL_OUTCOMES;

  const onlyInHook = [...hookSet].filter((v) => !whySet.has(v));
  const onlyInWhy = [...whySet].filter((v) => !hookSet.has(v));

  assert.deepEqual(
    onlyInHook,
    [],
    `hook-policy.mjs has outcomes why.ts is missing: ${onlyInHook.join(", ")}`
  );
  assert.deepEqual(
    onlyInWhy,
    [],
    `why.ts has outcomes hook-policy.mjs does not recognize: ${onlyInWhy.join(", ")}`
  );
});
