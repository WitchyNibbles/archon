import type {
  AutonomousExecutionState,
  CoverageItemRecord,
  RuntimeTraceAuthorityLabel,
  RuntimeTraceRecord,
  RuntimeTraceRegistrySummary,
  RuntimeTraceRegistryTargetSummary
} from "../domain/types.ts";

const riskyCoverageCategories = new Set([
  "services",
  "external_integrations",
  "authentication",
  "authorization",
  "runtime_side_effects"
]);
const defaultFreshnessWindowHours = 24;
const defaultRuntimeTraceAuthorityLabel: RuntimeTraceAuthorityLabel = "runtime_capture";

function traceSort(left: RuntimeTraceRecord, right: RuntimeTraceRecord): number {
  const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }

  return left.traceId.localeCompare(right.traceId);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeAuthorityLabel(trace: RuntimeTraceRecord): RuntimeTraceAuthorityLabel {
  return trace.authorityLabel ?? defaultRuntimeTraceAuthorityLabel;
}

function parseTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function computeFreshness(
  createdAt: string,
  referenceNow: string,
  freshnessWindowHours: number
): RuntimeTraceRegistryTargetSummary["freshness"] {
  const createdAtTime = parseTimestamp(createdAt);
  const referenceNowTime = parseTimestamp(referenceNow);
  if (createdAtTime === undefined || referenceNowTime === undefined) {
    return "stale";
  }

  const maxAgeMs = freshnessWindowHours * 60 * 60 * 1000;
  return referenceNowTime - createdAtTime <= maxAgeMs ? "fresh" : "stale";
}

function isRiskyTraceCandidate(item: CoverageItemRecord): boolean {
  return (
    item.criticality === "high" ||
    item.criticality === "critical" ||
    riskyCoverageCategories.has(item.category) ||
    (item.callsiteCount ?? 0) > 0
  );
}

function summarizeTarget(
  targetId: string,
  traces: readonly RuntimeTraceRecord[],
  options: {
    referenceNow: string;
    freshnessWindowHours: number;
  }
): RuntimeTraceRegistryTargetSummary {
  const sorted = [...traces].sort(traceSort);
  const latestTrace = sorted.at(-1);
  const latestCreatedAt = latestTrace?.createdAt ?? "";

  return {
    targetId,
    traceIds: sorted.map((trace) => trace.traceId),
    kinds: uniqueSorted(sorted.map((trace) => trace.kind)) as RuntimeTraceRegistryTargetSummary["kinds"],
    riskyTraceCount: sorted.filter((trace) => trace.risky).length,
    latestCreatedAt,
    authorityLabels: uniqueSorted(
      sorted.map((trace) => normalizeAuthorityLabel(trace))
    ) as RuntimeTraceRegistryTargetSummary["authorityLabels"],
    latestAuthorityLabel: latestTrace
      ? normalizeAuthorityLabel(latestTrace)
      : defaultRuntimeTraceAuthorityLabel,
    freshness: computeFreshness(latestCreatedAt, options.referenceNow, options.freshnessWindowHours),
    sideEffects: uniqueSorted(sorted.flatMap((trace) => trace.sideEffects)),
    evidenceRefs: uniqueSorted(sorted.flatMap((trace) => trace.evidenceRefs))
  };
}

export function buildRuntimeTraceRegistry(
  state: AutonomousExecutionState,
  options: {
    now?: string | undefined;
    freshnessWindowHours?: number | undefined;
  } = {}
): RuntimeTraceRegistrySummary {
  const traces = [...(state.runtimeTraces ?? [])].sort(traceSort);
  const tracesByTarget = new Map<string, RuntimeTraceRecord[]>();
  const referenceNow = options.now ?? state.updatedAt;
  const freshnessWindowHours = options.freshnessWindowHours ?? defaultFreshnessWindowHours;

  for (const trace of traces) {
    const existing = tracesByTarget.get(trace.targetId);
    if (existing) {
      existing.push(trace);
      continue;
    }

    tracesByTarget.set(trace.targetId, [trace]);
  }

  const targets = [...tracesByTarget.entries()]
    .map(([targetId, targetTraces]) =>
      summarizeTarget(targetId, targetTraces, { referenceNow, freshnessWindowHours })
    )
    .sort((left, right) => left.targetId.localeCompare(right.targetId));
  const tracedTargetIds = new Set(targets.map((target) => target.targetId));
  const missingTargetIdsFromGaps = state.gaps
    .filter((gap) => gap.status === "open" && gap.kind === "missing_runtime_trace")
    .map((gap) => gap.targetId);

  return {
    totalTraces: traces.length,
    riskyTraceCount: traces.filter((trace) => trace.risky).length,
    tracedTargetCount: targets.length,
    freshnessWindowHours,
    referenceNow,
    staleTargetIds: targets
      .filter((target) => target.freshness === "stale")
      .map((target) => target.targetId),
    operatorImportTargetIds: targets
      .filter((target) => target.authorityLabels.includes("operator_import"))
      .map((target) => target.targetId),
    openMissingTraceGapIds: uniqueSorted(
      state.gaps
        .filter((gap) => gap.status === "open" && gap.kind === "missing_runtime_trace")
        .map((gap) => gap.id)
    ),
    riskyTargetsMissingTrace: uniqueSorted([
      ...state.coverageItems
        .filter((item) => isRiskyTraceCandidate(item))
        .map((item) => item.id)
        .filter((targetId) => !tracedTargetIds.has(targetId)),
      ...missingTargetIdsFromGaps
    ]),
    targets
  };
}
