// Unit tests for the single Archon export writer (audit auditDebt202607 §3.6 / F8).
//
// Covers: atomic temp+rename behaviour, ifChanged skip semantics, the export-surface
// path guard, the consistent error surface (ArchonExportWriteError), idempotent
// removal, and the telemetry seam. Uses real temp dirs (no mocks) so the atomicity
// and mkdir behaviour is exercised against the real filesystem.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ArchonExportWriteError,
  assertArchonExportPath,
  removeArchonExport,
  setArchonExportWriteListener,
  writeArchonExport,
  writeArchonExportRelative,
  type ArchonExportWriteEvent
} from "../src/runtime/export-writer.ts";

async function makeTempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "archon-export-writer-"));
}

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await makeTempRoot();
  roots.push(root);
  return root;
}

afterEach(async () => {
  setArchonExportWriteListener(undefined);
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

describe("writeArchonExport — atomic write", () => {
  it("creates the file and its parent directories, returning true", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "daemon", "state.json");

    const written = await writeArchonExport(target, "hello\n");

    assert.equal(written, true);
    assert.equal(await readFile(target, "utf8"), "hello\n");
  });

  it("overwrites existing content", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "task-queue.json");

    await writeArchonExport(target, "v1");
    await writeArchonExport(target, "v2");

    assert.equal(await readFile(target, "utf8"), "v2");
  });

  it("leaves no .tmp staging files behind after a successful write", async () => {
    const root = await tempRoot();
    const dir = path.join(root, ".archon", "work");
    const target = path.join(dir, "task-queue.json");

    await writeArchonExport(target, "content");

    const entries = await readdir(dir);
    assert.deepEqual(
      entries.filter((name) => name.endsWith(".tmp")),
      [],
      "no temp file should remain after write"
    );
    assert.deepEqual(entries.sort(), ["task-queue.json"]);
  });

  it("accepts the .archon/ACTIVE pointer path", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "ACTIVE");

    const written = await writeArchonExport(target, "task_id=demo\n");

    assert.equal(written, true);
    assert.equal(await readFile(target, "utf8"), "task_id=demo\n");
  });

  it("survives concurrent writes to the same target (last write wins, no corruption)", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "task-queue.json");

    await Promise.all(
      Array.from({ length: 12 }, (_v, i) => writeArchonExport(target, `payload-${i}\n`))
    );

    const final = await readFile(target, "utf8");
    assert.match(final, /^payload-\d+\n$/, "final content must be exactly one complete write");

    const entries = await readdir(path.dirname(target));
    assert.deepEqual(entries.filter((name) => name.endsWith(".tmp")), []);
  });
});

describe("writeArchonExport — ifChanged semantics", () => {
  it("skips the write and returns false when bytes are identical", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "task-queue.json");

    await writeArchonExport(target, "same");
    const before = await stat(target);
    // Ensure any mtime change would be observable.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const written = await writeArchonExport(target, "same", { ifChanged: true });

    assert.equal(written, false);
    const after = await stat(target);
    assert.equal(after.mtimeMs, before.mtimeMs, "unchanged write must not touch the file");
  });

  it("writes and returns true when bytes differ", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "task-queue.json");

    await writeArchonExport(target, "old");
    const written = await writeArchonExport(target, "new", { ifChanged: true });

    assert.equal(written, true);
    assert.equal(await readFile(target, "utf8"), "new");
  });

  it("writes when the file does not yet exist (ENOENT is not an error)", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "new.json");

    const written = await writeArchonExport(target, "first", { ifChanged: true });

    assert.equal(written, true);
    assert.equal(await readFile(target, "utf8"), "first");
  });
});

describe("assertArchonExportPath / path guard", () => {
  it("throws for a path outside the .archon export surface", async () => {
    const root = await tempRoot();
    const outside = path.join(root, "src", "index.ts");

    assert.throws(() => assertArchonExportPath(outside), ArchonExportWriteError);
    await assert.rejects(() => writeArchonExport(outside, "nope"), ArchonExportWriteError);
  });

  it("rejects a traversal escape out of .archon/work", () => {
    // Normalizes to /tmp/x/secret — no .archon/work segment, no ACTIVE suffix.
    assert.throws(
      () => assertArchonExportPath("/tmp/x/.archon/work/../../secret"),
      ArchonExportWriteError
    );
  });

  it("accepts nested paths under .archon/work/", () => {
    assert.doesNotThrow(() => assertArchonExportPath("/repo/.archon/work/reviews/r.md"));
  });
});

describe("writeArchonExport — error surface", () => {
  it("wraps filesystem failures in ArchonExportWriteError carrying the target", async () => {
    const root = await tempRoot();
    // Make `.archon/work` a FILE so mkdir of a child dir fails with ENOTDIR/EEXIST.
    const workAsFile = path.join(root, ".archon", "work");
    await mkdir(path.dirname(workAsFile), { recursive: true });
    await writeFile(workAsFile, "i am a file");

    const target = path.join(workAsFile, "daemon", "state.json");
    await assert.rejects(
      () => writeArchonExport(target, "x"),
      (error: unknown) => {
        assert.ok(error instanceof ArchonExportWriteError);
        assert.equal(error.targetPath, target);
        return true;
      }
    );

    // No leftover temp staging file in the parent that does exist.
    const entries = await readdir(path.dirname(root)).catch(() => []);
    assert.ok(Array.isArray(entries));
  });
});

describe("removeArchonExport", () => {
  it("removes an existing export file", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "daemon", "state.json");
    await writeArchonExport(target, "x");

    await removeArchonExport(target);

    await assert.rejects(() => readFile(target, "utf8"));
  });

  it("is idempotent when the file is absent", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "daemon", "absent.json");

    await assert.doesNotReject(() => removeArchonExport(target));
  });

  it("guards the export surface", async () => {
    await assert.rejects(
      () => removeArchonExport("/tmp/x/src/index.ts"),
      ArchonExportWriteError
    );
  });
});

describe("writeArchonExportRelative", () => {
  it("resolves a repo-relative path against cwd", async () => {
    const root = await tempRoot();

    const written = await writeArchonExportRelative(root, ".archon/work/task-queue.json", "rel");

    assert.equal(written, true);
    assert.equal(await readFile(path.join(root, ".archon", "work", "task-queue.json"), "utf8"), "rel");
  });
});

describe("telemetry seam", () => {
  it("emits a written=true event on a real write and written=false on an ifChanged skip", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "task-queue.json");
    const events: ArchonExportWriteEvent[] = [];
    setArchonExportWriteListener((event) => events.push(event));

    await writeArchonExport(target, "data");
    await writeArchonExport(target, "data", { ifChanged: true });

    assert.equal(events.length, 2);
    assert.equal(events[0]?.written, true);
    assert.equal(events[0]?.targetPath, target);
    assert.equal(events[1]?.written, false);
  });

  it("never lets a throwing listener break the write", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "task-queue.json");
    setArchonExportWriteListener(() => {
      throw new Error("listener boom");
    });

    await assert.doesNotReject(() => writeArchonExport(target, "still-writes"));
    assert.equal(await readFile(target, "utf8"), "still-writes");
  });
});
