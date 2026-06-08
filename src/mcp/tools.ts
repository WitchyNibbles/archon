import { z } from "zod";

export interface McpRuntimeSurface {
  status(args: readonly string[]): Promise<unknown>;
  runtimeHealth(args: readonly string[]): Promise<unknown>;
  ops(args: readonly string[]): Promise<unknown>;
  loop(args: readonly string[]): Promise<unknown>;
  report(args: readonly string[]): Promise<unknown>;
  planContext(args: readonly string[]): Promise<unknown>;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  invoke: (input: Record<string, unknown>) => Promise<{
    content: { type: "text"; text: string }[];
    structuredContent: Record<string, unknown>;
  }>;
}

type DetailLevel = "summary" | "standard" | "full";

function pushOptionalStringFlag(args: string[], flag: string, value: unknown): void {
  if (typeof value === "string" && value.trim().length > 0) {
    args.push(flag, value.trim());
  }
}

function pushOptionalNumberFlag(args: string[], flag: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    args.push(flag, String(value));
  }
}

function buildRunSelectorArgs(input: {
  runId?: unknown;
  workspaceSlug?: unknown;
  projectSlug?: unknown;
}): string[] {
  const args: string[] = [];
  if (typeof input.runId === "string" && input.runId.trim().length > 0) {
    args.push("--run-id", input.runId.trim());
  } else {
    args.push("--run-id", "latest");
    pushOptionalStringFlag(args, "--workspace-slug", input.workspaceSlug);
    pushOptionalStringFlag(args, "--project-slug", input.projectSlug);
  }
  return args;
}

function resolveDetailLevel(value: unknown): DetailLevel {
  return value === "full" || value === "standard" ? value : "summary";
}

function compactStructuredContent(
  value: unknown,
  limits: { maxDepth: number; maxArrayItems: number; maxStringLength: number },
  depth = 0
): unknown {
  if (typeof value === "string") {
    return value.length > limits.maxStringLength
      ? `${value.slice(0, Math.max(0, limits.maxStringLength - 1))}…`
      : value;
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, limits.maxArrayItems)
      .map((item) => compactStructuredContent(item, limits, depth + 1));
    return value.length > limits.maxArrayItems ? [...items, `… +${value.length - limits.maxArrayItems} more`] : items;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (depth >= limits.maxDepth) {
    return "[truncated]";
  }

  const entries = Object.entries(value as Record<string, unknown>).slice(0, limits.maxArrayItems);
  const compacted = Object.fromEntries(
    entries.map(([key, nestedValue]) => [key, compactStructuredContent(nestedValue, limits, depth + 1)])
  );
  const omitted = Object.keys(value as Record<string, unknown>).length - entries.length;
  return omitted > 0 ? { ...compacted, _truncated: `+${omitted} more keys` } : compacted;
}

function summarizeStatusReport(report: Record<string, unknown>): Record<string, unknown> {
  const run = report.run && typeof report.run === "object" ? (report.run as Record<string, unknown>) : undefined;
  const orchestration =
    report.orchestration && typeof report.orchestration === "object"
      ? (report.orchestration as Record<string, unknown>)
      : undefined;
  const autonomous =
    report.autonomous && typeof report.autonomous === "object"
      ? (report.autonomous as Record<string, unknown>)
      : undefined;
  const resume =
    autonomous?.resume && typeof autonomous.resume === "object"
      ? (autonomous.resume as Record<string, unknown>)
      : undefined;
  const compaction =
    report.compaction && typeof report.compaction === "object"
      ? (report.compaction as Record<string, unknown>)
      : undefined;
  const reviewIdentity =
    report.reviewIdentity && typeof report.reviewIdentity === "object"
      ? (report.reviewIdentity as Record<string, unknown>)
      : undefined;
  const daemon = report.daemon && typeof report.daemon === "object" ? (report.daemon as Record<string, unknown>) : undefined;
  const continuation =
    daemon?.continuation && typeof daemon.continuation === "object"
      ? (daemon.continuation as Record<string, unknown>)
      : undefined;

  return {
    run: run
      ? {
          id: run.id,
          status: run.status,
          updatedAt: run.updatedAt,
          taskCounts: run.taskCounts
        }
      : undefined,
    orchestration: orchestration
      ? {
          blockers: orchestration.blockers,
          nextTaskIds: orchestration.nextTaskIds
        }
      : undefined,
    autonomous: autonomous
      ? {
          configured: autonomous.configured,
          phase: autonomous.phase,
          resume: resume
            ? {
                status: resume.status,
                source: resume.source,
                summary: resume.summary,
                executionMode: resume.executionMode
              }
            : undefined
        }
      : undefined,
    compaction: compaction
      ? {
          status: compaction.status,
          checkpointId: compaction.checkpointId,
          generatedAt: compaction.generatedAt
        }
      : undefined,
    reviewIdentity: reviewIdentity
      ? {
          liveTrustReady: reviewIdentity.liveTrustReady
        }
      : undefined,
    daemon: continuation
      ? {
          continuation: {
            summary: continuation.summary
          }
        }
      : undefined
  };
}

