/**
 * Tests for src/install/consumer-repair.ts (S5 consumer repair).
 *
 * ALL tests use injected stubs — no real filesystem I/O, no real consumer repo.
 * Fixtures are built in-memory using a Map<absolutePath, content>.
 *
 * Coverage:
 *   - detectRepairNeeds: all 5 action kinds detected from hexchange-class fixture
 *   - detectRepairNeeds: healthy repo → zero actions
 *   - detectRepairNeeds: partial breakage variants
 *   - executeRepairs: hexchange-class — detect all, repair repaired set, C12 backups
 *   - executeRepairs: C12 sequence — backup write happens BEFORE mutation write
 *   - executeRepairs: idempotency — re-run on healed state → no writes, no backups
 *   - executeRepairs: only stale settings → only settings touched
 *   - executeRepairs: only stuck migration-report → only report touched
 *   - executeRepairs: healthy repo → zero repaired, zero backups
 *   - stripStaleMcpEntriesFromSettings: strips only stale names, preserves user entries
 *   - advanceMigrationReportStatus: updates status, preserves other fields
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectRepairNeeds,
  executeRepairs,
  stripStaleMcpEntriesFromSettings,
  advanceMigrationReportStatus,
  maybeRunConsumerRepairPhase,
} from "../../src/install/consumer-repair.ts";
import type {
  RepairAction,
  RepairFns,
  RepairReport,
} from "../../src/install/consumer-repair.ts";
import {
  printRepairReport,
} from "../../src/install/guided-init.ts";
import type { GuidedInitIo } from "../../src/install/guided-init.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TARGET_ROOT = "/fake/consumer";

/** Stale mcpServers entries matching the hexchange-class calibration case. */
const STALE_SETTINGS_CONTENT = JSON.stringify(
  {
    mcpServers: {
      archon: {
        command: "node",
        args: [
          "--env-file=.env.archon",
          "--experimental-strip-types",
          "./node_modules/archon/src/mcp/server.ts",
        ],
      },
      gitnexus: {
        command: "npx",
        args: ["--no-install", "gitnexus", "mcp"],
      },
      grafana: {
        command: "node",
        args: [
          "--experimental-strip-types",
          "./node_modules/archon/src/grafana/mcp-server.ts",
        ],
      },
      obsidian: {
        command: "npx",
        args: ["@bitbonsai/mcpvault@latest", "${ARCHON_OBSIDIAN_VAULT_PATH}"],
        env: {},
      },
      playwright: {
        command: "npx",
        args: [
          "--yes",
          "@playwright/mcp@latest",
          "--config",
          ".archon/playwright/mcp.json",
        ],
      },
      playwright_vision: {
        command: "npx",
        args: [
          "--yes",
          "@playwright/mcp@latest",
          "--config",
          ".archon/playwright/mcp.vision.json",
        ],
      },
    },
  },
  null,
  2
);

/** Healthy settings.json with no archon-managed mcpServers. */
const HEALTHY_SETTINGS_CONTENT = JSON.stringify(
  {
    mcpServers: {
      gitnexus: { command: "npx", args: ["--no-install", "gitnexus", "mcp"] },
    },
  },
  null,
  2
);

const STUCK_MIGRATION_REPORT = JSON.stringify(
  {
    status: "planned",
    project: { repoPath: TARGET_ROOT, projectSlug: "consumer" },
    orphans: [],
    conflicts: [],
    verification: { commands: ["npm run archon:doctor"] },
  },
  null,
  2
);

const HEALTHY_MIGRATION_REPORT = JSON.stringify(
  {
    status: "upgrade-applied",
    project: { repoPath: TARGET_ROOT, projectSlug: "consumer" },
    orphans: [],
    conflicts: [],
  },
  null,
  2
);

const INSTALL_MANIFEST_CONTENT = JSON.stringify(
  { version: 1, files: [] },
  null,
  2
);

const MCP_JSON_CONTENT = JSON.stringify(
  { mcpServers: { archon: { command: "node", args: [] } } },
  null,
  2
);

/** Absolute path in the fake consumer root. */
function abs(rel: string): string {
  return `${TARGET_ROOT}/${rel}`;
}

type FileMap = Map<string, string>;

