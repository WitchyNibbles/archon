---
name: archon-eval-engineering
description: Eval design for agent behavior, graders, benchmark cases, regression sets, and interpretable quality signals.
---

# Archon Eval Engineering

Use when the task adds or changes benchmarks, graders, eval datasets, skill regression checks, or measurable agent-quality claims.

Goal: make agent quality claims fail-able, replayable, and decision-useful.

1. Name the exact behavior being measured.
2. Define the pass or fail condition before adding cases.
3. Separate: deterministic checks, model-graded checks, human-review checkpoints.
4. Cover success, failure, edge, and stale-regression cases.
5. Prefer trace-backed cases when behavior spans multiple turns or tools.
6. Record blind spots, false-positive risk, and false-negative risk.
7. Keep eval output actionable for the next engineering decision.

## Rules

- do not ship vanity metrics
- do not add an eval that cannot meaningfully fail
- treat benchmark freshness and provenance as part of correctness

## Output

Return measured behavior, grader type, case set, failure conditions, rerun commands, and blind spots.
