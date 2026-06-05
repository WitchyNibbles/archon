---
name: archon-architecture
description: Architecture boundaries and sequencing for archon.
---

# Archon Architecture

Use for architecture decisions that shape planning or worker routing.

Goal: a thin-slice design that fits repo reality.

1. Identify source-of-truth layers.
2. Map components and data flow.
3. Call out trust boundaries and migration risk.
4. Mark decisions as reversible or expensive.
5. End with the smallest safe first slice.

## Rules

- canonical policy stays in repo markdown
- operational state stays explicit
- retrieval stays derived and rebuildable
- do not introduce hidden durable authority
- do not add distributed complexity without a concrete need

## Output

Return boundaries, risks, reversible decisions, expensive decisions, and the first slice.
