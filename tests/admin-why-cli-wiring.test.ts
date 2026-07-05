import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// Audit F9 review (QA finding): CLI wiring-regression coverage for the "why"
// command — same shape as the established "autonomous-enable" wiring test in
// tests/autonomous-enable.test.ts. Checks all three registration points so a
// future refactor can't silently drop "why" from one of them and leave the
// command dispatching to "Unknown archon command" or "Unknown command".

test("archon CLI: \"why\" is listed in archon.ts adminCommands", async () => {
  const src = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/admin/archon.ts"),
    "utf8"
  );
  assert.ok(src.includes('"why"'), 'archon.ts must include "why" in adminCommands');
});

test("admin.ts: \"why\" dispatcher is wired", async () => {
  const src = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/admin.ts"),
    "utf8"
  );
  assert.ok(src.includes('command === "why"'), 'admin.ts must wire the "why" command dispatch');
  assert.ok(src.includes("whyCommand"), "admin.ts must import and call whyCommand");
});

test("admin.ts: \"why\" is registered in COMMAND_REQUIRED so config validation runs", async () => {
  const src = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/admin.ts"),
    "utf8"
  );
  assert.match(
    src,
    /\["why",\s*\["ARCHON_CORE_DATABASE_URL"\]\]/,
    '"why" must be registered in COMMAND_REQUIRED with ARCHON_CORE_DATABASE_URL'
  );
});
