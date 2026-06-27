/**
 * autonomous-enable — operator command to turn ON or OFF the daemon's autonomous
 * execution loop for a run.
 *
 * Gap closed: the daemon's turn dispatch is gated on
 * `autonomousExecution.enabled`, but the ONLY method that previously set it
 * (`service.configureAutonomousExecution`) was called exclusively from
 * `src/evals/orchestration-baseline.ts`. This command gives operators a
 * first-class surface.
 *
 * Usage:
 *   npx archon autonomous-enable [--run-id <id|latest>] [--profile <p>] [--phase <p>]
 *   npx archon autonomous-enable --disable [--run-id <id|latest>]
 *
 * Options:
 *   --run-id <id|latest>   Runtime run id (default: resolve from env/flags)
 *   --profile <profile>    Execution profile (default: standard_delivery)
 *   --phase <phase>        Starting analysis phase (default: discovery)
 *   --disable              Flip enabled=false instead of enabling
 *   --format json|text     Output format (default: json)
 */

import process from "node:process";
import type { AnalysisPhase, AutonomousExecutionState, RunProfile } from "../domain/types.ts";
import { analysisPhases, runProfiles } from "../domain/types.ts";
import { withClient } from "./db.ts";
import { PostgresStore } from "../store/postgres-store.ts";
import { ArchonCoreService } from "../core/service.ts";
import { resolveRunIdForCommand, resolveCommandFlag } from "../workflow.ts";

// ─── Pure types ───────────────────────────────────────────────────────────────

export interface ParsedAutonomousEnableArgs {
  runId: string | undefined;
  profile: RunProfile | undefined;
  phase: AnalysisPhase | undefined;
  disable: boolean;
  format: "json" | "text";
}

export interface AutonomousEnableOutput {
  runId: string;
  enabled: boolean;
  profile: RunProfile;
  phase: AnalysisPhase;
  updatedAt: string;
  hint: string;
}

export interface AutonomousDisableOutput {
  runId: string;
  enabled: boolean;
  profile: RunProfile;
  phase: AnalysisPhase;
  updatedAt: string;
  hint: string;
}

// ─── Pure flag parser ─────────────────────────────────────────────────────────

export function parseAutonomousEnableArgs(args: readonly string[]): ParsedAutonomousEnableArgs {
  const runId = resolveCommandFlag(args, "--run-id");
  const profileRaw = resolveCommandFlag(args, "--profile");
  const phaseRaw = resolveCommandFlag(args, "--phase");
  const formatRaw = resolveCommandFlag(args, "--format") ?? "json";
  const disable = args.includes("--disable");

  if (formatRaw !== "json" && formatRaw !== "text") {
    throw new Error(`Invalid --format value: "${formatRaw}". Must be "json" or "text".`);
  }

  const profile: RunProfile | undefined =
    profileRaw !== undefined
      ? (runProfiles as readonly string[]).includes(profileRaw)
        ? (profileRaw as RunProfile)
        : (() => { throw new Error(`Invalid --profile value: "${profileRaw}". Valid: ${runProfiles.join(", ")}`); })()
      : undefined;

  const phase: AnalysisPhase | undefined =
    phaseRaw !== undefined
      ? (analysisPhases as readonly string[]).includes(phaseRaw)
        ? (phaseRaw as AnalysisPhase)
        : (() => { throw new Error(`Invalid --phase value: "${phaseRaw}". Valid: ${analysisPhases.join(", ")}`); })()
      : undefined;

  return {
    runId,
    profile,
    phase,
    disable,
    format: formatRaw
  };
}

// ─── Pure output builders ─────────────────────────────────────────────────────

export function buildAutonomousEnableOutput(
  runId: string,
  state: AutonomousExecutionState
): AutonomousEnableOutput {
  return {
    runId,
    enabled: state.enabled,
    profile: state.profile,
    phase: state.phase,
    updatedAt: state.updatedAt,
    hint: "autonomous execution enabled — run `archon daemon` to begin autonomous turns"
  };
}

export function buildAutonomousDisableOutput(
  runId: string,
  state: AutonomousExecutionState
): AutonomousDisableOutput {
  return {
    runId,
    enabled: state.enabled,
    profile: state.profile,
    phase: state.phase,
    updatedAt: state.updatedAt,
    hint: "autonomous execution disabled — daemon turns will return 'blocked: no executable next step' until re-enabled"
  };
}

// ─── Wired entry point ────────────────────────────────────────────────────────

export async function autonomousEnableCommand(args: readonly string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      [
        "npx archon autonomous-enable [--run-id <id>] [--profile <p>] [--phase <p>] [--disable]",
        "",
        "Enable (or disable) the daemon's autonomous execution loop for a run.",
        "",
        "When enabled, `archon daemon` will dispatch autonomous turns instead of returning",
        "'blocked: no executable next step'. Run `archon daemon` after enabling.",
        "",
        "Options:",
        "  --run-id <id|latest>   Runtime run id (default: latest from env)",
        `  --profile <profile>    Execution profile (default: standard_delivery). Valid: ${runProfiles.join(", ")}`,
        `  --phase <phase>        Starting analysis phase (default: discovery). Valid: ${analysisPhases.join(", ")}`,
        "  --disable              Disable autonomous execution instead of enabling",
        "  --format json|text     Output format (default: json)",
        "",
        "Safety rails (all active by default):",
        "  ARCHON_MAX_RESPAWNS_PER_TASK — respawn budget per task (default: 8)",
        "  ARCHON_CONTEXT_MONITOR       — enforce|observe (default: enforce)",
        "  Cross-process file-lock lease — prevents concurrent daemon instances",
        ""
      ].join("\n")
    );
    return;
  }

  const parsed = parseAutonomousEnableArgs(args);

  await withClient(async (client) => {
    const store = new PostgresStore(client as ConstructorParameters<typeof PostgresStore>[0]);
    const service = new ArchonCoreService(store);

    const runId = await resolveRunIdForCommand(
      parsed.runId !== undefined ? ["--run-id", parsed.runId] : args,
      {
        env: process.env,
        findLatestRun(workspaceSlug, projectSlug) {
          return store.findLatestRun({ workspaceSlug, projectSlug });
        }
      }
    );

    if (parsed.disable) {
      const state = await service.disableAutonomousExecution(runId);
      const output = buildAutonomousDisableOutput(runId, state);
      if (parsed.format === "text") {
        process.stdout.write(
          [
            `autonomous-enable: disabled for run ${runId}`,
            `  profile: ${output.profile}`,
            `  phase:   ${output.phase}`,
            `  hint:    ${output.hint}`,
            ""
          ].join("\n")
        );
      } else {
        process.stdout.write(JSON.stringify(output, null, 2) + "\n");
      }
      return;
    }

    const state = await service.configureAutonomousExecution(runId, {
      profile: parsed.profile,
      phase: parsed.phase
    });
    const output = buildAutonomousEnableOutput(runId, state);
    if (parsed.format === "text") {
      process.stdout.write(
        [
          `autonomous-enable: enabled for run ${runId}`,
          `  profile: ${output.profile}`,
          `  phase:   ${output.phase}`,
          `  hint:    ${output.hint}`,
          ""
        ].join("\n")
      );
    } else {
      process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    }
  });
}
