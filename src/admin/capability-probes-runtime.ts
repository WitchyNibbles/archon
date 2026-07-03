/**
 * L3 (RUNTIME CAPABILITY) probes for the doctor command.
 *
 * L3 probes assert that runtime capabilities actually work:
 *   - MCP server is Connected (not Pending) via `claude mcp list`
 *   - Hook dry-run exits 0 (safe no-op with Read payload)
 *   - DB preflight: pgvector enabled + all required migrations applied
 *
 * All `claude` invocations use the injected SpawnFn with array args (council C7).
 * Tool absent (ENOENT / spawn failure) → skipped, never crash.
 * Parse-fail → skipped advisory.
 *
 * SECURITY (council C8): detail and remediation fields never echo credentials.
 *
 * U1 RETIREMENT: `claude mcp list` output format captured from real machine in
 *   tests/install/fixtures/claude-mcp-list.txt; the fixture test guards drift.
 *
 * U2 RETIREMENT: Hook dry-run mechanism (VERIFIED on real machine 2026-07-02):
 *   The shipped archon-pre-tool.mjs hook calls readHookPayload() which reads
 *   stdin via readFileSync(0, "utf8"). When stdin is empty/null (/dev/null),
 *   readFileSync returns "" and readHookPayload() returns {}. With payload={},
 *   hook-policy.mjs line 113 calls toolName.startsWith("mcp__archon__") where
 *   toolName is undefined → TypeError crash → hook exits 1.
 *
 *   Safe no-op payload: '{"tool_name":"Read","tool_input":{"file_path":"/tmp/x"}}'
 *   isHandoffSafeTool("Read") returns true immediately (diagnosticTools.has),
 *   so evaluatePreToolUse returns undefined without any enforcement action.
 *   Hook exits 0. This is the dry-run mechanism used by probeHookDryRun.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { ProbeResult } from "../install/capability/types.ts";
import type { SpawnFn } from "../install/capability/probes-external.ts";
import type { DbQueryFn } from "./db-preflight.ts";
import { checkPgvector, checkMigrationsCurrent } from "./db-preflight.ts";
import { scrubPgCredentials } from "./db-error-scrub.ts";

// ---------------------------------------------------------------------------
// Package constants (council C7)
// ---------------------------------------------------------------------------

/** Hardcoded claude CLI binary name. Never derived from config or arguments. */
const CLAUDE_CLI = "claude";

/** MCP server name for archon — hardcoded, never config-derived (C7). */
const MCP_SERVER_NAME = "archon";

// ---------------------------------------------------------------------------
// MCP output parsers (fixture-tested — tests/install/mcp-output-fixture.test.ts)
// ---------------------------------------------------------------------------

/**
 * Parses `claude mcp list` stdout and finds the status of a named server.
 *
 * Real output format (captured from machine, see fixture):
 *   Checking MCP server health…\n
 *   \n
 *   <name>: <command> - ✔ Connected
 *   <name>: <command> - ✗ Connected   (error / disconnected)
 *   <name>: <command> - ✔ Pending     (first-use approval needed)
 *
 * Returns "connected" | "pending" | "disconnected" | "not-found" | null (parse error).
 */
export function parseMcpListStatus(
  stdout: string,
  serverName: string
): "connected" | "pending" | "disconnected" | "not-found" | null {
  if (typeof stdout !== "string" || stdout.trim().length === 0) {
    return null;
  }

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    // Line format: "<name>: <command or url> - <checkmark> <status>"
    // The name prefix is: "<serverName>: "
    if (!trimmed.startsWith(`${serverName}:`)) {
      continue;
    }

    const lower = trimmed.toLowerCase();
    // Check for "connected" with a checkmark (✔) — means operational
    if (/[✔✓].*connected/i.test(trimmed) && !/pending/i.test(lower)) {
      return "connected";
    }
    // Check for "pending" — means first-use approval needed
    if (/pending/i.test(lower)) {
      return "pending";
    }
    // Any other state (✗, failed, disconnected, error) → disconnected
    return "disconnected";
  }

  return "not-found";
}

// ---------------------------------------------------------------------------
// L3 probe: MCP server Connected via `claude mcp list`
// ---------------------------------------------------------------------------