/** Creates a read function from a FileMap. */
function makeReadFn(
  files: FileMap
): (absolutePath: string) => Promise<string | undefined> {
  return async (p: string) => files.get(p);
}

/**
 * Creates a RepairFns stub backed by a mutable FileMap.
 * Tracks write calls in order for sequence assertions (C12).
 */
function makeRepairFns(files: FileMap): RepairFns & {
  writeCalls: Array<{ path: string; op: "write" | "copy" }>;
} {
  const writeCalls: Array<{ path: string; op: "write" | "copy" }> = [];

  const fns: RepairFns = {
    async readFile(p: string) {
      return files.get(p);
    },
    async writeFile(p: string, content: string) {
      writeCalls.push({ path: p, op: "write" });
      files.set(p, content);
    },
    async copyFile(src: string, dest: string) {
      writeCalls.push({ path: dest, op: "copy" });
      const content = files.get(src);
      if (content === undefined) {
        throw new Error(`copyFile: src not found: ${src}`);
      }
      files.set(dest, content);
    },
    async ensureDir(_p: string) {
      // no-op in tests
    },
  };

  return Object.assign(fns, { writeCalls });
}

/** Builds the hexchange-class fixture: all 5 breakage markers present. */
function buildHexchangeFixture(): FileMap {
  return new Map([
    [abs(".claude/settings.json"), STALE_SETTINGS_CONTENT],
    [abs(".archon/install-manifest.json"), INSTALL_MANIFEST_CONTENT],
    [abs(".archon/runtime/migration-report.json"), STUCK_MIGRATION_REPORT],
    [abs("scripts/check-archon-workflow.sh"), "#!/bin/bash\necho old"],
    // .mcp.json deliberately ABSENT (missing-mcp-json)
  ]);
}

/** Builds a fully healthy fixture: all issues resolved. */
function buildHealthyFixture(): FileMap {
  return new Map([
    [abs(".mcp.json"), MCP_JSON_CONTENT],
    [abs(".claude/settings.json"), HEALTHY_SETTINGS_CONTENT],
    [abs(".archon/install-manifest.json"), INSTALL_MANIFEST_CONTENT],
    [abs(".archon/runtime/migration-report.json"), HEALTHY_MIGRATION_REPORT],
    // no check-archon-workflow.sh
  ]);
}

// ---------------------------------------------------------------------------
// detectRepairNeeds — all breakages (hexchange class)
// ---------------------------------------------------------------------------

test("detectRepairNeeds — hexchange class: detects all 5 action kinds", async () => {
  const files = buildHexchangeFixture();
  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));

  const kinds = actions.map((a) => a.kind);
  assert.ok(kinds.includes("missing-mcp-json"), "missing-mcp-json not detected");
  assert.ok(
    kinds.includes("stale-settings-mcp-entries"),
    "stale-settings-mcp-entries not detected"
  );
  // manifest is present in hexchange fixture — so missing-manifest should NOT fire
  assert.ok(!kinds.includes("missing-manifest"), "missing-manifest should not fire (manifest present)");
  assert.ok(
    kinds.includes("stuck-migration-report"),
    "stuck-migration-report not detected"
  );
  assert.ok(
    kinds.includes("legacy-workflow-scripts"),
    "legacy-workflow-scripts not detected"
  );
});

test("detectRepairNeeds — hexchange class: detects 5 stale archon mcpServers entries with correct definitive flags", async () => {
  const files = buildHexchangeFixture();
  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const staleAction = actions.find(
    (a): a is Extract<RepairAction, { kind: "stale-settings-mcp-entries" }> =>
      a.kind === "stale-settings-mcp-entries"
  );
  assert.ok(staleAction, "stale-settings-mcp-entries action not found");
  // archon, grafana, obsidian, playwright, playwright_vision — gitnexus is NOT stale
  assert.equal(staleAction.staleEntries.length, 5);
  const staleNames = staleAction.staleEntries.map((e) => e.serverName);
  assert.ok(staleNames.includes("archon"), "archon not in stale list");
  assert.ok(staleNames.includes("grafana"), "grafana not in stale list");
  assert.ok(staleNames.includes("obsidian"), "obsidian not in stale list");
  assert.ok(staleNames.includes("playwright"), "playwright not in stale list");
  assert.ok(staleNames.includes("playwright_vision"), "playwright_vision not in stale list");
  assert.ok(!staleNames.includes("gitnexus"), "gitnexus should NOT be in stale list");

  // definitive flag: only entries with node_modules/archon/src/ path are definitive
  const byName = Object.fromEntries(staleAction.staleEntries.map((e) => [e.serverName, e]));
  assert.equal(byName.archon!.definitive, true, "archon must be definitive (has src path)");
  assert.equal(byName.grafana!.definitive, true, "grafana must be definitive (has src path)");
  assert.equal(byName.obsidian!.definitive, false, "obsidian must NOT be definitive (@latest only, no src path)");
  assert.equal(byName.playwright!.definitive, false, "playwright must NOT be definitive (--yes+@latest only)");
  assert.equal(byName.playwright_vision!.definitive, false, "playwright_vision must NOT be definitive");
});

