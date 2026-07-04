// Unit tests for the single Archon export writer (audit auditDebt202607 §3.6 / F8).
//
// Covers: atomic temp+rename behaviour, ifChanged skip semantics (including the
// non-ENOENT read-failure branch), the root-explicit export-surface path guard
// (including the cross-root-escape case a security review demonstrated against
// an earlier substring-only check), symlink-escape rejection, the move-into-
// export primitive used by daemon review-queue archiving, the consistent error
// surface (ArchonExportWriteError), idempotent removal, and the telemetry seam.
// Uses real temp dirs and real symlinks (no mocks) so the atomicity, mkdir, and
// symlink-resolution behaviour is exercised against the real filesystem.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ArchonExportWriteError,
  moveIntoArchonExport,
  removeArchonExport,
  resolveArchonExportPath,
  setArchonExportWriteListener,
  writeArchonExport,
  type ArchonExportWriteEvent
} from "../src/runtime/export-writer.ts";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "archon-export-writer-"));
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

    const written = await writeArchonExport(root, target, "hello\n");

    assert.equal(written, true);
    assert.equal(await readFile(target, "utf8"), "hello\n");
  });

  it("overwrites existing content", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "task-queue.json");

    await writeArchonExport(root, target, "v1");
    await writeArchonExport(root, target, "v2");

    assert.equal(await readFile(target, "utf8"), "v2");
  });

  it("leaves no .tmp staging files behind after a successful write", async () => {
    const root = await tempRoot();
    const dir = path.join(root, ".archon", "work");
    const target = path.join(dir, "task-queue.json");

    await writeArchonExport(root, target, "content");

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

    const written = await writeArchonExport(root, target, "task_id=demo\n");

    assert.equal(written, true);
    assert.equal(await readFile(target, "utf8"), "task_id=demo\n");
  });

  it("accepts a root-relative target path (resolved against root, not absolute)", async () => {
    const root = await tempRoot();

    const written = await writeArchonExport(root, ".archon/work/task-queue.json", "rel");

    assert.equal(written, true);
    assert.equal(await readFile(path.join(root, ".archon", "work", "task-queue.json"), "utf8"), "rel");
  });

  it("survives concurrent writes to the same target (last write wins, no corruption)", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "task-queue.json");

    await Promise.all(
      Array.from({ length: 12 }, (_v, i) => writeArchonExport(root, target, `payload-${i}\n`))
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

    await writeArchonExport(root, target, "same");
    const before = await stat(target);
    // Ensure any mtime change would be observable.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const written = await writeArchonExport(root, target, "same", { ifChanged: true });

    assert.equal(written, false);
    const after = await stat(target);
    assert.equal(after.mtimeMs, before.mtimeMs, "unchanged write must not touch the file");
  });

  it("writes and returns true when bytes differ", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "task-queue.json");

    await writeArchonExport(root, target, "old");
    const written = await writeArchonExport(root, target, "new", { ifChanged: true });

    assert.equal(written, true);
    assert.equal(await readFile(target, "utf8"), "new");
  });

  it("writes when the file does not yet exist (ENOENT is not an error)", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "new.json");

    const written = await writeArchonExport(root, target, "first", { ifChanged: true });

    assert.equal(written, true);
    assert.equal(await readFile(target, "utf8"), "first");
  });

  // Audit follow-up finding 7: the non-ENOENT read-failure branch of the
  // ifChanged pre-read must surface as an ArchonExportWriteError, not be
  // swallowed and silently proceed to overwrite.
  it("throws ArchonExportWriteError when the ifChanged pre-read fails with a non-ENOENT error", async () => {
    const root = await tempRoot();
    // A directory at the target path makes readFile() fail with EISDIR, not ENOENT.
    const target = path.join(root, ".archon", "work", "task-queue.json");
    await mkdir(target, { recursive: true });

    await assert.rejects(
      () => writeArchonExport(root, target, "content", { ifChanged: true }),
      (error: unknown) => {
        assert.ok(error instanceof ArchonExportWriteError);
        assert.match(error.message, /Failed to read existing export before ifChanged write/);
        assert.equal(error.targetPath, target);
        assert.ok(error.cause, "original EISDIR error must be preserved as .cause");
        return true;
      }
    );
  });
});

