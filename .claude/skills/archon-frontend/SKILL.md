---
name: archon-frontend
description: Hub for all frontend work on Archon UIs — tokens, component patterns, design system, visual taste, and quality gates. Use before any CSS, UI component, visual identity, or design-system work. Only invoke on projects with a UI surface.
---

# Archon Frontend

Use this skill as the single entry point for any frontend or UI work. It routes to the right detail skill for each concern.

**Only load this on projects with a UI surface** — backend/infra-only projects skip this cluster entirely.

---

## Skill Chain (in order of use)

| Skill | Question it answers | When to invoke |
|---|---|---|
| `archon-visual-standards` | Exact token values: colors, type scale, spacing, motion curves | Before any CSS or color decision |
| `archon-design-system` | How to build and apply a consistent token system | When adding or extending the token/component system |
| `archon-ui-patterns` | Concrete component implementations (table, kanban, log panel, DAG, metrics) | When implementing specific dashboard components |
| `archon-frontend-taste` | Anti-generic checklist, four non-negotiable quality principles | Before implementation and as the final gate before handoff |

Each detail file is in `.claude/skills/<name>/SKILL.md`.

---

## Quick-reference: when to use which

- **Writing CSS or picking colors** → `archon-visual-standards` first
- **Building a new component** → `archon-ui-patterns` for the pattern, `archon-frontend-taste` for the taste gate
- **Extending the token system** → `archon-design-system`
- **Visual QA / pre-handoff review** → `archon-frontend-taste` anti-generic checklist

---

## Core Non-Negotiables (from archon-frontend-taste)

These four principles must all be present. Any one missing degrades the result:

1. **Aggressive high contrast** — visual hierarchy must parse instantly
2. **Whitespace as signal** — tight internal padding, generous vertical rhythm between sections
3. **Monochrome base + exactly one accent** — indigo (`#6366F1`); never two accent colors
4. **Sharp geometric typography at tight tracking** — Geist Sans + Geist Mono, negative letter-spacing at heading sizes

---

## Hard-Fail Anti-Patterns (block review)

- Gradient fills on cards, panels, or sections
- More than one accent color
- `box-shadow` for elevation on dark surfaces (use luminance steps)
- Border radius > 8px on data/infrastructure UI
- Default system font stack with no stated typographic direction
- Pure `#FFFFFF` body text
- Spacing values not on 8px grid
- Status colors used decoratively (red/green/amber = real state only)
- Motion > 200ms or decorative loops

---

## Recommended Stack

| Layer | Choice |
|---|---|
| Build | Vite 6 |
| Framework | React 19 |
| Routing | TanStack Router v2 |
| Server state | TanStack Query v6 |
| Styling | Tailwind CSS v4 |
| Components | shadcn/ui (Radix primitives) |
| Charts | Tremor + Recharts v3 |
| Graph/DAG | React Flow v12 + Dagre |
| Animation | motion/react |
| Typography | Geist Sans + Geist Mono |

---

## Output

When applying this skill, state:
- Which detail skill was used and why
- Visual direction declared (surface, accent, type, density, motion)
- Anti-generic checklist: pass/fail per item
- Browser verification confirmed before handoff