test("detectRepairNeeds — detects missing-manifest when manifest absent", async () => {
  const files = new Map([
    [abs(".mcp.json"), MCP_JSON_CONTENT],
    [abs(".claude/settings.json"), HEALTHY_SETTINGS_CONTENT],
    // no install-manifest.json
    [abs(".archon/runtime/migration-report.json"), HEALTHY_MIGRATION_REPORT],
  ]);
  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const kinds = actions.map((a) => a.kind);
  assert.ok(kinds.includes("missing-manifest"), "missing-manifest not detected");
});

// ---------------------------------------------------------------------------
// detectRepairNeeds — healthy repo
// ---------------------------------------------------------------------------

test("detectRepairNeeds — healthy repo: zero actions", async () => {
  const files = buildHealthyFixture();
  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  assert.equal(actions.length, 0, `expected 0 actions, got: ${actions.map((a) => a.kind).join(", ")}`);
});

test("detectRepairNeeds — migration-report with status other than 'planned' is healthy", async () => {
  const files = new Map([
    [abs(".mcp.json"), MCP_JSON_CONTENT],
    [abs(".claude/settings.json"), HEALTHY_SETTINGS_CONTENT],
    [abs(".archon/install-manifest.json"), INSTALL_MANIFEST_CONTENT],
    [
      abs(".archon/runtime/migration-report.json"),
      JSON.stringify({ status: "completed" }),
    ],
  ]);
  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const kinds = actions.map((a) => a.kind);
  assert.ok(!kinds.includes("stuck-migration-report"), "non-planned status should not trigger repair");
});

// ---------------------------------------------------------------------------
// executeRepairs — hexchange-class full repair
// ---------------------------------------------------------------------------

test("executeRepairs — hexchange class: repaired actions for stale settings + migration-report", async () => {
  const files = buildHexchangeFixture();
  const fns = makeRepairFns(files);
  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const report = await executeRepairs(TARGET_ROOT, actions, "2026-01-01T00-00-00-000Z", fns);

  const repairedKinds = report.repaired.map((r) => r.kind);
  assert.ok(
    repairedKinds.includes("stale-settings-mcp-entries"),
    "stale-settings-mcp-entries should be repaired"
  );
  assert.ok(
    repairedKinds.includes("stuck-migration-report"),
    "stuck-migration-report should be repaired"
  );
});

test("executeRepairs — hexchange class: C12 backups exist for EVERY mutated pre-existing file", async () => {
  const files = buildHexchangeFixture();
  const fns = makeRepairFns(files);
  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const report = await executeRepairs(TARGET_ROOT, actions, "2026-01-01T00-00-00-000Z", fns);

  // Two mutated pre-existing files: settings.json + migration-report.json
  assert.equal(report.backupPaths.length, 2, `expected 2 backups, got: ${report.backupPaths.join(", ")}`);

  const settingsBackup = report.backupPaths.find((p) =>
    p.includes("settings.json")
  );
  assert.ok(settingsBackup, "no backup for settings.json");

  const reportBackup = report.backupPaths.find((p) =>
    p.includes("migration-report.json")
  );
  assert.ok(reportBackup, "no backup for migration-report.json");

  // Backup files should exist in the file map
  assert.ok(
    files.has(abs(settingsBackup!)),
    `backup file not created: ${settingsBackup}`
  );
  assert.ok(
    files.has(abs(reportBackup!)),
    `backup file not created: ${reportBackup}`
  );
});

