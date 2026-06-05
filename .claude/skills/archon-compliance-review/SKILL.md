---
name: archon-compliance-review
description: Compliance-oriented review of controls, auditability, operator evidence, and regulated-surface discipline.
---

# Archon Compliance Review

Use when the task touches policy controls, authenticated review evidence, audit trails, regulated workflows, or operator attestations.

Goal: verify that control claims are backed by shipped artifacts, runtime evidence, and clear operator procedures.

1. Restate the control claim or regulated surface.
2. Identify the authoritative evidence: runtime records, shipped rules or templates, operator docs, review artifacts.
3. Check traceability from claim to evidence.
4. Call out missing approvals, ambiguous ownership, and weak audit trails.
5. Separate control gaps from implementation bugs.
6. Record residual compliance risk plainly.

## Rules

- do not approve undocumented operator-sensitive flows
- do not treat narrative docs as enough when runtime authority is required
- findings must name the affected control surface and missing evidence

## Output

Return findings first, then affected control surface, missing evidence, and required follow-up.