/**
 * L3 probe: asserts the archon MCP server shows as Connected in claude mcp list.
 *
 * Spawns `claude mcp list` with shell:false (C7).
 * Tool absent → skipped. Parse-fail → skipped advisory.
 * Connected → ok; Pending → degraded (approval click needed); other → blocked.
 */
export async function probeMcpConnected(spawnFn: SpawnFn): Promise<ProbeResult> {
  let result: { exitCode: number | null; stdout: string; stderr: string };
  try {
    result = await spawnFn(CLAUDE_CLI, ["mcp", "list"]);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      capability: "mcp-archon",
      layer: "L3",
      status: "skipped",
      code: "mcp-list-spawn-failed",
      detail: `Failed to spawn '${CLAUDE_CLI} mcp list': ${errMsg}`,
      remediation:
        "Verify the claude CLI is installed and accessible on PATH, then re-run doctor.",
    };
  }

  if (result.exitCode !== 0) {
    return {
      capability: "mcp-archon",
      layer: "L3",
      status: "skipped",
      code: "mcp-list-nonzero",
      detail: `'${CLAUDE_CLI} mcp list' exited ${String(result.exitCode)}.`,
      remediation: "Check the claude CLI installation and re-run doctor.",
    };
  }

  const status = parseMcpListStatus(result.stdout, MCP_SERVER_NAME);

  if (status === null) {
    return {
      capability: "mcp-archon",
      layer: "L3",
      status: "skipped",
      code: "mcp-list-parse-failed",
      detail: "Failed to parse 'claude mcp list' output — format may have changed.",
      remediation: "Re-run doctor; if this persists, check claude CLI version.",
    };
  }

  if (status === "not-found") {
    return {
      capability: "mcp-archon",
      layer: "L3",
      status: "blocked",
      code: "mcp-archon-not-registered",
      detail: "The archon MCP server is not listed in 'claude mcp list'.",
      remediation:
        "Run 'archon upgrade --apply' to ensure .mcp.json is correct, then restart Claude.",
    };
  }

  if (status === "pending") {
    return {
      capability: "mcp-archon",
      layer: "L3",
      status: "degraded",
      code: "mcp-archon-pending",
      detail:
        "The archon MCP server is registered but shows Pending — first-use approval needed.",
      remediation:
        "Open Claude in your IDE, find the archon MCP server in the settings panel, " +
        "and approve it. This is a one-time manual click that cannot be automated.",
    };
  }

  if (status === "disconnected") {
    return {
      capability: "mcp-archon",
      layer: "L3",
      status: "blocked",
      code: "mcp-archon-disconnected",
      detail: "The archon MCP server is registered but shows as disconnected or errored.",
      remediation:
        "Check that the archon MCP server command is correct in .mcp.json, then restart Claude.",
    };
  }

  // connected
  return {
    capability: "mcp-archon",
    layer: "L3",
    status: "ok",
    code: "mcp-archon-connected",
    detail: "The archon MCP server shows as Connected in 'claude mcp list'.",
    remediation: "",
  };
}

// ---------------------------------------------------------------------------
// L3 probe: hook executable dry-run
// ---------------------------------------------------------------------------

/**
 * Minimal no-op payload for the PreToolUse hook dry-run.
 *
 * The archon-pre-tool.mjs hook reads its payload from stdin and calls
 * evaluatePreToolUse(payload, context). With tool_name="Read", the hook calls
 * isHandoffSafeTool("Read") which returns true (Read is in diagnosticTools),
 * so evaluatePreToolUse returns undefined immediately — no policy enforcement,
 * no writes. The hook process exits 0.
 *
 * We do NOT pass empty/null stdin because payload={} causes hook-policy.mjs
 * line 113 to call `undefined.startsWith("mcp__archon__")` → TypeError crash
 * → exit 1. This Read payload is the verified safe no-op (U2 retirement).
 */
const HOOK_DRY_RUN_PAYLOAD = JSON.stringify({
  tool_name: "Read",
  tool_input: { file_path: "/tmp/archon-hook-dryrun-probe" },
});

/**
 * L3 probe: asserts a shipped hook script is executable and exits 0 on a safe no-op payload.
 *
 * Spawns: node <hookPath> with HOOK_DRY_RUN_PAYLOAD written to stdin.
 * The Read tool payload is a safe diagnostic no-op — no policy action, no writes.
 * Hook absent (ENOENT) → skipped. Exit non-zero → blocked.
 */