describe("resolveArchonExportPath / root-explicit containment (audit finding 1)", () => {
  it("throws for a path outside the .archon export surface", async () => {
    const root = await tempRoot();
    const outside = path.join(root, "src", "index.ts");

    assert.throws(() => resolveArchonExportPath(root, outside), ArchonExportWriteError);
    await assert.rejects(() => writeArchonExport(root, outside, "nope"), ArchonExportWriteError);
  });

  it("accepts nested paths under .archon/work/", () => {
    assert.doesNotThrow(() => resolveArchonExportPath("/repo", "/repo/.archon/work/reviews/r.md"));
  });

  // The exact class of bug the security reviewer demonstrated: an absolute path
  // that CONTAINS the substring "/.archon/work/" but lives under a completely
  // different root's tree used to pass a bare substring check. Root-explicit
  // resolution must reject it.
  it("rejects a cross-root escape: a path containing /.archon/work/ but outside THIS root", () => {
    const thisRoot = "/repo";
    const siblingProjectPath = "/other-project/.archon/work/evil.json";

    assert.throws(
      () => resolveArchonExportPath(thisRoot, siblingProjectPath),
      ArchonExportWriteError,
      "a sibling project's .archon/work/ file must not pass containment for a different root"
    );
  });

  it("rejects a cross-root escape via a relative traversal segment", () => {
    // root/.archon/work/../../../other-root/.archon/work/evil.json resolves
    // (via path.resolve) OUTSIDE root/.archon/work — must be rejected.
    const root = "/repo";
    const traversal = "/repo/.archon/work/../../../other-root/.archon/work/evil.json";

    assert.throws(() => resolveArchonExportPath(root, traversal), ArchonExportWriteError);
  });

  it("accepts a root-relative candidate resolved to exactly the ACTIVE pointer", () => {
    const resolved = resolveArchonExportPath("/repo", ".archon/ACTIVE");
    assert.equal(resolved, path.resolve("/repo", ".archon", "ACTIVE"));
  });
});

describe("symlink-escape rejection (audit finding 6)", () => {
  it("rejects a write when .archon/work itself is a symlink pointing outside the root", async () => {
    const root = await tempRoot();
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "archon-outside-"));
    roots.push(outsideDir);

    await mkdir(path.join(root, ".archon"), { recursive: true });
    await symlink(outsideDir, path.join(root, ".archon", "work"), "dir");

    const target = path.join(root, ".archon", "work", "state.json");
    await assert.rejects(
      () => writeArchonExport(root, target, "x"),
      (error: unknown) => {
        assert.ok(error instanceof ArchonExportWriteError);
        assert.match(error.message, /symlink-resolved/);
        return true;
      }
    );

    // Confirm nothing was actually written into the escaped-to directory.
    const outsideEntries = await readdir(outsideDir);
    assert.deepEqual(outsideEntries, []);
  });

  it("rejects a write when a subdirectory under .archon/work is a symlink pointing outside", async () => {
    const root = await tempRoot();
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "archon-outside-"));
    roots.push(outsideDir);

    await mkdir(path.join(root, ".archon", "work"), { recursive: true });
    await symlink(outsideDir, path.join(root, ".archon", "work", "daemon"), "dir");

    const target = path.join(root, ".archon", "work", "daemon", "state.json");
    await assert.rejects(() => writeArchonExport(root, target, "x"), ArchonExportWriteError);

    const outsideEntries = await readdir(outsideDir);
    assert.deepEqual(outsideEntries, []);
  });

  it("allows a symlink that stays WITHIN the export surface", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, ".archon", "work", "real-daemon"), { recursive: true });
    await symlink(
      path.join(root, ".archon", "work", "real-daemon"),
      path.join(root, ".archon", "work", "daemon"),
      "dir"
    );

    const target = path.join(root, ".archon", "work", "daemon", "state.json");
    const written = await writeArchonExport(root, target, "ok");

    assert.equal(written, true);
    assert.equal(await readFile(path.join(root, ".archon", "work", "real-daemon", "state.json"), "utf8"), "ok");
  });
});

