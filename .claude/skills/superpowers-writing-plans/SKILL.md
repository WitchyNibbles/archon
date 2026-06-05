---
name: superpowers-writing-plans
description: Repo-local wrapper for planning discipline. Use when a request needs sharper task packets, clearer done bars, and explicit verification before execution starts.
---

# Superpowers Writing Plans

Use when turning a request into a plan, brief, or task packet.

Goal: produce plans that are executable, testable, and hard to misread.

1. Define the goal, success criteria, constraints, and main risk.
2. Separate facts, assumptions, and open questions.
3. Split work by ownership and trust boundary, not by arbitrary file count.
4. Give each task a concrete done bar:
   - outputs
   - verification
   - required reviews
   - rollback notes
5. Keep plans small enough that a worker can complete one slice without hidden dependencies.

## Anti-patterns

- vague "implement X"
- giant mixed-scope tasks
- no verification step
- no explicit owner or write scope

## Output

Return:
- task breakdown
- risks and assumptions
- verification plan
- completion gates
