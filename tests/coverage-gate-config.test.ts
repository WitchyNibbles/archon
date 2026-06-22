import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Guards the coverage ratchet gate against silent removal/weakening. The gate's
// failure path (c8 exits non-zero below a floor) is c8's own well-tested behavior;
// what we protect here is that the gate stays *configured and enforcing*.

test("coverage gate: package.json c8 config enforces a ratchet floor", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const c8 = pkg.c8;
  assert.ok(c8, "package.json must define a c8 config block");
  assert.equal(c8["check-coverage"], true, "check-coverage must be enabled so floors are enforced");
  for (const metric of ["lines", "statements", "functions", "branches"]) {
    assert.equal(typeof c8[metric], "number", `c8.${metric} floor must be a number`);
    assert.ok(c8[metric] > 0, `c8.${metric} floor must be a positive ratchet (got ${c8[metric]})`);
  }
  assert.equal(c8.all, true, "c8.all must be true so untested files count against the floor");
});

test("coverage gate: check:coverage runs the real c8 script, not the old no-op note", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(pkg.scripts["check:coverage"], /check-coverage\.ts/);
  const script = await readFile(path.join(repoRoot, "scripts/check-coverage.ts"), "utf8");
  assert.match(script, /c8 node/, "check-coverage.ts must invoke c8");
  assert.doesNotMatch(
    script,
    /formal coverage measurement requires/,
    "the previous no-op coverage note must be gone"
  );
});
