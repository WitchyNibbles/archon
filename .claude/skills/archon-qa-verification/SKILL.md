---
name: archon-qa-verification
description: QA gates and verification matrices.
---

# Archon QA Verification

Use when a task needs a verification plan or blocking QA gate.

Goal: make completion claims falsifiable.

1. Restate the acceptance criteria.
2. Build a lean matrix for happy, edge, failure, and regression paths.
3. If retrieval or memory changed, add provenance, freshness, and authority checks.
   - contradiction handling
   - redaction or exposure boundaries
4. Prefer replayable commands and precise repro steps.
5. Call out missing acceptance criteria instead of inventing them.

## Rules

- do not approve vague "looks good" work
- do not skip setup/install verification when packaging or bootstrapping changed
- keep the verification set lean but real

## Output

Return the verification matrix, the exact commands, and any blocking gap.
