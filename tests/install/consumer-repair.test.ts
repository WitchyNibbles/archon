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
} from "../../src/install/consumer-repair.ts";
import type {
  RepairAction,
  RepairFns,
} from "../../src/install/consumer-repair.ts";

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

test("detectRepairNeeds — hexchange class: detects 5 stale archon mcpServers entries", async () => {
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

test("executeRepairs — hexchange class: stale settings entries stripped (gitnexus preserved)", async () => {
  const files = buildHexchangeFixture();
  const fns = makeRepairFns(files);
  const actions = await detectRepairNeeds(TARGET_ROOT, makeReadFn(files));
  await executeRepairs(TARGET_ROOT, actions, "ts", fns);

  const updatedSettings = files.get(abs(".claude/settings.json"));
  assert.ok(updatedSettings, "settings.json should be written after repair");
  const parsed = JSON.parse(updatedSettings!) as Record<string, unknown>;
  const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined;

  // Stale archon-managed entries removed
  assert.ok(!mcpServers?.archon, "archon should be stripped from settings.json");
  assert.ok(!mcpServers?.grafana, "grafana should be stripped from settings.json");
  assert.ok(!mcpServers?.playwright, "playwright should be stripped from settings.json");
  assert.ok(!mcpServers?.playwright_vision, "playwright_vision should be stripped from settings.json");
  assert.ok(!mcpServers?.obsidian, "obsidian should be stripped from settings.json");

  // User-managed entry preserved
  assert.ok(mcpServers?.gitnexus, "gitnexus (user-managed) should be preserved");
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
