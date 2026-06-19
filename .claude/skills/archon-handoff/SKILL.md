# Archon Handoff

**Trigger domain**: invoked when the agent's context budget reaches `handoff_required`
or `hard_stop`, or when the operator explicitly requests a context handoff.

**Skill ID**: `archon-handoff`

**Invocation**: `/archon-handoff`

---

## Purpose

Produce a well-structured handoff artifact that allows a successor agent to resume
work without loss of context, then stop cleanly so the context window is not
exhausted.

## When to invoke

- The `ContextBudgetMonitor` reaches `handoff_required` or `hard_stop` (the
  managed loop's `onContextSample` returns that action).
- `archon_next_action` reports the invocation may not proceed and must commit a
  handoff.
- The operator runs `/archon-handoff` manually to snapshot progress.

## Skill steps

### 1. Assess current state

Read the active task from `.archon/ACTIVE` and the task packet from
`.archon/work/tasks/task-<id>.md`.  Summarise what has been completed and what
remains.

### 2. Collect artifact paths

List all files written or modified in the current invocation.  Include paths that
were created but not yet verified.

### 3. Draft next steps

Write an ordered list of remaining actions.  Each step must be:
- Atomic (completable in a single agent turn).
- Unambiguous (no "continue as before" references).
- Scoped (references only paths in the task's `allowedWriteScope`).

### 4. Commit the handoff

Use the two-step prepare → commit flow:

**Step 4a — prepare** (marks the invocation as handoff_requested and returns a packet template):

Call `mcp__archon__archon_handoff_prepare` with:

```json
{
  "invocationId": "<current invocation id>",
  "runId": "<active run id>",
  "taskId": "<active task id>",
  "fromRole": "<current role>",
  "toRole": "<successor role, default same role>",
  "reason": "context_threshold_70",
  "contextUsedPct": 72
}
```

**Step 4b — commit** (validates and persists the full handoff packet):

Call `mcp__archon__archon_handoff_commit` with `{ invocationId, packet }`, where
`packet` conforms to `HandoffPacketV1` (see `.archon/rules/context-handoff.md`):

```json
{
  "invocationId": "<current invocation id>",
  "packet": {
    "schemaVersion": 1,
    "handoffId": "<unique handoff id>",
    "runId": "<active run id>",
    "taskId": "<active task id>",
    "fromInvocationId": "<current invocation id>",
    "fromRole": "<current role>",
    "toRole": "<successor role, default same role>",
    "reason": "context_threshold_70",
    "contextUsedPct": 72,
    "status": "needs_followup",
    "summary": "<plain-text summary of completed work, >= 10 chars>",
    "scope": {
      "allowedWriteScope": ["<path glob>"],
      "touchedPaths": ["<path1>", "<path2>"],
      "lockedPaths": []
    },
    "decisions": [],
    "openQuestions": [],
    "evidenceRefs": ["<test/log/artifact ref>"],
    "nextActions": ["<step 1>", "<step 2>"],
    "risks": [],
    "createdAt": "<ISO-8601 timestamp>"
  }
}
```

Validation notes: `summary` must be at least 10 characters; `evidenceRefs` is
required unless `status` is `blocked`; `nextActions` is required unless `status`
is `completed`; `contextUsedPct` is required when `reason` is
`context_threshold_70`.

The commit call returns the persisted handoff id. Record it.

### 5. Update task state

Write a brief note to `.archon/work/product-state.md` recording:
- What was completed in this invocation.
- The handoff artifact id (returned by `mcp__archon__archon_handoff_commit`).

### 6. Stop

Output the handoff artifact id and stop. Do NOT attempt further tool calls.
The successor agent will read the handoff via `mcp__archon__archon_context_bundle`.

## Output contract

```
Handoff committed: <artifact-id>
Completed: <one-line summary>
Remaining: <N> steps — see handoff artifact
```

## Anti-patterns

- Do NOT attempt to "sneak in" one more write after the handoff is committed.
- Do NOT write a vague summary — the successor agent depends on it.
- Do NOT omit artifact paths — the successor cannot verify your work without them.
- Do NOT spawn a subagent to do the handoff — this skill runs in the current thread.
