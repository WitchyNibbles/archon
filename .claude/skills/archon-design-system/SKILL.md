---
name: archon-design-system
description: Use when frontend work needs reusable visual rules, tokens, component consistency, or stronger systemization so UI quality survives beyond a single screen. Pairs with archon-visual-standards (token values) and archon-ui-patterns (component implementations).
---

# Archon Design System

Use when a UI task needs durable consistency across components or screens.

Goal: turn one-off styling into a small system with explicit tokens and repeatable rules — so the UI holds together when the next component is added.

---

## Skill Chain

This skill works in a three-part chain. Use the right one for the right question:

| Skill | Question it answers |
|---|---|
| `archon-visual-standards` | What are the exact token values? (colors, type scale, spacing, motion curves) |
| `archon-design-system` ← this skill | How do I build a consistent token system? How do I organize and apply it? |
| `archon-ui-patterns` | What are the concrete component implementations? (table, kanban, log panel, DAG) |

---

## Token System: Minimum Required Set

Define these before writing any component. If a token set exists, tighten it — don't invent a parallel one.

```
Surface ramp      (4 levels: base → raised → elevated → overlay)
Border system     (2–3 levels: default, emphasis, strong)
Text hierarchy    (4 levels: primary, secondary, muted, inverse)
Accent            (1 color + 1 dark-mode boosted variant + 1 subtle tint)
Status colors     (5 semantic: success, error, warning, running, pending)
Spacing scale     (8px base grid: 4, 8, 12, 16, 24, 32, 48, 64)
Radius scale      (4 levels: none, sm=2, md=4, lg=6 — max 8px for dev tools)
Type scale        (display, h1, h2, h3, body, small, label, code)
Motion durations  (150ms state, 200ms enter — maximum; specific easing curves)
```

For exact values, see `archon-visual-standards`. Never define token values inline in a component — always reference a token name.

---

## Tailwind v4 Token Implementation

Put all tokens in the `@theme` block as CSS custom properties. This is the single source of truth:

```css
@import "tailwindcss";

@theme {
  /* Surface ramp */
  --color-surface-base:      #0A0A0A;
  --color-surface-raised:    #111111;
  --color-surface-elevated:  #1A1A1A;
  --color-surface-overlay:   #222222;

  /* Borders */
  --color-border:            rgba(255, 255, 255, 0.08);
  --color-border-emphasis:   rgba(255, 255, 255, 0.15);
  --color-border-strong:     rgba(255, 255, 255, 0.24);

  /* Text */
  --color-text-primary:      #EDEDED;
  --color-text-secondary:    #A0A0A0;
  --color-text-muted:        #6B6B6B;

  /* Accent */
  --color-accent:            #6366F1;
  --color-accent-bright:     #818CF8;
  --color-accent-subtle:     rgba(99, 102, 241, 0.12);

  /* Status */
  --color-status-success:    #22C55E;
  --color-status-error:      #EF4444;
  --color-status-warning:    #F59E0B;
  --color-status-running:    #06B6D4;
  --color-status-pending:    #6366F1;
  --color-status-muted:      #6B6B6B;

  /* Spacing (if overriding Tailwind defaults) */
  --spacing-1:  4px;
  --spacing-2:  8px;
  --spacing-3: 12px;
  --spacing-4: 16px;
  --spacing-6: 24px;
  --spacing-8: 32px;
}
```

Use Tailwind class names that reference these tokens: `bg-surface-raised`, `text-text-secondary`, `border-border`, `text-accent-bright`.

---

## Component Normalization

When the same UI pattern appears more than once, extract it. Never re-style independently:

| Pattern | Extract to |
|---|---|
| Status dot + label | `StatusBadge` component |
| Authority indicator | `AuthorityBadge` component |
| Run ID / timestamp / count | `MonoMeta` span with `font-mono text-xs text-text-muted` |
| Blocker list | `BlockerBanner` component |
| Section header | `SectionHeader` with consistent padding + Geist Mono label |
| Empty state | `EmptyState` with icon + label + optional action |
| Loading skeleton | `Skeleton` with `bg-surface-elevated animate-pulse` |

Patterns to never re-style per-component: row hover state, card border, badge dot, section dividers.

---

## Dark-First System Architecture

Archon's design system is dark-first — the entire surface ramp defaults to dark. Do not build light-mode first and add dark variants.

Dark mode strategy: `.dark` class toggle on `<html>`, not `prefers-color-scheme` media query — operators need explicit control.

Surface elevation in dark UI uses **luminance, not shadow**:
```
Wrong: box-shadow: 0 4px 12px rgba(0,0,0,0.4) on a dark card
Right: bg-surface-elevated (slightly lighter background) for the elevated surface
```

Never add `box-shadow` to dark surfaces for elevation. The only permitted shadow is a very subtle ambient fill (use `drop-shadow` with <10% opacity only for floating elements like modals, not cards).

---

## Process

1. Audit the existing token surface before defining new tokens. Tighten what exists; don't duplicate.
2. Name tokens by semantic role (`--color-text-secondary`), not raw value (`--color-gray-500`).
3. Apply tokens at the component boundary, not per-property inside components.
4. Normalize repeated patterns to a shared component on second occurrence.
5. Verify the system on: one dense data screen, one empty/sparse state, one mobile viewport.
6. Run `archon-frontend-taste` as the taste check after any token or component change.

---

## Anti-Patterns (Hard Fail)

- ad hoc colors per component (any hardcoded color that isn't a token reference)
- arbitrary spacing values not on the 8px grid
- multiple near-identical token values (consolidate)
- `box-shadow` for elevation on dark UI surfaces
- radius values above 8px on data or infrastructure surfaces
- separate token sets per feature or page
- token names that describe raw value (`--gray-500`) instead of role (`--text-secondary`)
- design system prose with no corresponding code-level token surface

---

## Output

Return:
- Tokens introduced, reused, or consolidated
- Components normalized (and what they replaced)
- Dark-mode verification confirmed
- System gaps or inconsistencies remaining