function summarizeRuntimeHealthReport(report: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: report.ok,
    blockers: report.blockers,
    advisories: report.advisories,
    runtime: report.runtime,
    project: report.project
  };
}

function summarizeReport(report: Record<string, unknown>): Record<string, unknown> {
  const summary =
    report.summary && typeof report.summary === "object" ? (report.summary as Record<string, unknown>) : undefined;
  const autonomous =
    report.autonomous && typeof report.autonomous === "object"
      ? (report.autonomous as Record<string, unknown>)
      : undefined;
  const resume =
    autonomous?.resume && typeof autonomous.resume === "object"
      ? (autonomous.resume as Record<string, unknown>)
      : undefined;
  return {
    runId: report.runId,
    totals: {
      totalLoopExecutions: summary?.totalLoopExecutions,
      totalTasks: summary?.totalTasks
    },
    resume: resume?.summary
  };
}

function summarizePlanContext(report: Record<string, unknown>): Record<string, unknown> {
  return {
    query: report.query,
    requesterRole: report.requesterRole,
    totalResults: report.totalResults,
    summary: report.summary
  };
}

function buildTextResult(
  summary: string,
  structuredContent: unknown,
  options: {
    detail?: unknown;
    summarize?: (structuredContent: Record<string, unknown>) => Record<string, unknown>;
  } = {}
) {
  const normalizedStructuredContent =
    structuredContent && typeof structuredContent === "object" && !Array.isArray(structuredContent)
      ? (structuredContent as Record<string, unknown>)
      : { value: structuredContent };
  const detail = resolveDetailLevel(options.detail);
  const resolvedStructuredContent =
    detail === "full"
      ? normalizedStructuredContent
      : detail === "standard"
        ? (compactStructuredContent(normalizedStructuredContent, {
            maxDepth: 3,
            maxArrayItems: 4,
            maxStringLength: 180
          }) as Record<string, unknown>)
        : options.summarize
          ? options.summarize(normalizedStructuredContent)
          : (compactStructuredContent(normalizedStructuredContent, {
              maxDepth: 2,
              maxArrayItems: 3,
              maxStringLength: 140
            }) as Record<string, unknown>);

  return {
    content: [{ type: "text" as const, text: summary }],
    structuredContent: resolvedStructuredContent
  };
}

const detailInput = z.enum(["summary", "standard", "full"]).optional();

