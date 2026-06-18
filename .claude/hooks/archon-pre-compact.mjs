// PreCompact hook — Safety parachute for context handoff.
//
// Claude Code fires this hook just before native compaction triggers.
// If an agent invocation is active and no handoff has been committed,
// we write a minimal precompact_fallback handoff packet so the
// successor agent has some continuation context.
//
// Design: TDD §14.4
//   - Reads active invocation from .archon/work/context-guard.json
//   - If no handoff exists, prepares + commits a precompact_fallback handoff
//   - Archives transcript path if present in the guard payload
//   - Best-effort: never throws — compaction must not be blocked

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readContextGuard() {
  try {
    const guardPath = path.join(repoRoot, ".archon", "work", "context-guard.json");
    const raw = readFileSync(guardPath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.invocationId === "string" &&
      parsed.invocationId.trim().length > 0
    ) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function writeContextGuard(invocationId, newState) {
  try {
    const guardPath = path.join(repoRoot, ".archon", "work", "context-guard.json");
    writeFileSync(
      guardPath,
      JSON.stringify({ invocationId, state: newState, updatedAt: new Date().toISOString() }),
      "utf-8"
    );
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const guard = readContextGuard();
  if (!guard) {
    // No active managed invocation — nothing to do.
    return;
  }

  const invocationId = String(guard.invocationId);
  const existingState = typeof guard.state === "string" ? guard.state : "normal";

  // If the agent already committed a handoff, nothing to add.
  if (existingState === "handoff_written") {
    return;
  }

  // Dynamically import the store so this hook only loads it when needed.
  // The import path is relative to the repo root.
  let store;
  let client;
  try {
    const { withClient } = await import(path.join(repoRoot, "src", "db.ts"));
    const { PostgresStore } = await import(path.join(repoRoot, "src", "store", "agent-runtime-store.ts"));

    await withClient(async (dbClient) => {
      client = dbClient;
      store = new PostgresStore(dbClient);

      const alreadyCommitted = await store.hasCommittedHandoff(invocationId);
      if (alreadyCommitted) {
        return;
      }

      // Look up the invocation to get runId, taskId, role.
      const invocation = await store.getInvocationById(invocationId);
      if (!invocation) {
        return;
      }

      const runId = invocation.runId;
      const taskId = invocation.taskId;
      const fromRole = invocation.role;

      // Prepare the handoff
      const { HandoffController } = await import(path.join(repoRoot, "src", "runtime", "handoff-controller.ts"));
      const controller = new HandoffController(store);

      const prepareResult = await controller.prepare({
        invocationId,
        runId,
        taskId,
        fromRole,
        toRole: fromRole, // continuation will be picked up by same role
        reason: "precompact_fallback",
        contextUsedPct: typeof guard.contextPct === "number" ? guard.contextPct : undefined
      });

      // Commit a minimal synthetic packet
      const { HandoffPacketV1Schema } = await import(path.join(repoRoot, "src", "domain", "handoff-schemas.ts"));
      const syntheticPacket = {
        handoffId: prepareResult.template.handoffId,
        invocationId,
        runId,
        taskId,
        fromRole,
        toRole: fromRole,
        reason: "precompact_fallback",
        status: "precompact_fallback",
        summary: "Precompact fallback handoff: context compaction triggered before agent committed a handoff. " +
          "Successor must re-read task context from .archon/ACTIVE and task packet.",
        nextSteps: ["Re-read .archon/ACTIVE and the task packet.", "Resume from the last known good state."],
        artifacts: [],
        metadata: {
          triggeredBy: "precompact_hook",
          guardState: existingState,
          transcriptPath: typeof guard.transcriptPath === "string" ? guard.transcriptPath : undefined
        }
      };

      const parsed = HandoffPacketV1Schema.safeParse(syntheticPacket);
      if (!parsed.success) {
        // Cannot produce a valid packet — log and bail
        process.stderr.write(
          `[archon-pre-compact] packet validation failed: ${parsed.error.message}\n`
        );
        return;
      }

      await controller.commit({ invocationId, rawPacket: syntheticPacket });

      // Update context-guard to reflect handoff_written
      writeContextGuard(invocationId, "handoff_written");

      process.stderr.write(
        `[archon-pre-compact] precompact_fallback handoff committed for invocation ${invocationId}\n`
      );
    });
  } catch (err) {
    // Best-effort: log but never block compaction
    process.stderr.write(`[archon-pre-compact] error during fallback handoff: ${String(err)}\n`);
  }
}

await main();
