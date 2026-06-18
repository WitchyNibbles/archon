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

- The `ContextBudgetMonitor` emits a `handoff_required` or `hard_stop` event.
- The PreToolUse hook returns a context-guard block message.
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

Call `mcp__archon__create_handoff` with:

```json
{
  "invocationId": "<current invocation id>",
  "taskId": "<active task id>",
  "summary": "<plain text summary of completed work>",
  "nextSteps": ["<step 1>", "<step 2>", "..."],
  "artifacts": ["<path1>", "<path2>", "..."]
}
```

### 5. Update task state

Write a brief note to `.archon/work/product-state.md` recording:
- What was completed in this invocation.
- The handoff artifact id (returned by `mcp__archon__create_handoff`).

### 6. Stop

Output the handoff artifact id and stop. Do NOT attempt further tool calls.
The successor agent will read the handoff via `mcp__archon__get_handoff`.

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
