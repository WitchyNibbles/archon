import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Direct test of the extracted state-readers leaf module (daemon split). Imports from
// the module path to lock the boundary; exercises the absent-file (ENOENT) path.
import {
  readDaemonContinuationStatus,
  readDaemonOperatorHandoff,
  readDaemonSupervisorStatus
} from "../src/daemon/state-readers.ts";

test("daemon state readers return undefined when their artifact is absent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archon-state-readers-"));
  assert.equal(await readDaemonContinuationStatus(dir), undefined);
  assert.equal(await readDaemonOperatorHandoff(dir), undefined);
  assert.equal(await readDaemonSupervisorStatus(dir), undefined);
});
