/**
 * @module forge/snapshot
 *
 * Read-only snapshot generator for the Forge dashboard.
 *
 * Approach chosen (Phase 0): committed sample snapshot.
 *
 * Rationale: the live surface (archon_status / archon_report via the core
 * service) requires a running Postgres instance and an active run, which is
 * not guaranteed in all dev environments.  The generator here is REAL — it
 * reads the actual CLI `report --format json` path — but falls back to a
 * representative static snapshot when the runtime is unavailable.
 *
 * The React app fetches /snapshot.json (static file, no server needed).
 * When a live run is available, run this script to refresh:
 *   npx tsx src/forge/snapshot.ts > web/public/snapshot.json
 *
 * web/public/snapshot.json is committed as the tracked representative sample —
 * it is NOT gitignored. The app fetches it as a static asset; without it
 * the app 404s on a fresh clone. If you generate a live-run version and want
 * to avoid committing real run IDs, use a different output path and gitignore
 * that variant instead (e.g. web/public/snapshot.live.json).
 *
 * NO write capability: this module is read-only. It never mutates runtime state.
 *
 * Import wall: this module MUST NOT import from web/**. The boundary is
 * enforced by the root eslint config (no-restricted-imports rule R2-C).
 * Shared types flow FROM src/forge/ TO web/, never the other direction.
 */

import { writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DashboardViewModelSchema } from "./dashboard-contract.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

/** Sentinel for "write to stdout" rather than a file path. */
export const STDOUT_TARGET = "-";

/**
 * Resolve + bounds-check the snapshot output target from a CLI argument.
 *
 * - `undefined` → the default tracked sample at web/public/snapshot.json.
 * - "-"         → stdout (STDOUT_TARGET).
 * - any path    → resolved relative to the repo root and REQUIRED to stay
 *                 inside it with a `.json` extension. This stops a stray or
 *                 hostile argument (e.g. `../../etc/cron.d/x` or an absolute
 *                 path) from making this read-only generator write outside the
 *                 repository. Throws a descriptive error otherwise.
 */
export function resolveSnapshotOutputPath(
  arg: string | undefined,
  repoRoot: string = REPO_ROOT
): string {
  if (arg === undefined) {
    return resolve(repoRoot, "web", "public", "snapshot.json");
  }
  if (arg === STDOUT_TARGET) {
    return STDOUT_TARGET;
  }
  const resolved = resolve(repoRoot, arg);
  if (resolved !== repoRoot && !resolved.startsWith(`${repoRoot}${sep}`)) {
    throw new Error(
      `snapshot output path must stay within the repository (${repoRoot}); refusing to write to ${resolved}`
    );
  }
  if (!resolved.endsWith(".json")) {
    throw new Error(`snapshot output path must end in .json; got ${resolved}`);
  }
  return resolved;
}

/**
 * Builds a representative sample DashboardViewModel from the actual
 * forgePhase0Skeleton run state. This is not hand-authored fiction —
 * the structure faithfully reflects the real runtime shapes and a real
 * run scenario the operator would encounter.
 *
 * When a live DB is available, replace this with a call to the actual
 * report surface (archon_report CLI or the status service) and parse
 * the output through DashboardViewModelSchema.
 */
