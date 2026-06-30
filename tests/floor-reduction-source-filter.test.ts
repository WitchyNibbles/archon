import test from "node:test";
import assert from "node:assert/strict";

import { getReviewFloorReductions } from "../src/store/postgres/reviews.ts";
import type { SqlClient } from "../src/store/postgres/shared.ts";

// Defense-in-depth (floorReductionSourceFilter): a review-floor reduction lowers
// the required gate floor, so it must only be honored when ORCHESTRATOR-recorded.
// The store query (and the Stop-hook inline query that mirrors it) must filter
// `source = 'orchestrator'`, matching the reconciler-layer filter from #119.

class CapturingClient implements SqlClient {
  lastText = "";
  lastValues: readonly unknown[] | undefined;
  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.lastText = text;
    this.lastValues = values;
    return { rows: [] as Row[], rowCount: 0 };
  }
}

test("getReviewFloorReductions filters review_floor_reductions to source='orchestrator'", async () => {
  const client = new CapturingClient();
  await getReviewFloorReductions(client, "run-1", "task-1");
  // normalize whitespace for a robust match
  const sql = client.lastText.replace(/\s+/g, " ").toLowerCase();
  assert.match(sql, /from review_floor_reductions/, "queries the reductions table");
  assert.match(sql, /source = 'orchestrator'/, "restricts to orchestrator-recorded reductions");
  assert.deepEqual(client.lastValues, ["run-1", "task-1"], "parameterized by run/task");
});
