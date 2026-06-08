# Repo-Local Skill Format

Repo-local skills live in `.archon/skills/<category>/<name>/SKILL.md`.
Format is agentskills.io-compatible with an optional archon extension block.

## SKILL.md Template

```yaml
---
name: <hyphen-separated-class-name>
description: One line describing what this skill covers.
version: 1.0.0
metadata:
  hermes:
    tags: [tag1, tag2]
    category: build|deploy|debug|review|api|test
  archon:
    created_by: agent
    task_id: <task-id>
    review_exempt: false
---

# Skill Title

## When to Use
Trigger conditions for this skill.

## Procedure
1. Step one
2. Step two

## Pitfalls
- Common failure modes specific to this repo.

## Verification
How to confirm it worked.
```

## Naming Rules

Names MUST be class-level:
- GOOD: typescript-build, staging-deploy, api-auth-debug, e2e-setup
- BAD: fix-issue-123, deploy-2026-06-08, debug-auth-error-today

If the name only makes sense for one task, fall back to patching an existing skill
or adding a support file.

## Support Files

- references/<topic>.md -- error transcripts, API doc excerpts, domain notes
- templates/<name>.<ext> -- starter files to copy and modify
- scripts/<name>.<ext> -- re-runnable verification scripts

## Skill Review Preference Order

Before creating a new skill:
1. Patch a skill loaded during this task
2. Patch an existing .archon/skills/ skill in the same domain
3. Add a support file to an existing skill
4. Create a new class-level skill (last resort)
