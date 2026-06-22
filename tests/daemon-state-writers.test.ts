import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Direct test of the extracted state-writers leaf module (daemon split). Round-trips
// the continuation-context artifact through write/read/clear from the module path.
import {
  writeDaemonContinuationContext,
  readDaemonContinuationContext,
  clearDaemonContinuationContext
} from "../src/daemon/state-writers.ts";

test("daemon continuation-context write/read/clear round-trip", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-state-writers-"));

  assert.equal(await readDaemonContinuationContext(dir), undefined);

  await writeDaemonContinuationContext(dir, "RESUME-CONTEXT-MARKER");
  assert.equal(await readDaemonContinuationContext(dir), "RESUME-CONTEXT-MARKER");

  await clearDaemonContinuationContext(dir);
  assert.equal(await readDaemonContinuationContext(dir), undefined);

  // clear on an already-empty dir must not throw.
  await clearDaemonContinuationContext(dir);
});
