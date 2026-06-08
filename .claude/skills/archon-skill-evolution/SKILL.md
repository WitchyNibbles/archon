---
name: archon-skill-evolution
description: Create, update, and manage repo-local skills in .archon/skills/.
---

# Archon Skill Evolution

Use when a task surfaces repo-specific knowledge worth preserving.

## When to Use

- A task exposed a non-obvious build/test/deploy pattern for this repo
- The agent was corrected on behavior specific to this repo
- A debugging pattern or error signature emerged that will recur
- A skill was loaded during the task and needs updating

## Procedure

1. Check .archon/skills/ for existing skills in the same domain
2. Follow the preference order below before creating anything new
3. Write or patch using the format in .archon/rules/skill-format.md
4. Keep skill names class-level -- see naming rules

## Preference Order (anti-sprawl -- follow strictly)

1. Patch a skill that was loaded during this task
2. Patch an existing .archon/skills/ skill in the same domain
3. Add a support file (references/, templates/, scripts/) to an existing skill
4. Create a new class-level skill ONLY when nothing else fits

## Naming Rules

- GOOD: typescript-build, staging-deploy, api-auth-debug
- BAD: fix-issue-123, deploy-today, debug-auth-error-2026-06-08

If the name only makes sense for today's task, it is wrong.

## What to Capture

- Non-obvious repo-specific steps (build flags, env var requirements, path quirks)
- Debugging patterns and common error signatures for this codebase
  Agent behavioral corrections: "stop doing X in this repo" -> embed in skill
- Workarounds for repo-specific constraints

## What NOT to Capture

- Environment-dependent failures (missing binaries, unset env vars)
- One-off task narratives that will not recur
- Anything covered by archon's own archon-* skills
