/**
 * MCP output fixture tests — guards `claude mcp list` / `claude plugin list`
 * parser against output-shape drift (design U1 retirement).
 *
 * Fixture files capture REAL stdout from `claude mcp list` and
 * `claude plugin list` on this machine (captured 2026-07-02):
 *   tests/install/fixtures/claude-mcp-list.txt
 *   tests/install/fixtures/claude-plugin-list.txt
 *
 * If the upstream format changes, these tests fail — making drift a failing
 * test rather than a silent wrong result. Parsers are in:
 *   src/admin/capability-probes-runtime.ts (parseMcpListStatus)
 *
 * U1 retirement evidence (first lines of real captures):
 *   mcp list: "Checking MCP server health…" then "<name>: <cmd> - ✔ Connected"
 *   plugin list: "Installed plugins:" then "  ❯ <name>@<scope>"
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseMcpListStatus,
  probeHookDryRun,
  probeMcpHandshake,
} from "../../src/admin/capability-probes-runtime.ts";
import type { SpawnFn } from "../../src/install/capability/probes-external.ts";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures"
);

function readFixture(name: string): string {
  return readFileSync(path.join(fixtureDir, name), "utf8");
}

// ---------------------------------------------------------------------------
// `claude mcp list` fixture parser
// ---------------------------------------------------------------------------

test("parseMcpListStatus: fixture contains the expected header line", () => {
  const fixture = readFixture("claude-mcp-list.txt");
  assert.ok(
    fixture.includes("Checking MCP server health"),
    "fixture must include the 'Checking MCP server health' header line (format drift guard)"
  );
});

test("parseMcpListStatus: archon server → connected in real fixture", () => {
  const fixture = readFixture("claude-mcp-list.txt");
  const status = parseMcpListStatus(fixture, "archon");
  assert.equal(status, "connected", "archon server must parse as 'connected' from real fixture");
});

test("parseMcpListStatus: unknown server → not-found", () => {
  const fixture = readFixture("claude-mcp-list.txt");
  const status = parseMcpListStatus(fixture, "nonexistent-server-xyz");
  assert.equal(status, "not-found");
});

test("parseMcpListStatus: synthetic Connected line → connected", () => {
  const synthetic = "archon: node src/mcp/server.ts - ✔ Connected\n";
  assert.equal(parseMcpListStatus(synthetic, "archon"), "connected");
});

test("parseMcpListStatus: synthetic Pending line → pending", () => {
  const synthetic = "archon: node src/mcp/server.ts - ✔ Pending\n";
  assert.equal(parseMcpListStatus(synthetic, "archon"), "pending");
});

test("parseMcpListStatus: synthetic disconnected line → disconnected", () => {
  const synthetic = "archon: node src/mcp/server.ts - ✗ Connected\n";
  assert.equal(parseMcpListStatus(synthetic, "archon"), "disconnected");
});

test("parseMcpListStatus: empty stdout → null (parse failure)", () => {
  assert.equal(parseMcpListStatus("", "archon"), null);
});

test("parseMcpListStatus: whitespace-only stdout → null (parse failure)", () => {
  assert.equal(parseMcpListStatus("   \n\n  ", "archon"), null);
});

test("parseMcpListStatus: line without archon prefix is not matched", () => {
  const output = "other-server: node other.ts - ✔ Connected\n";
  assert.equal(parseMcpListStatus(output, "archon"), "not-found");
});

test("parseMcpListStatus: server name with similar prefix not matched (no false positives)", () => {
  // "archon-extra" must not match when looking for "archon"
  const output = "archon-extra: node extra.ts - ✔ Connected\n";
  assert.equal(parseMcpListStatus(output, "archon"), "not-found");
});

// ---------------------------------------------------------------------------
// `claude plugin list` fixture shape guard
// ---------------------------------------------------------------------------

test("plugin list fixture: contains 'Installed plugins:' header (format drift guard)", () => {
  const fixture = readFixture("claude-plugin-list.txt");
  assert.ok(
    fixture.includes("Installed plugins:"),
    "plugin list fixture must include 'Installed plugins:' header (format drift guard)"
  );
});

test("plugin list fixture: contains at least one plugin entry", () => {
  const fixture = readFixture("claude-plugin-list.txt");
  // Entries start with "  ❯ " (arrow prefix with spaces)
  assert.ok(
    fixture.includes("❯"),
    "plugin list fixture must include at least one plugin entry with arrow prefix"
  );
});

test("plugin list fixture: contains everything-claude-code entry", () => {
  const fixture = readFixture("claude-plugin-list.txt");
  assert.ok(
    fixture.includes("everything-claude-code"),
    "plugin list fixture must include the everything-claude-code plugin entry"
  );
});

test("plugin list fixture: Status field present for at least one entry", () => {
  const fixture = readFixture("claude-plugin-list.txt");
  assert.ok(
    fixture.includes("Status:"),
    "plugin list fixture must include 'Status:' field"
  );
});

// ---------------------------------------------------------------------------
// probeHookDryRun unit tests (U2 retirement: Read payload mechanism)
// ---------------------------------------------------------------------------

function makeSpawnFn(
  exitCode: number | null,
  stdout = "",
  stderr = ""
): SpawnFn {
  // Ignores all args — stub captures call result only.
  return async () => ({ exitCode, stdout, stderr });
}

function makeSpawnFnCapturing(): SpawnFn & { calls: Array<{ command: string; args: readonly string[]; stdin: string | undefined }> } {
  const calls: Array<{ command: string; args: readonly string[]; stdin: string | undefined }> = [];
  const fn = async (command: string, args: readonly string[], stdin?: string) => {
    calls.push({ command, args, stdin });
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  (fn as typeof fn & { calls: typeof calls }).calls = calls;
  return fn as ReturnType<typeof makeSpawnFnCapturing>;
}

function makeSpawnFnThrowing(message: string): SpawnFn {
  return async () => {
    throw new Error(message);
  };
}

test("probeHookDryRun: exit 0 → ok", async () => {
  const spawnFn = makeSpawnFn(0);
  const result = await probeHookDryRun(spawnFn, "/fake/target");
  assert.equal(result.status, "ok");
  assert.equal(result.code, "hook-dry-run-ok");
  assert.equal(result.capability, "hooks");
  assert.equal(result.layer, "L3");
});

test("probeHookDryRun: exit 1 → blocked", async () => {
  const spawnFn = makeSpawnFn(1, "", "TypeError: Cannot read properties of undefined");
  const result = await probeHookDryRun(spawnFn, "/fake/target");
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "hook-nonzero-exit");
});

test("probeHookDryRun: ENOENT throw → skipped (hook absent)", async () => {
  const spawnFn = makeSpawnFnThrowing("ENOENT: no such file or directory");
  const result = await probeHookDryRun(spawnFn, "/fake/target");
  assert.equal(result.status, "skipped");
  assert.equal(result.code, "hook-file-absent");
});

test("probeHookDryRun: non-ENOENT throw → blocked (spawn failure)", async () => {
  const spawnFn = makeSpawnFnThrowing("Permission denied");
  const result = await probeHookDryRun(spawnFn, "/fake/target");
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "hook-spawn-error");
});

test("probeHookDryRun: passes Read payload as stdin (U2 mechanism)", async () => {
  const spawnFn = makeSpawnFnCapturing();
  await probeHookDryRun(spawnFn, "/fake/target");
  assert.equal(spawnFn.calls.length, 1);
  const call = spawnFn.calls[0];
  assert.ok(typeof call.stdin === "string", "stdin must be provided");
  const payload = JSON.parse(call.stdin!);
  assert.equal(payload.tool_name, "Read", "payload must have tool_name=Read for safe no-op");
});

test("probeHookDryRun: spawns node with the pre-tool hook path", async () => {
  const spawnFn = makeSpawnFnCapturing();
  await probeHookDryRun(spawnFn, "/fake/target");
  const call = spawnFn.calls[0];
  assert.equal(call.command, "node");
  assert.ok(
    call.args[0]?.endsWith(".claude/hooks/archon-pre-tool.mjs"),
    "hook path must end with .claude/hooks/archon-pre-tool.mjs"
  );
});

// ---------------------------------------------------------------------------
// probeMcpHandshake unit tests (stubbed spawn; temp .mcp.json)
// ---------------------------------------------------------------------------

const HANDSHAKE_MCP_JSON = JSON.stringify({
  mcpServers: {
    archon: {
      command: "node",
      args: ["./node_modules/@witchynibbles/archon/dist/cli/archon-bin.js", "mcp"],
    },
  },
});

async function withHandshakeTempDir<T>(
  mcpJsonContent: string | undefined,
  fn: (dir: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "archon-handshake-"));
  try {
    if (mcpJsonContent !== undefined) {
      await writeFile(path.join(dir, ".mcp.json"), mcpJsonContent, "utf8");
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("probeMcpHandshake: jsonrpc response → ok", async () => {
  await withHandshakeTempDir(HANDSHAKE_MCP_JSON, async (dir) => {
    const spawnFn = makeSpawnFn(0, '{"result":{},"jsonrpc":"2.0","id":1}');
    const result = await probeMcpHandshake(spawnFn, dir);
    assert.equal(result.status, "ok");
    assert.equal(result.code, "mcp-handshake-ok");
    assert.equal(result.layer, "L3");
  });
});

test("probeMcpHandshake: silent exit 0 with no output → blocked (pre-fix entrypoint bug)", async () => {
  await withHandshakeTempDir(HANDSHAKE_MCP_JSON, async (dir) => {
    const spawnFn = makeSpawnFn(0, "", "");
    const result = await probeMcpHandshake(spawnFn, dir);
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "mcp-handshake-silent-exit");
  });
});

test("probeMcpHandshake: server error → blocked, stderr credential scrubbed (C8)", async () => {
  await withHandshakeTempDir(HANDSHAKE_MCP_JSON, async (dir) => {
    const spawnFn = makeSpawnFn(
      1,
      "",
      "connection failed: postgres://archon:sekretpass@localhost:5432/archon refused"
    );
    const result = await probeMcpHandshake(spawnFn, dir);
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "mcp-handshake-server-error");
    assert.ok(!result.detail.includes("sekretpass"), "credential must be scrubbed from detail");
    assert.ok(!result.remediation.includes("sekretpass"), "credential must be scrubbed from remediation");
  });
});

test("probeMcpHandshake: .mcp.json absent → skipped", async () => {
  await withHandshakeTempDir(undefined, async (dir) => {
    const spawnFn = makeSpawnFn(0, "");
    const result = await probeMcpHandshake(spawnFn, dir);
    assert.equal(result.status, "skipped");
    assert.equal(result.code, "mcp-handshake-no-mcp-json");
  });
});

test("probeMcpHandshake: spawn ENOENT → skipped (node absent)", async () => {
  await withHandshakeTempDir(HANDSHAKE_MCP_JSON, async (dir) => {
    const spawnFn = makeSpawnFnThrowing("spawn node ENOENT");
    const result = await probeMcpHandshake(spawnFn, dir);
    assert.equal(result.status, "skipped");
    assert.equal(result.code, "mcp-handshake-node-absent");
  });
});

test("probeMcpHandshake: relative args resolved against targetRoot, initialize sent on stdin", async () => {
  await withHandshakeTempDir(HANDSHAKE_MCP_JSON, async (dir) => {
    const spawnFn = makeSpawnFnCapturing();
    await probeMcpHandshake(spawnFn, dir);
    const call = spawnFn.calls[0];
    assert.equal(call.command, "node");
    assert.ok(path.isAbsolute(call.args[0]!), "relative ./ arg must be resolved to absolute");
    assert.ok(call.args[0]!.startsWith(dir), "resolved arg must stay under targetRoot");
    assert.equal(call.args[1], "mcp");
    assert.ok(call.stdin?.includes('"initialize"'), "initialize request must be sent via stdin");
  });
});
