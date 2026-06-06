---
name: archon-frontend-taste
description: Use when designing or reviewing visible UI and you need to avoid default AI-generated layouts, weak hierarchy, generic spacing, or interchangeable styling. Enforces the four premium developer-tool design principles derived from Vercel, Linear, Raycast, and Stripe.
---

# Archon Frontend Taste

Use for any UI-affecting work where visual quality matters. Run this skill before writing code, and again as a review gate before handoff.

Goal: produce interfaces that look intentional, technically credible, and differentiated from generic model output.

---

## The Four Non-Negotiable Principles

These are the shared foundation of every premium developer tool UI (Vercel, Linear, Raycast, Stripe). All four must be present — removing any one degrades the result:

**1. Aggressive high contrast**
Black on white, white on dark — nothing muddy. Visual hierarchy must be instant, requiring zero cognitive load to parse. If a user has to slow down to read the structure, the contrast is wrong.

**2. Whitespace as signal**
Not padding for decoration — whitespace communicates "each element earns its space." Dense developer UIs use tight internal padding but generous vertical rhythm between sections. The wrong move is uniform padding everywhere.

**3. Monochrome base + exactly one accent**
Neutral gray ramp for all surfaces, one color used sparingly and with purpose. Vercel: pure grayscale + rare blue. Linear: near-black + indigo. Never two accent colors. The palette communicates restraint and engineering precision.

**4. Sharp geometric typography at tight tracking**
Not rounded, not friendly — geometric and tight. Negative letter-spacing at display/heading sizes is what separates developer tool typography from consumer SaaS. Typography should signal "infrastructure-grade" without explanation.

---

## Developer Tool Aesthetic: The Restraint Rule

> "Vercel looks expensive because of what they don't use."

The signal is restraint. Every addition must justify itself. Default to removing, not adding.

What the best developer tool UIs deliberately omit:
- generic gradient hero layouts and interchangeable SaaS section patterns
- gradient fills on UI panels or cards (gradients only as ambient atmospheric glow)
- more than one accent color
- decorative shadows on dark surfaces (use luminance steps)
- rounded corners above 6px on data/infrastructure UI
- decorative motion that doesn't clarify state or hierarchy
- multiple competing typefaces
- warm/cool tint in the neutral ramp

If it would look at home on a consumer fintech landing page — it does not belong in a developer tool.

---

## Workflow

1. **Before writing code:** state the visual direction explicitly — typography choice, surface approach, accent color, density level, motion tone. Do not begin without this.

2. **Check the hierarchy in three passes:**
   - Far away: the structure is obvious without reading anything
   - Component level: spacing and grouping feel rhythmic and consistent
   - Mobile: layout is composed, not a compressed desktop version

3. **Run the anti-generic check** (below) before any review gate.

4. **When changing existing UI:** preserve the established visual language unless the task is an explicit redesign.

5. **Before handoff:** verify in the browser and cite the artifacts.

---

## Anti-Generic Checklist

Run these before declaring UI work complete. Any "yes" is a hard fail:

- [ ] Could this screen belong to any AI-generated SaaS product?
- [ ] Is the font stack a plain system default with no reasoning?
- [ ] Are there gradient fills on UI cards, panels, or section backgrounds?
- [ ] Are there more than two accent colors in use?
- [ ] Is spacing inconsistent or not on an 8px grid?
- [ ] Does the mobile layout feel like a shrunken desktop?
- [ ] Is motion present but not clarifying hierarchy or state?
- [ ] Are there border-radius values above 8px on data/infrastructure surfaces?
- [ ] Are shadows used for elevation instead of luminance steps on dark UI?
- [ ] Does text use `#FFFFFF` on a near-black background (OLED strain)?

---

## Heuristics for Developer Dashboard UIs

These apply specifically to agent orchestration and data-dense developer tool surfaces:

- **Mobile layout must feel composed** — not a shrunken desktop; content priorities and composition must hold at narrow widths
- **Density is correct** — developer tool users are experts; don't over-space to "feel friendly"
- **Monospace is semantic** — use Geist Mono for all IDs, timestamps, token counts, config values, version strings; not decoratively
- **Status colors carry meaning** — never use status colors (red/green/amber) decoratively; only for actual states
- **Blockers are first-class** — blocked state must be visually dominant, not a subtle badge; it is the most important state
- **Authority is visible** — runtime-authoritative data must be distinguishable from derived/advisory data at a glance
- **Real-time must feel live** — a pulsing dot + subtle ambient glow on the active panel tells the user data is streaming, without adding noise
- **No marketing-page patterns** — hero sections, feature grids, testimonials, gradient overlays: none of these belong in a developer dashboard

---

## Reference: What Each Tool Does Right

Use these as mental benchmarks during design:

| Tool | The one thing they got right |
|---|---|
| Vercel | Pure monochrome restraint — nothing decorative on information surfaces |
| Linear | Angular gradient glow as ambient lighting behind key active state; micro-motion at 150–200ms |
| Raycast | Geist Mono + tight negative tracking for display text; information density without visual noise |
| Langfuse | Tree + timeline toggle for the same trace data — two views of one truth, not two separate UIs |
| LangSmith | DAG view for agent execution — nodes and edges communicate structure better than indented lists |

---

## Output

Before handoff, return:
- Visual direction (1–2 sentences)
- Accent color choice and where it's used
- Typography decisions (face, scale, tracking)
- Anti-generic checklist results
- Browser verification artifacts cited
