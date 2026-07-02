/**
 * Capability report assembler.
 *
 * Takes raw ProbeResult[] and applies the severity policy to produce a
 * CapabilityReport. Severity decisions live HERE, not in probes.
 *
 * Severity policy (data-driven, reversible — council C14 guards the contract):
 *   verify context: L0/L1 blocked/degraded → blocking; L2/L3 → advisory; skipped → advisory.
 *   doctor context: blocked → blocking; degraded → advisory; skipped → advisory.
 *
 * Defence-in-depth (council C8): every detail and remediation string is passed
 * through scrubPgCredentials() regardless of whether the probe scrubbed it at
 * the call site. This is the last line of defence against credential leakage.
 */
import { scrubPgCredentials } from "../../admin/db-error-scrub.ts";
import type { CapabilityReport, ProbeResult } from "./types.ts";

/**
 * Context in which the report is assembled.
 *   verify — fast, no external deps; L2/L3 are advisory.
 *   doctor — operator machine with claude + DB; L2/L3 can be blocking.
 */
export type AssemblyContext = "verify" | "doctor";

/**
 * Returns true when a probe result is blocking in the given context.
 *
 * Severity policy:
 *   verify: L0/L1 blocked → blocking; L0/L1 degraded → advisory; L2/L3 any → advisory.
 *   doctor: blocked → blocking; degraded → advisory.
 *   skipped → always advisory.
 */
function isProbeBlocking(probe: ProbeResult, context: AssemblyContext): boolean {
  if (probe.status === "ok" || probe.status === "skipped") {
    return false;
  }

  if (context === "verify") {
    // Only L0/L1 failures are blocking in verify; L2/L3 are always advisory.
    return (probe.layer === "L0" || probe.layer === "L1") && probe.status === "blocked";
  }

  // doctor context: blocked is always blocking across all layers.
  return probe.status === "blocked";
}

/**
 * Assembles probe results into a CapabilityReport.
 *
 * - Applies severity policy for the given context.
 * - Scrubs credentials from all detail/remediation strings (C8).
 * - Deduplicates nextActions.
 * - Output shape is byte-compatible with doctorCommand JSON (runtime.ts):
 *     { ok, blockers, advisories, nextActions, reason }
 */
export function assembleCapabilityReport(
  probes: readonly ProbeResult[],
  context: AssemblyContext
): CapabilityReport {
  const blockers: string[] = [];
  const advisories: string[] = [];
  const nextActionsSet = new Set<string>();

  for (const probe of probes) {
    if (probe.status === "ok") {
      continue;
    }

    // C8 defence-in-depth: always scrub, even if the probe already scrubbed.
    const detail = scrubPgCredentials(probe.detail);
    const remediation = scrubPgCredentials(probe.remediation);
    const summary = `[${probe.capability}/${probe.layer}] ${detail}`;

    if (probe.status === "skipped") {
      if (detail) {
        advisories.push(`${summary} (skipped)`);
      }
      continue;
    }

    if (isProbeBlocking(probe, context)) {
      blockers.push(summary);
      if (remediation) {
        nextActionsSet.add(remediation);
      }
    } else {
      advisories.push(summary);
      if (remediation) {
        nextActionsSet.add(remediation);
      }
    }
  }

  const nextActions = [...nextActionsSet];
  const ok = blockers.length === 0;
  const reason =
    ok
      ? advisories.length === 0
        ? "All checked capabilities are operational."
        : `All required capabilities are operational; ${advisories.length} advisory item(s).`
      : `${blockers.length} blocking issue(s): ${blockers.slice(0, 2).join("; ")}${blockers.length > 2 ? " …" : ""}`;

  return {
    ok,
    blockers,
    advisories,
    nextActions,
    reason,
    probes,
  };
}

/**
 * Builds L2/L3 placeholder probes for capabilities not yet implemented in S1.
 *
 * Returns skipped ProbeResults for all L2/L3 capabilities so the report is
 * complete and honest: "not checked yet" is advisory, never a crash or a blocker.
 */
export function buildL2L3PlaceholderProbes(): readonly ProbeResult[] {
  const placeholders: ProbeResult[] = [
    {
      capability: "ecc-plugin",
      layer: "L2",
      status: "skipped",
      code: "ecc-plugin-placeholder",
      detail:
        "ECC plugin presence check not yet implemented — ships in S2/S3. Install manually: claude plugin marketplace add affaan-m/ECC && claude plugin install ecc@ecc",
      remediation:
        "Install ECC manually: claude plugin marketplace add affaan-m/ECC && claude plugin install ecc@ecc",
    },
    {
      capability: "playwright-browsers",
      layer: "L2",
      status: "skipped",
      code: "playwright-browsers-placeholder",
      detail:
        "Playwright browser check not yet implemented — ships in S2. Install manually: npm run archon:setup:playwright",
      remediation: "Run 'npm run archon:setup:playwright' to install Playwright browsers.",
    },
    {
      capability: "doctor",
      layer: "L3",
      status: "skipped",
      code: "doctor-runtime-placeholder",
      detail:
        "DB preflight runtime check (L3) not yet implemented — ships in S2. Run 'npm run archon:doctor' manually.",
      remediation: "Run 'npm run archon:doctor' to check DB connectivity and migrations.",
    },
  ];
  return placeholders;
}
