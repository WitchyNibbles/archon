---
name: anthropic-webapp-testing
description: Repo-local wrapper for browser-backed web app verification. Use when UI work needs Playwright evidence, assertion discipline, or replayable frontend checks.
---

# Anthropic Webapp Testing

Use for UI-affecting verification where what the user sees must be proved in the browser.

Goal: replace screenshot-only confidence with small, replayable browser checks.

1. Start with the task's UI surface:
   - `visual_change`
   - `interactive_flow`
2. Cover the minimum matrix:
   - desktop viewport
   - mobile viewport
   - one happy path
   - one failure or regression path
3. Prefer snapshot/assertion evidence over prose-only judgment.
4. Keep checks bounded:
   - reuse storage state when possible
   - mock unstable third-party dependencies when needed
   - avoid broad click-through suites for local verification
5. Record Playwright evidence in the QA or E2E handoff, including artifact paths when captured.

## Anti-patterns

- approving UI work without browser evidence
- long-running suites for non-critical local checks
- screenshot-only signoff with no assertion or repro path
- backend-only tasks forced through browser verification

## Output

Return:
- browser matrix covered
- assertions or snapshot checks used
- evidence refs
- remaining browser gaps