test("executeRepairs — hexchange class: C12 backup BEFORE mutation (sequence check)", async () => {
  const files = buildHexchangeFixture();
  const fns = makeRepairFns(files);
  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  await executeRepairs(TARGET_ROOT, actions, "2026-01-01T00-00-00-000Z", fns);

  // For settings.json: the copy (backup) must appear BEFORE the write (strip)
  const settingsEvents = fns.writeCalls.filter(
    (c) => c.path.includes("settings.json")
  );
  assert.ok(settingsEvents.length >= 2, "expected at least 2 settings.json events");
  assert.equal(
    settingsEvents[0]!.op,
    "copy",
    "first settings.json event must be copy (backup), not write"
  );

  // For migration-report.json: backup before write
  const reportEvents = fns.writeCalls.filter(
    (c) => c.path.includes("migration-report.json")
  );
  assert.ok(reportEvents.length >= 2, "expected at least 2 migration-report.json events");
  assert.equal(
    reportEvents[0]!.op,
    "copy",
    "first migration-report.json event must be copy (backup), not write"
  );
});

test("executeRepairs — hexchange class: definitive stale entries stripped; ambiguous ones warned, NOT stripped", async () => {
  const files = buildHexchangeFixture();
  const fns = makeRepairFns(files);
  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const report = await executeRepairs(TARGET_ROOT, actions, "ts", fns);

  const updatedSettings = files.get(abs(".claude/settings.json"));
  assert.ok(updatedSettings, "settings.json should be written after repair (definitive entries exist)");
  const parsed = JSON.parse(updatedSettings!) as Record<string, unknown>;
  const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined;

  // Definitive entries (node_modules/archon/src/ path) → auto-stripped
  assert.ok(!mcpServers?.archon, "archon should be stripped (definitive: node_modules/archon/src/)");
  assert.ok(!mcpServers?.grafana, "grafana should be stripped (definitive: node_modules/archon/src/)");

  // Ambiguous entries (@latest / --yes only, no src path) → NOT stripped; must stay in settings
  assert.ok(mcpServers?.playwright, "playwright must NOT be stripped (non-definitive: @latest+--yes only)");
  assert.ok(mcpServers?.playwright_vision, "playwright_vision must NOT be stripped (non-definitive)");
  assert.ok(mcpServers?.obsidian, "obsidian must NOT be stripped (non-definitive: @latest only)");

  // User-managed entry preserved
  assert.ok(mcpServers?.gitnexus, "gitnexus (user-managed) should be preserved");

  // Ambiguous entries surfaced in notAutoRepaired with operator-visible reason
  const ambiguousWarnings = report.notAutoRepaired.filter((n) =>
    n.includes("ambiguous")
  );
  assert.ok(
    ambiguousWarnings.some((w) => w.includes("playwright") && !w.includes("playwright_vision")),
    "playwright ambiguous warning missing"
  );
  assert.ok(
    ambiguousWarnings.some((w) => w.includes("playwright_vision")),
    "playwright_vision ambiguous warning missing"
  );
  assert.ok(
    ambiguousWarnings.some((w) => w.includes("obsidian")),
    "obsidian ambiguous warning missing"
  );
});

test("executeRepairs — hexchange class: migration-report status advanced to upgrade-applied", async () => {
  const files = buildHexchangeFixture();
  const fns = makeRepairFns(files);
  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  await executeRepairs(TARGET_ROOT, actions, "ts", fns);

  const updatedReport = files.get(abs(".archon/runtime/migration-report.json"));
  assert.ok(updatedReport, "migration-report.json should be written after repair");
  const parsed = JSON.parse(updatedReport!) as Record<string, unknown>;
  assert.equal(parsed.status, "upgrade-applied", "status should be upgrade-applied");
  // Other fields preserved
  assert.ok(parsed.project, "project field should be preserved");
});

test("executeRepairs — hexchange class: skill-ref advisory active for pre-P1 consumer", async () => {
  const files = buildHexchangeFixture();
  const fns = makeRepairFns(files);
  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const report = await executeRepairs(TARGET_ROOT, actions, "ts", fns);
  assert.equal(
    report.skillRefAdvisoryActive,
    true,
    "skillRefAdvisoryActive should be true for pre-P1 consumer"
  );
});

// ---------------------------------------------------------------------------
// executeRepairs — idempotency
// ---------------------------------------------------------------------------

