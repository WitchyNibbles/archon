---
name: archon-visual-standards
description: Canonical visual identity for Archon and projects built with it. Use before writing any CSS, choosing any palette, or making any typography decision. Defines exact color tokens, type scale, motion curves, and surface elevation for dark-first developer tool UIs.
---

# Archon Visual Standards

Use this skill as the source of truth before any visual design decision. Override only with explicit task justification and council approval.

Goal: produce UIs that feel premium, technically credible, and intentionally designed — not generic AI output.

---

## Core Principle: Restraint Is the Decision

The best developer tool UIs (Vercel, Linear, Raycast) are distinguished primarily by what they *omit*:
- No gradient fills on UI elements — gradients only as ambient/atmospheric glow behind live status
- No decorative shadows — use luminance steps for elevation
- No more than one accent color — used sparingly, never decoratively
- No rounded corners on data or infrastructure UI — 0–6px max radius, nothing "friendly"
- No multiple competing typefaces — one sans + one mono, both variable
- No warm/cool color tints in the neutral ramp — pure neutral grays only

The signal is restraint and engineering precision. Every addition must justify itself.

---

## Color System

### Surface Ramp (luminance-based elevation, not shadow-based)

Dark UIs signal elevation through progressive lightness — not `box-shadow`:

```css
--surface-base:     #0A0A0A;  /* canvas, body — slightly warm, not pure black */
--surface-raised:   #111111;  /* cards, panels */
--surface-elevated: #1A1A1A;  /* nested cards, hover states */
--surface-overlay:  #222222;  /* modals, dropdowns, popovers */
```

### Border System

```css
--border-default:   rgba(255, 255, 255, 0.08);  /* default dividers, card outlines */
--border-emphasis:  rgba(255, 255, 255, 0.15);  /* focused, active, hovered states */
--border-strong:    rgba(255, 255, 255, 0.24);  /* selected, current item */
```

### Text Hierarchy

Do NOT use pure `#FFFFFF` for body text — causes eye strain on OLED and looks flat:

```css
--text-primary:   #EDEDED;  /* primary content */
--text-secondary: #A0A0A0;  /* labels, metadata, timestamps */
--text-muted:     #6B6B6B;  /* disabled, placeholder, decorative */
--text-inverse:   #0A0A0A;  /* text on light/accent backgrounds */
```

### Accent (one, used sparingly)

```css
--accent:         #6366F1;  /* indigo — links, primary CTA, active state */
--accent-bright:  #818CF8;  /* dark-mode boosted variant for higher contrast */
--accent-subtle:  rgba(99, 102, 241, 0.12);  /* accent background tint */
```

Use the accent for: current route indicator, primary action button, live/running pulse, progress fills.
Never use the accent for: decorative backgrounds, section fills, hover states on data cells.

### Semantic Status Colors

```css
--status-success:  #22C55E;  /* passed, complete, approved */
--status-error:    #EF4444;  /* failed, blocked, critical */
--status-warning:  #F59E0B;  /* stale, degraded, needs attention */
--status-running:  #06B6D4;  /* active/in-progress — pair with pulse animation */
--status-pending:  #6366F1;  /* ready, queued — same as accent */
--status-muted:    #6B6B6B;  /* done/archived, no longer active */
```

---

## Typography

### Typeface Choice

**Geist Sans + Geist Mono (variable fonts, free, open source)**

Why Geist: built specifically for developer tools, geometric precision, influenced by Inter and Univers but sharper. Geist Mono signals "infrastructure-grade tool" without explanation.

```
npm install geist
```

```css
@import 'geist/font/sans';  /* variable font: 100–900 weight */
@import 'geist/font/mono';  /* variable font: 100–700 weight */

body {
  font-family: 'Geist Sans', system-ui, sans-serif;
}

code, pre, kbd, .metadata, .id, .timestamp {
  font-family: 'Geist Mono', 'Fira Code', monospace;
}
```

If Geist is not available or project already uses Inter: Inter variable is the next best choice. Never default to system-ui alone for developer tool UI without a stated reason.

### Type Scale

Negative letter-spacing at larger sizes is what separates developer tool typography from generic SaaS:

```css
--text-display:  font-size: 48px; font-weight: 700; letter-spacing: -0.04em;
--text-h1:       font-size: 32px; font-weight: 600; letter-spacing: -0.03em;
--text-h2:       font-size: 24px; font-weight: 600; letter-spacing: -0.02em;
--text-h3:       font-size: 18px; font-weight: 500; letter-spacing: -0.01em;
--text-body:     font-size: 14px; font-weight: 400; letter-spacing:  0em;
--text-small:    font-size: 12px; font-weight: 400; letter-spacing: +0.01em;
--text-label:    font-size: 11px; font-weight: 500; letter-spacing: +0.03em; font-family: Geist Mono;
--text-code:     font-size: 13px; font-weight: 400; letter-spacing: +0.017em; font-family: Geist Mono;
```

