/**
 * Tests for src/install/ecc-plugin.ts.
 *
 * All tests use injected stubs — no real spawn calls, no real filesystem writes,
 * no ~/.claude mutations (council C13: test isolation).
 *
 * Coverage:
 *   - parsePluginList: empty, real fixture format, canonical, legacy
 *   - isAcceptedEccIdentity / isLegacyEccIdentity: canonical, legacy, unknown
 *   - checkMajorVersionBump: same/higher/lower/unparseable
 *   - readEccPluginRecord / writeEccPluginRecord: absent, valid, malformed
 *   - runConsentedEccInstall: already-installed, needs-confirmation (C6), install path,
 *     idempotency, failure cases
 *   - C5: parseCliArgs --install-plugin gate (--yes alone must not set installPlugin)
 *   - C6: version record written; major-bump returns needs-confirmation
 *   - C7: spawn calls use hardcoded "claude" command + hardcoded plugin constants
 *   - C13: idempotency (second run with already-installed → already-installed)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePluginList,
  isAcceptedEccIdentity,
  isLegacyEccIdentity,
  checkMajorVersionBump,
  readEccPluginRecord,
  writeEccPluginRecord,
  runConsentedEccInstall,
  ECC_CANONICAL_IDENTITY,
  ECC_LEGACY_PLUGIN_NAME,
  ECC_MARKETPLACE_SOURCE,
  ECC_PLUGIN_RECORD_RELATIVE_PATH,
} from "../../src/install/ecc-plugin.ts";
import { parseCliArgs, runEccInstallFromCli } from "../../src/install/cli.ts";
import type { SpawnFn } from "../../src/install/capability/probes-external.ts";
import type { ReadFileFn } from "../../src/install/capability/probes-file.ts";
import type { WriteFileFn } from "../../src/install/ecc-plugin.ts";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Stub builders
// ---------------------------------------------------------------------------

function makeSpawnFn(
  responses: Record<string, { exitCode: number | null; stdout: string; stderr: string }>
): SpawnFn & { calls: Array<{ command: string; args: readonly string[] }> } {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const fn = async (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    const key = `${command} ${args.join(" ")}`;
    // Exact match first, then wildcard
    const response = responses[key] ?? responses["*"] ?? { exitCode: 0, stdout: "", stderr: "" };
    return response;
  };
  (fn as typeof fn & { calls: typeof calls }).calls = calls;
  return fn as ReturnType<typeof makeSpawnFn>;
}

function makeReadFn(files: Record<string, string>): ReadFileFn {
  return async (absolutePath: string) => files[absolutePath];
}

function makeWriteFn(): WriteFileFn & { written: Record<string, string> } {
  const written: Record<string, string> = {};
  const fn = async (absolutePath: string, content: string) => {
    written[absolutePath] = content;
  };
  (fn as typeof fn & { written: typeof written }).written = written;
  return fn as ReturnType<typeof makeWriteFn>;
}

const TARGET = "/fake/repo";
const RECORD_PATH = path.join(TARGET, ECC_PLUGIN_RECORD_RELATIVE_PATH);

// Plugin list fixture strings
const CANONICAL_PLUGIN_LIST = `Installed plugins:

  ❯ ecc@ecc
    Version: 2.0.0
    Scope: user
    Status: ✔ enabled
`;

const LEGACY_PLUGIN_LIST = `Installed plugins:

  ❯ everything-claude-code@everything-claude-code
    Version: 1.8.0
    Scope: user
    Status: ✔ enabled
`;

const EMPTY_PLUGIN_LIST = `Installed plugins:

`;

// ---------------------------------------------------------------------------
// parsePluginList
// ---------------------------------------------------------------------------

test("parsePluginList: empty string → empty array", () => {
  assert.deepEqual(parsePluginList(""), []);
});

test("parsePluginList: whitespace-only → empty array", () => {
  assert.deepEqual(parsePluginList("   \n\n  "), []);
});

test("parsePluginList: canonical ecc@ecc → parsed correctly", () => {
  const plugins = parsePluginList(CANONICAL_PLUGIN_LIST);
  assert.equal(plugins.length, 1);
  const p = plugins[0]!;
  assert.equal(p.identity, "ecc@ecc");
  assert.equal(p.name, "ecc");
  assert.equal(p.marketplace, "ecc");
  assert.equal(p.version, "2.0.0");
  assert.equal(p.enabled, true);
});

test("parsePluginList: legacy everything-claude-code → parsed correctly", () => {
  const plugins = parsePluginList(LEGACY_PLUGIN_LIST);
  assert.equal(plugins.length, 1);
  const p = plugins[0]!;
  assert.equal(p.identity, "everything-claude-code@everything-claude-code");
  assert.equal(p.name, "everything-claude-code");
  assert.equal(p.marketplace, "everything-claude-code");
  assert.equal(p.version, "1.8.0");
  assert.equal(p.enabled, true);
});

test("parsePluginList: empty Installed plugins block → empty array", () => {
  const plugins = parsePluginList(EMPTY_PLUGIN_LIST);
  assert.equal(plugins.length, 0);
});

test("parsePluginList: real fixture format with two plugins", () => {
  const input = `Installed plugins:

  ❯ ecc@ecc
    Version: 2.0.0
    Scope: user
    Status: ✔ enabled

  ❯ superpowers@claude-plugins-official
    Version: 5.0.2
    Scope: local
    Status: ✘ disabled
`;
  const plugins = parsePluginList(input);
  assert.equal(plugins.length, 2);
  assert.equal(plugins[0]!.identity, "ecc@ecc");
  assert.equal(plugins[1]!.identity, "superpowers@claude-plugins-official");
  assert.equal(plugins[1]!.enabled, false);
});

test("parsePluginList: disabled status → enabled=false", () => {
  const input = `Installed plugins:

  ❯ ecc@ecc
    Version: 2.0.0
    Scope: user
    Status: ✘ disabled
`;
  const plugins = parsePluginList(input);
  assert.equal(plugins[0]!.enabled, false);
});

// ---------------------------------------------------------------------------
// isAcceptedEccIdentity / isLegacyEccIdentity
// ---------------------------------------------------------------------------

test("isAcceptedEccIdentity: canonical ecc@ecc → true", () => {
  assert.equal(isAcceptedEccIdentity("ecc@ecc"), true);
});

test("isAcceptedEccIdentity: legacy everything-claude-code@everything-claude-code → true", () => {
  assert.equal(isAcceptedEccIdentity("everything-claude-code@everything-claude-code"), true);
});

test("isAcceptedEccIdentity: other legacy marketplace → true (prefix match)", () => {
  assert.equal(isAcceptedEccIdentity(`${ECC_LEGACY_PLUGIN_NAME}@some-other-marketplace`), true);
});

test("isAcceptedEccIdentity: unknown plugin → false", () => {
  assert.equal(isAcceptedEccIdentity("superpowers@claude-plugins-official"), false);
});

test("isLegacyEccIdentity: canonical → false", () => {
  assert.equal(isLegacyEccIdentity(ECC_CANONICAL_IDENTITY), false);
});

test("isLegacyEccIdentity: legacy → true", () => {
  assert.equal(isLegacyEccIdentity("everything-claude-code@everything-claude-code"), true);
});

test("isLegacyEccIdentity: unrelated plugin → false", () => {
  assert.equal(isLegacyEccIdentity("other@marketplace"), false);
});

// ---------------------------------------------------------------------------
// checkMajorVersionBump
// ---------------------------------------------------------------------------

test("checkMajorVersionBump: same major → false", () => {
  assert.equal(checkMajorVersionBump("1.8.0", "1.9.0"), false);
});

test("checkMajorVersionBump: new major higher → true", () => {
  assert.equal(checkMajorVersionBump("1.8.0", "2.0.0"), true);
});

test("checkMajorVersionBump: new major lower (downgrade) → false", () => {
  assert.equal(checkMajorVersionBump("2.0.0", "1.8.0"), false);
});

test("checkMajorVersionBump: unparseable recorded → false (conservative)", () => {
  assert.equal(checkMajorVersionBump("unknown", "2.0.0"), false);
});

test("checkMajorVersionBump: unparseable new → false (conservative)", () => {
  assert.equal(checkMajorVersionBump("1.0.0", "unknown"), false);
});

test("checkMajorVersionBump: same major different minor+patch → false", () => {
  assert.equal(checkMajorVersionBump("2.0.0", "2.1.3"), false);
});

// ---------------------------------------------------------------------------
// readEccPluginRecord / writeEccPluginRecord
// ---------------------------------------------------------------------------

test("readEccPluginRecord: file absent → undefined", async () => {
  const readFn = makeReadFn({});
  const result = await readEccPluginRecord(readFn, TARGET);
  assert.equal(result, undefined);
});

test("readEccPluginRecord: valid record → parsed correctly", async () => {
  const record = { identity: "ecc@ecc", version: "2.0.0", installedAt: "2026-07-03T00:00:00.000Z" };
  const readFn = makeReadFn({ [RECORD_PATH]: JSON.stringify(record) });
  const result = await readEccPluginRecord(readFn, TARGET);
  assert.deepEqual(result, record);
});

test("readEccPluginRecord: malformed JSON → undefined", async () => {
  const readFn = makeReadFn({ [RECORD_PATH]: "not-json{{" });
  const result = await readEccPluginRecord(readFn, TARGET);
  assert.equal(result, undefined);
});

test("readEccPluginRecord: missing required fields → undefined", async () => {
  const readFn = makeReadFn({ [RECORD_PATH]: JSON.stringify({ identity: "ecc@ecc" }) });
  const result = await readEccPluginRecord(readFn, TARGET);
  assert.equal(result, undefined);
});

test("writeEccPluginRecord: writes valid JSON with all required fields", async () => {
  const writeFn = makeWriteFn();
  const record = { identity: "ecc@ecc", version: "2.0.0", installedAt: "2026-07-03T00:00:00.000Z" };
  await writeEccPluginRecord(writeFn, TARGET, record);
  assert.ok(RECORD_PATH in writeFn.written, "record file must be written");
  const parsed = JSON.parse(writeFn.written[RECORD_PATH]!) as typeof record;
  assert.equal(parsed.identity, record.identity);
  assert.equal(parsed.version, record.version);
  assert.equal(parsed.installedAt, record.installedAt);
});

test("writeEccPluginRecord: round-trips through readEccPluginRecord", async () => {
  const writeFn = makeWriteFn();
  const originalRecord = {
    identity: ECC_CANONICAL_IDENTITY,
    version: "2.0.0",
    installedAt: "2026-07-03T00:00:00.000Z",
  };
  await writeEccPluginRecord(writeFn, TARGET, originalRecord);

  const readFn = makeReadFn({ [RECORD_PATH]: writeFn.written[RECORD_PATH]! });
  const readBack = await readEccPluginRecord(readFn, TARGET);
  assert.deepEqual(readBack, originalRecord, "round-trip must preserve all fields");
});

// ---------------------------------------------------------------------------
// runConsentedEccInstall — already-installed path (C13 idempotency)
// ---------------------------------------------------------------------------

test("runConsentedEccInstall: canonical already installed → already-installed, record written", async () => {
  const spawnFn = makeSpawnFn({
    "claude plugin list": { exitCode: 0, stdout: CANONICAL_PLUGIN_LIST, stderr: "" },
  });
  const readFn = makeReadFn({});
  const writeFn = makeWriteFn();

  const result = await runConsentedEccInstall(spawnFn, readFn, writeFn, TARGET);

  assert.equal(result.status, "already-installed");
  assert.equal(result.record.identity, "ecc@ecc");
  assert.equal(result.record.version, "2.0.0");
  // C6: record must be written
  assert.ok(RECORD_PATH in writeFn.written, "C6: version record must be written");
  // Idempotent: only plugin list was called (no install/marketplace spawns)
  const nonListCalls = spawnFn.calls.filter(
    (c) => !(c.args[0] === "plugin" && c.args[1] === "list")
  );
  assert.equal(nonListCalls.length, 0, "C13: no install calls when already installed");
});

test("runConsentedEccInstall: legacy already installed → already-installed, record written", async () => {
  const spawnFn = makeSpawnFn({
    "claude plugin list": { exitCode: 0, stdout: LEGACY_PLUGIN_LIST, stderr: "" },
  });
  const readFn = makeReadFn({});
  const writeFn = makeWriteFn();

  const result = await runConsentedEccInstall(spawnFn, readFn, writeFn, TARGET);

  assert.equal(result.status, "already-installed");
  assert.equal(result.record.identity, "everything-claude-code@everything-claude-code");
  assert.ok(RECORD_PATH in writeFn.written, "C6: record must be written for legacy install");
});

// ---------------------------------------------------------------------------
// runConsentedEccInstall — C6 major version bump gate
// ---------------------------------------------------------------------------

test("C6: major version bump without confirmation → needs-confirmation", async () => {
  // Currently installed: v2.0.0; recorded: v1.8.0 → major bump (2 > 1)
  const spawnFn = makeSpawnFn({
    "claude plugin list": { exitCode: 0, stdout: CANONICAL_PLUGIN_LIST, stderr: "" },
  });
  const existingRecord = JSON.stringify({
    identity: "ecc@ecc",
    version: "1.8.0",
    installedAt: "2026-01-01T00:00:00.000Z",
  });
  const readFn = makeReadFn({ [RECORD_PATH]: existingRecord });
  const writeFn = makeWriteFn();

  const result = await runConsentedEccInstall(spawnFn, readFn, writeFn, TARGET);

  assert.equal(result.status, "needs-confirmation");
  if (result.status === "needs-confirmation") {
    assert.equal(result.reason, "major-bump");
    assert.equal(result.installedVersion, "2.0.0");
    assert.equal(result.recordedVersion, "1.8.0");
  }
  // Record must NOT be updated when confirmation is needed
  assert.equal(
    RECORD_PATH in writeFn.written,
    false,
    "C6: record must not be updated before confirmation"
  );
});

test("C6: major version bump with confirmMajorBump=true → already-installed", async () => {
  const spawnFn = makeSpawnFn({
    "claude plugin list": { exitCode: 0, stdout: CANONICAL_PLUGIN_LIST, stderr: "" },
  });
  const existingRecord = JSON.stringify({
    identity: "ecc@ecc",
    version: "1.8.0",
    installedAt: "2026-01-01T00:00:00.000Z",
  });
  const readFn = makeReadFn({ [RECORD_PATH]: existingRecord });
  const writeFn = makeWriteFn();

  const result = await runConsentedEccInstall(spawnFn, readFn, writeFn, TARGET, {
    confirmMajorBump: true,
  });

  assert.equal(result.status, "already-installed");
  assert.ok(RECORD_PATH in writeFn.written, "C6: record must be updated after confirmation");
});

// ---------------------------------------------------------------------------
// runConsentedEccInstall — install path (not installed → install)
// ---------------------------------------------------------------------------

test("runConsentedEccInstall: not installed → runs marketplace add + install → installed", async () => {
  // First plugin list call: empty (not installed)
  // marketplace add: ok
  // plugin install: ok
  // Second plugin list call: canonical installed
  let listCallCount = 0;
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawnFn: SpawnFn = async (command, args) => {
    calls.push({ command, args });
    if (command === "claude" && args[0] === "plugin" && args[1] === "list") {
      listCallCount += 1;
      if (listCallCount === 1) {
        return { exitCode: 0, stdout: EMPTY_PLUGIN_LIST, stderr: "" };
      }
      return { exitCode: 0, stdout: CANONICAL_PLUGIN_LIST, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const readFn = makeReadFn({});
  const writeFn = makeWriteFn();

  const result = await runConsentedEccInstall(spawnFn, readFn, writeFn, TARGET);

  assert.equal(result.status, "installed");
  assert.equal(result.record.identity, "ecc@ecc");
  assert.equal(result.record.version, "2.0.0");
  assert.ok(RECORD_PATH in writeFn.written, "C6: version record must be written after install");
});

test("C7: all spawn calls use hardcoded 'claude' command and plugin constants", async () => {
  let listCallCount = 0;
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawnFn: SpawnFn = async (command, args) => {
    calls.push({ command, args });
    if (command === "claude" && args[0] === "plugin" && args[1] === "list") {
      listCallCount += 1;
      return listCallCount === 1
        ? { exitCode: 0, stdout: EMPTY_PLUGIN_LIST, stderr: "" }
        : { exitCode: 0, stdout: CANONICAL_PLUGIN_LIST, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const readFn = makeReadFn({});
  const writeFn = makeWriteFn();

  await runConsentedEccInstall(spawnFn, readFn, writeFn, TARGET);

  // C7: ALL commands must be "claude" (hardcoded constant)
  for (const call of calls) {
    assert.equal(call.command, "claude", `C7: all spawn calls must use 'claude' command, got '${call.command}'`);
  }

  // C7: marketplace add must use hardcoded ECC_MARKETPLACE_SOURCE
  const marketplaceCalls = calls.filter(
    (c) => c.args[0] === "plugin" && c.args[1] === "marketplace" && c.args[2] === "add"
  );
  assert.ok(marketplaceCalls.length > 0, "C7: marketplace add must be called");
  assert.equal(
    marketplaceCalls[0]!.args[3],
    ECC_MARKETPLACE_SOURCE,
    `C7: marketplace source must be hardcoded '${ECC_MARKETPLACE_SOURCE}'`
  );

  // C7: plugin install must use hardcoded ECC_CANONICAL_IDENTITY
  const installCalls = calls.filter(
    (c) => c.args[0] === "plugin" && c.args[1] === "install"
  );
  assert.ok(installCalls.length > 0, "C7: plugin install must be called");
  assert.equal(
    installCalls[0]!.args[2],
    ECC_CANONICAL_IDENTITY,
    `C7: install identity must be hardcoded '${ECC_CANONICAL_IDENTITY}'`
  );
});

test("runConsentedEccInstall: install spawn fails → failed", async () => {
  const spawnFn: SpawnFn = async (_command, args) => {
    if (args[0] === "plugin" && args[1] === "list") {
      return { exitCode: 0, stdout: EMPTY_PLUGIN_LIST, stderr: "" };
    }
    if (args[0] === "plugin" && args[1] === "marketplace") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "plugin" && args[1] === "install") {
      return { exitCode: 1, stdout: "", stderr: "install error" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const readFn = makeReadFn({});
  const writeFn = makeWriteFn();

  const result = await runConsentedEccInstall(spawnFn, readFn, writeFn, TARGET);

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.ok(result.error.length > 0, "failed result must include error message");
  }
  // No record written on failure
  assert.equal(RECORD_PATH in writeFn.written, false, "record must not be written on install failure");
});

test("C13: idempotency — second run with already-installed → already-installed (no re-install)", async () => {
  // Simulate: canonical already installed; record from previous run present
  const spawnFn = makeSpawnFn({
    "claude plugin list": { exitCode: 0, stdout: CANONICAL_PLUGIN_LIST, stderr: "" },
  });
  const existingRecord = JSON.stringify({
    identity: "ecc@ecc",
    version: "2.0.0",
    installedAt: "2026-07-01T00:00:00.000Z",
  });
  const readFn = makeReadFn({ [RECORD_PATH]: existingRecord });
  const writeFn = makeWriteFn();

  const result = await runConsentedEccInstall(spawnFn, readFn, writeFn, TARGET);

  assert.equal(result.status, "already-installed");
  // installedAt from existing record must be preserved (not overwritten)
  const written = JSON.parse(writeFn.written[RECORD_PATH]!) as { installedAt: string };
  assert.equal(
    written.installedAt,
    "2026-07-01T00:00:00.000Z",
    "C13: idempotent run must preserve original installedAt"
  );
  // Only plugin list spawned — no install/marketplace calls
  assert.equal(
    spawnFn.calls.filter((c) => c.args[1] === "marketplace" || c.args[1] === "install").length,
    0,
    "C13: idempotent run must not spawn marketplace or install calls"
  );
});

// ---------------------------------------------------------------------------
// C5: parseCliArgs gate — --yes alone must not set installPlugin
// ---------------------------------------------------------------------------

test("C5: init --apply without --install-plugin → installPlugin not set", () => {
  const parsed = parseCliArgs(["init", "--apply", "/some/target"]);
  assert.equal(parsed.command, "init");
  assert.equal(
    "installPlugin" in parsed ? (parsed as { installPlugin?: boolean }).installPlugin : undefined,
    undefined,
    "C5: installPlugin must be undefined when --install-plugin is not present"
  );
});

test("C5: init --apply --install-plugin → installPlugin = true", () => {
  const parsed = parseCliArgs(["init", "--apply", "--install-plugin", "/some/target"]);
  assert.equal(parsed.command, "init");
  assert.equal(
    (parsed as { installPlugin?: boolean }).installPlugin,
    true,
    "--install-plugin must set installPlugin=true"
  );
});

test("C5: upgrade --apply without --install-plugin → installPlugin not set", () => {
  const parsed = parseCliArgs(["upgrade", "--apply", "/some/target"]);
  assert.equal(parsed.command, "upgrade");
  assert.equal(
    "installPlugin" in parsed ? (parsed as { installPlugin?: boolean }).installPlugin : undefined,
    undefined,
    "C5: upgrade without --install-plugin must not set installPlugin"
  );
});

test("C5: --confirm-ecc-major without --install-plugin → confirmEccMajor not set independently", () => {
  // confirmEccMajor is parsed separately; installPlugin is still gated on --install-plugin
  const parsed = parseCliArgs(["init", "--apply", "--confirm-ecc-major", "/some/target"]);
  assert.equal(
    "installPlugin" in parsed ? (parsed as { installPlugin?: boolean }).installPlugin : undefined,
    undefined,
    "C5: --confirm-ecc-major alone must not set installPlugin"
  );
  assert.equal(
    (parsed as { confirmEccMajor?: boolean }).confirmEccMajor,
    true,
    "--confirm-ecc-major must set confirmEccMajor"
  );
});

// ---------------------------------------------------------------------------
// C6: version shown at consent surface (version record round-trip)
// ---------------------------------------------------------------------------

test("C6: installed version is captured and round-trips correctly", async () => {
  let listCallCount = 0;
  const spawnFn: SpawnFn = async (_command, args) => {
    if (args[0] === "plugin" && args[1] === "list") {
      listCallCount += 1;
      // First call: not installed; second call: installed with specific version
      return listCallCount === 1
        ? { exitCode: 0, stdout: EMPTY_PLUGIN_LIST, stderr: "" }
        : {
            exitCode: 0,
            stdout: `Installed plugins:\n\n  ❯ ecc@ecc\n    Version: 2.1.5\n    Scope: user\n    Status: ✔ enabled\n`,
            stderr: "",
          };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const readFn = makeReadFn({});
  const writeFn = makeWriteFn();

  const result = await runConsentedEccInstall(spawnFn, readFn, writeFn, TARGET);

  assert.equal(result.status, "installed");
  assert.equal(result.record.version, "2.1.5", "C6: actual installed version must be captured");

  // Round-trip the record
  const readFn2 = makeReadFn({ [RECORD_PATH]: writeFn.written[RECORD_PATH]! });
  const readBack = await readEccPluginRecord(readFn2, TARGET);
  assert.equal(readBack?.version, "2.1.5", "C6: version must round-trip through record file");
});

// ---------------------------------------------------------------------------
// MEDIUM-3: --yes alone must NOT set installPlugin (C5 binding test)
// ---------------------------------------------------------------------------

test("C5 / MEDIUM-3: --yes alone must not set installPlugin", () => {
  const parsed = parseCliArgs(["init", "--apply", "--yes", "/some/target"]);
  assert.equal(parsed.command, "init");
  assert.equal(
    (parsed as { installPlugin?: boolean }).installPlugin,
    undefined,
    "C5 / MEDIUM-3: --yes alone must never set installPlugin; ~/.claude writes require --install-plugin"
  );
});

test("C5 / MEDIUM-3: --yes with --dry-run must not set installPlugin", () => {
  // --yes is accepted as a known flag (reserved for S4 interactive consent) but
  // C5 mandates it NEVER sets installPlugin; only --install-plugin may.
  const parsed = parseCliArgs(["init", "--dry-run", "--yes", "/some/target"]);
  assert.equal(
    (parsed as { installPlugin?: boolean }).installPlugin,
    undefined,
    "C5 / MEDIUM-3: --yes with --dry-run must still not set installPlugin without --install-plugin"
  );
});

// ---------------------------------------------------------------------------
// MEDIUM-4: same-major minor version bump → no gate, record updated
// ---------------------------------------------------------------------------

test("MEDIUM-4: pre-existing record v1.8.0, installed v1.9.0 (same major) → record updated, no gate", async () => {
  // Installed: 1.9.0 (legacy identity); recorded: 1.8.0 → same major → no confirmation gate
  const legacyV190List = `Installed plugins:\n\n  ❯ everything-claude-code@everything-claude-code\n    Version: 1.9.0\n    Scope: user\n    Status: ✔ enabled\n`;
  const spawnFn = makeSpawnFn({
    "claude plugin list": { exitCode: 0, stdout: legacyV190List, stderr: "" },
  });
  const existingRecord = JSON.stringify({
    identity: "everything-claude-code@everything-claude-code",
    version: "1.8.0",
    installedAt: "2026-01-01T00:00:00.000Z",
  });
  const readFn = makeReadFn({ [RECORD_PATH]: existingRecord });
  const writeFn = makeWriteFn();

  const result = await runConsentedEccInstall(spawnFn, readFn, writeFn, TARGET);

  // Same major → no confirmation gate; result is already-installed
  assert.equal(
    result.status,
    "already-installed",
    "MEDIUM-4: same-major minor bump must not trigger needs-confirmation gate"
  );
  // Record must be updated to the new minor version
  assert.equal(result.record.version, "1.9.0", "MEDIUM-4: record must be updated to installed v1.9.0");
  assert.ok(RECORD_PATH in writeFn.written, "MEDIUM-4: record must be written with updated version");
  const written = JSON.parse(writeFn.written[RECORD_PATH]!) as { version: string };
  assert.equal(written.version, "1.9.0", "MEDIUM-4: written record version must be 1.9.0");
  // No install/marketplace calls (already installed)
  assert.equal(
    spawnFn.calls.filter((c) => c.args[1] === "install" || c.args[1] === "marketplace").length,
    0,
    "MEDIUM-4: same-major bump must not trigger re-install"
  );
});

// ---------------------------------------------------------------------------
// MEDIUM-5: CLI orchestration test via exported runEccInstallFromCli
// ---------------------------------------------------------------------------

test("MEDIUM-5: runEccInstallFromCli with stub spawn, already-installed → no plugin install call", async () => {
  // Use a real tmpDir so createDefaultEccReadFileFn/WriteFileFn can operate without errors.
  // No ~/.claude writes: stub spawn returns "already-installed" — plugin install never invoked.
  const tmpDir = await mkdtemp("/tmp/archon-test-ecc-m5-");
  try {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawnStub: SpawnFn = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "plugin" && args[1] === "list") {
        return { exitCode: 0, stdout: CANONICAL_PLUGIN_LIST, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    // 3rd arg is now GuidedInitIo (io); 4th arg is the optional spawn override.
    const ioStub = {
      isTTY: false,
      async question(): Promise<string> { return ""; },
      stdout(_msg: string): void {},
      stderr(_msg: string): void {},
    };
    await runEccInstallFromCli(tmpDir, false, ioStub, spawnStub);

    // The C5 gate in main() ensures runEccInstallFromCli is never called without --install-plugin.
    // Here we verify that when runEccInstallFromCli IS called (--install-plugin path),
    // it does not spawn `claude plugin install` when the plugin is already present.
    const installCalls = calls.filter((c) => c.args[0] === "plugin" && c.args[1] === "install");
    assert.equal(
      installCalls.length,
      0,
      "MEDIUM-5: plugin install must not be spawned when ECC is already installed"
    );
    // Only plugin list should have been called
    const listCalls = calls.filter((c) => c.args[0] === "plugin" && c.args[1] === "list");
    assert.ok(listCalls.length >= 1, "MEDIUM-5: plugin list must be called to detect installed state");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// LOW-9: parsePluginList — missing Version column
// ---------------------------------------------------------------------------

test("LOW-9: parsePluginList: entry missing Version field → version = 'unknown'", () => {
  const input = `Installed plugins:

  ❯ ecc@ecc
    Scope: user
    Status: ✔ enabled
`;
  const plugins = parsePluginList(input);
  assert.equal(plugins.length, 1);
  const p = plugins[0]!;
  assert.equal(p.identity, "ecc@ecc");
  assert.equal(p.version, "unknown", "LOW-9: missing Version field must yield version='unknown'");
  assert.equal(p.enabled, true);
});

// ---------------------------------------------------------------------------
// LOW-10: isAcceptedEccIdentity near-match tests
// ---------------------------------------------------------------------------

test("LOW-10: isAcceptedEccIdentity: 'ecc-extra@ecc' → false (name prefix match must not trigger)", () => {
  assert.equal(
    isAcceptedEccIdentity("ecc-extra@ecc"),
    false,
    "LOW-10: 'ecc-extra@ecc' is not canonical (name must be exactly 'ecc')"
  );
});

test("LOW-10: isAcceptedEccIdentity: 'ecc@ecc-fake' → false (canonical requires name AND marketplace both 'ecc')", () => {
  assert.equal(
    isAcceptedEccIdentity("ecc@ecc-fake"),
    false,
    "LOW-10: 'ecc@ecc-fake' must not match canonical — marketplace must be exactly 'ecc'"
  );
});

test("LOW-10: isAcceptedEccIdentity: 'everything-claude-code-extra@somewhere' → false (prefix too long)", () => {
  assert.equal(
    isAcceptedEccIdentity("everything-claude-code-extra@somewhere"),
    false,
    "LOW-10: name must start with 'everything-claude-code' exactly; extra suffix disqualifies it"
  );
});

test("LOW-10: isAcceptedEccIdentity: empty string → false", () => {
  assert.equal(isAcceptedEccIdentity(""), false, "LOW-10: empty string must not be accepted");
});

test("LOW-10: isAcceptedEccIdentity: 'ecc@' (no marketplace) → false", () => {
  assert.equal(isAcceptedEccIdentity("ecc@"), false, "LOW-10: 'ecc@' with empty marketplace must not match canonical");
});
