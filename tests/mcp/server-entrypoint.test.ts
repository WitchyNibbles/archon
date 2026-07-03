/**
 * MCP server entrypoint guard regression tests.
 *
 * Tests the isMainModule guard introduced to replace the fragile
 * `process.argv[1].endsWith("src/mcp/server.ts")` pattern.
 *
 * Failure modes this catches:
 *   - Guard doesn't fire when run as dist/*.js (the original bug).
 *   - Guard doesn't fire when run with --experimental-strip-types src/*.ts.
 *   - Silent exit 0 with no output — the hallmark of the original bug.
 *
 * Grafana server test uses a full jsonrpc handshake (server starts env-free).
 * Archon server test proves non-silent behaviour (DB unavailable in test env
 * causes a fast ECONNREFUSED, which produces stderr + non-zero exit, proving
 * the guard fired rather than silently exiting 0).
 *
 * No dist/ build inside unit tests — the CI pack-install leg covers that via
 * scripts/ci/assert-mcp-handshake.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../../src/shared/is-main-module.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * MCP initialize request (NDJSON single line) as required by the MCP protocol.
 * The server must respond with a jsonrpc result for id 1.
 */
const INIT_REQUEST =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "archon-test", version: "0.0.1" },
    },
  }) + "\n";

// ---------------------------------------------------------------------------
// Spawn helper — shell:false, array args, collects stdout/stderr, timeout-safe
// ---------------------------------------------------------------------------

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function spawnCollect(
  cmd: string,
  args: readonly string[],
  opts: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    stdinData?: string | undefined;
    timeoutMs?: number | undefined;
  } = {}
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            if (!settled) {
              settled = true;
              child.kill("SIGTERM");
              resolve({ exitCode: null, stdout, stderr, timedOut: true });
            }
          }, opts.timeoutMs)
        : null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        if (timer !== null) clearTimeout(timer);
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr, timedOut: false });
      }
    });

    if (child.stdin) {
      if (opts.stdinData !== undefined) {
        child.stdin.write(opts.stdinData, "utf8");
      }
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// isMainModule unit tests
// ---------------------------------------------------------------------------

test("isMainModule: returns false when process.argv[1] is absent", () => {
  const orig = process.argv[1];
  try {
    // Temporarily clear argv[1] to test the falsy guard
    (process.argv as string[])[1] = "";
    assert.equal(isMainModule("file:///some/path.ts"), false);
  } finally {
    (process.argv as string[])[1] = orig;
  }
});

test("isMainModule: returns false for invalid importMetaUrl", () => {
  // Non-file:// URL → fileURLToPath throws → caught → false
  assert.equal(isMainModule("not-a-url"), false);
  assert.equal(isMainModule("https://example.com/foo.ts"), false);
});

test("isMainModule: returns true when argv[1] is this test file", () => {
  const thisFile = fileURLToPath(import.meta.url);
  const orig = process.argv[1];
  try {
    (process.argv as string[])[1] = thisFile;
    assert.equal(isMainModule(import.meta.url), true);
  } finally {
    (process.argv as string[])[1] = orig;
  }
});

test("isMainModule: returns false when argv[1] is a different file", () => {
  const orig = process.argv[1];
  try {
    (process.argv as string[])[1] = "/some/completely/different/file.ts";
    assert.equal(isMainModule(import.meta.url), false);
  } finally {
    (process.argv as string[])[1] = orig;
  }
});

// ---------------------------------------------------------------------------
// Grafana MCP server entrypoint test (full jsonrpc handshake, no DB/env needed)
// ---------------------------------------------------------------------------

test(
  "grafana MCP server: isMainModule guard fires and server responds to initialize",
  { timeout: 10_000 },
  async () => {
    const result = await spawnCollect(
      "node",
      [
        "--experimental-strip-types",
        path.join(REPO_ROOT, "src/grafana/mcp-server.ts"),
      ],
      {
        cwd: REPO_ROOT,
        stdinData: INIT_REQUEST,
        // 6-second timeout: the server sends the response then exits on stdin
        // EOF; give generous headroom for CI environments.
        timeoutMs: 6_000,
      }
    );

    // If the guard did NOT fire (original bug): silent exit 0, stdout empty.
    assert.notEqual(
      result.stdout,
      "",
      `Grafana MCP server produced no stdout — entrypoint guard did not fire.\n` +
        `stderr: ${result.stderr}\nexitCode: ${String(result.exitCode)}`
    );

    // Verify a proper jsonrpc response is present on stdout.
    assert.match(
      result.stdout,
      /"jsonrpc"\s*:\s*"2\.0"/,
      `stdout must contain a jsonrpc response; got: ${result.stdout}`
    );
    assert.match(
      result.stdout,
      /"id"\s*:\s*1/,
      `jsonrpc response must carry id:1; got: ${result.stdout}`
    );
    assert.match(
      result.stdout,
      /"result"/,
      `jsonrpc response must have a result field; got: ${result.stdout}`
    );
  }
);

// ---------------------------------------------------------------------------
// Archon MCP server entrypoint test (no DB in test env — proves non-silent exit)
// ---------------------------------------------------------------------------

test(
  "archon MCP server: isMainModule guard fires (non-silent exit when DB unavailable)",
  { timeout: 10_000 },
  async () => {
    // Strip ARCHON_CORE_DATABASE_URL so the DB connection fails immediately
    // (ECONNREFUSED), producing stderr output and a non-zero exit code.
    // This proves the guard fired — the original bug was silent exit 0.
    const env = { ...process.env };
    delete env["ARCHON_CORE_DATABASE_URL"];

    const result = await spawnCollect(
      "node",
      [
        "--experimental-strip-types",
        path.join(REPO_ROOT, "src/mcp/server.ts"),
      ],
      {
        cwd: REPO_ROOT,
        env,
        stdinData: INIT_REQUEST,
        timeoutMs: 8_000,
      }
    );

    // The original bug: guard does not fire → silent exit 0, no output at all.
    // After the fix: guard fires → DB connection attempted → fails with stderr
    // output and non-zero exit (or responds with jsonrpc if DB is available).
    const hadOutput = result.stdout.length > 0 || result.stderr.length > 0;
    const hadNonZeroExit = result.exitCode !== null && result.exitCode !== 0;

    assert.ok(
      hadOutput || hadNonZeroExit,
      `Archon MCP server must NOT silently exit 0 — entrypoint guard must fire.\n` +
        `stdout='${result.stdout}' stderr='${result.stderr}' exit=${String(result.exitCode)} timedOut=${String(result.timedOut)}`
    );
  }
);
