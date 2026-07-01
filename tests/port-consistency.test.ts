/**
 * Asserts that the default ARCHON_POSTGRES_PORT (5533) is consistent across
 * docker-compose.yml and both setup scripts.  A drift between these files would
 * cause Docker-mode setup to fail silently when the operator relies on defaults.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const TARGET_PORT = "5533";

test("docker-compose.yml default host port is 5533", async () => {
  const content = await readFile(path.join(repoRoot, "docker-compose.yml"), "utf8");
  // Matches: "${ARCHON_POSTGRES_PORT:-5533}"
  assert.match(
    content,
    new RegExp(`ARCHON_POSTGRES_PORT:-${TARGET_PORT}`),
    `docker-compose.yml default port must be ${TARGET_PORT}`
  );
});

test("scripts/setup-archon.sh default ARCHON_POSTGRES_PORT is 5533", async () => {
  const content = await readFile(
    path.join(repoRoot, "scripts", "setup-archon.sh"),
    "utf8"
  );
  // Matches the line: export ARCHON_POSTGRES_PORT="5533"
  assert.match(
    content,
    new RegExp(`ARCHON_POSTGRES_PORT="${TARGET_PORT}"`),
    `setup-archon.sh default port must be ${TARGET_PORT}`
  );
});

test("scripts/setup-archon.ps1 default ARCHON_POSTGRES_PORT is 5533", async () => {
  const content = await readFile(
    path.join(repoRoot, "scripts", "setup-archon.ps1"),
    "utf8"
  );
  // Matches: $env:ARCHON_POSTGRES_PORT = "5533"
  assert.match(
    content,
    new RegExp(`ARCHON_POSTGRES_PORT = "${TARGET_PORT}"`),
    `setup-archon.ps1 default port must be ${TARGET_PORT}`
  );
});
