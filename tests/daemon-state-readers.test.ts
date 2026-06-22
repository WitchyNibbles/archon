import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Direct test of the extracted state-readers leaf module (daemon split). Imports from
// the module path to lock the boundary; exercises the absent-file (ENOENT) path of all
// four readers.
import {
  readDaemonContinuationStatus,
  readDaemonOperatorHandoff,
  readDaemonSupervisorStatus,
  readDaemonSupervisorHistory
} from "../src/daemon/state-readers.ts";

const historyOptions = { limit: 10, scope: "all" as const };

test("daemon state readers return the empty/absent result when their artifact is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-state-readers-"));
  assert.equal(await readDaemonContinuationStatus(dir), undefined);
  assert.equal(await readDaemonOperatorHandoff(dir), undefined);
  assert.equal(await readDaemonSupervisorStatus(dir, historyOptions), undefined);
  assert.deepEqual(await readDaemonSupervisorHistory(dir, historyOptions), {
    entries: [],
    retainedCount: 0,
    filteredCount: 0
  });
});
