---
name: archon-docs-research
description: Verify APIs, framework behavior, release notes, and standards from official or primary sources.
---

# Archon Docs Research

Use when answering API, framework, library, or standards questions from current documentation.

Goal: answer documentation and standards questions with current, source-backed evidence.

1. Define the exact question.
2. Prefer official docs, release notes, and primary specs.
3. Record version or date when it matters.
4. Separate sourced fact from inference.
5. Record competing interpretations or unresolved drift when the docs are ambiguous or incomplete.
6. When repo-local Grafana configuration is present, use Grafana logs as advisory runtime evidence when they help validate incidents, regressions, or observed behavior. If the configuration is partial or the tool is unavailable, say that explicitly instead of acting like Grafana does not exist.
7. If local repo context matters, read the repo evidence before or alongside external docs.

## Rules

- no blog-first answers when primary docs exist
- do not assume stale behavior is still current
- cite the source used
- do not make strong negative claims from a narrow pass when broader evidence or an alternate interpretation has not been checked
- stop at the evidence boundary instead of filling gaps with confident guesses

## Output

Return concise findings with sources, dates or versions, and any unresolved drift risk.