export async function probeHookDryRun(
  spawnFn: SpawnFn,
  targetRoot: string
): Promise<ProbeResult> {
  // The pre-tool hook is the primary hook; we use it as the representative.
  const hookRelative = ".claude/hooks/archon-pre-tool.mjs";
  const hookPath = path.join(targetRoot, hookRelative);

  let result: { exitCode: number | null; stdout: string; stderr: string };
  try {
    // Pass the safe Read payload as stdin so the hook can evaluate it and exit 0.
    result = await spawnFn("node", [hookPath], HOOK_DRY_RUN_PAYLOAD);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isAbsent = /ENOENT|not found|no such file/i.test(errMsg);
    if (isAbsent) {
      return {
        capability: "hooks",
        layer: "L3",
        status: "skipped",
        code: "hook-file-absent",
        detail: `Hook file not found: ${hookRelative}`,
        remediation: "Run 'archon upgrade --apply' to restore hook files.",
      };
    }
    return {
      capability: "hooks",
      layer: "L3",
      status: "blocked",
      code: "hook-spawn-error",
      detail: `Failed to spawn hook dry-run: ${errMsg}`,
      remediation: "Ensure node is installed and hook files are executable.",
    };
  }

  if (result.exitCode !== 0) {
    return {
      capability: "hooks",
      layer: "L3",
      status: "blocked",
      code: "hook-nonzero-exit",
      detail: `Hook dry-run exited ${String(result.exitCode)} — hook may be broken.`,
      remediation:
        "Run 'archon upgrade --apply' to restore hook files, or inspect the hook for errors.",
    };
  }

  return {
    capability: "hooks",
    layer: "L3",
    status: "ok",
    code: "hook-dry-run-ok",
    detail: `Hook dry-run exited 0: ${hookRelative}`,
    remediation: "",
  };
}

// ---------------------------------------------------------------------------
// L3 probes: DB preflight (wraps db-preflight.ts)
// ---------------------------------------------------------------------------

/**
 * L3 probe: asserts pgvector extension is enabled in the connected database.
 * Wraps checkPgvector from db-preflight.ts.
 * queryFn must be provided by the caller (doctorCommand wires a real pg client).
 */
export async function probeDbPgvector(queryFn: DbQueryFn): Promise<ProbeResult> {
  let result: { ok: boolean; message: string };
  try {
    result = await checkPgvector(queryFn);
  } catch (err) {
    const msg = scrubPgCredentials(
      err instanceof Error ? err.message : String(err)
    );
    return {
      capability: "doctor",
      layer: "L3",
      status: "skipped",
      code: "db-pgvector-check-error",
      detail: scrubPgCredentials(`pgvector check threw: ${msg}`),
      remediation: scrubPgCredentials(
        "Ensure the DB is reachable and re-run doctor."
      ),
    };
  }

  if (!result.ok) {
    return {
      capability: "doctor",
      layer: "L3",
      status: "blocked",
      code: "db-pgvector-missing",
      detail: scrubPgCredentials(result.message),
      remediation: scrubPgCredentials(
        "Enable the pgvector extension: CREATE EXTENSION IF NOT EXISTS vector; " +
          "or run 'npm run archon:doctor' for guided repair."
      ),
    };
  }

  return {
    capability: "doctor",
    layer: "L3",
    status: "ok",
    code: "db-pgvector-ok",
    detail: "pgvector extension is enabled in the connected database.",
    remediation: "",
  };
}

/**
 * L3 probe: asserts all required migrations have been applied.
 * Wraps checkMigrationsCurrent from db-preflight.ts.
 */
export async function probeDbMigrations(queryFn: DbQueryFn): Promise<ProbeResult> {
  let result: { ok: boolean; message: string };
  try {
    result = await checkMigrationsCurrent(queryFn);
  } catch (err) {
    const msg = scrubPgCredentials(
      err instanceof Error ? err.message : String(err)
    );
    return {
      capability: "doctor",
      layer: "L3",
      status: "skipped",
      code: "db-migrations-check-error",
      detail: scrubPgCredentials(`migrations check threw: ${msg}`),
      remediation: scrubPgCredentials(
        "Ensure the DB is reachable and re-run doctor."
      ),
    };
  }

  if (!result.ok) {
    return {
      capability: "doctor",
      layer: "L3",
      status: "blocked",
      code: "db-migrations-not-current",
      detail: scrubPgCredentials(result.message),
      remediation: scrubPgCredentials(
        "Run 'npm run archon:migrate' to apply all pending migrations."
      ),
    };
  }

  return {
    capability: "doctor",
    layer: "L3",
    status: "ok",
    code: "db-migrations-ok",
    detail: "All required migrations are applied.",
    remediation: "",
  };
}

