// Subtask MCP Tools — Phase 4 of the Archon Agentic Loop Runtime.
//
// Provides two MCP tools for subagent lifecycle management:
//   archon_spawn_subtask   — request a new bounded subagent
//   archon_subtask_result  — record the result packet from a completed subagent
//
// Registration: import createSubtaskToolDefinitions and add to server.ts.

import { z } from "zod";
import type { McpToolDefinition } from "./tools.ts";
import type { SubtaskStoreLike, ParentInvocationStoreLike } from "../runtime/subtask-scheduler.ts";
import { SubtaskScheduler } from "../runtime/subtask-scheduler.ts";

// ---------------------------------------------------------------------------
// Combined store surface needed by subtask tools
// ---------------------------------------------------------------------------

export interface SubtaskToolSurface {
  subtaskStore: SubtaskStoreLike;
  invocationStore: ParentInvocationStoreLike;
}

// ---------------------------------------------------------------------------
// createSubtaskToolDefinitions — factory
// ---------------------------------------------------------------------------

export function createSubtaskToolDefinitions(
  surface: SubtaskToolSurface
): readonly McpToolDefinition[] {
  const scheduler = new SubtaskScheduler(surface.subtaskStore, surface.invocationStore);

  return [
    // -----------------------------------------------------------------------
    // archon_spawn_subtask
    // -----------------------------------------------------------------------
    {
      name: "archon_spawn_subtask",
      description:
        "Request a new bounded subagent for the given parent invocation. " +
        "The runtime validates spawn policy limits (depth, concurrency, total) " +
        "and write-scope containment before creating the subtask. " +
        "Returns the created subtask ID on success.",
      inputSchema: {
        parentInvocationId: z.string().trim().min(1),
        subagentType: z.string().trim().min(1),
        title: z.string().trim().min(1),
        prompt: z.string().trim().min(10),
        allowedTools: z.array(z.string()).default([]),
        allowedWriteScope: z.array(z.string()).default([]),
        maxTurns: z.number().int().positive().default(20),
        stopCondition: z.string().trim().min(1)
      },
      async invoke(input) {
        const parentInvocationId = String(input["parentInvocationId"] ?? "");
        const subagentType = String(input["subagentType"] ?? "");
        const title = String(input["title"] ?? "");
        const prompt = String(input["prompt"] ?? "");
        const stopCondition = String(input["stopCondition"] ?? "");

        const allowedTools = Array.isArray(input["allowedTools"])
          ? (input["allowedTools"] as unknown[]).map(String)
          : [];
        const allowedWriteScope = Array.isArray(input["allowedWriteScope"])
          ? (input["allowedWriteScope"] as unknown[]).map(String)
          : [];
        const maxTurns =
          typeof input["maxTurns"] === "number" && input["maxTurns"] > 0
            ? input["maxTurns"]
            : 20;

        const outcome = await scheduler.requestSubtask(parentInvocationId, {
          subagentType,
          title,
          prompt,
          allowedTools,
          allowedWriteScope,
          maxTurns,
          stopCondition
        });

        if (!outcome.ok) {
          throw new Error(`archon_spawn_subtask: spawn rejected — ${outcome.reason}`);
        }

        const summary =
          `Subtask '${outcome.subtask.id}' created for parent '${parentInvocationId}'. ` +
          `Type: ${subagentType}. Status: ${outcome.subtask.status}.`;

        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: {
            subtaskId: outcome.subtask.id,
            runId: outcome.subtask.runId,
            taskId: outcome.subtask.taskId,
            subagentType: outcome.subtask.subagentType,
            status: outcome.subtask.status,
            createdAt: outcome.subtask.createdAt
          }
        };
      }
    },

    // -----------------------------------------------------------------------
    // archon_subtask_result
    // -----------------------------------------------------------------------
    {
      name: "archon_subtask_result",
      description:
        "Record the result packet from a completed, blocked, or failed subagent. " +
        "The packet must conform to SubagentResultPacketV1Schema. " +
        "The subtask status is set from the packet status field.",
      inputSchema: {
        subtaskId: z.string().trim().min(1),
        packet: z.record(z.unknown())
      },
      async invoke(input) {
        const subtaskId = String(input["subtaskId"] ?? "");
        const rawPacket = input["packet"];

        if (typeof rawPacket !== "object" || rawPacket === null || Array.isArray(rawPacket)) {
          throw new Error(
            `archon_subtask_result: 'packet' must be an object, got ${typeof rawPacket}`
          );
        }

        const outcome = await scheduler.recordResult(
          subtaskId,
          rawPacket as Record<string, unknown>
        );

        if (!outcome.ok) {
          throw new Error(`archon_subtask_result: validation failed — ${outcome.reason}`);
        }

        const summary = `Result packet recorded for subtask '${subtaskId}'.`;

        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: {
            subtaskId,
            recorded: true
          }
        };
      }
    }
  ];
}
