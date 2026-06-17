// Debate MCP Tools — Phase 5 of the Archon Agentic Loop Runtime.
//
// Provides three MCP tools for multi-agent debate lifecycle:
//   archon_debate_start     — create a new debate session
//   archon_debate_argument  — submit one argument to an open session
//   archon_debate_decision  — record the final decision on a session
//
// Registration: import createDebateToolDefinitions and add to server.ts.

import { z } from "zod";
import type { McpToolDefinition } from "./tools.ts";
import type { DebateStoreLike } from "../runtime/debate-controller.ts";
import { DebateController } from "../runtime/debate-controller.ts";

// ---------------------------------------------------------------------------
// createDebateToolDefinitions — factory
// ---------------------------------------------------------------------------

export function createDebateToolDefinitions(
  store: DebateStoreLike
): readonly McpToolDefinition[] {
  const controller = new DebateController(store);

  return [
    // -----------------------------------------------------------------------
    // archon_debate_start
    // -----------------------------------------------------------------------
    {
      name: "archon_debate_start",
      description:
        "Create a new multi-agent debate session for an active run. " +
        "Validates that the trigger kind warrants a debate (returns an error " +
        "if the kind is in the skip list). Returns the session ID on success.",
      inputSchema: {
        runId: z.string().trim().min(1),
        taskId: z.string().trim().optional(),
        topic: z.string().trim().min(1),
        triggerKind: z.enum([
          "architecture_significant",
          "security_trust_boundary",
          "migration_data_loss",
          "high_uncertainty",
          "product_behavior_ambiguous",
          "release_blocking_disagreement",
          "trivial_edit",
          "obvious_test_fix",
          "formatting_only",
          "already_approved"
        ])
      },
      async invoke(input) {
        const runId = String(input["runId"] ?? "");
        const rawTaskId = input["taskId"];
        const taskId =
          typeof rawTaskId === "string" && rawTaskId.trim().length > 0
            ? rawTaskId.trim()
            : undefined;
        const topic = String(input["topic"] ?? "");
        const triggerKind = String(input["triggerKind"] ?? "") as Parameters<
          typeof controller.shouldDebate
        >[0]["kind"];

        const trigger = { kind: triggerKind };
        if (!controller.shouldDebate(trigger)) {
          throw new Error(
            `archon_debate_start: trigger kind '${triggerKind}' does not require debate`
          );
        }

        const session = await controller.start({ runId, taskId, topic, triggerKind });

        const summary =
          `Debate session '${session.id}' created for run '${runId}'. ` +
          `Topic: ${topic}. Trigger: ${triggerKind}.`;

        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: {
            sessionId: session.id,
            runId: session.runId,
            taskId: session.taskId ?? null,
            topic: session.topic,
            triggerKind: session.triggerKind,
            status: session.status,
            createdAt: session.createdAt
          }
        };
      }
    },

    // -----------------------------------------------------------------------
    // archon_debate_argument
    // -----------------------------------------------------------------------
    {
      name: "archon_debate_argument",
      description:
        "Submit one argument to an open debate session. " +
        "Each argument carries a role, round number, position statement, " +
        "optional evidence references, optional critiques, and an optional vote. " +
        "Role and position must be non-empty.",
      inputSchema: {
        sessionId: z.string().trim().min(1),
        role: z.string().trim().min(1),
        round: z.number().int().positive(),
        position: z.string().trim().min(1),
        evidenceRefs: z.array(z.string()).default([]),
        critiques: z.array(z.string()).default([]),
        vote: z
          .enum(["approve", "approve_with_conditions", "rework", "reject"])
          .optional()
      },
      async invoke(input) {
        const sessionId = String(input["sessionId"] ?? "");
        const role = String(input["role"] ?? "");
        const round =
          typeof input["round"] === "number" && input["round"] > 0
            ? Math.floor(input["round"])
            : 1;
        const position = String(input["position"] ?? "");

        const evidenceRefs = Array.isArray(input["evidenceRefs"])
          ? (input["evidenceRefs"] as unknown[]).map(String)
          : [];
        const critiques = Array.isArray(input["critiques"])
          ? (input["critiques"] as unknown[]).map(String)
          : [];

        const rawVote = input["vote"];
        const allowedVotes = new Set(["approve", "approve_with_conditions", "rework", "reject"]);
        const vote =
          typeof rawVote === "string" && allowedVotes.has(rawVote)
            ? (rawVote as "approve" | "approve_with_conditions" | "rework" | "reject")
            : undefined;

        await controller.addArgument(sessionId, {
          role,
          round,
          position,
          evidenceRefs,
          critiques,
          vote
        });

        const summary =
          `Argument by '${role}' (round ${round}) recorded for session '${sessionId}'.`;

        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: {
            sessionId,
            role,
            round,
            recorded: true
          }
        };
      }
    },

    // -----------------------------------------------------------------------
    // archon_debate_decision
    // -----------------------------------------------------------------------
    {
      name: "archon_debate_decision",
      description:
        "Record the final decision on a debate session. " +
        "Outcome must be one of: approved, approved_with_conditions, " +
        "rework_required, rejected. Dissent owner must be non-empty. " +
        "At least one evidence reference is required.",
      inputSchema: {
        sessionId: z.string().trim().min(1),
        outcome: z.enum([
          "approved",
          "approved_with_conditions",
          "rework_required",
          "rejected"
        ]),
        voteApprove: z.number().int().min(0).default(0),
        voteRework: z.number().int().min(0).default(0),
        voteReject: z.number().int().min(0).default(0),
        dissentOwner: z.string().trim().min(1),
        dissentSummary: z.string().trim().min(1),
        conditions: z.array(z.string()).default([]),
        evidenceRefs: z.array(z.string()).min(1)
      },
      async invoke(input) {
        const sessionId = String(input["sessionId"] ?? "");
        const outcome = String(input["outcome"] ?? "") as
          | "approved"
          | "approved_with_conditions"
          | "rework_required"
          | "rejected";

        const voteApprove =
          typeof input["voteApprove"] === "number" ? Math.floor(input["voteApprove"]) : 0;
        const voteRework =
          typeof input["voteRework"] === "number" ? Math.floor(input["voteRework"]) : 0;
        const voteReject =
          typeof input["voteReject"] === "number" ? Math.floor(input["voteReject"]) : 0;

        const dissentOwner = String(input["dissentOwner"] ?? "");
        const dissentSummary = String(input["dissentSummary"] ?? "");

        const conditions = Array.isArray(input["conditions"])
          ? (input["conditions"] as unknown[]).map(String)
          : [];
        const evidenceRefs = Array.isArray(input["evidenceRefs"])
          ? (input["evidenceRefs"] as unknown[]).map(String)
          : [];

        await controller.finalizeDecision(sessionId, {
          outcome,
          vote: { approve: voteApprove, rework: voteRework, reject: voteReject },
          dissent: { owner: dissentOwner, summary: dissentSummary },
          conditions,
          evidenceRefs
        });

        const summary =
          `Decision '${outcome}' recorded for debate session '${sessionId}'. ` +
          `Dissent owner: ${dissentOwner}.`;

        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: {
            sessionId,
            outcome,
            recorded: true
          }
        };
      }
    }
  ];
}