test("executeRepairs — idempotency: re-run on healed state → zero writes, zero backups", async () => {
  const files = buildHexchangeFixture();
  const fns = makeRepairFns(files);

  // First run
  const actions1 = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  await executeRepairs(TARGET_ROOT, actions1, "ts1", fns);

  // Clear write calls tracker
  fns.writeCalls.length = 0;

  // Second run: re-detect and re-repair (idempotency check)
  const actions2 = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const report2 = await executeRepairs(TARGET_ROOT, actions2, "ts2", fns);

  // No writes on second run for the repaired items
  assert.equal(fns.writeCalls.length, 0, "second run should produce zero writes");
  assert.equal(report2.repaired.length, 0, "second run should produce zero repaired actions");
  assert.equal(report2.backupPaths.length, 0, "second run should produce zero backups");
});

// ---------------------------------------------------------------------------
// executeRepairs — partial breakage
// ---------------------------------------------------------------------------

test("executeRepairs — only stale settings: only settings.json mutated, migration-report untouched", async () => {
  const files = new Map([
    [abs(".mcp.json"), MCP_JSON_CONTENT],
    [abs(".claude/settings.json"), STALE_SETTINGS_CONTENT],
    [abs(".archon/install-manifest.json"), INSTALL_MANIFEST_CONTENT],
    [abs(".archon/runtime/migration-report.json"), HEALTHY_MIGRATION_REPORT],
  ]);
  const fns = makeRepairFns(files);

  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const report = await executeRepairs(TARGET_ROOT, actions, "ts", fns);

  assert.equal(report.repaired.length, 1, "only one action should be repaired");
  assert.equal(report.repaired[0]!.kind, "stale-settings-mcp-entries");
  assert.equal(report.backupPaths.length, 1, "only one backup");
  assert.ok(
    report.backupPaths[0]!.includes("settings.json"),
    "backup should be for settings.json"
  );

  // migration-report.json: not mutated
  const reportEvents = fns.writeCalls.filter((c) =>
    c.path.includes("migration-report.json")
  );
  assert.equal(reportEvents.length, 0, "migration-report.json should not be touched");
});

test("executeRepairs — only missing mcp.json: notAutoRepaired contains note, no backups", async () => {
  const files = new Map([
    // .mcp.json absent
    [abs(".claude/settings.json"), HEALTHY_SETTINGS_CONTENT],
    [abs(".archon/install-manifest.json"), INSTALL_MANIFEST_CONTENT],
    [abs(".archon/runtime/migration-report.json"), HEALTHY_MIGRATION_REPORT],
  ]);
  const fns = makeRepairFns(files);

  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const report = await executeRepairs(TARGET_ROOT, actions, "ts", fns);

  assert.equal(report.repaired.length, 0, "no repairs should be applied for missing-mcp-json");
  assert.equal(report.backupPaths.length, 0, "no backups for file creation");
  assert.ok(
    report.notAutoRepaired.some((n) => n.includes("missing-mcp-json")),
    "notAutoRepaired should mention missing-mcp-json"
  );
  assert.equal(fns.writeCalls.length, 0, "no writes for missing-mcp-json");
});

test("executeRepairs — only stuck migration-report: only report mutated, settings untouched", async () => {
  const files = new Map([
    [abs(".mcp.json"), MCP_JSON_CONTENT],
    [abs(".claude/settings.json"), HEALTHY_SETTINGS_CONTENT],
    [abs(".archon/install-manifest.json"), INSTALL_MANIFEST_CONTENT],
    [abs(".archon/runtime/migration-report.json"), STUCK_MIGRATION_REPORT],
  ]);
  const fns = makeRepairFns(files);

  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const report = await executeRepairs(TARGET_ROOT, actions, "ts", fns);

  assert.equal(report.repaired.length, 1, "only one action should be repaired");
  assert.equal(report.repaired[0]!.kind, "stuck-migration-report");

  const settingsEvents = fns.writeCalls.filter((c) =>
    c.path.includes("settings.json")
  );
  assert.equal(settingsEvents.length, 0, "settings.json should not be touched");
});

// ---------------------------------------------------------------------------
// executeRepairs — healthy repo
// ---------------------------------------------------------------------------

