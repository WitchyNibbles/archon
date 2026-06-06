# Frontend Quality Rubric

Use this rubric for visible UI work owned or reviewed by `frontend_designer`, `qa_engineer`, `reviewer`, or `release-readiness`.

## Goal

Reject generic AI-generated UI output and require browser-backed proof for user-visible quality claims. The target standard is Vercel/Linear/Langfuse-grade developer tool UI — technically credible, information-dense, visually restrained.

---

## Hard Fail Patterns

Any of these blocks approval. No exceptions without explicit council waiver:

**Visual:**
- gradient fill on any UI panel, card, or section (glow is ambient only, behind live-status areas)
- more than one accent color in the palette
- `box-shadow` for elevation on dark surfaces instead of luminance steps
- border radius above 8px on data or infrastructure surfaces
- default font stack with no stated typographic direction
- pure `#FFFFFF` body text on dark backgrounds
- spacing values not on the 8px grid (arbitrary padding)
- status colors (red/green/amber) used decoratively, not to communicate actual state
- motion above 200ms or decorative infinite loops that do not clarify hierarchy or state
- warm/cool tint in the neutral gray ramp (must be pure neutral)

**Information architecture:**
- generic gradient-hero layout with interchangeable SaaS sections
- decorative cards with no information hierarchy
- desktop-only composition with no intentional mobile adaptation
- no token or component discipline for repeated UI patterns
- accessibility or layout claims made without rendered browser evidence

**Developer tool–specific:**
- blocker state not rendered first when blockers are present
- `runtime_authoritative` vs `derived_only` data indistinguishable to the user
- live/running state with no visual indicator beyond a text label
- Geist Mono not used for IDs, timestamps, token counts, version strings
- status badge colors inconsistent with the canonical status color system

---

## Required Design Checks

Before any review submission, verify and document all of the following:

**1. Visual direction is explicit:**
- [ ] Typography face and scale stated
- [ ] Accent color named and scope limited (where it appears)
- [ ] Surface ramp defined (which levels are used and where)
- [ ] Density level declared (compact / standard / spacious)
- [ ] Motion tone stated (none / micro / purposeful) with duration and easing

**2. Token system:**
- [ ] All color values reference tokens, not hardcoded hex
- [ ] All spacing values are on the 8px grid
- [ ] All radius values are ≤8px on data/infrastructure surfaces
- [ ] Repeated patterns use a shared component or token rule

**3. Information hierarchy:**
- [ ] Structure is obvious at a glance without reading content
- [ ] Blockers (if present) are the first visible element on the screen
- [ ] Status data carries authority label (authoritative vs derived)
- [ ] Status colors match canonical system from `archon-visual-standards`

**4. Accessibility:**
- [ ] Semantic HTML used — not `div` where `button`, `nav`, `main`, `section` applies
- [ ] Keyboard navigation verified for all interactive elements
- [ ] Focus outline present and visible (never removed without accessible alternative)
- [ ] Color is not the only differentiator for meaning (includes icon or label)
- [ ] WCAG AA contrast verified for all text/background combinations

**5. Responsive:**
- [ ] Desktop viewport: layout holds
- [ ] Mobile viewport: composition feels intentional, not just scaled down
- [ ] No layout overflow or broken grid at narrow widths

**6. Real-time (if applicable):**
- [ ] SSE used for log streams / live data
- [ ] TanStack Query polling used for status/metrics with appropriate interval
- [ ] Virtualization applied to any list that can exceed 100 items
- [ ] Running/live state has a visible animated indicator (pulsing dot)

---

## Anti-Generic Checklist

Run before any handoff or review submission. Every "yes" is a hard fail:

- [ ] Could this screen belong to any AI-generated SaaS product?
- [ ] Is the font stack a plain system default with no reasoning?
- [ ] Are there gradient fills on UI cards, panels, or section backgrounds?
- [ ] Are there more than one accent color?
- [ ] Is spacing inconsistent or off the 8px grid?
- [ ] Does the mobile layout feel like a shrunken desktop?
- [ ] Is motion present but not clarifying hierarchy or state?
- [ ] Are there border-radius values above 8px on data/infrastructure surfaces?
- [ ] Are shadows used for elevation instead of luminance steps on dark UI?

---

## Required Browser Verification

For `ui_surface = visual_change` or `ui_surface = interactive_flow`, all of the following must be cited in the `qa_engineer` review:

- one desktop viewport (screenshot, ≥1280px)
- one mobile viewport (screenshot, ≤480px)
- one happy path walkthrough
- one empty state (no data) rendering
- one error/failure state rendering
- cited Playwright evidence refs in the `qa_engineer` review

---

## Review Prompts (for `reviewer` and `qa_engineer`)

Ask these before approving:

- Does this look like it could come from Vercel, Linear, or Langfuse — or does it look generic?
- Is the typography doing real hierarchy work, or is it a default placeholder?
- Is the spacing rhythm consistent — could you draw the grid it's following?
- Does the mobile layout feel deliberately composed?
- Is the running/live state visually alive, or just a text label?
- Are blockers the first thing you see when they exist?
- Can you tell which data is runtime-authoritative vs derived?
- Do the browser artifacts prove what the user actually sees?

---

## Approval Rule

Do not approve visible UI work that:
- fails any hard-fail pattern check
- fails the anti-generic checklist
- lacks browser-backed evidence for the claimed quality
- omits required accessibility or responsive checks

A waiver requires explicit `design_council` review with documented rationale. Generic waivers ("good enough for now") are not valid.
