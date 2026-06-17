// Handoff MCP Tools — Phase 3 of the Archon Agentic Loop Runtime.
//
// Provides four MCP tools for agent handoff lifecycle management:
//   archon_handoff_prepare   — mark invocation handoff_requested; return template
//   archon_handoff_commit    — validate and persist handoff packet
//   archon_context_sample    — record current context usage
//   archon_next_action       — ask runtime what action is allowed now
//
// Registration: import createHandoffToolDefinitions and loop in server.ts.

import { z } from "zod";
import type { McpToolDefinition } from "./tools.ts";
import { HandoffController } from "../runtime/handoff-controller.ts";
import type { HandoffStoreLike } from "../runtime/handoff-controller.ts";
import { HandoffPacketV1Schema } from "../domain/handoff-schemas.ts";
import { handoffReasons } from "../domain/types.ts";
import type { ContextBudgetStoreLike } from "../runtime/context-budget.ts";
import { ContextBudgetMonitor } from "../runtime/context-budget.ts";

// ---------------------------------------------------------------------------
// Combined store surface needed by handoff tools
// ---------------------------------------------------------------------------

export interface HandoffToolSurface {
  handoffStore: HandoffStoreLike;
  contextStore: ContextBudgetStoreLike;
}

// ---------------------------------------------------------------------------
// createHandoffToolDefinitions — factory
// ---------------------------------------------------------------------------