// ---------------------------------------------------------------------------
// L3 probe: MCP handshake (entrypoint guard functional check)
// ---------------------------------------------------------------------------

/**
 * MCP initialize request in NDJSON (single line) format.
 * Sent to the server via stdin; the server must respond with a jsonrpc result.
 */
const MCP_INIT_REQUEST =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "archon-doctor", version: "0.1.0" },
    },
  }) + "\n";

/**
 * L3 probe: sends an MCP initialize request to the archon MCP server registered
 * in .mcp.json and asserts a jsonrpc response is returned.
 *
 * Closes the blind spot that let the dist entrypoint guard bug ship undetected:
 *   - Silent exit 0 with no output → blocked (mcp-handshake-silent-exit)
 *   - Server errored (non-zero exit, DB unavailable) → blocked (mcp-handshake-server-error)
 *   - jsonrpc response received → ok
 *   - .mcp.json absent / invalid / node missing → skipped
 *
 * Relative args in the archon entry are resolved against targetRoot so the
 * spawn works regardless of the caller's working directory.
 *
 * SECURITY (C8): detail/remediation fields never contain credentials.
 */
export async function probeMcpHandshake(
  spawnFn: SpawnFn,
  targetRoot: string
): Promise<ProbeResult> {
  // Read .mcp.json
  let mcpRaw: string;
  try {
    mcpRaw = await readFile(path.join(targetRoot, ".mcp.json"), "utf8");
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String((err as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      return {
        capability: "mcp-handshake",
        layer: "L3",
        status: "skipped",
        code: "mcp-handshake-no-mcp-json",
        detail: ".mcp.json not found — probe skipped.",
        remediation: "Run 'archon init --apply' to create .mcp.json.",
      };
    }
    return {
      capability: "mcp-handshake",
      layer: "L3",
      status: "skipped",
      code: "mcp-handshake-read-error",
      detail: `Could not read .mcp.json: ${err instanceof Error ? err.message : String(err)}`,
      remediation: "Check .mcp.json is readable and re-run doctor.",
    };
  }

  // Parse and extract archon entry
  let mcpJson: Record<string, unknown>;
  try {
    mcpJson = JSON.parse(mcpRaw) as Record<string, unknown>;
  } catch {
    return {
      capability: "mcp-handshake",
      layer: "L3",
      status: "skipped",
      code: "mcp-handshake-parse-error",
      detail: ".mcp.json could not be parsed as JSON.",
      remediation: "Run 'archon upgrade --apply' to restore .mcp.json.",
    };
  }

  const servers = mcpJson["mcpServers"];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return {
      capability: "mcp-handshake",
      layer: "L3",
      status: "skipped",
      code: "mcp-handshake-no-archon-entry",
      detail: ".mcp.json has no mcpServers object.",
      remediation: "Run 'archon upgrade --apply' to add the archon entry.",
    };
  }

  const archonEntry = (servers as Record<string, unknown>)["archon"];
  if (!archonEntry || typeof archonEntry !== "object" || Array.isArray(archonEntry)) {
    return {
      capability: "mcp-handshake",
      layer: "L3",
      status: "skipped",
      code: "mcp-handshake-no-archon-entry",
      detail: ".mcp.json has no mcpServers.archon entry.",
      remediation: "Run 'archon upgrade --apply' to add the archon entry in .mcp.json.",
    };
  }

  const entry = archonEntry as Record<string, unknown>;
  const command = entry["command"];
  const rawArgs = entry["args"];

  if (typeof command !== "string" || !Array.isArray(rawArgs)) {
    return {
      capability: "mcp-handshake",
      layer: "L3",
      status: "skipped",
      code: "mcp-handshake-invalid-entry",
      detail: "mcpServers.archon has no valid command/args.",
      remediation: "Run 'archon upgrade --apply' to restore .mcp.json.",
    };
  }

  // Resolve relative paths against targetRoot (council C7: args are never shell-interpolated)
  const args: readonly string[] = rawArgs.map((arg: unknown) => {
    const str = typeof arg === "string" ? arg : String(arg);
    if (!path.isAbsolute(str) && (str.startsWith("./") || str.startsWith("../"))) {
      return path.resolve(targetRoot, str);
    }
    return str;
  });

  // Spawn and send the initialize request via stdin (council C7: shell:false via injected spawnFn)
  let result: { exitCode: number | null; stdout: string; stderr: string };
  try {
    result = await spawnFn(command, args, MCP_INIT_REQUEST);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isAbsent = /ENOENT|not found|no such file/i.test(errMsg);
    return {
      capability: "mcp-handshake",
      layer: "L3",
      status: "skipped",
      code: isAbsent ? "mcp-handshake-node-absent" : "mcp-handshake-spawn-error",
      detail: `Failed to spawn MCP server: ${errMsg}`,
      remediation: isAbsent
        ? "Ensure node is installed and on PATH, then re-run doctor."
        : "Check .mcp.json command is correct and re-run doctor.",
    };
  }

  // Full handshake: server responded with a jsonrpc message
  if (result.stdout.includes('"jsonrpc"') && result.stdout.includes('"id"')) {
    return {
      capability: "mcp-handshake",
      layer: "L3",
      status: "ok",
      code: "mcp-handshake-ok",
      detail: "MCP server responded to the initialize handshake.",
      remediation: "",
    };
  }

  // Silent exit 0 — the entrypoint guard did not fire (pre-fix bug)
  if (result.exitCode === 0 && result.stdout.length === 0 && result.stderr.length === 0) {
    return {
      capability: "mcp-handshake",
      layer: "L3",
      status: "blocked",
      code: "mcp-handshake-silent-exit",
      detail:
        "The archon MCP server exited 0 with no output — the entrypoint guard did not fire.",
      remediation:
        "Upgrade the installed archon package: npm install @witchynibbles/archon@latest",
    };
  }

  // Server errored (non-zero exit or output without jsonrpc) — separate from entrypoint bug
  const stderrSnippet = result.stderr.slice(0, 200).replace(/\n/g, " ");
  return {
    capability: "mcp-handshake",
    layer: "L3",
    status: "blocked",
    code: "mcp-handshake-server-error",
    detail: `MCP server did not respond to initialize (exit ${String(result.exitCode)}). ${stderrSnippet}`,
    remediation:
      "Ensure ARCHON_CORE_DATABASE_URL is set and the database is reachable, then re-run doctor.",
  };
}

