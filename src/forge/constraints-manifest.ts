/**
 * @module forge/constraints-manifest
 *
 * Machine-readable constraints manifest for the Archon Forge visual critic (S4).
 *
 * Transcribed from:
 *   - .claude/skills/archon-visual-standards/SKILL.md  (color tokens, type, spacing, motion, anti-patterns)
 *   - .claude/skills/archon-design-system/SKILL.md     (token system, component normalization rules)
 *   - .claude/skills/archon-frontend-taste/SKILL.md    (four non-negotiable principles, anti-generic checklist)
 *
 * DO NOT invent values. Every token value and rule is sourced verbatim from the
 * skill files above. Each constraint carries a stable `id` so the S4 repair loop
 * can cite violations in machine-readable diffs.
 *
 * This module has zero runtime dependencies on archon services — it is a pure
 * typed data module safe to import from web/ or any tooling layer.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Constraint severity
// ---------------------------------------------------------------------------

export const ConstraintSeveritySchema = z.enum(["hard_fail", "warning"]);
export type ConstraintSeverity = z.infer<typeof ConstraintSeveritySchema>;

// ---------------------------------------------------------------------------
// Identity token schemas
// ---------------------------------------------------------------------------

export const ColorTokenSchema = z.object({
  name: z.string(),
  value: z.string(),
  description: z.string()
});

export const TypographyTokenSchema = z.object({
  name: z.string(),
  fontSize: z.string(),
  fontWeight: z.string(),
  letterSpacing: z.string(),
  fontFamily: z.string().optional()
});

export const SpacingTokenSchema = z.object({
  name: z.string(),
  value: z.string()
});

export const RadiusTokenSchema = z.object({
  name: z.string(),
  value: z.string(),
  description: z.string()
});

export const MotionTokenSchema = z.object({
  name: z.string(),
  durationMs: z.number(),
  easing: z.string(),
  description: z.string()
});

// ---------------------------------------------------------------------------
// Anti-generic constraint item
// ---------------------------------------------------------------------------

export const AntiGenericConstraintSchema = z.object({
  /**
   * Stable unique id. The S4 critic MUST reference this id in every violation report.
   * Format: AG-NNN (Anti-Generic constraint).
   */
  id: z.string().regex(/^AG-\d{3}$/),
  /** Short human-readable rule title. */
  rule: z.string(),
  /** Detailed description of what is forbidden and why. */
  description: z.string(),
  /** Severity of violation — "hard_fail" blocks approval. */
  severity: ConstraintSeveritySchema,
  /**
   * Optional example of the forbidden pattern for illustration.
   * NEVER use this as a template — it is the anti-example.
   */
  forbiddenExample: z.string().optional()
});

export type AntiGenericConstraint = z.infer<typeof AntiGenericConstraintSchema>;

// ---------------------------------------------------------------------------
// Full manifest schema
// ---------------------------------------------------------------------------