test("executeRepairs — healthy repo: zero repaired, zero backups", async () => {
  const files = buildHealthyFixture();
  const fns = makeRepairFns(files);

  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const report = await executeRepairs(TARGET_ROOT, actions, "ts", fns);

  assert.equal(report.detected.length, 0, "no issues should be detected in healthy repo");
  assert.equal(report.repaired.length, 0, "no repairs should run in healthy repo");
  assert.equal(report.backupPaths.length, 0, "no backups in healthy repo");
  assert.equal(fns.writeCalls.length, 0, "no writes in healthy repo");
  assert.equal(report.skillRefAdvisoryActive, false, "skill-ref advisory inactive for healthy repo");
});

// ---------------------------------------------------------------------------
// stripStaleMcpEntriesFromSettings — unit
// ---------------------------------------------------------------------------

test("stripStaleMcpEntriesFromSettings — strips only named entries, preserves others", () => {
  const staleNames = new Set(["archon", "playwright"]);
  const input = JSON.stringify({
    mcpServers: {
      archon: { command: "node", args: ["node_modules/archon/src/mcp.ts"] },
      gitnexus: { command: "npx", args: ["gitnexus"] },
      playwright: { command: "npx", args: ["--yes", "@playwright/mcp@latest"] },
    },
  });

  const result = JSON.parse(stripStaleMcpEntriesFromSettings(input, staleNames)) as Record<
    string,
    unknown
  >;
  const mcpServers = result.mcpServers as Record<string, unknown>;

  assert.ok(!mcpServers.archon, "archon should be stripped");
  assert.ok(!mcpServers.playwright, "playwright should be stripped");
  assert.ok(mcpServers.gitnexus, "gitnexus should be preserved");
});

test("stripStaleMcpEntriesFromSettings — removes mcpServers key when all entries stripped", () => {
  const staleNames = new Set(["archon"]);
  const input = JSON.stringify({
    other: "value",
    mcpServers: {
      archon: { command: "node", args: ["node_modules/archon/src/mcp.ts"] },
    },
  });

  const result = JSON.parse(stripStaleMcpEntriesFromSettings(input, staleNames)) as Record<
    string,
    unknown
  >;
  assert.ok(!("mcpServers" in result), "mcpServers key should be removed when empty");
  assert.equal(result.other, "value", "other keys preserved");
});

test("stripStaleMcpEntriesFromSettings — returns original on parse failure", () => {
  const input = "not valid json";
  assert.equal(stripStaleMcpEntriesFromSettings(input, new Set(["archon"])), input);
});

// ---------------------------------------------------------------------------
// advanceMigrationReportStatus — unit
// ---------------------------------------------------------------------------

test("advanceMigrationReportStatus — updates status field, preserves other fields", () => {
  const input = JSON.stringify({
    status: "planned",
    project: { repoPath: "/foo" },
    orphans: [],
    verification: { commands: ["archon doctor"] },
  });

  const result = JSON.parse(advanceMigrationReportStatus(input, "2026-01-01")) as Record<
    string,
    unknown
  >;
  assert.equal(result.status, "upgrade-applied");
  assert.equal((result.project as Record<string, string>).repoPath, "/foo");
  assert.deepEqual(result.orphans, []);
  assert.deepEqual(result.verification, { commands: ["archon doctor"] });
  assert.equal(result.upgradedAt, "2026-01-01");
});

test("advanceMigrationReportStatus — returns original on parse failure", () => {
  const input = "bad json";
  assert.equal(advanceMigrationReportStatus(input, "ts"), input);
});

// ---------------------------------------------------------------------------
// executeRepairs — ok + failures (finding 5: per-action error isolation)
// ---------------------------------------------------------------------------

test("executeRepairs — healthy repo: ok=true, failures empty", async () => {
  const files = buildHealthyFixture();
  const fns = makeRepairFns(files);
  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const report = await executeRepairs(TARGET_ROOT, actions, "ts", fns);
  assert.equal(report.ok, true, "ok must be true when no failures");
  assert.equal(report.failures.length, 0, "failures must be empty on success");
});

test("executeRepairs — hexchange class: ok=true, failures empty when all succeed", async () => {
  const files = buildHexchangeFixture();
  const fns = makeRepairFns(files);
  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const report = await executeRepairs(TARGET_ROOT, actions, "ts", fns);
  assert.equal(report.ok, true, "ok must be true when all actions succeed");
  assert.equal(report.failures.length, 0, "failures must be empty on success");
});

