---
name: archon-docs-research
description: Verify APIs, framework behavior, release notes, and standards from official or primary sources.
---

# Archon Docs Research

Use when answering API, framework, library, or standards questions from current documentation.

Goal: answer documentation and standards questions with current, source-backed evidence.

1. Identify the exact question and the relevant official source.
2. Retrieve current documentation (not cached assumptions).
3. Note the version and date of the documentation consulted.
4. Flag when docs are ambiguous, out of date, or contradict implementation behavior.
5. Cite the source with enough specificity to be re-checked.

## Rules

- always cite the source and version for documentation claims
- do not treat blog posts or Stack Overflow as authoritative without corroboration from official docs
- do not claim "it's documented" without a verifiable reference
- flag deprecation notices instead of ignoring them

## Output

Return the answer, the source citation with version, and any ambiguity or deprecation caveats.
