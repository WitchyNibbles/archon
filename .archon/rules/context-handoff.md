# Context Handoff Policy

## Purpose

Define when and how Archon-managed agents must hand off work when approaching
context window limits. The guarantees in this policy apply to **Archon-managed
invocations** (the daemon / agentic loop / SDK-driven runs). Unmanaged manual
Claude Code sessions are out of contract — see "Enforcement surface" below.

## Thresholds (defaults — override via env vars)

| Threshold       | Default | Env var                        |
|-----------------|---------|--------------------------------|
| `warningPct`    | 60 %    | `ARCHON_CONTEXT_WARNING_PCT`   |
| `handoffPct`    | 70 %    | `ARCHON_CONTEXT_HANDOFF_PCT`   |
| `hardStopPct`   | 80 %    | `ARCHON_CONTEXT_HARD_STOP_PCT` |

## State machine

```
normal → warning → handoff_required → hard_stop
```

Transitions are monotonically upward within a single invocation (no downgrade).
`ContextBudgetMonitor.recordSample` computes the state from each context sample.

## Enforcement surface

Context-budget enforcement is **loop-side**, not interactive-hook-side:

- The managed loop records a context sample each turn via `archon_context_sample`.
  `AgenticLoopController.onContextSample` maps the resulting state to a
  `LoopAction` (`continue` / `warn` / `handoff_required` / `hard_stop`) and the
  loop acts on it.
- An agent can ask the runtime what it may do via `archon_next_action`, which
  returns the allowed action and tool set for the current state.
- The interactive Claude Code `PreToolUse` hook does **not** observe context
  window usage (the hook payload does not expose `used_percentage`), so it does
  not block tools on the 70 % threshold. Interactive sessions rely on the agent
  calling `archon_context_sample` / `archon_next_action`, plus the `PreCompact`
  hook as a last-resort `precompact_fallback` handoff.

## Agent obligations by state

### `warning`

- Agent MAY continue substantive work.
- Agent SHOULD begin writing intermediate checkpoints / evidence refs.
- No action is gated.

### `handoff_required`

- Agent MUST commit a handoff (prepare → commit, below) before continuing
  substantive work.
- In the managed loop, `onContextSample` returns `handoff_required` and the loop
  stops normal work pending a committed handoff.

### `hard_stop`

- Agent MUST stop immediately. No further substantive work is permitted.
- `onContextSample` returns `hard_stop`; a committed handoff does NOT bypass it.

## Monitor mode (`ARCHON_CONTEXT_MONITOR`)

| Value     | Behaviour                                                                |
|-----------|--------------------------------------------------------------------------|
| `enforce` | (default) state transitions are applied as computed                      |
| `observe` | `handoff_required` is downgraded to `warning` — data recorded, no gating |

`hard_stop` is never downgraded by observe mode.

> Caution: `observe` mode disables the 70% handoff gate. It is a rollout /
> diagnostic setting for collecting context-sample data without interrupting
> agents — do not run it in a production agentic loop where agents can be
> adversarially prompted.

## Handoff packet contract

Use the two-step MCP flow:

1. **`archon_handoff_prepare`** — marks the invocation `handoff_requested` and
   returns a packet template. Input:
   `{ invocationId, runId, taskId, fromRole, toRole, reason, contextUsedPct? }`
   where `reason` is one of `context_threshold_70`, `role_boundary`, `blocked`,
   `review_required`, `manual`, `precompact_fallback`, `crash_recovery`.
2. **`archon_handoff_commit`** — validates and persists the packet. Input:
   `{ invocationId, packet }` where `packet` conforms to `HandoffPacketV1`:

| Field            | Rule                                                                 |
|------------------|----------------------------------------------------------------------|
| `schemaVersion`  | `1`                                                                  |
| `handoffId`, `runId`, `taskId` | required                                               |
| `fromInvocationId`, `fromRole`, `toRole` | required (`toRole` defaults to same role)     |
| `reason`         | handoff reason enum (above)                                          |
| `contextUsedPct` | required when `reason === context_threshold_70`                     |
| `status`         | free-form label (e.g. `needs_followup`, `completed`, `blocked`)     |
| `summary`        | required, ≥ 10 chars — no "stuff done, continue pls"                 |
| `scope`          | `{ allowedWriteScope, touchedPaths, lockedPaths }`                  |
| `decisions`, `openQuestions`, `risks` | arrays                                          |
| `evidenceRefs`   | required unless `status === blocked`                                |
| `nextActions`    | required unless `status === completed`                              |
| `subagentResults`| required if subagents were spawned                                  |
| `createdAt`      | required                                                            |

The commit call returns `{ handoffId }`. Record it.

## Successor agent contract

The successor invocation after a handoff:

1. Builds its context via `archon_context_bundle`, which surfaces the latest
   unconsumed handoff packet (compact, not the full transcript).
2. Verifies the packet references the same `taskId`.
3. Resumes from `nextActions` without repeating completed work.
4. Records a new context sample on first substantive tool use.

## Workflow-proof gate (AC11)

The authoritative `workflow-proof` command blocks task completion when a task has
agent invocations and a recorded context sample `>= 70 %` but no committed
handoff. This makes "crossed the threshold and kept going" a hard completion
failure, not a style note.
