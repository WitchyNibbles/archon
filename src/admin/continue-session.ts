// continue-session — one-command continuation path for interactive sessions
// that hit the context-guard threshold (handoff_required / hard_stop).
//
// Usage:
//   npx archon continue-session [--run-id <id>] [--task-id <id>] [--exec]
//
// What it does:
//   1. Reads .archon/ACTIVE (or --run-id / --task-id flags) to locate the task.
//   2. Fetches the latest uncommitted handoff from the DB.
//   3. Builds a sanitized continuation prompt via HandoffController.buildContinuationPrompt.
//   4. Prints a ready-to-run claude invocation that feeds the prompt via --print.
//   5. With --exec: spawns claude directly.
//
// Operator note — two continuation paths are available:
//   (a) Supervised: scripts/archon-interactive-supervisor.sh watches for handoff
//       completion and respawns claude automatically. Recommended for long-running
//       work where the context threshold may be hit multiple times.
//   (b) Manual: when a handoff is required, the current session commits a handoff
//       via archon_handoff_commit (now permitted by the hook), then the operator
//       runs `npx archon continue-session` in a new terminal to start the
//       successor session. This does not require the supervisor script.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { HandoffController } from "../runtime/handoff-controller.ts";
import { AgentRuntimeStore } from "../store/agent-runtime-store.ts";
import { withClient } from "./db.ts";

// ---------------------------------------------------------------------------
// Pure helpers — testable without DB or file I/O
// ---------------------------------------------------------------------------

/**
 * Parse .archon/ACTIVE content to extract task_id and run_id.
 * Returns undefined for either field that is absent.
 */
export function parseActiveFile(content: string): { taskId?: string; runId?: string } {
  const result: { taskId?: string; runId?: string } = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("task_id=")) {
      const val = line.slice("task_id=".length).trim();
      if (val) result.taskId = val;
    }
    if (line.startsWith("run_id=")) {
      const val = line.slice("run_id=".length).trim();
      if (val) result.runId = val;
    }
  }
  return result;
}

/**
 * Build the claude CLI invocation string for a continuation prompt.
 * Pure: does NOT spawn. The caller decides whether to print or exec.
 * The prompt is shell-escaped using single-quote escaping.
 */
export function buildClaudeInvocation(continuationPrompt: string): string {
  // Escape single quotes so the prompt is safe inside a shell single-quoted string.
  const escaped = continuationPrompt.replace(/'/g, "'\\''");
  return `claude --print '${escaped}'`;
}

// ---------------------------------------------------------------------------
// continueSessionCommand — wired entry point
// ---------------------------------------------------------------------------

export async function continueSessionCommand(args: readonly string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write([
      "npx archon continue-session [--run-id <id>] [--task-id <id>] [--exec]",
      "",
      "Start a successor claude session after the previous session hit the context threshold.",
      "",
      "Options:",
      "  --run-id <id>   Runtime run id (default: read from .archon/ACTIVE)",
      "  --task-id <id>  Task id (default: read from .archon/ACTIVE)",
      "  --exec          Spawn claude directly instead of printing the invocation",
      "",
      "Two continuation paths are available:",
      "  (a) Supervised: scripts/archon-interactive-supervisor.sh watches for",
      "      handoff completion and respawns claude automatically.",
      "  (b) Manual (this command): after archon_handoff_commit is called in the",
      "      current session, run `npx archon continue-session` in a new terminal.",
      "",
    ].join("\n"));
    return;
  }

  const exec = args.includes("--exec");

  // Resolve run + task from flags or ACTIVE file.
  let runId = resolveFlag(args, "--run-id");
  let taskId = resolveFlag(args, "--task-id");

  if (!runId || !taskId) {
    const activeContent = await readFileIfExists(path.join(process.cwd(), ".archon", "ACTIVE"));
    if (activeContent) {
      const parsed = parseActiveFile(activeContent);
      if (!runId && parsed.runId) runId = parsed.runId;
      if (!taskId && parsed.taskId) taskId = parsed.taskId;
    }
  }

  if (!taskId) {
    process.stdout.write([
      "continue-session: no active task found.",
      "Either point .archon/ACTIVE at an active task, or pass --task-id <id> --run-id <id>.",
      "If no handoff has been committed yet, call archon_handoff_commit first.",
      "",
    ].join("\n"));
    process.exitCode = 1;
    return;
  }

  // Try DB path. If DB is unavailable, fall back to manual instructions.
  try {
    await withClient(async (client) => {
      const store = new AgentRuntimeStore(client);

      if (!runId) {
        process.stdout.write([
          `continue-session: no run id found for task ${taskId}.`,
          "Pass --run-id <id> explicitly, or add run_id=<id> to .archon/ACTIVE.",
          "",
        ].join("\n"));
        process.exitCode = 1;
        return;
      }

      const controller = new HandoffController(store);
      const handoff = await controller.getLatestForTask(runId, taskId!);

      if (!handoff) {
        process.stdout.write([
          `continue-session: no uncommitted handoff found for task ${taskId} in run ${runId}.`,
          "If the agent has not committed a handoff yet, call archon_handoff_commit first.",
          "Then re-run: npx archon continue-session",
          "",
        ].join("\n"));
        process.exitCode = 1;
        return;
      }

      const continuationPrompt = controller.buildContinuationPrompt(handoff);
      const invocation = buildClaudeInvocation(continuationPrompt);

      if (exec) {
        process.stdout.write(`Spawning continuation session for task ${taskId}...\n`);
        const result = spawnSync("claude", ["--print", continuationPrompt], {
          stdio: "inherit",
          shell: false
        });
        if (result.status !== 0) {
          process.exitCode = result.status ?? 1;
        }
      } else {
        process.stdout.write([
          `# Continuation session for task ${taskId} (handoff ${handoff.id})`,
          "# Run the following command in a new terminal to start the successor session:",
          "",
          invocation,
          "",
        ].join("\n"));
      }
    });
  } catch (error) {
    // DB unavailable — print manual instructions.
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write([
      "continue-session: could not connect to the archon runtime DB.",
      `  (${message})`,
      "",
      "Manual continuation path:",
      "  1. Ensure the current session called archon_handoff_commit before stopping.",
      "  2. Start a new claude session and paste the continuation prompt from:",
      "       .archon/work/daemon/continuation-context.txt",
      "  Or, for automatic respawn, configure scripts/archon-interactive-supervisor.sh.",
      "",
    ].join("\n"));
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function resolveFlag(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    const val = args[idx + 1];
    if (val !== undefined && !val.startsWith("--")) return val;
  }
  return undefined;
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}