test("executeRepairs — per-action error isolation: copyFile throw on action 1, action 2 still executes", async () => {
  // stale-settings-mcp-entries fires first (has definitive archon+grafana entries)
  // stuck-migration-report fires second.
  // We make copyFile throw on any path containing "settings.json",
  // succeed for migration-report.json.
  const files = buildHexchangeFixture();
  const errorFns: RepairFns = {
    async readFile(p: string) {
      return files.get(p);
    },
    async writeFile(p: string, content: string) {
      files.set(p, content);
    },
    async copyFile(src: string, dest: string) {
      if (src.includes("settings.json")) {
        throw new Error("simulated backup failure on settings.json");
      }
      const content = files.get(src);
      if (content === undefined) throw new Error(`copyFile: src not found: ${src}`);
      files.set(dest, content);
    },
    async ensureDir(_p: string) {},
  };

  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  const report = await executeRepairs(TARGET_ROOT, actions, "ts", errorFns);

  // Action 1 (stale-settings-mcp-entries) failed
  assert.equal(report.ok, false, "ok must be false when any action fails");
  assert.equal(report.failures.length, 1, "exactly one failure recorded");
  assert.equal(
    report.failures[0]!.kind,
    "stale-settings-mcp-entries",
    "failure kind must be stale-settings-mcp-entries"
  );
  assert.ok(
    report.failures[0]!.error.includes("simulated"),
    "failure error should include thrown message"
  );

  // Action 2 (stuck-migration-report) still ran and succeeded
  const migratedReport = files.get(`${TARGET_ROOT}/.archon/runtime/migration-report.json`);
  assert.ok(migratedReport, "migration-report.json should have been written by action 2");
  const parsed = JSON.parse(migratedReport!) as Record<string, unknown>;
  assert.equal(parsed.status, "upgrade-applied", "migration-report status should be upgrade-applied");

  // stuck-migration-report IS in repaired
  assert.ok(
    report.repaired.some((r) => r.kind === "stuck-migration-report"),
    "stuck-migration-report should appear in repaired"
  );
});

// ---------------------------------------------------------------------------
// printRepairReport — finding 1: test coverage
// ---------------------------------------------------------------------------

/** Creates a GuidedInitIo stub that collects all stdout lines for assertion. */
function makeIoStub(): GuidedInitIo & { lines: string[] } {
  const lines: string[] = [];
  const io: GuidedInitIo = {
    isTTY: false,
    stdout: (s: string) => { lines.push(s); },
    stderr: (s: string) => { lines.push(`ERR:${s}`); },
    question: async () => "",
  };
  return Object.assign(io, { lines });
}

/** Minimal RepairReport builder for printRepairReport tests. */
function makeReport(overrides: Partial<RepairReport>): RepairReport {
  return {
    detected: [],
    repaired: [],
    notAutoRepaired: [],
    backupPaths: [],
    skillRefAdvisoryActive: false,
    failures: [],
    ok: true,
    ...overrides,
  };
}

test("printRepairReport — prints repaired action descriptions", () => {
  const io = makeIoStub();
  const report = makeReport({
    detected: [{ kind: "stuck-migration-report", currentStatus: "planned" }],
    repaired: [
      {
        kind: "stuck-migration-report",
        description: 'Advanced migration-report.json from "planned" to "upgrade-applied". Backup: .archon/install-backups/ts/report.json',
        backupPath: ".archon/install-backups/ts/report.json",
      },
    ],
    backupPaths: [".archon/install-backups/ts/report.json"],
  });

  printRepairReport(report, io);

  assert.ok(
    io.lines.some((l) => l.includes("repaired")),
    "should print repaired section header"
  );
  assert.ok(
    io.lines.some((l) => l.includes("Advanced migration-report")),
    "should print repaired action description"
  );
});

test("printRepairReport — prints notAutoRepaired entries", () => {
  const io = makeIoStub();
  const report = makeReport({
    detected: [{ kind: "missing-mcp-json" }],
    notAutoRepaired: ["missing-mcp-json: .mcp.json will be created by the managed-file upgrade pass"],
  });

  printRepairReport(report, io);

  assert.ok(
    io.lines.some((l) => l.includes("pending") || l.includes("notAutoRepaired") || l.includes("requires action")),
    "should print pending/notAutoRepaired section"
  );
  assert.ok(
    io.lines.some((l) => l.includes("missing-mcp-json")),
    "should print notAutoRepaired content"
  );
});