// ---------------------------------------------------------------------------
// Aggregate runner
// ---------------------------------------------------------------------------

/**
 * Runs all L3 runtime probes.
 * Returns one ProbeResult per probe, never throws.
 *
 * queryFn is optional: if absent, DB probes return skipped.
 * spawnFn: injected for testability (C7).
 */
export async function runL3Probes(
  spawnFn: SpawnFn,
  targetRoot: string,
  queryFn?: DbQueryFn
): Promise<readonly ProbeResult[]> {
  const probePromises: Promise<ProbeResult | ProbeResult[]>[] = [
    probeMcpConnected(spawnFn),
    probeHookDryRun(spawnFn, targetRoot),
    probeMcpHandshake(spawnFn, targetRoot),
  ];

  if (queryFn) {
    probePromises.push(
      probeDbPgvector(queryFn),
      probeDbMigrations(queryFn)
    );
  } else {
    probePromises.push(
      Promise.resolve({
        capability: "doctor",
        layer: "L3" as const,
        status: "skipped" as const,
        code: "db-no-query-fn",
        detail: "DB probe skipped — no query function available.",
        remediation: "Ensure ARCHON_CORE_DATABASE_URL is set and re-run doctor.",
      })
    );
  }

  const settled = await Promise.allSettled(probePromises);
  const results: ProbeResult[] = [];
  const capNames = ["mcp-archon", "hooks", "mcp-handshake", "doctor", "doctor"];

  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      const val = r.value;
      if (Array.isArray(val)) {
        results.push(...(val as ProbeResult[]));
      } else {
        results.push(val as ProbeResult);
      }
    } else {
      const cap = capNames[i] ?? "unknown";
      results.push({
        capability: cap,
        layer: "L3",
        status: "skipped",
        code: `${cap}-unexpected-error`,
        detail: `L3 probe threw unexpectedly: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        remediation: "Investigate and re-run doctor.",
      });
    }
  });

  return results;
}
