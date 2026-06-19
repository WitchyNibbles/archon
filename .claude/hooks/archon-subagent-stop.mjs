// SubagentStop hook — Subagent result capture safety net (R3).
//
// Claude Code fires this hook when an Agent-tool subagent finishes. We capture
// the child's transcript path and status so subagent work is auditable even when
// the parent never called archon_subtask_result (§14.1, FR-16).
//
// Two effects, both best-effort and non-blocking:
//   1. Always append the stop event to .archon/work/subagent-stops.jsonl (audit
//      trail; works without a database).
//   2. If the database is reachable and exactly one pending, un-resulted subtask
//      exists for the active task, attach the transcript as a fallback result.
//
// Never throws — a failing hook must not break subagent completion.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { buildSubagentStopRecord, selectSubtaskForStop } from "./hook-policy.mjs";
import { readActiveTaskContext } from "./hook-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fallbackRoot = path.resolve(scriptDir, "..", "..");

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function resolveBaseDir(payload) {
  const fromWorkspace =
    payload && typeof payload === "object" && payload.workspace && typeof payload.workspace === "object"
      ? payload.workspace.current_dir
      : undefined;
  return (
    (typeof fromWorkspace === "string" && fromWorkspace.trim().length > 0 && fromWorkspace) ||
    (typeof payload?.cwd === "string" && payload.cwd.trim().length > 0 && payload.cwd) ||
    fallbackRoot
  );
}

function appendAuditRecord(baseDir, record) {
  try {
    const dir = path.join(baseDir, ".archon", "work");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "subagent-stops.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // best-effort
  }
}

async function attachFallbackResult(baseDir, record) {
  try {
    const context = await readActiveTaskContext({ repoRoot: baseDir });
    const taskId = context?.activeTaskId;
    if (!taskId || !context.runtimeConnected) {
      return;
    }
    const { withClient } = await import(path.join(fallbackRoot, "src", "db.ts"));
    const { PostgresStore } = await import(
      path.join(fallbackRoot, "src", "store", "agent-runtime-store.ts")
    );
    await withClient(async (dbClient) => {
      const store = new PostgresStore(dbClient);
      const subtasks = await store.listSubtasksForTask(taskId);
      const subtaskId = selectSubtaskForStop(subtasks);
      if (!subtaskId) {
        return;
      }
      await store.updateSubtaskResult(
        subtaskId,
        {
          schema_version: 1,
          status: "transcript_captured",
          summary:
            "SubagentStop fallback: subagent ended without an explicit result packet. " +
            "Transcript captured by the runtime; parent must synthesize.",
          transcript_path: record.transcriptPath,
          captured_by: "subagent_stop_hook",
          stopped_at: record.stoppedAt
        },
        "transcript_captured"
      );
    });
  } catch (err) {
    process.stderr.write(`[archon-subagent-stop] fallback result skipped: ${String(err)}\n`);
  }
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    payload = {};
  }

  const baseDir = resolveBaseDir(payload);
  const record = buildSubagentStopRecord(payload);
  appendAuditRecord(baseDir, record);
  await attachFallbackResult(baseDir, record);
}

await main();
