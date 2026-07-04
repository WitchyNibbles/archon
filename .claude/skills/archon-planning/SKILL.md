---
name: archon-planning
description: Turn substantive work into executable task packets.
---

# Archon Planning

Use when the task is substantive enough that the repo should not jump straight to code.

Goal: produce a plan that is executable, reviewable, and safe to hand off.

1. Restate goal, audience, constraints, risks, unknowns, success criteria, and stop/go.
2. Separate approved assumptions, blocked assumptions, and user questions.
3. Require a reasoning-quality section that captures claim, evidence refs, alternatives, confidence, bounded budgets, and the intended reasoning policy mode (`strict` by default; `dual` or `legacy` only when explicitly justified — modes defined in `.archon/rules/reasoning-quality.md`).
4. For dual or strict work, include reasoning attempts, verification records, and a verdict path instead of leaving critique implicit.
5. Split work by trust boundary and write scope.
6. Define the smallest useful slice first.
7. For each task packet, follow `.archon/templates/task-packet.md` (write it as `.archon/work/tasks/task-<task-id>.md`) and include owner role, completion standard, required specialists, quality gates, scope, acceptance criteria, verification, and review gates.
   - inputs and dependencies
   - allowed write scope
   - out of scope
   - acceptance criteria
   - verification steps
   - required reviews
   - security checks
   - anti-patterns to avoid
   - rollback notes
   - handoff format
8. Require QA and security gates for substantive work.
9. Ensure the plan or task packet names the same current task id used by `.archon/ACTIVE` and the intake brief.

## Rules

- do not treat retrieval hints as canonical facts
- do not produce giant tasks with fuzzy done bars
- do not skip rollback notes
- prefer a thin vertical slice over a roadmap dump
- do not allow planning to continue against a stale active task marker
- do not decompose around a single untested hypothesis when alternatives remain plausible

## Output

Return a concise plan plus task packets or an explicit blocker.