Use Geist Mono for: run IDs, task IDs, timestamps, token counts, version strings, config values, any numeric metadata.

---

## Spacing

8px base grid — only use multiples: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128px.

Never use odd values (e.g., 7px, 15px, 22px) except for visual alignment corrections of <2px. Arbitrary spacing is a hard-fail in review.

```css
--space-1:   4px;
--space-2:   8px;
--space-3:  12px;
--space-4:  16px;
--space-6:  24px;
--space-8:  32px;
--space-12: 48px;
--space-16: 64px;
```

---

## Border Radius

Developer tool UIs are not "friendly" — they are precise:

```css
--radius-none: 0px;
--radius-sm:   2px;  /* inputs, data cells, badges */
--radius-md:   4px;  /* cards, panels */
--radius-lg:   6px;  /* modals, dropdowns */
```

Never exceed 8px for developer tool UI surfaces. Anything above feels consumer/marketing and breaks the technical aesthetic.

---

## Motion

Motion should clarify structure or state — not decorate. Linear's micro-motion philosophy:

- All animations: **150–200ms maximum** (not 300ms+)
- Enter/open easing: `cubic-bezier(0.16, 1, 0.3, 1)` (ease-out-expo, fast start then settle)
- Exit/close easing: `cubic-bezier(0.4, 0, 1, 1)` (ease-in, quick exit)
- State transitions: `all 150ms cubic-bezier(0.16, 1, 0.3, 1)`

```css
/* Running/active status pulse — opacity + scale only, not color */
@keyframes status-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.5; transform: scale(0.85); }
}
.status-running { animation: status-pulse 2s ease-in-out infinite; }
```

Permitted infinite animations: spinner/loader, active status pulse dot.
Forbidden: decorative background animations, parallax, scroll-triggered reveals for information-dense UIs.

---

## Ambient Glow (use sparingly)

The Linear-inspired glow pattern — blurred radial gradient behind key status areas:

```css
/* Behind a live/running section or active panel header */
.glow-accent {
  background: radial-gradient(ellipse 80% 60% at 50% 0%, rgba(99, 102, 241, 0.15) 0%, transparent 70%);
}
```

Apply only to: active run header, review gate open panel, top-of-dashboard hero when a run is live.
Never apply to: cards, tables, sidebars, inactive areas.

---

## Tailwind v4 Implementation

Put all tokens in `@theme` block as CSS custom properties:

```css
@import "tailwindcss";

@theme {
  --color-surface-base:     #0A0A0A;
  --color-surface-raised:   #111111;
  --color-surface-elevated: #1A1A1A;
  --color-surface-overlay:  #222222;
  --color-border:           rgba(255, 255, 255, 0.08);
  --color-border-emphasis:  rgba(255, 255, 255, 0.15);
  --color-text-primary:     #EDEDED;
  --color-text-secondary:   #A0A0A0;
  --color-text-muted:       #6B6B6B;
  --color-accent:           #6366F1;
  --color-accent-bright:    #818CF8;
  --color-status-success:   #22C55E;
  --color-status-error:     #EF4444;
  --color-status-warning:   #F59E0B;
  --color-status-running:   #06B6D4;
  --color-status-pending:   #6366F1;
}
```

Dark mode strategy: use `.dark` class strategy (not `prefers-color-scheme`) so operators can toggle. Surface ramp tokens are dark-first — the entire system defaults dark.

---

## Anti-Patterns (Hard Fail)

These patterns signal generic AI output and must be rejected before any approval:

- Gradient fills on cards, panels, or sections
- More than one accent color in the palette
- Border radius > 8px on data/infrastructure UI
- Shadows instead of luminance steps for elevation
- `box-shadow: 0 4px 6px rgba(0,0,0,0.3)` on dark UI surfaces
- Pure `#FFFFFF` body text
- Pure `#000000` canvas
- Default system font stack with no reason
- Warm or cool tint in the neutral gray ramp
- Random spacing values not on the 8px grid
- Motion longer than 200ms or looping decoratively

---

## Output

When applying this skill, return:
- Tokens introduced or reused
- Typeface decisions and rationale
- Motion choices
- Any deviation from this standard with justification