export function createMcpToolDefinitions(runtime: McpRuntimeSurface): readonly McpToolDefinition[] {
  return [
    {
      name: "archon_status",
      description:
        "Get the authoritative archon run status report. Use runId or latest plus workspace/project.",
      inputSchema: {
        runId: z.string().trim().optional(),
        workspaceSlug: z.string().trim().optional(),
        projectSlug: z.string().trim().optional(),
        staleAfterDays: z.number().int().min(0).optional(),
        detail: detailInput
      },
      async invoke(input) {
        const args = buildRunSelectorArgs(input);
        pushOptionalNumberFlag(args, "--stale-after-days", input.staleAfterDays);
        const report = await runtime.status(args);
        return buildTextResult("Returned the devgod status report.", report, {
          detail: input.detail,
          summarize: summarizeStatusReport
        });
      }
    },
    {
      name: "archon_runtime_health",
      description:
        "Check runtime registration, data-root, and review-identity health for a archon run.",
      inputSchema: {
        runId: z.string().trim().optional(),
        workspaceSlug: z.string().trim().optional(),
        projectSlug: z.string().trim().optional(),
        detail: detailInput
      },
      async invoke(input) {
        const report = await runtime.runtimeHealth(buildRunSelectorArgs(input));
        return buildTextResult("Returned the archon runtime health report.", report, {
          detail: input.detail,
          summarize: summarizeRuntimeHealthReport
        });
      }
    },
    {
      name: "archon_ops",
      description:
        "Get the operator dashboard for a run, including routing and recovery guidance with authority labels.",
      inputSchema: {
        runId: z.string().trim().optional(),
        workspaceSlug: z.string().trim().optional(),
        projectSlug: z.string().trim().optional(),
        staleAfterHours: z.number().int().min(0).optional(),
        detail: detailInput
      },
      async invoke(input) {
        const args = buildRunSelectorArgs(input);
        pushOptionalNumberFlag(args, "--stale-after-hours", input.staleAfterHours);
        const report = await runtime.ops(args);
        return buildTextResult("Returned the archon operator dashboard.", report, {
          detail: input.detail
        });
      }
    },
    {
      name: "archon_loop",
      description:
        "Get the authoritative next archon loop step for a run and optionally apply safe recovery first.",
      inputSchema: {
        runId: z.string().trim().optional(),
        workspaceSlug: z.string().trim().optional(),
        projectSlug: z.string().trim().optional(),
        staleAfterHours: z.number().int().min(0).optional(),
        applySafeRecovery: z.boolean().optional(),
        executeSupportedDirectives: z.boolean().optional(),
        ownerActor: z.string().trim().optional(),
        reviewInputPaths: z.array(z.string().trim().min(1)).optional(),
        detail: detailInput
      },
      async invoke(input) {
        const args = [...buildRunSelectorArgs(input), "--format", "json"];
        pushOptionalNumberFlag(args, "--stale-after-hours", input.staleAfterHours);
        if (input.applySafeRecovery === true) {
          args.push("--apply-safe-recovery");
        }
        if (input.executeSupportedDirectives === true) {
          args.push("--execute-supported-directives");
        }
        pushOptionalStringFlag(args, "--owner-actor", input.ownerActor);
        if (Array.isArray(input.reviewInputPaths)) {
          for (const reviewInputPath of input.reviewInputPaths) {
            pushOptionalStringFlag(args, "--review-input", reviewInputPath);
          }
        }
        const report = await runtime.loop(args);
        return buildTextResult("Returned the archon loop execution step.", report, {
          detail: input.detail
        });
      }
    },
    {
      name: "archon_report",
      description:
        "Get the run evidence report, including timeline, reviews, approvals, and recovery observations.",
      inputSchema: {
        runId: z.string().trim().optional(),
        workspaceSlug: z.string().trim().optional(),
        projectSlug: z.string().trim().optional(),
        staleAfterHours: z.number().int().min(0).optional(),
        detail: detailInput
      },
      async invoke(input) {
        const args = [...buildRunSelectorArgs(input), "--format", "json"];
        pushOptionalNumberFlag(args, "--stale-after-hours", input.staleAfterHours);
        const report = await runtime.report(args);
        return buildTextResult("Returned the archon run evidence report.", report, {
          detail: input.detail,
          summarize: summarizeReport
        });
      }
    },
    {
      name: "archon_plan_context",
      description:
        "Search reviewed archon planning context with authority, freshness, and citation metadata.",
      inputSchema: {
        query: z.string().trim().min(1),
        workspaceSlug: z.string().trim().optional(),
        projectSlug: z.string().trim().optional(),
        role: z.string().trim().optional(),
        limit: z.number().int().min(1).max(20).optional(),
        projectOnly: z.boolean().optional(),
        detail: detailInput
      },
      async invoke(input) {
        const args = ["--query", String(input.query), "--format", "json"];
        pushOptionalStringFlag(args, "--workspace-slug", input.workspaceSlug);
        pushOptionalStringFlag(args, "--project-slug", input.projectSlug);
        pushOptionalStringFlag(args, "--role", input.role);
        pushOptionalNumberFlag(args, "--limit", input.limit);
        if (input.projectOnly === true) {
          args.push("--project-only");
        }
        const report = await runtime.planContext(args);
        return buildTextResult("Returned archon planning context results.", report, {
          detail: input.detail,
          summarize: summarizePlanContext
        });
      }
    }
  ];
}
