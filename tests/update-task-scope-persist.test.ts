import test from "node:test";
import assert from "node:assert/strict";

import { updateTask } from "../src/store/postgres/tasks.ts";
import type { SqlClient } from "../src/store/postgres/shared.ts";
import type { TaskRecord, TaskPacketInput } from "../src/domain/types.ts";

// Regression for the W2 follow-up bug: postgres updateTask wrote only
// status/claimed_by/payload, dropping the allowed_write_scope COLUMN. The
// PreToolUse hook reads allowed_write_scope from the COLUMN (not payload), so an
// idempotent init-task scope-widening was a silent no-op at the enforcement layer.

function makePacket(overrides: Partial<TaskPacketInput> = {}): TaskPacketInput {
  return {
    taskId: "t1",
    title: "T1",
    ownerRole: "planner",
    completionStandard: "artifact_complete",
    requiredSpecialistRoles: [],
    qualityGates: [],
    goal: "g",
    inputs: [],
    outputs: [],
    dependencies: [],
    allowedWriteScope: ["src/admin", "tests"],
    outOfScope: [],
    acceptanceCriteria: [],
    verificationSteps: [],
    requiredReviews: [],
    securityChecks: [],
    antiPatterns: [],
    rollbackNotes: "",
    handoffFormat: "",
    ...overrides
  };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    runId: "00000000-0000-0000-0000-0000000000aa",
    workspaceId: "ws",
    projectId: "proj",
    class: "prototype_slice",
    packet: makePacket(overrides.packet),
    status: "in_progress",
    claimedBy: "manager",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    ...overrides
  };
}

class CapturingClient implements SqlClient {
  queries: { text: string; values?: readonly unknown[] }[] = [];
  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, values });
    if (/select\s+"class"\s+from\s+tasks/i.test(text)) {
      return { rows: [{ class: "prototype_slice" }] as Row[], rowCount: 1 };
    }
    return { rows: [] as Row[], rowCount: 0 };
  }
}

test("updateTask persists allowed_write_scope to the COLUMN", async () => {
  const client = new CapturingClient();
  await updateTask(client, makeTask({ packet: makePacket({ allowedWriteScope: ["src/admin", "src/admin.ts", "tests"] }) }));

  const update = client.queries.find((q) => /^\s*update\s+tasks\s+set/i.test(q.text));
  assert.ok(update, "an UPDATE tasks statement must be issued");
  assert.match(update!.text, /allowed_write_scope/, "the UPDATE must set the allowed_write_scope column");
  const hasScope = (update!.values ?? []).some(
    (v) => Array.isArray(v) && v.length === 3 && v[0] === "src/admin" && v[2] === "tests"
  );
  assert.ok(hasScope, "the UPDATE values must carry the new scope array");
});

test("updateTask syncs the mutable packet columns (required_reviews) so the row does not drift from payload", async () => {
  const client = new CapturingClient();
  await updateTask(client, makeTask({ packet: makePacket({ requiredReviews: ["reviewer", "security_reviewer"] }) }));
  const update = client.queries.find((q) => /^\s*update\s+tasks\s+set/i.test(q.text));
  assert.ok(update, "an UPDATE tasks statement must be issued");
  assert.match(update!.text, /required_reviews/, "the UPDATE must set required_reviews");
});

test("updateTask still guards the immutable class column", async () => {
  const client = new CapturingClient(); // reports persisted class = prototype_slice
  await assert.rejects(
    () => updateTask(client, makeTask({ class: "release_blocker" as TaskRecord["class"] })),
    /immutable field 'class'/,
    "changing class must still throw"
  );
});
