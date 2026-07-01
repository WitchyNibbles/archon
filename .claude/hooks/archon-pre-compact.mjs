// PreCompact hook — interactive parachute (handoffConsumerWiring rev 2, P1).
//
// Claude Code fires this hook just before native compaction. For an
// interactively-registered archon session (context-guard.json written by
// archon-session-start.mjs), we ensure a real invocation row exists and commit
// a schema-valid precompact_fallback handoff so continuity survives the
// compaction. The successor (same, compacted session) can re-read the handoff.
//
// All DB work is delegated to runPrecompactHandoff (interactive-parachute.ts),
// which drives the REAL HandoffController (schema validation + commit).
// Best-effort: never throws, never blocks compaction.
//
// Replaces a prior implementation that was dead four ways: it imported a
// non-existent `src/db.ts`, imported `PostgresStore` (the class is
// `AgentRuntimeStore`), built a packet that failed `HandoffPacketV1Schema`, and
// bailed in `getInvocationById` on the synthetic interactive invocationId.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const guardPath = path.join(repoRoot, ".archon", "work", "context-guard.json");

// Cheap pre-check: only open a DB connection when there is a registered
// interactive invocation that has not already committed a handoff.
function readGuard() {
  try {
    const parsed = JSON.parse(readFileSync(guardPath, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.invocationId === "string" &&
      parsed.invocationId.trim().length > 0
    ) {
      return parsed;
    }
  } catch {
    // absent / unreadable — no registered interactive session
  }
  return undefined;
}

async function main() {
  const guard = readGuard();
  if (!guard) return; // no registered interactive session
  if (guard.state === "handoff_written") return; // already handed off (idempotent)

  try {
    const { withClient } = await import(path.join(repoRoot, "src", "admin", "db.ts"));
    const { AgentRuntimeStore } = await import(
      path.join(repoRoot, "src", "store", "agent-runtime-store.ts")
    );
    const { runPrecompactHandoff, upsertInteractiveInvocationRow } = await import(
      path.join(repoRoot, "src", "runtime", "interactive-parachute.ts")
    );

    await withClient(async (client) => {
      const agentStore = new AgentRuntimeStore(client);

      // AgentRuntimeStore already implements HandoffStoreLike; the composite
      // adds upsertInteractiveInvocation (create-on-demand, idempotent) so the
      // synthetic interactive invocationId is backed by a real row before the
      // handoff commits. Defaults mirror AgentRuntimeStore.createInvocation.
      const store = {
        createHandoff: (d) => agentStore.createHandoff(d),
        getLatestUnconsumedHandoff: (r, t) => agentStore.getLatestUnconsumedHandoff(r, t),
        markHandoffConsumed: (h, t) => agentStore.markHandoffConsumed(h, t),
        hasCommittedHandoff: (i) => agentStore.hasCommittedHandoff(i),
        updateAgentInvocationStatus: (i, s, m) => agentStore.updateAgentInvocationStatus(i, s, m),
        // Idempotent create-on-demand (backstop for a DB-unavailable session
        // start). Delegates to the shared helper so the row defaults live in ONE
        // place (interactive-parachute.ts) and cannot drift between hooks.
        upsertInteractiveInvocation: async (data) => {
          const res = await upsertInteractiveInvocationRow(agentStore, {
            id: data.id,
            runId: data.runId,
            taskId: data.taskId,
            role: data.role,
            startedAt: data.startedAt
          });
          if (res.alreadyExisted) {
            process.stderr.write(
              `[archon-pre-compact] invocation ${data.id} already exists (idempotent)\n`
            );
          } else if (res.structuralError !== undefined) {
            // Structural failure (FK/schema): the handoff commit will then fail
            // to find the invocation, so surface it loudly — the silent loss of
            // session protection must be diagnosable.
            process.stderr.write(
              `[archon-pre-compact][WARN] upsertInteractiveInvocation structural failure (handoff will be lost): ${res.structuralError}\n`
            );
          }
        }
      };

      const result = await runPrecompactHandoff({ store, contextGuardPath: guardPath });
      if (result.committed) {
        process.stderr.write(
          `[archon-pre-compact] precompact_fallback handoff committed for ${result.invocationId}\n`
        );
      }
    });
  } catch (err) {
    // Best-effort: log but never block compaction.
    process.stderr.write(`[archon-pre-compact] error during parachute handoff: ${String(err)}\n`);
  }
}

await main();
