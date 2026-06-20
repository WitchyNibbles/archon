// Option B condition 6: the Stop hook's offline review-floor predicate (ported to
// .claude/hooks/hook-utils.mjs) must not drift from the runtime predicate in
// src/domain/task-class.ts. This test runs the identical class×scope matrix through
// BOTH and asserts identical results, plus the one-directional safety property
// offlineFloor ⊇ runtimeFloor (the hook offline is never weaker than the runtime).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VALID_TASK_CLASSES,
  OPT_OUT_TASK_CLASSES,
  REVIEW_FLOOR_DENY_PREFIXES,
  isOptOutClass,
  scopeIsReviewSafe,
  type TaskClass
} from "../src/domain/task-class.ts";
import { effectiveRequiredReviewsForTask } from "../src/domain/contracts.ts";
import { requiredGateReviews } from "../src/domain/types.ts";
import type { TaskRecord } from "../src/domain/types.ts";

import {
  OPT_OUT_TASK_CLASSES as MJS_OPT_OUT,
  REVIEW_FLOOR_DENY_PREFIXES as MJS_DENY,
  isOptOutClass as mjsIsOptOutClass,
  scopeIsReviewSafe as mjsScopeIsReviewSafe
} from "../.claude/hooks/hook-utils.mjs";

// Representative scope axis: safe, every deny root, adversarial normalization,
// empty/wildcard, and lookalikes that must stay safe.
const SCOPE_MATRIX: string[][] = [
  ["sandbox/"],
  ["tmp/"],
  [".archon/work/scratch"],
  ["sandbox/a", "tmp/b"],
  ...REVIEW_FLOOR_DENY_PREFIXES.map((p) => [p]),
  [".claude/hooks/hook-utils.mjs"],
  ["docs/proposals/x.md"],
  [".\\claude"],
  ["./.claude"],
  ["CLAUDE.md/"],
  [".claude%2Fhooks"],
  ["docs/../.claude"],
  ["../CLAUDE.md"],
  [".claude∕hooks"],
  [".claude／hooks"],
  [],
  [""],
  ["."],
  ["*"],
  ["**"],
  ["/"],
  ["sandbox/a", ".claude/x"],
  ["srcdocs/x"],
  ["readme-notes/x"],
  ["claude-config/x"]
];

test("parity: OPT_OUT_TASK_CLASSES match between .ts and .mjs", () => {
  assert.deepEqual([...MJS_OPT_OUT].sort(), [...OPT_OUT_TASK_CLASSES].sort());
});

test("parity: REVIEW_FLOOR_DENY_PREFIXES match between .ts and .mjs", () => {
  assert.deepEqual([...MJS_DENY].sort(), [...REVIEW_FLOOR_DENY_PREFIXES].sort());
});

test("parity: isOptOutClass agrees for every canonical TaskClass", () => {
  for (const cls of VALID_TASK_CLASSES) {
    assert.equal(mjsIsOptOutClass(cls), isOptOutClass(cls), `isOptOutClass drift for ${cls}`);
  }
});

test("parity: scopeIsReviewSafe agrees on the full scope matrix", () => {
  for (const scope of SCOPE_MATRIX) {
    assert.equal(
      mjsScopeIsReviewSafe(scope),
      scopeIsReviewSafe(scope),
      `scopeIsReviewSafe drift for ${JSON.stringify(scope)}`
    );
  }
});

function makeTask(cls: TaskClass, scope: string[]): TaskRecord {
  return {
    id: "t",
    runId: "r",
    workspaceId: "w",
    projectId: "p",
    class: cls,
    packet: {
      taskId: "t",
      title: "t",
      ownerRole: "backend_engineer",
      completionStandard: "artifact_complete",
      requiredSpecialistRoles: [],
      qualityGates: [],
      goal: "g",
      inputs: [],
      outputs: [],
      dependencies: [],
      allowedWriteScope: scope,
      outOfScope: [],
      acceptanceCriteria: [],
      verificationSteps: [],
      requiredReviews: [],
      securityChecks: [],
      antiPatterns: [],
      rollbackNotes: "",
      handoffFormat: ""
    },
    status: "in_progress",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

test("safety property: offlineFloor (full trio) is always a superset of the runtime floor", () => {
  // The hook offline never reduces — it requires the full trio. The runtime floor
  // may be reduced to [reviewer]. offlineFloor ⊇ runtimeFloor must hold for every
  // class × scope × flag combination (offline is never weaker than the runtime).
  const offlineFloor = [...requiredGateReviews];
  for (const cls of VALID_TASK_CLASSES) {
    for (const scope of SCOPE_MATRIX) {
      for (const reductionEnabled of [true, false]) {
        const runtimeFloor = effectiveRequiredReviewsForTask(makeTask(cls, scope), { reductionEnabled });
        for (const role of runtimeFloor) {
          assert.ok(
            offlineFloor.includes(role),
            `offline floor missing ${role} required by runtime for ${cls}/${JSON.stringify(scope)}/${reductionEnabled}`
          );
        }
      }
    }
  }
});
