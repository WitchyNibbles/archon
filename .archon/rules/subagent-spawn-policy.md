# Subagent Spawn Policy

## Purpose

Govern when the orchestrator may spawn subagents, what write scope they inherit,
and how they must report back.

## Spawn conditions

An orchestrator MAY spawn a subagent only when ALL of the following hold:

1. An active archon task is present in `.archon/ACTIVE` and `.archon/work/task-queue.json`.
2. The orchestrator's context budget state is `normal` or `warning` (not `handoff_required`
   or `hard_stop`). An agent approaching context limits must hand off rather than spawn.
3. The subagent prompt explicitly declares the task id and the bounded write scope it
   will operate within (a strict subset of the parent task's `allowedWriteScope`).
4. The subagent does not receive a wider write scope than the orchestrator's own scope.

## Scope inheritance rules

- Subagents inherit a NARROWER or EQUAL write scope — never wider.
- The orchestrator must pass `allowedWriteScope` explicitly in the subagent prompt.
- Subagents must not modify `.archon/ACTIVE`, task packets, or review artifacts
  unless those paths are explicitly listed in their received scope.
- `.archon/memory/` is always excluded from subagent scope.

## Isolation modes

| Mode        | When to use                                                   |
|-------------|---------------------------------------------------------------|
| `inline`    | Short, bounded tasks; shared context; no git operations       |
| `worktree`  | Independent slices; parallel execution; may include git ops   |

Use `isolation: "worktree"` in the Agent tool call when the subagent will perform
independent file writes that might conflict with the parent's working tree.

## Subagent output contract

Every subagent MUST produce one of:

- **Completion report**: lists files written, tests run, and verification evidence.
- **Blocker report**: states the exact blocker, what was tried, and what scope is needed.

The orchestrator MUST NOT claim task completion based on subagent silence or a
vague "done" message — it must read the explicit report.

## Deadlock prevention

- Do not spawn a subagent to resolve a scope blocker: escalate to the user instead.
- Do not spawn a subagent whose only job is to spawn further subagents.
- Do not create circular task dependencies between subagents.
- Each subagent must have an explicit stop condition in its prompt.

## Parallel spawn limit

No more than 5 subagents may be active simultaneously for a single orchestrator
invocation. Beyond this limit, serialise remaining work or create a successor task.
