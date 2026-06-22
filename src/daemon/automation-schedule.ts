// Daemon split (by concern): supported-schedule conversion and automation-handoff
// prompt building. Leaf module — depends only on node builtins; the rest of the
// daemon (automation/cli scheduler request writers) calls one-way into these.
// Behavior-preserving move from daemon.ts — no logic changes.
import { access } from "node:fs/promises";
import path from "node:path";

export function convertSupportedCronScheduleToRrule(schedule: string): string {
  switch (schedule.trim()) {
    case "*/30 * * * *":
      return "FREQ=MINUTELY;INTERVAL=30";
    case "0 * * * *":
      return "FREQ=HOURLY;INTERVAL=1";
    default:
      throw new Error(`unsupported cron schedule for Codex app automation handoff: ${schedule}`);
  }
}


export function buildAppAutomationPrompt(input: {
  envelope: {
    continuationIntent: "defer_same_thread" | "defer_fresh_run";
    targetMode: "same_thread" | "fresh_run";
    targetId: string;
    source: "progress_proof" | "checkpoint";
    sourceId?: string | undefined;
    summary: string;
    nextActions: string[];
    workspaceSlug: string;
    projectSlug: string;
    activeRunId: string;
    activeTaskId: string;
  };
  cwd: string;
  /**
   * Compact continuation context assembled from the latest handoff packet by
   * ContinuationContextBuilder. When present it is injected verbatim so the
   * resumed invocation starts from durable runtime state rather than re-reading
   * the prior transcript. Omitted when no prior handoff exists.
   */
  continuationContext?: string | undefined;
}): string {
  const lines = [
    `Resume deferred archon work for workspace ${input.envelope.workspaceSlug} project ${input.envelope.projectSlug}.`,
    `Repo root: ${input.cwd}`,
    `Active run: ${input.envelope.activeRunId}`,
    `Active task: ${input.envelope.activeTaskId}`,
    `Continuation target: ${input.envelope.targetId}`,
    `Continuation intent: ${input.envelope.continuationIntent}`,
    `Target mode: ${input.envelope.targetMode}`,
    `Resume source: ${input.envelope.source}${input.envelope.sourceId ? ` (${input.envelope.sourceId})` : ""}`,
    `Summary: ${input.envelope.summary}`,
    "Before making changes, read `.archon/work/daemon/automation-envelope.json` and confirm the active runtime task still matches this request.",
    "Carry out the recorded continuation target, record concrete progress or blockers, and stop if the task becomes blocked by external input or no longer remains active."
  ];
  if (input.envelope.nextActions.length > 0) {
    lines.push(`Next actions: ${input.envelope.nextActions.join("; ")}`);
  }
  const continuationContext = input.continuationContext?.trim();
  if (continuationContext) {
    lines.push(
      "",
      "Compact continuation context from prior handoff (runtime-authoritative — do not relitigate decisions already recorded here):",
      continuationContext
    );
  }
  return `${lines.join("\n")}\n`;
}


export async function detectGitAutomationExecutionEnvironment(cwd: string): Promise<"worktree" | "local"> {
  try {
    await access(path.join(cwd, ".git"));
    return "worktree";
  } catch {
    return "local";
  }
}


export function convertSupportedCronScheduleToSystemdOnCalendar(schedule: string): string | undefined {
  switch (schedule.trim()) {
    case "*/30 * * * *":
      return "*-*-* *:0/30:00";
    case "0 * * * *":
      return "hourly";
    default:
      return undefined;
  }
}
