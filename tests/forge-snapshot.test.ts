/**
 * Tests for the Forge snapshot generator's hardened entry points:
 * the bounds-checked output-path resolver and the exported sample builder.
 * The import-time guard is implicitly verified — importing this module must
 * NOT execute main() (no file written, no process exit).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  resolveSnapshotOutputPath,
  buildSampleSnapshot,
  STDOUT_TARGET
} from "../src/forge/snapshot.ts";

const REPO = "/tmp/archon-repo";

describe("resolveSnapshotOutputPath", () => {
  it("defaults to the gitignored live path (snapshot.live.json) when no mode given", () => {
    assert.equal(
      resolveSnapshotOutputPath(undefined, REPO),
      path.join(REPO, "web", "public", "snapshot.live.json")
    );
  });

  it("defaults to the committed sample path (snapshot.json) in sample mode", () => {
    assert.equal(
      resolveSnapshotOutputPath(undefined, REPO, "sample"),
      path.join(REPO, "web", "public", "snapshot.json")
    );
  });

  it("passes through the stdout sentinel", () => {
    assert.equal(resolveSnapshotOutputPath(STDOUT_TARGET, REPO), STDOUT_TARGET);
  });

  it("accepts an in-repo .json path", () => {
    assert.equal(
      resolveSnapshotOutputPath("web/public/snapshot.live.json", REPO),
      path.join(REPO, "web", "public", "snapshot.live.json")
    );
  });

  it("rejects a path that escapes the repository root", () => {
    assert.throws(
      () => resolveSnapshotOutputPath("../../etc/cron.d/evil.json", REPO),
      /must stay within the repository/
    );
  });

  it("rejects an absolute path outside the repo", () => {
    assert.throws(
      () => resolveSnapshotOutputPath("/etc/passwd.json", REPO),
      /must stay within the repository/
    );
  });

  it("rejects a prefix-spoof sibling path (locks the ${repoRoot}${sep} invariant)", () => {
    // `/tmp/archon-repo-evil/x.json` shares the repo-root string prefix but is a
    // SIBLING, not inside the repo. A bare startsWith(repoRoot) would wrongly
    // accept it; the separator-appended check must reject it. This guards against
    // a future simplification silently breaking the security boundary.
    assert.throws(
      () => resolveSnapshotOutputPath(`${REPO}-evil/x.json`, REPO),
      /must stay within the repository/
    );
  });

  it("accepts an absolute path that IS inside the repo", () => {
    assert.equal(
      resolveSnapshotOutputPath(path.join(REPO, "web", "public", "out.json"), REPO),
      path.join(REPO, "web", "public", "out.json")
    );
  });

  it("rejects a non-.json output path", () => {
    assert.throws(
      () => resolveSnapshotOutputPath("web/public/snapshot.txt", REPO),
      /must end in \.json/
    );
  });
});

describe("buildSampleSnapshot", () => {
  it("returns a schema-valid view model with a blocked run and review gates", () => {
    const snapshot = buildSampleSnapshot();
    assert.equal(snapshot.header.status, "review_blocked");
    assert.ok(snapshot.blockers.length > 0, "expected at least one blocker");
    assert.ok(snapshot.reviewGates.some((g) => g.state === "blocked"), "expected a blocked gate");
    assert.ok(snapshot.taskQueue.length > 0, "expected a populated task queue");
  });
});