export const ConstraintsManifestSchema = z.object({
  /** Manifest schema version — increment when breaking changes are made. */
  version: z.literal(2),

  /**
   * Identity: fixed archon design identity (D1 — zero divergence allowed).
   * Transcribed from archon-visual-standards/SKILL.md
   */
  identity: z.object({
    /** Primary canvas background. Source: --surface-base in visual-standards. */
    darkBase: z.string(),
    /** Surface ramp (luminance-based elevation, not shadow-based). */
    surfaceRamp: z.object({
      base: z.string(),
      raised: z.string(),
      elevated: z.string(),
      overlay: z.string()
    }),
    /** Border token ramp. Source: visual-standards border system. */
    borderRamp: z.object({
      default: z.string(),
      emphasis: z.string(),
      strong: z.string()
    }),
    /** Text hierarchy. Source: visual-standards text hierarchy. */
    textHierarchy: z.object({
      primary: z.string(),
      secondary: z.string(),
      muted: z.string(),
      inverse: z.string()
    }),
    /**
     * SINGLE accent color (indigo). Hard-fail: any second accent is forbidden.
     * Source: visual-standards accent section.
     */
    accent: z.object({
      base: z.string(),
      bright: z.string(),
      subtle: z.string()
    }),
    /**
     * Semantic status colors for fills, dots, borders, and icons.
     * Source: visual-standards semantic status colors.
     * NOTE: several of these (pending, muted, and error-on-overlay) fail WCAG AA
     * as small text — render status text with `statusTextColors` instead.
     */
    statusColors: z.object({
      success: z.string(),
      error: z.string(),
      warning: z.string(),
      running: z.string(),
      pending: z.string(),
      muted: z.string()
    }),
    /**
     * WCAG 2.1 AA-compliant (≥4.5:1 on every surface in the ramp, including
     * overlay) text variants of the status colors. Use these whenever a status
     * is rendered AS TEXT (label, count, message) rather than as a fill/dot.
     * Source: visual-standards "Readable Status Text" section.
     */
    statusTextColors: z.object({
      success: z.string(),
      error: z.string(),
      warning: z.string(),
      running: z.string(),
      pending: z.string(),
      muted: z.string()
    }),
    /**
     * Typeface pair. Source: visual-standards typography section.
     * Geist Sans (sans) + Geist Mono (mono). Variable fonts.
     */
    typefaces: z.object({
      sans: z.string(),
      mono: z.string(),
      monoUseCases: z.array(z.string())
    }),
    /**
     * Spacing: 8px base grid. Source: visual-standards spacing section.
     * Only multiples of 4px are permitted (4, 8, 12, 16, 24, 32, 48, 64, 96, 128).
     */
    spacingBaseGridPx: z.number(),
    spacingTokens: z.array(SpacingTokenSchema),
    /**
     * Border radius cap. Source: visual-standards radius section.
     * Max 6px on data/infrastructure surfaces (lg = 6px, NEVER exceed 8px).
     */
    radiusCap: z.object({
      maxDataSurfacePx: z.number(),
      absoluteMaxPx: z.number(),
      tokens: z.array(RadiusTokenSchema)
    }),
    /**
     * Motion constraints. Source: visual-standards motion section.
     * All animations 150–200ms max.
     */
    motion: z.object({
      maxDurationMs: z.number(),
      enterEasing: z.string(),
      exitEasing: z.string(),
      stateTransitionMs: z.number(),
      permitted: z.array(z.string()),
      forbidden: z.array(z.string())
    }),
    /**
     * Type scale tokens. Source: visual-standards type scale section.
     */
    typeScale: z.array(TypographyTokenSchema)
  }),

  /**
   * Anti-generic hard-fail list.
   * Source: archon-visual-standards anti-patterns + archon-frontend-taste anti-generic checklist.
   * Each item has a stable id (AG-NNN) for machine-readable violation citing.
   */
  antiGenericRules: z.array(AntiGenericConstraintSchema),

  /**
   * Benchmark reference UIs used by the S4 critic for qualitative comparison.
   * Source: archon-frontend-taste reference table + archon-visual-standards core principle.
   */
  benchmarks: z.array(z.object({
    tool: z.string(),
    principle: z.string()
  })),

  /**
   * Four non-negotiable design principles (all must be present).
   * Source: archon-frontend-taste "The Four Non-Negotiable Principles".
   */
  nonNegotiablePrinciples: z.array(z.object({
    id: z.string().regex(/^NNP-\d{3}$/),
    name: z.string(),
    description: z.string()
  }))
});

export type ConstraintsManifest = z.infer<typeof ConstraintsManifestSchema>;

// ---------------------------------------------------------------------------
// The manifest (single source of truth — transcribed, NOT invented)
// ---------------------------------------------------------------------------