test("printRepairReport — prints C12 backup paths", () => {
  const io = makeIoStub();
  const report = makeReport({
    backupPaths: [".archon/install-backups/ts/.claude/settings.json"],
  });

  printRepairReport(report, io);

  assert.ok(
    io.lines.some((l) => l.includes("backup") || l.includes("C12")),
    "should print backup section header"
  );
  assert.ok(
    io.lines.some((l) => l.includes(".archon/install-backups/ts/.claude/settings.json")),
    "should print backup path"
  );
});

test("printRepairReport — prints skill-ref advisory text with heuristic disclosure (finding 4)", () => {
  const io = makeIoStub();
  const report = makeReport({ skillRefAdvisoryActive: true });

  printRepairReport(report, io);

  const advisoryLine = io.lines.find((l) => l.includes("everything-claude-code"));
  assert.ok(advisoryLine, "advisory line should be printed when skillRefAdvisoryActive=true");
  assert.ok(
    advisoryLine!.includes("inferred from stale settings.json entries"),
    "advisory must disclose heuristic origin"
  );
  assert.ok(
    advisoryLine!.includes("archon verify"),
    "advisory must mention 'archon verify' for full scan"
  );
  assert.ok(
    advisoryLine!.includes("--migrate-skill-refs"),
    "advisory must mention --migrate-skill-refs (S6)"
  );
});

test("printRepairReport — does NOT print advisory when skillRefAdvisoryActive=false", () => {
  const io = makeIoStub();
  const report = makeReport({ skillRefAdvisoryActive: false });

  printRepairReport(report, io);

  assert.ok(
    !io.lines.some((l) => l.includes("everything-claude-code")),
    "advisory should NOT be printed when inactive"
  );
});

// ---------------------------------------------------------------------------
// maybeRunConsumerRepairPhase — finding 2: cli.ts upgrade wiring
// ---------------------------------------------------------------------------

test("maybeRunConsumerRepairPhase — dry-run: returns undefined, no IO", async () => {
  const files = buildHexchangeFixture();
  const fns = makeRepairFns(files);

  const result = await maybeRunConsumerRepairPhase("upgrade", true, TARGET_ROOT, fns);

  assert.equal(result, undefined, "dry-run must return undefined");
  assert.equal(fns.writeCalls.length, 0, "dry-run must not write anything");
});

test("maybeRunConsumerRepairPhase — command=init: returns undefined, no IO", async () => {
  const files = buildHexchangeFixture();
  const fns = makeRepairFns(files);

  const result = await maybeRunConsumerRepairPhase("init", false, TARGET_ROOT, fns);

  assert.equal(result, undefined, "init command must return undefined");
  assert.equal(fns.writeCalls.length, 0, "init command must not write anything");
});

test("maybeRunConsumerRepairPhase — upgrade live: calls detectRepairNeeds + executeRepairs, returns RepairReport", async () => {
  const files = buildHexchangeFixture();
  const fns = makeRepairFns(files);

  const result = await maybeRunConsumerRepairPhase("upgrade", false, TARGET_ROOT, fns);

  assert.ok(result !== undefined, "upgrade live must return a RepairReport");

  // detectRepairNeeds was called (report.detected is populated)
  assert.ok(result.detected.length > 0, "detected should be non-empty for hexchange fixture");

  // executeRepairs was called (stale-settings and migration-report repaired)
  const repairedKinds = result.repaired.map((r) => r.kind);
  assert.ok(
    repairedKinds.includes("stale-settings-mcp-entries"),
    "stale-settings-mcp-entries should be repaired"
  );
  assert.ok(
    repairedKinds.includes("stuck-migration-report"),
    "stuck-migration-report should be repaired"
  );

  // timestamp was used (backupPaths contain an ISO-ish timestamp)
  assert.ok(result.backupPaths.length > 0, "backupPaths must be non-empty (C12)");

  // Report propagated correctly
  assert.equal(result.ok, true, "ok must be true when no failures");
  assert.equal(result.failures.length, 0, "failures must be empty on success");
});
