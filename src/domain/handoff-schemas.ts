import { z } from "zod";
import { agentKinds, agentInvocationStatuses, handoffReasons, contextSampleSources } from "./types.ts";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const nonEmptyString = z.string().min(1);

// ---------------------------------------------------------------------------
// HandoffPacketV1Schema
// ---------------------------------------------------------------------------
// Validates the JSON payload emitted by an agent when context >= 70% or at
// a role boundary.  Rules follow TDD §9.1.

const HandoffScopeBlockSchema = z.object({
  allowedWriteScope: z.array(z.string()),
  touchedPaths: z.array(z.string()),
  lockedPaths: z.array(z.string()).optional()
});

const HandoffDecisionSchema = z.object({
  decision: nonEmptyString,
  rationale: nonEmptyString
});

const HandoffRiskSchema = z.object({
  severity: z.enum(["low", "medium", "high", "critical"]),
  risk: nonEmptyString,
  mitigation: nonEmptyString
});

const HandoffSubagentResultSchema = z.object({
  subtaskId: nonEmptyString,
  role: nonEmptyString,
  status: nonEmptyString,
  summary: nonEmptyString
});

export const HandoffPacketV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    handoffId: nonEmptyString,
    runId: nonEmptyString,
    taskId: nonEmptyString,
    fromInvocationId: nonEmptyString,
    fromRole: nonEmptyString,
    toRole: nonEmptyString,
    reason: z.enum(handoffReasons),
    contextUsedPct: z.number().min(0).max(100).optional(),
    // status describes what the handoff represents; not an enum so agents can
    // use free-form labels like "needs_followup" or "completed".
    status: nonEmptyString,
    // summary must be present and non-empty — no "stuff done, continue pls"
    summary: z.string().min(10, "summary must be at least 10 characters"),
    scope: HandoffScopeBlockSchema,
    decisions: z.array(HandoffDecisionSchema),
    openQuestions: z.array(z.string()),
    // evidenceRefs required unless status === "blocked"
    evidenceRefs: z.array(z.string()),
    // nextActions required unless status === "completed"
    nextActions: z.array(z.string()),
    risks: z.array(HandoffRiskSchema),
    subagentResults: z.array(HandoffSubagentResultSchema).optional(),
    createdAt: nonEmptyString
  })
  .superRefine((val, ctx) => {
    // context_threshold_70 handoffs must include a contextUsedPct
    if (val.reason === "context_threshold_70" && val.contextUsedPct === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "contextUsedPct is required for context_threshold_70 reason",
        path: ["contextUsedPct"]
      });
    }

    // evidenceRefs must be non-empty unless the invocation is blocked
    if (val.status !== "blocked" && val.evidenceRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "evidenceRefs is required unless status is 'blocked'",
        path: ["evidenceRefs"]
      });
    }

    // nextActions must be non-empty unless the invocation is completed
    if (val.status !== "completed" && val.nextActions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "nextActions is required unless status is 'completed'",
        path: ["nextActions"]
      });
    }
  });

export type HandoffPacketV1 = z.infer<typeof HandoffPacketV1Schema>;

// ---------------------------------------------------------------------------
// SubagentResultPacketV1Schema
// ---------------------------------------------------------------------------
// Output packet a bounded subagent must return on completion.
// Rules follow TDD §12.5.

export const SubagentResultPacketV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    subtaskId: nonEmptyString,
    parentInvocationId: nonEmptyString,
    subagentType: nonEmptyString,
    status: z.enum(["completed", "blocked", "failed"]),
    summary: z.string().min(10, "summary must be at least 10 characters"),
    evidenceRefs: z.array(z.string()),
    changedPaths: z.array(z.string()),
    openQuestions: z.array(z.string()),
    risks: z.array(HandoffRiskSchema),
    nextActions: z.array(z.string()),
    confidence: z.enum(["low", "medium", "high"])
  })
  .superRefine((val, ctx) => {
    // completed subagents must provide evidence refs
    if (val.status === "completed" && val.evidenceRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "evidenceRefs is required for completed subagent results",
        path: ["evidenceRefs"]
      });
    }
  });

export type SubagentResultPacketV1 = z.infer<typeof SubagentResultPacketV1Schema>;

// ---------------------------------------------------------------------------
// ContextPolicySchema
// ---------------------------------------------------------------------------

export const ContextPolicySchema = z.object({
  policyId: nonEmptyString,
  handoffPct: z.number().min(1).max(99).default(70),
  warningPct: z.number().min(1).max(99).default(60),
  hardStopPct: z.number().min(1).max(100).default(80),
  maxTurns: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  appliesTo: z.literal("all_archon_agents")
});

export type ContextPolicyInput = z.input<typeof ContextPolicySchema>;
export type ContextPolicyOutput = z.infer<typeof ContextPolicySchema>;

// ---------------------------------------------------------------------------
// AgentInvocationCreateSchema
// ---------------------------------------------------------------------------
// Input schema for creating a new agent invocation record.

export const AgentInvocationCreateSchema = z.object({
  id: nonEmptyString,
  runId: nonEmptyString,
  taskId: nonEmptyString,
  parentInvocationId: z.string().min(1).optional(),
  role: nonEmptyString,
  agentKind: z.enum(agentKinds),
  model: nonEmptyString,
  effort: z.enum(["high", "medium", "low"]),
  status: z.enum(agentInvocationStatuses),
  contextPolicyId: nonEmptyString,
  sessionId: z.string().min(1).optional(),
  transcriptPath: z.string().min(1).optional(),
  startedAt: nonEmptyString,
  endedAt: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).default({})
});

export type AgentInvocationCreate = z.infer<typeof AgentInvocationCreateSchema>;

// ---------------------------------------------------------------------------
// ContextSampleCreateSchema
// ---------------------------------------------------------------------------

export const ContextSampleCreateSchema = z.object({
  invocationId: nonEmptyString,
  runId: nonEmptyString,
  taskId: nonEmptyString,
  source: z.enum(contextSampleSources),
  usedPercentage: z.number().min(0).max(100).optional(),
  remainingPercentage: z.number().min(0).max(100).optional(),
  currentUsageTokens: z.number().int().nonnegative().optional(),
  contextWindowSize: z.number().int().positive().optional(),
  sampledAt: nonEmptyString,
  raw: z.record(z.unknown()).default({})
});

export type ContextSampleCreate = z.infer<typeof ContextSampleCreateSchema>;