describe("writeArchonExport — error surface", () => {
  it("wraps filesystem failures in ArchonExportWriteError carrying the resolved target", async () => {
    const root = await tempRoot();
    // Make `.archon/work` a FILE so mkdir of a child dir fails with ENOTDIR/EEXIST.
    const workAsFile = path.join(root, ".archon", "work");
    await mkdir(path.dirname(workAsFile), { recursive: true });
    await writeFile(workAsFile, "i am a file");

    const target = path.join(workAsFile, "daemon", "state.json");
    await assert.rejects(
      () => writeArchonExport(root, target, "x"),
      (error: unknown) => {
        assert.ok(error instanceof ArchonExportWriteError);
        assert.equal(error.targetPath, target);
        assert.ok(error.cause, "original filesystem error must be preserved as .cause");
        return true;
      }
    );
  });
});

describe("removeArchonExport", () => {
  it("removes an existing export file", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "daemon", "state.json");
    await writeArchonExport(root, target, "x");

    await removeArchonExport(root, target);

    await assert.rejects(() => readFile(target, "utf8"));
  });

  it("is idempotent when the file is absent", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "daemon", "absent.json");

    await assert.doesNotReject(() => removeArchonExport(root, target));
  });

  it("guards the export surface", async () => {
    await assert.rejects(
      () => removeArchonExport("/tmp/x", "/tmp/x/src/index.ts"),
      ArchonExportWriteError
    );
  });
});

describe("moveIntoArchonExport", () => {
  it("moves an external source file into the export surface", async () => {
    const root = await tempRoot();
    const inboxDir = await mkdtemp(path.join(os.tmpdir(), "archon-inbox-"));
    roots.push(inboxDir);
    const sourcePath = path.join(inboxDir, "queued-review.json");
    await writeFile(sourcePath, '{"role":"reviewer"}');

    const destination = path.join(root, ".archon", "work", "daemon", "processed-review-actions", "queued-review.json");
    await moveIntoArchonExport(root, sourcePath, destination);

    assert.equal(await readFile(destination, "utf8"), '{"role":"reviewer"}');
    await assert.rejects(() => readFile(sourcePath, "utf8"), "source must have been moved, not copied");
  });

  it("guards the destination against the export-surface boundary", async () => {
    const root = await tempRoot();
    const inboxDir = await mkdtemp(path.join(os.tmpdir(), "archon-inbox-"));
    roots.push(inboxDir);
    const sourcePath = path.join(inboxDir, "queued-review.json");
    await writeFile(sourcePath, "x");

    const outsideDestination = path.join(root, "src", "escaped.json");
    await assert.rejects(
      () => moveIntoArchonExport(root, sourcePath, outsideDestination),
      ArchonExportWriteError
    );
    // Source must remain untouched since the guard rejects before the rename.
    assert.equal(await readFile(sourcePath, "utf8"), "x");
  });
});

describe("telemetry seam", () => {
  it("emits a written=true event on a real write and written=false on an ifChanged skip", async () => {
    const root = await tempRoot();
    const target = path.join(root, ".archon", "work", "task-queue.json");
    const events: ArchonExportWriteEvent[] = [];
    setArchonExportWriteListener((event) => events.push(event));

    await writeArchonExport(root, target, "data");
    await writeArchonExport(root, target, "data", { ifChanged: true });

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

    await assert.doesNotReject(() => writeArchonExport(root, target, "still-writes"));
    assert.equal(await readFile(target, "utf8"), "still-writes");
  });
});