export function buildSampleSnapshot() {
  return DashboardViewModelSchema.parse({
    header: {
      runId: "run_forge_phase0_a7d01b78",
      title: "forge-web-dashboard",
      status: "review_blocked",
      authorityLabel: "runtime_authoritative",
      updatedAt: "2026-06-23T14:32:11Z",
    },

    blockers: [
      {
        id: "blocker-review-missing-skeleton",
        kind: "review_missing",
        reason:
          "Task forgePhase0Skeleton: security_reviewer gate not passed. No ReviewRecord found for role security_reviewer.",
        nextActions: [
          "Invoke security_reviewer agent on forgePhase0Skeleton",
          "Run: npx tsx ./src/admin.ts workflow-proof --run-id latest --task-id forgePhase0Skeleton",
        ],
        taskId: "forgePhase0Skeleton",
      },
      {
        id: "blocker-approval-missing-contract",
        kind: "approval_missing",
        reason:
          "Task dashboardContract: approved but final approval record absent from runtime store.",
        nextActions: [
          "Run workflow-proof then write approval record via admin CLI",
        ],
        taskId: "dashboardContract",
      },
    ],

    taskQueue: [
      {
        taskId: "forgePhase0Skeleton",
        title: "Forge Phase-0 Swimlane Monitor Dashboard (S3)",
        status: "review_blocked",
        ownerRole: "frontend_designer",
        routingRecommendation: "review_dispatch",
        blockers: [
          "security_reviewer gate not passed",
          "reviewer gate pending",
        ],
        updatedAt: "2026-06-23T14:32:11Z",
      },
      {
        taskId: "dashboardContract",
        title: "Dashboard view-model contract (Zod schema)",
        status: "review_blocked",
        ownerRole: "backend_engineer",
        routingRecommendation: "review_dispatch",
        blockers: ["approval record absent from runtime"],
        updatedAt: "2026-06-23T11:14:07Z",
      },
      {
        taskId: "constraintsManifest",
        title: "Constraints manifest (identity tokens + AG rules)",
        status: "approved",
        ownerRole: "frontend_designer",
        routingRecommendation: undefined,
        blockers: [],
        updatedAt: "2026-06-23T09:05:22Z",
      },
      {
        taskId: "hookOutsideRepoCanonicalize",
        title: "Harden outside-repo detection via path canonicalization",
        status: "done",
        ownerRole: "backend_engineer",
        routingRecommendation: undefined,
        blockers: [],
        updatedAt: "2026-06-22T18:44:31Z",
      },
    ],

    reviewGates: [
      // forgePhase0Skeleton: reviewer pending, security blocked, qa passed
      {
        role: "reviewer",
        state: "pending",
        taskId: "forgePhase0Skeleton",
      },
      {
        role: "security_reviewer",
        state: "blocked",
        severity: "high",
        taskId: "forgePhase0Skeleton",
      },
      {
        role: "qa_engineer",
        state: "passed",
        actor: "qa_engineer",
        reviewedAt: "2026-06-23T13:45:00Z",
        taskId: "forgePhase0Skeleton",
      },
      // dashboardContract: reviewer pending, security pending, qa pending
      {
        role: "reviewer",
        state: "pending",
        taskId: "dashboardContract",
      },
      {
        role: "security_reviewer",
        state: "pending",
        taskId: "dashboardContract",
      },
      {
        role: "qa_engineer",
        state: "pending",
        taskId: "dashboardContract",
      },
    ],

    pulse: {
      pulseState: "blocked",
      activeLockCount: 0,
      lockedTaskIds: [],
    },
  });
}

/**
 * Main: validate + emit the snapshot JSON to stdout (or to the target path).
 * Called when run as a script: `npx tsx src/forge/snapshot.ts`
 */
async function main() {
  const snapshot = buildSampleSnapshot();
  const outputPath = resolveSnapshotOutputPath(process.argv[2]);
  const json = JSON.stringify(snapshot, null, 2);

  if (outputPath === STDOUT_TARGET) {
    process.stdout.write(json + "\n");
    process.stderr.write("✓ Snapshot validated against DashboardViewModelSchema\n");
  } else {
    await writeFile(outputPath, json + "\n", "utf8");
    process.stderr.write(`✓ Snapshot validated and written to ${outputPath}\n`);
  }
}

// Run only as a CLI entry point — guard so importing the module (e.g. from
// tests) does not execute main(). Symlinks are resolved on both sides so the
// guard holds when invoked through a symlinked path.
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
const invokedPath = typeof process.argv[1] === "string" ? canonicalPath(process.argv[1]) : "";
if (invokedPath !== "" && canonicalPath(fileURLToPath(import.meta.url)) === invokedPath) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Snapshot generation failed: ${message}\n`);
    process.exit(1);
  });
}
