import { readActiveTaskContext, readHookPayload } from "./hook-utils.mjs";
import { evaluateSessionStart } from "./hook-policy.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const payload = await readHookPayload();
const context = await readActiveTaskContext(
  typeof payload?.cwd === "string" && payload.cwd.trim().length > 0
    ? { repoRoot: payload.cwd }
    : {}
);
const response = evaluateSessionStart(payload, context);

if (response) {
  process.stdout.write(JSON.stringify(response));
}

// Interactive parachute — handoffConsumerWiring rev 2, D4.
// Register an interactive session ONLY when an archon task is genuinely active
// (council C8 replacement: gated on active task, not merely an env var).
// Writes context-guard.json so archon-pre-compact.mjs has the invocation anchor
// (runId/taskId/role) it needs to commit a handoff before native compaction.
// Best-effort: every error is swallowed so session start is never blocked.
if (context.activeTaskId) {
  try {
    let runId;
    try {
      const activePath = path.join(context.repoRoot, ".archon", "ACTIVE");
      const content = readFileSync(activePath, "utf8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith("run_id=")) {
          const candidate = line.slice("run_id=".length).trim();
          if (candidate.length > 0) { runId = candidate; }
          break;
        }
      }
    } catch { /* ACTIVE absent — skip */ }

    if (runId !== undefined) {
      const invocationId = `inv_interactive_${randomUUID()}`;
      const guardPath = path.join(context.repoRoot, ".archon", "work", "context-guard.json");
      mkdirSync(path.dirname(guardPath), { recursive: true });
      writeFileSync(guardPath, JSON.stringify({
        invocationId, runId, taskId: context.activeTaskId,
        role: (typeof process.env.ARCHON_ROLE === "string" && process.env.ARCHON_ROLE.trim().length > 0)
          ? process.env.ARCHON_ROLE.trim() : "interactive",
        surface: "interactive", state: "registered",
        registeredAt: new Date().toISOString()
      }), "utf-8");
      process.stderr.write(`[archon-session-start] interactive parachute registered: ${invocationId} (task: ${context.activeTaskId})\n`);
    }
  } catch (err) {
    process.stderr.write(`[archon-session-start] interactive registration error: ${String(err)}\n`);
  }
}
