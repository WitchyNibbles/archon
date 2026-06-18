# Context Handoff Policy

## Purpose

Define when and how agents must hand off work when approaching context window limits.

## Thresholds (defaults — override via env vars)

| Threshold       | Default | Env var                       |
|-----------------|---------|-------------------------------|
| `warningPct`    | 60 %    | `ARCHON_CONTEXT_WARNING_PCT`  |
| `handoffPct`    | 70 %    | `ARCHON_CONTEXT_HANDOFF_PCT`  |
| `hardStopPct`   | 80 %    | `ARCHON_CONTEXT_HARD_STOP_PCT`|

## State machine

```
normal → warning → handoff_required → hard_stop
```

Transitions are monotonically upward within a single invocation (no downgrade).

## Agent obligations by state

### `warning`

- Agent MAY continue substantive work.
- Agent SHOULD begin writing intermediate checkpoints.
- No tool blocking is applied.

### `handoff_required`

- Agent MUST call `mcp__archon__create_handoff` before making further
  substantive tool calls.
- The PreToolUse hook blocks non-safe tools until a handoff is committed
  (unless `ARCHON_HANDOFF_ENFORCEMENT=warn` or `=off`).
- Safe tools during `handoff_required`: Read, LS, Glob, Grep, WebSearch, WebFetch.

### `hard_stop`

- Agent MUST stop immediately. No further substantive tool use is permitted.
- The PreToolUse hook blocks non-safe tools unconditionally — a committed
  handoff does NOT bypass the block at `hard_stop`.
- The Stop hook SHOULD surface the context budget state to the operator.

## Enforcement modes (`ARCHON_HANDOFF_ENFORCEMENT`)

| Value   | Behaviour                                             |
|---------|-------------------------------------------------------|
| `block` | (default) Hook blocks non-safe tools                  |
| `warn`  | Hook emits advisory context only — no block           |
| `off`   | Hook check disabled entirely                          |

## Monitor mode (`ARCHON_CONTEXT_MONITOR`)

| Value     | Behaviour                                                                 |
|-----------|---------------------------------------------------------------------------|
| `enforce` | (default) State transitions are applied as computed                       |
| `observe` | `handoff_required` is downgraded to `warning` — data recorded, no block  |

`hard_stop` is never downgraded by observe mode.

## Handoff artifact requirements

A valid handoff artifact recorded via `mcp__archon__create_handoff` must include:

- `invocationId` — the current agent invocation identifier
- `taskId` — the active archon task id
- `summary` — a plain-text summary of work completed so far
- `nextSteps` — an ordered list of remaining actions for the successor agent
- `artifacts` — list of file paths written or modified in this invocation

## Successor agent contract

The successor agent spawned after a handoff:

1. Reads the handoff artifact via `mcp__archon__get_handoff`
2. Verifies the artifact references the same `taskId`
3. Resumes from `nextSteps` without repeating completed work
4. Records a new context sample on first substantive tool use
