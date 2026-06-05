---
name: archon-accessibility-gate
description: Use when UI work needs an accessibility-focused verification pass before QA or release approval.
---

# Archon Accessibility Gate

Use for UI review and QA where accessibility is part of done, not a post-hoc note.

Goal: catch obvious accessibility regressions before approval and force specific remediation guidance.

1. Check semantics first: headings, landmarks, labels, button/link intent.
2. Check interaction: keyboard reachability, focus visibility, dialog and menu behavior, error and validation messaging.
3. Check visual access: contrast, text resizing resilience, touch target size, non-color state communication.
4. For UI-affecting tasks, require browser evidence instead of prose-only claims.
5. When something is inaccessible, report user impact and repro path, not only the standard violated.

## Anti-patterns

- "accessible enough"
- screenshot-only accessibility review
- contrast claims without checking the actual rendered surface
- relying on placeholders or icon-only affordances without labels

## Output

Return findings with: affected user action, observed issue, likely impact, concrete fix direction.