export const CONSTRAINTS_MANIFEST: ConstraintsManifest = {
  version: 2,

  identity: {
    // Source: archon-visual-standards --surface-base
    darkBase: "#0A0A0A",

    surfaceRamp: {
      base:     "#0A0A0A",  // --surface-base: canvas, body
      raised:   "#111111",  // --surface-raised: cards, panels
      elevated: "#1A1A1A",  // --surface-elevated: nested cards, hover states
      overlay:  "#222222"   // --surface-overlay: modals, dropdowns, popovers
    },

    borderRamp: {
      default:  "rgba(255, 255, 255, 0.08)",  // --border-default
      emphasis: "rgba(255, 255, 255, 0.15)",  // --border-emphasis
      strong:   "rgba(255, 255, 255, 0.24)"   // --border-strong
    },

    textHierarchy: {
      primary:   "#EDEDED",  // --text-primary: primary content
      secondary: "#A0A0A0",  // --text-secondary: labels, metadata, timestamps (readable muted)
      muted:     "#6B6B6B",  // --text-muted: DECORATIVE ONLY — fails WCAG AA (~3.7:1) for text; use secondary for legible muted text
      inverse:   "#0A0A0A"   // --text-inverse: text on light/accent backgrounds
    },

    // SINGLE accent color. Source: visual-standards accent section.
    accent: {
      base:   "#6366F1",                       // --accent: indigo
      bright: "#818CF8",                       // --accent-bright: dark-mode boosted
      subtle: "rgba(99, 102, 241, 0.12)"       // --accent-subtle: background tint
    },

    statusColors: {
      success: "#22C55E",  // --status-success: passed, complete, approved
      error:   "#EF4444",  // --status-error: failed, blocked, critical (fails AA on overlay as text)
      warning: "#F59E0B",  // --status-warning: stale, degraded, needs attention
      running: "#06B6D4",  // --status-running: active/in-progress (pair with pulse)
      pending: "#6366F1",  // --status-pending: ready, queued (same as accent; fails AA as text)
      muted:   "#6B6B6B"   // --status-muted: done/archived (fails AA as text)
    },

    // AA-compliant readable text variants — use when a status is rendered AS TEXT
    // (label/count/message), not as a fill/dot. Each is ≥4.5:1 on every surface in
    // the ramp (verified by tests/forge-contrast.test.ts). Source: visual-standards
    // "Readable Status Text".
    statusTextColors: {
      success: "#4ADE80",  // --status-success-text: ≥9.1:1
      error:   "#F87171",  // --status-error-text:   ≥5.7:1
      warning: "#FCD34D",  // --status-warning-text: ≥11:1
      running: "#67E8F9",  // --status-running-text: ≥10.9:1
      pending: "#A5B4FC",  // --status-pending-text: ≥7.9:1
      muted:   "#A0A0A0"   // --status-muted-text:   ≥6:1 (= --text-secondary)
    },

    typefaces: {
      sans:  "Geist Sans",
      mono:  "Geist Mono",
      monoUseCases: [
        "run IDs",
        "task IDs",
        "timestamps",
        "token counts",
        "version strings",
        "config values",
        "numeric metadata"
      ]
    },

    spacingBaseGridPx: 8,

    spacingTokens: [
      { name: "--space-1",  value: "4px"  },
      { name: "--space-2",  value: "8px"  },
      { name: "--space-3",  value: "12px" },
      { name: "--space-4",  value: "16px" },
      { name: "--space-6",  value: "24px" },
      { name: "--space-8",  value: "32px" },
      { name: "--space-12", value: "48px" },
      { name: "--space-16", value: "64px" }
    ],

    radiusCap: {
      maxDataSurfacePx: 6,   // --radius-lg: max for data/infrastructure surfaces
      absoluteMaxPx: 8,      // Hard ceiling — never exceed for any dev tool surface
      tokens: [
        { name: "--radius-none", value: "0px",  description: "sharp corners" },
        { name: "--radius-sm",   value: "2px",  description: "inputs, data cells, badges" },
        { name: "--radius-md",   value: "4px",  description: "cards, panels" },
        { name: "--radius-lg",   value: "6px",  description: "modals, dropdowns — max for data surfaces" }
      ]
    },

    motion: {
      maxDurationMs: 200,
      enterEasing: "cubic-bezier(0.16, 1, 0.3, 1)",    // ease-out-expo: fast start then settle
      exitEasing:  "cubic-bezier(0.4, 0, 1, 1)",        // ease-in: quick exit
      stateTransitionMs: 150,
      permitted: [
        "spinner/loader",
        "active status pulse dot (opacity + scale only, not color)"
      ],
      forbidden: [
        "decorative background animations",
        "parallax",
        "scroll-triggered reveals for information-dense UIs",
        "animations longer than 200ms",
        "looping decorative motion"
      ]
    },

    typeScale: [
      { name: "--text-display", fontSize: "48px", fontWeight: "700", letterSpacing: "-0.04em" },
      { name: "--text-h1",      fontSize: "32px", fontWeight: "600", letterSpacing: "-0.03em" },
      { name: "--text-h2",      fontSize: "24px", fontWeight: "600", letterSpacing: "-0.02em" },
      { name: "--text-h3",      fontSize: "18px", fontWeight: "500", letterSpacing: "-0.01em" },
      { name: "--text-body",    fontSize: "14px", fontWeight: "400", letterSpacing: "0em"     },
      { name: "--text-small",   fontSize: "12px", fontWeight: "400", letterSpacing: "+0.01em" },
      { name: "--text-label",   fontSize: "11px", fontWeight: "500", letterSpacing: "+0.03em", fontFamily: "Geist Mono" },
      { name: "--text-code",    fontSize: "13px", fontWeight: "400", letterSpacing: "+0.017em", fontFamily: "Geist Mono" }
    ]
  },

  antiGenericRules: [
    {
      id: "AG-001",
      rule: "No gradient fills on UI surfaces",
      description: "Gradient fills on cards, panels, or section backgrounds are forbidden. Gradients are only permitted as ambient atmospheric glow (radial, behind live status areas). A gradient fill on a card or panel signals generic AI output.",
      severity: "hard_fail",
      forbiddenExample: "background: linear-gradient(135deg, #1a1a2e, #16213e)"
    },
    {
      id: "AG-002",
      rule: "Single accent color only",
      description: "More than one accent color in the palette is forbidden. Archon uses exactly one accent: indigo #6366F1. Adding a second accent (teal, purple variant, etc.) destroys the monochrome restraint signal.",
      severity: "hard_fail",
      forbiddenExample: "Using both #6366F1 (indigo) and #10B981 (emerald) as accent colors"
    },
    {
      id: "AG-003",
      rule: "No border radius above 8px on data/infrastructure UI",
      description: "Border radius above 8px on any data or infrastructure surface is forbidden. Values > 6px on cards/panels feel consumer/marketing. The hard ceiling is 8px; data cells and badges must use 2px (radius-sm).",
      severity: "hard_fail",
      forbiddenExample: "border-radius: 12px on a card or panel"
    },
    {
      id: "AG-004",
      rule: "No shadows for elevation on dark surfaces",
      description: "box-shadow for elevation on dark UI surfaces is forbidden. Elevation must use luminance steps (lighter background token). Only drop-shadow <10% opacity is permitted for floating elements (modals), never cards.",
      severity: "hard_fail",
      forbiddenExample: "box-shadow: 0 4px 6px rgba(0,0,0,0.3) on a dark card"
    },
    {
      id: "AG-005",
      rule: "No pure #FFFFFF body text",
      description: "Pure white (#FFFFFF) for body text is forbidden — causes eye strain on OLED and looks flat. Use --text-primary (#EDEDED) for primary content.",
      severity: "hard_fail",
      forbiddenExample: "color: #FFFFFF on body text"
    },
    {
      id: "AG-006",
      rule: "No pure #000000 canvas",
      description: "Pure black (#000000) for the canvas/body background is forbidden. Use --surface-base (#0A0A0A) which is slightly warm and avoids optical illusion issues.",
      severity: "hard_fail",
      forbiddenExample: "background: #000000 on the body element"
    },
    {
      id: "AG-007",
      rule: "No default system font stack without justification",
      description: "Using system-ui or a generic font stack without a stated reason is forbidden. Archon uses Geist Sans + Geist Mono. Fallback to Inter variable is the only permitted alternative.",
      severity: "hard_fail",
      forbiddenExample: "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif with no reason"
    },
    {
      id: "AG-008",
      rule: "No warm or cool tint in the neutral gray ramp",
      description: "Neutral grays must be pure neutral — no warm (#8B7355-style) or cool (#7B8FA1-style) tint. Any tint in the neutral ramp breaks the monochrome base signal.",
      severity: "hard_fail",
      forbiddenExample: "Using a blue-tinted gray (#64748B) for neutral UI text"
    },
    {
      id: "AG-009",
      rule: "No arbitrary spacing values off the 8px grid",
      description: "Spacing values not on the 8px grid (multiples of 4px: 4, 8, 12, 16, 24, 32, 48, 64) are forbidden, except for visual alignment corrections under 2px. Values like 7px, 15px, 22px are hard-fails.",
      severity: "hard_fail",
      forbiddenExample: "padding: 7px 15px"
    },
    {
      id: "AG-010",
      rule: "No motion longer than 200ms or looping decoratively",
      description: "All animations must be 150–200ms maximum. Decorative looping animations (background, parallax, scroll-reveal) are forbidden. Only spinner/loader and active status pulse dot may loop.",
      severity: "hard_fail",
      forbiddenExample: "transition: all 300ms ease or @keyframes decorative-bg-shift { ... } animation: decorative-bg-shift 4s infinite"
    },
    {
      id: "AG-011",
      rule: "No glassmorphism without purpose",
      description: "backdrop-filter: blur() used decoratively as a style effect is forbidden. Semi-transparent surfaces are only permitted for genuine floating overlays (modals, tooltips) where the layering hierarchy needs to be communicated.",
      severity: "hard_fail",
      forbiddenExample: "background: rgba(255,255,255,0.05); backdrop-filter: blur(12px) on a data card"
    },
    {
      id: "AG-012",
      rule: "No generic 3-card feature soup layout",
      description: "Three-card grid layouts used to display 'features' or introduce sections are a hard-fail — they are the defining pattern of generic AI-generated SaaS UIs. Information-dense developer tool dashboards must use data tables, list panels, or structured hierarchy — not marketing-page card grids.",
      severity: "hard_fail",
      forbiddenExample: "A row of 3 icon-title-description cards presenting dashboard sections"
    },
    {
      id: "AG-013",
      rule: "No ad hoc colors — all values must be token references",
      description: "Any hardcoded color value that is not a reference to a defined token is forbidden. This prevents per-component color drift and enforces the monochrome + single accent system.",
      severity: "hard_fail",
      forbiddenExample: "color: #3B82F6 inline in a component (unlisted token)"
    },
    {
      id: "AG-014",
      rule: "No marketing-page patterns in developer dashboard",
      description: "Hero sections, feature grids, testimonials, gradient overlays, and similar marketing-page patterns do not belong in a developer dashboard. Every screen element must serve information or action — never decoration.",
      severity: "hard_fail"
    },
    {
      id: "AG-015",
      rule: "Blocked state must be visually dominant",
      description: "A blocked run or task must be the most visually prominent element on screen. Subtle badges or low-contrast indicators for blocked state are a hard-fail. Blockers are the operator's primary action surface.",
      severity: "hard_fail",
      forbiddenExample: "Displaying a blocked task with only a small grey badge in a long list"
    }
  ],

  benchmarks: [
    {
      tool: "Vercel",
      principle: "Pure monochrome restraint — nothing decorative on information surfaces"
    },
    {
      tool: "Linear",
      principle: "Angular gradient glow as ambient lighting behind key active state; micro-motion at 150–200ms"
    },
    {
      tool: "Raycast",
      principle: "Geist Mono + tight negative tracking for display text; information density without visual noise"
    },
    {
      tool: "Stripe",
      principle: "Sharp geometric typography at tight tracking; aggressive high contrast"
    },
    {
      tool: "Langfuse",
      principle: "Tree + timeline toggle for the same trace data — two views of one truth, not two separate UIs"
    }
  ],

  nonNegotiablePrinciples: [
    {
      id: "NNP-001",
      name: "Aggressive high contrast",
      description: "Black on white, white on dark — nothing muddy. Visual hierarchy must be instant, requiring zero cognitive load to parse. If a user has to slow down to read the structure, the contrast is wrong."
    },
    {
      id: "NNP-002",
      name: "Whitespace as signal",
      description: "Not padding for decoration — whitespace communicates that each element earns its space. Dense developer UIs use tight internal padding but generous vertical rhythm between sections. Uniform padding everywhere is the wrong move."
    },
    {
      id: "NNP-003",
      name: "Monochrome base plus exactly one accent",
      description: "Neutral gray ramp for all surfaces, one color used sparingly and with purpose. Vercel: pure grayscale + rare blue. Linear: near-black + indigo. Never two accent colors. The palette communicates restraint and engineering precision."
    },
    {
      id: "NNP-004",
      name: "Sharp geometric typography at tight tracking",
      description: "Not rounded, not friendly — geometric and tight. Negative letter-spacing at display and heading sizes is what separates developer tool typography from consumer SaaS. Typography must signal infrastructure-grade without explanation."
    }
  ]
};
