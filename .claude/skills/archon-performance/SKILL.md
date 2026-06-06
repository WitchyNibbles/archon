---
name: archon-performance
description: Use when a task carries the performance_check_required quality gate or touches latency-sensitive code paths, indexing, large data, or throughput-critical operations.
---

# Archon Performance

Use when the task requires the `performance_check_required` quality gate or touches latency, throughput, indexing, or large data paths.

Goal: produce a baseline-before/measurement-after record that makes performance claims falsifiable.

1. Identify the specific boundary: API response time, query cost, index scan count, throughput cap, memory footprint.
2. Capture the baseline metric before any change: profiler output, query EXPLAIN ANALYZE, load test p50/p95/p99, or trace duration.
3. Make one change at a time. Re-measure after each change before moving to the next.
4. Flag any regression >10% as a blocking finding — do not proceed until it is understood and justified.
5. Record for every measurement: metric name, baseline value, post-change value, measurement command or tool used, and environment.
6. Prefer replayable evidence: a command that can be re-run, not a screenshot of a one-off profiler run.

## Gate requirement

A task with `performance_check_required` is not complete without at least one before/after measurement with a replayable command.

## Anti-patterns

- "It feels faster" without a number
- Measuring production under load as the baseline (too noisy)
- Optimizing without first confirming the target path is actually hot
- Accepting a regression because the feature matters more
- Measuring only the happy path without checking edge-case query costs
