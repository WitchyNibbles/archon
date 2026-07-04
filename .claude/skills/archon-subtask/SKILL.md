---
name: archon-subtask
description: Use when the orchestrator needs to delegate a bounded, parallelisable work slice to a subagent — spawn-policy triggers include independent file sets that can run in parallel, risky work needing worktree isolation, and staying within child-depth / concurrency / per-task spawn limits. Enforces the subagent spawn policy and collects the result before claiming progress.
---

# Archon Subtask

## Purpose

Spawn a correctly-scoped subagent for a bounded work slice, enforce the
subagent spawn policy (`.archon/rules/subagent-spawn-policy.md`), and collect the
result before claiming progress.

## When to invoke

- A task phase can be parallelised across independent file sets.
- The orchestrator's context budget is `normal` or `warning` (never spawn at
  `handoff_required` or `hard_stop` — use `/archon-handoff` instead).
- The work slice has a clear, verifiable output (files written + tests passed).

## Pre-spawn checklist

Before calling the Agent tool, verify:

- [ ] Active task id is set in `.archon/ACTIVE`.
- [ ] Orchestrator context budget state is `normal` or `warning`.
- [ ] Subagent write scope is a strict subset of the orchestrator's `allowedWriteScope`.
- [ ] Subagent prompt contains: task id, bounded write scope, explicit stop condition.
- [ ] No more than 4 other subagents are currently active.

## Skill steps

### 1. Define the slice

State in plain text:
- What the subagent must produce (file paths + passing tests).
- What it must NOT touch (paths outside its scope).
- Its stop condition (e.g. "stop after writing X and running Y").

### 2. Compose the subagent prompt

Include these sections in the prompt:

```
Task id: <active task id>
Write scope: <comma-separated subset of parent allowedWriteScope>
Goal: <one-sentence description>
Steps: <numbered list>
Stop condition: <explicit criterion>
Output required: <list of files + verification evidence>
```

### 3. Choose isolation mode

| Mode        | When                                               |
|-------------|-----------------------------------------------------|
| `inline`    | Short, no git ops, no parallel file conflicts       |
| `worktree`  | Independent slice, may involve git ops or conflicts |

### 4. Spawn the subagent

Use the `Agent` tool with `subagent_type` matching the relevant role from
`.claude/agents/` (e.g. `backend-engineer`, `frontend-designer`).

Set `isolation: "worktree"` when the slice is independent and git-safe.

### 5. Collect the result

The subagent MUST return one of:

- **Completion report**: files written, tests run, verification evidence.
- **Blocker report**: exact blocker, what was tried, scope needed.

Do NOT interpret silence or a vague "done" as completion.

### 6. Record progress

After the subagent completes:
- Update `.archon/work/product-state.md` with what was completed.
- If verification evidence is present, note it for the Stop hook.

## Output contract

```
Subagent result: <completed | blocked>
Files written: <list>
Verification: <command run + outcome>
```

## Anti-patterns

- Do NOT spawn at `handoff_required` or `hard_stop`.
- Do NOT give the subagent a wider write scope than the orchestrator.
- Do NOT accept a vague "done" from a subagent — require explicit output.
- Do NOT spawn a subagent whose sole job is to spawn more subagents.
- Do NOT create circular dependencies between subagent slices.
