---
name: archon-frontend-taste
description: Use when designing or reviewing visible UI and you need to avoid default AI-generated layouts, weak hierarchy, generic spacing, or interchangeable styling.
---

# Archon Frontend Taste

Use for UI-affecting work where visual quality matters.

Goal: produce interfaces that look intentional, differentiated, and implementation-ready instead of generic model output.

1. Start from the user task and information hierarchy, not from a stock hero/feature grid pattern.
2. Pick a concrete visual direction before writing code: typography, spacing rhythm, palette, density, and motion tone.
3. Reject default AI patterns:
   - generic gradient hero
   - default sans stack with no reason
   - weak section hierarchy
   - decorative cards with no content structure
   - mobile layout treated as a shrink of desktop
4. Make the layout legible in three passes:
   - scan from far away: hierarchy is obvious
   - scan at component level: spacing and grouping are consistent
   - scan on mobile: composition still feels intentional
5. When changing existing UI, preserve the product's established visual language unless the task explicitly calls for redesign.
6. Before handoff, state the intended visual direction in one or two sentences and verify it in the browser.
7. Apply the repo-local frontend quality rubric before approval (`.archon/rules/frontend-quality-rubric.md`).

## Heuristics

- prefer one strong idea over many weak decorative ideas
- use fewer visual motifs with better consistency
- typography must do real work, not act as a default placeholder
- motion should clarify entry, hierarchy, or state change
- if a page could plausibly belong to any SaaS landing page, it is too generic
- mobile layout must feel composed, not merely scaled down

## Output

Return visual direction, core layout decisions, anti-generic checks performed, and browser verification notes.