export function createHandoffToolDefinitions(
  surface: HandoffToolSurface
): readonly McpToolDefinition[] {
  const controller = new HandoffController(surface.handoffStore);
  const monitor = new ContextBudgetMonitor(surface.contextStore);

  return [
    // -----------------------------------------------------------------------
    // archon_handoff_prepare
    // -----------------------------------------------------------------------
    {
      name: "archon_handoff_prepare",
      description:
        "Mark an agent invocation as handoff_requested and return a handoff template. " +
        "Call this when context reaches 70% or at a role boundary. " +
        "The returned template must be filled in and submitted via archon_handoff_commit.",
      inputSchema: {
        invocationId: z.string().trim().min(1),
        runId: z.string().trim().min(1),
        taskId: z.string().trim().min(1),
        fromRole: z.string().trim().min(1),
        toRole: z.string().trim().min(1),
        reason: z.enum(handoffReasons),
        contextUsedPct: z.number().min(0).max(100).optional()
      },
      async invoke(input) {
        const invocationId = String(input["invocationId"] ?? "");
        const runId = String(input["runId"] ?? "");
        const taskId = String(input["taskId"] ?? "");
        const fromRole = String(input["fromRole"] ?? "");
        const toRole = String(input["toRole"] ?? "");
        const rawReason = input["reason"];
        const contextUsedPct =
          typeof input["contextUsedPct"] === "number"
            ? input["contextUsedPct"]
            : undefined;

        // Validate reason is a known enum value
        const reasonParse = z.enum(handoffReasons).safeParse(rawReason);
        if (!reasonParse.success) {
          throw new Error(
            `archon_handoff_prepare: invalid reason '${String(rawReason)}'. ` +
              `Must be one of: ${handoffReasons.join(", ")}`
          );
        }

        const result = await controller.prepare({
          invocationId,
          runId,
          taskId,
          fromRole,
          toRole,
          reason: reasonParse.data,
          contextUsedPct
        });

        const summary =
          `Invocation ${invocationId} transitioned to handoff_requested. ` +
          `Handoff ID: ${result.template.handoffId}. ` +
          `Fill in the template and submit via archon_handoff_commit.`;

        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: {
            newStatus: result.newStatus,
            template: result.template
          }
        };
      }
    },

    // -----------------------------------------------------------------------
    // archon_handoff_commit
    // -----------------------------------------------------------------------
    {
      name: "archon_handoff_commit",
      description:
        "Validate and persist a completed handoff packet. " +
        "The packet must conform to HandoffPacketV1Schema. " +
        "On success the invocation is transitioned to handoff_written.",
      inputSchema: {
        invocationId: z.string().trim().min(1),
        packet: z.record(z.unknown())
      },
      async invoke(input) {
        const invocationId = String(input["invocationId"] ?? "");
        const rawPacket = input["packet"];

        // Run the Zod schema to give an early structured error message.
        const preCheck = HandoffPacketV1Schema.safeParse(rawPacket);
        if (!preCheck.success) {
          const messages = preCheck.error.issues
            .map((issue) => `[${issue.path.join(".")}] ${issue.message}`)
            .join("; ");
          throw new Error(`archon_handoff_commit: validation failed — ${messages}`);
        }

        const result = await controller.commit({ invocationId, rawPacket });

        const summary =
          `Handoff packet ${result.record.id} committed. ` +
          `Invocation ${invocationId} is now ${result.newStatus}.`;

        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: {
            newStatus: result.newStatus,
            record: {
              id: result.record.id,
              runId: result.record.runId,
              taskId: result.record.taskId,
              fromRole: result.record.fromRole,
              toRole: result.record.toRole,
              reason: result.record.reason,
              status: result.record.status,
              createdAt: result.record.createdAt
            }
          }
        };
      }
    },

    // -----------------------------------------------------------------------
    // archon_context_sample
    // -----------------------------------------------------------------------
    {
      name: "archon_context_sample",
      description:
        "Record the current context window usage for an agent invocation. " +
        "Call this periodically to let the runtime track context budget and " +
        "trigger handoff requirements when usage reaches 70%.",
      inputSchema: {
        invocationId: z.string().trim().min(1),
        runId: z.string().trim().min(1),
        taskId: z.string().trim().min(1),
        usedPercentage: z.number().min(0).max(100),
        source: z
          .enum(["sdk", "statusline", "transcript", "auto", "precompact"])
          .optional(),
        currentUsageTokens: z.number().int().nonnegative().optional(),
        contextWindowSize: z.number().int().positive().optional()
      },
      async invoke(input) {
        const invocationId = String(input["invocationId"] ?? "");
        const runId = String(input["runId"] ?? "");
        const taskId = String(input["taskId"] ?? "");
        const usedPercentage =
          typeof input["usedPercentage"] === "number" ? input["usedPercentage"] : 0;
        const source =
          typeof input["source"] === "string"
            ? (input["source"] as "sdk" | "statusline" | "transcript" | "auto" | "precompact")
            : "auto";

        const rawData: Record<string, unknown> = {};
        if (typeof input["currentUsageTokens"] === "number") {
          rawData["currentUsageTokens"] = input["currentUsageTokens"];
        }
        if (typeof input["contextWindowSize"] === "number") {
          rawData["contextWindowSize"] = input["contextWindowSize"];
        }

        const newState = await monitor.recordSample(
          invocationId,
          runId,
          taskId,
          source,
          usedPercentage,
          rawData
        );

        const needsHandoff = newState === "handoff_required" || newState === "hard_stop";
        const summary = needsHandoff
          ? `Context at ${usedPercentage.toFixed(1)}% (${newState}). ` +
            `Call archon_handoff_prepare immediately before using any other tool.`
          : `Context at ${usedPercentage.toFixed(1)}% (${newState}). Continuing.`;

        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: {
            invocationId,
            usedPercentage,
            state: newState,
            needsHandoff
          }
        };
      }
    },

    // -----------------------------------------------------------------------
    // archon_next_action
    // -----------------------------------------------------------------------
    {
      name: "archon_next_action",
      description:
        "Ask the runtime what action is currently allowed for an invocation. " +
        "Returns whether the invocation may proceed, must commit a handoff, or is blocked.",
      inputSchema: {
        invocationId: z.string().trim().min(1),
        toolName: z.string().trim().min(1).optional()
      },
      async invoke(input) {
        const invocationId = String(input["invocationId"] ?? "");
        const toolName =
          typeof input["toolName"] === "string" ? input["toolName"] : "unknown_tool";

        const decision = await monitor.evaluatePreToolUse(invocationId, toolName);
        const state = await monitor.getStateFromStore(invocationId);

        let requiredAction: string;
        let allowedTools: string[];
        let message: string;

        if (decision.decision === "allow") {
          requiredAction = "proceed";
          allowedTools = ["any"];
          message = `Invocation ${invocationId} may proceed. Context state: ${state}.`;
        } else {
          requiredAction = "commit_handoff_packet";
          allowedTools = [
            "archon_handoff_prepare",
            "archon_handoff_commit",
            "archon_context_sample"
          ];
          message =
            decision.reason ??
            `Context state is ${state}. Commit a handoff packet before using other tools.`;
        }

        return {
          content: [{ type: "text" as const, text: message }],
          structuredContent: {
            allowed: decision.decision === "allow",
            reason: state,
            required_action: requiredAction,
            allowed_tools: allowedTools,
            message
          }
        };
      }
    }
  ];
}
