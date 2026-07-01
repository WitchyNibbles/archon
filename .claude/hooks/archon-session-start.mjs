import { readActiveTaskContext, readHookPayload } from "./hook-utils.mjs";
import { evaluateSessionStart } from "./hook-policy.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const payload = await readHookPayload();
const context = await readActiveTaskContext(
  typeof payload?.cwd === "string" && payload.cwd.trim().length > 0
    ? { repoRoot: payload.cwd }
    : {}
);
const existingResponse = evaluateSessionStart(payload, context);

// Interactive parachute — handoffConsumerWiring rev 2, D4.
// Register an interactive session ONLY when an archon task is genuinely active
// (council C8 replacement: gated on active task, not merely an env var).
// Writes context-guard.json so archon-pre-compact.mjs has the invocation anchor
// (runId/taskId/role) it needs to commit a handoff before native compaction.
// Best-effort: every error is swallowed so session start is never blocked.
//
// RESTRUCTURED: stdout write is deferred to the end so the consume block (A1)
// can merge its continuation text into a single JSON output.
let runId;
let newInvocationId;
let sessionRole;
let registeredAt;
const guardPath = path.join(context.repoRoot, ".archon", "work", "context-guard.json");

if (context.activeTaskId) {
  try {
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
      newInvocationId = `inv_interactive_${randomUUID()}`;
      mkdirSync(path.dirname(guardPath), { recursive: true });
      // SECURITY (P1 security gate, HIGH-1): ARCHON_ROLE is untrusted (any
      // subagent/MCP with env access can set it) and `role` flows into the
      // TRUSTED identity section of successor continuation prompts. Constrain it
      // to a strict injection-proof token; anything else → "interactive".
      // (runPrecompactHandoff re-validates via normalizeRole — this is
      // defense-in-depth at the write boundary.)
      const rawRole = typeof process.env.ARCHON_ROLE === "string" ? process.env.ARCHON_ROLE.trim() : "";
      sessionRole = /^[a-z][a-z0-9_-]{0,39}$/.test(rawRole) ? rawRole : "interactive";
      registeredAt = new Date().toISOString();
      writeFileSync(guardPath, JSON.stringify({
        invocationId: newInvocationId, runId, taskId: context.activeTaskId,
        role: sessionRole,
        surface: "interactive", state: "registered",
        registeredAt
      }), "utf-8");
      process.stderr.write(`[archon-session-start] interactive parachute registered: ${newInvocationId} (task: ${context.activeTaskId})\n`);
    }
  } catch (err) {
    process.stderr.write(`[archon-session-start] interactive registration error: ${String(err)}\n`);
  }
}

// A1 — consume-on-next-start.
//
// If a precompact_fallback (or other) handoff was committed by the previous
// session's PreCompact hook, consume it now and inject the continuation prompt
// as additionalContext for this session.
//
// Security (C1): normalizeRole applied inside consumeInteractiveHandoff to the
// role field read from context-guard.json (attacker-writable). The role does not
// flow from the guard into any DB call in the consume path.
//
// A3: If a daemon lease (owner=daemon) is held for the run, skip — the daemon
// owns this consume cycle.
//
// Best-effort: any error is swallowed so session start is never blocked.
let continuationText;
if (context.activeTaskId && runId && newInvocationId) {
  try {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDir, "..", "..");

    const { withClient } = await import(path.join(repoRoot, "src", "admin", "db.ts"));
    const { AgentRuntimeStore } = await import(
      path.join(repoRoot, "src", "store", "agent-runtime-store.ts")
    );
    const { consumeInteractiveHandoff } = await import(
      path.join(repoRoot, "src", "runtime", "handoff-consumer.ts")
    );
    const { upsertInteractiveInvocationRow } = await import(
      path.join(repoRoot, "src", "runtime", "interactive-parachute.ts")
    );
    const { makeFileLockLeaseStore } = await import(
      path.join(repoRoot, "src", "runtime", "respawn-lease.ts")
    );

    const daemonLeaseDir = path.join(repoRoot, ".archon", "work", "daemon");
    const leaseStore = makeFileLockLeaseStore({ lockDir: daemonLeaseDir });

    await withClient(async (client) => {
      const agentStore = new AgentRuntimeStore(client);

      // EAGER invocation-row creation (interactiveInvocationRegister fix).
      //
      // archon-session-start.mjs mints a synthetic invocationId but historically
      // wrote ONLY context-guard.json — no agent_invocations row. When the
      // context guard later demands a handoff mid-session, the MCP
      // archon_handoff_commit tool (and context sampling) resolve
      // from_invocation_id against agent_invocations (NOT NULL FK) and
      // FK-violate: the guard demands a handoff that can never be committed.
      //
      // Create the row now so it exists for the whole session lifetime. The
      // PreCompact parachute keeps its own idempotent upsert as a backstop for
      // the case where the DB was unreachable at session start.
      const upsert = await upsertInteractiveInvocationRow(agentStore, {
        id: newInvocationId,
        runId,
        taskId: context.activeTaskId,
        role: sessionRole ?? "interactive",
        startedAt: registeredAt
      });
      if (upsert.created) {
        process.stderr.write(
          `[archon-session-start] interactive invocation row created: ${newInvocationId}\n`
        );
      } else if (upsert.structuralError !== undefined) {
        process.stderr.write(
          `[archon-session-start][WARN] interactive invocation row NOT created (guard-demanded handoffs will fail): ${upsert.structuralError}\n`
        );
      }

      // Composite store: exposes only getLatestUnconsumedHandoff + markHandoffConsumed
      // to the consume path (plus the other HandoffStoreLike stubs required by
      // HandoffController for type-safety in buildContinuationPrompt).
      const store = {
        getLatestUnconsumedHandoff: (r, t) => agentStore.getLatestUnconsumedHandoff(r, t),
        markHandoffConsumed: (h, i) => agentStore.markHandoffConsumed(h, i),
        // Unused stubs — not called by consumeInteractiveHandoff:
        createHandoff: () => Promise.reject(new Error("not used in consume path")),
        hasCommittedHandoff: () => Promise.resolve(false),
        updateAgentInvocationStatus: () => Promise.resolve()
      };

      const result = await consumeInteractiveHandoff({
        store,
        leaseStore,
        runId,
        taskId: context.activeTaskId,
        contextGuardPath: guardPath
      });

      if (result.consumed) {
        continuationText = result.continuationText;
        process.stderr.write(
          `[archon-session-start] handoff ${result.handoffId} consumed — continuation injected\n`
        );
      } else {
        process.stderr.write(
          `[archon-session-start] consume-on-start: ${result.skipped}\n`
        );
      }
    });
  } catch (err) {
    // Best-effort: log but never block session start.
    process.stderr.write(`[archon-session-start] consume-on-start error: ${String(err)}\n`);
  }
}

// Write a single merged response to stdout.
// Merges: task/scope context from evaluateSessionStart + handoff continuation.
// Only one write is permitted (Claude Code parses a single JSON from stdout).
const contextParts = [];
if (existingResponse?.additionalContext) {
  contextParts.push(existingResponse.additionalContext);
}
if (continuationText) {
  contextParts.push(`Handoff continuation from prior session:\n\n${continuationText}`);
}

if (contextParts.length > 0) {
  process.stdout.write(JSON.stringify({ additionalContext: contextParts.join("\n\n") }));
}
