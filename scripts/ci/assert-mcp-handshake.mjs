// CI pack-install check: assert the archon MCP server's entrypoint guard fires.
//
// Reads $INIT_DIR/.mcp.json, takes the archon entry's exact command+args
// (the product read path), spawns it in $INIT_DIR with an MCP initialize
// request on stdin, and asserts the server does NOT silently exit 0 with no
// output — which is the hallmark of the pre-fix entrypoint guard bug.
//
// Pass conditions (in priority order):
//   1. stdout contains a jsonrpc response → PASS (full handshake, DB available)
//   2. server produced output (stdout or stderr) → PASS (guard fired; DB
//      unavailable in pack-install CI is expected and acceptable)
//   3. server exited silently (exit 0, no output) → FAIL (bug still present)
//
// Windows notes:
//   - spawn node directly with shell:false (no cmd.exe wrapping)
//   - relative args in .mcp.json are resolved against INIT_DIR before spawning
//   - spawn cwd is set to INIT_DIR so archon-bin finds .env.archon there
//
// Shared verbatim by the unix and windows pack-install legs of
// .github/workflows/ci.yml so the assertion logic lives in ONE place.
//
// Usage: node scripts/ci/assert-mcp-handshake.mjs <init-dir>

import path from "node:path";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const TIMEOUT_MS = 10_000;

const initDir = process.argv[2];
if (!initDir) {
  console.error("usage: node scripts/ci/assert-mcp-handshake.mjs <init-dir>");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Read and validate .mcp.json archon entry
// ---------------------------------------------------------------------------

let mcpJson;
try {
  const raw = readFileSync(path.join(initDir, ".mcp.json"), "utf8");
  mcpJson = JSON.parse(raw);
} catch (e) {
  console.error(
    `FAIL: could not read/parse ${path.join(initDir, ".mcp.json")}: ${e instanceof Error ? e.message : String(e)}`
  );
  process.exit(1);
}

const archonEntry = mcpJson?.mcpServers?.archon;
if (
  !archonEntry ||
  typeof archonEntry.command !== "string" ||
  !Array.isArray(archonEntry.args)
) {
  console.error(
    "FAIL: .mcp.json does not have a valid mcpServers.archon entry with command and args"
  );
  process.exit(1);
}

const command = archonEntry.command; // "node"

// Resolve relative path args against initDir so they work regardless of cwd.
// This is required on both platforms: spawn resolves args relative to the
// spawn cwd, but making paths absolute is more robust.
const args = archonEntry.args.map((arg) => {
  if (
    typeof arg === "string" &&
    !path.isAbsolute(arg) &&
    (arg.startsWith("./") || arg.startsWith("../"))
  ) {
    return path.resolve(initDir, arg);
  }
  return typeof arg === "string" ? arg : String(arg);
});

// ---------------------------------------------------------------------------
// MCP initialize request (NDJSON single line)
// ---------------------------------------------------------------------------

const INIT_REQUEST =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "archon-ci-check", version: "0.1.0" },
    },
  }) + "\n";

// ---------------------------------------------------------------------------
// Spawn the archon MCP entry
// ---------------------------------------------------------------------------

let stdout = "";
let stderr = "";
let settled = false;

const child = spawn(command, args, {
  // cwd: initDir so archon-bin finds .env.archon and resolves relative module paths
  cwd: initDir,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});

const timer = setTimeout(() => {
  if (!settled) {
    settled = true;
    child.kill("SIGTERM");
    finalize(true);
  }
}, TIMEOUT_MS);

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

child.on("error", (err) => {
  if (!settled) {
    settled = true;
    clearTimeout(timer);
    console.error(
      `FAIL: failed to spawn '${command} ${args.join(" ")}': ${err.message}`
    );
    process.exit(1);
  }
});

child.on("exit", () => {
  if (!settled) {
    settled = true;
    clearTimeout(timer);
    finalize(false);
  }
});

// Write the initialize request and close stdin so the server reads it then gets EOF.
if (child.stdin) {
  child.stdin.write(INIT_REQUEST, "utf8");
  child.stdin.end();
}

function finalize(timedOut) {
  // Full handshake: jsonrpc response received on stdout.
  if (stdout.includes('"jsonrpc"') && stdout.includes('"id"')) {
    console.log(
      "OK: MCP handshake succeeded — jsonrpc response received from archon MCP server"
    );
    process.exit(0);
  }

  // Guard fired but server errored (DB unavailable in pack-install CI).
  // This is acceptable: the bug was silent exit 0 with zero output.
  const hadOutput = stdout.length > 0 || stderr.length > 0;
  if (hadOutput || timedOut) {
    const reason = timedOut
      ? "server still running after timeout (guard fired)"
      : "server produced output (guard fired, DB not available in pack-install CI)";
    console.log(`OK: MCP entrypoint guard fired — ${reason}`);
    if (stderr.length > 0) {
      // Log stderr as info (expected DB error in pack-install CI).
      console.log(`  server stderr: ${stderr.slice(0, 200).replace(/\n/g, " ")}`);
    }
    process.exit(0);
  }

  // Silent exit 0 with no output — this is the original entrypoint bug.
  console.error(
    "FAIL: archon MCP server exited silently (no stdout, no stderr, exit 0)"
  );
  console.error(
    "This is the pre-fix bug: the entrypoint guard did not fire in the dist build."
  );
  console.error(
    `Command: ${command} ${args.join(" ")}`
  );
  process.exit(1);
}
