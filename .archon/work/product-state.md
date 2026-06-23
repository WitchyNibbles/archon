# Product State

> Maintained by archon planner after each completed task.

## Current initiative: Frontend Forge

Give archon a frontend-generation capability (intent → directions → tokens →
assets → implement → browser-QA → critic → repair → handoff), realized
**archon-native** (compose-on-core, NOT a parallel module). First dogfood: a
read-only Run-Status dashboard in `web/`. Source spec:
`docs/archon_frontend_forge_codex_imagegen_roadmap.md` (research doc — ideas
ported to archon primitives, its Python/parallel-module file tree discarded).
Council outcome: **APPROVED_WITH_CONDITIONS** (12 conditions; #1 = falsifiable
anti-generic gate; R2-C hard package boundary for the React/Vite/Playwright
toolchain).

User directive: always choose the best LONG-TERM option over low-cost/low-risk.

### Phase status

- [x] **Phase 0 — walking skeleton (COMPLETE, sealed).** Isolated `web/`
      (Vite/React19/Tailwind4 + Playwright) with hard R2-C boundary; Swimlane
      Monitor dashboard built through the Forge pipeline (intent → directions →
      operator-pick → build → anti-generic critic → a11y → browser-QA →
      boundary). PRs #50 (F5 scaffold), #51 (S1 contract+manifest), #52 (S3+S5
      dashboard), #53 (runtime role-id resolution fix). Run `8b21e9ae` sealed.
- [ ] **Phase 0.5 — production-readiness hardening (IN PROGRESS this session).**
      Bounded local fixes from the Phase-0 seal backlog + the F3/F5 spikes;
      no council needed (local bug-fixes/hygiene). See "Completed this session".
- [ ] **Phase 1 — forge profile + stage skills (council gate REQUIRED).** Forge
      run profile + stage skills (`archon-forge-intent/direction/assets`) +
      `forge` admin subcommand; wire dashboard to LIVE pg data (swap snapshot.ts
      generator body for a status query); contract codegen/shared-package to kill
      web-side type duplication (`web/src/types/dashboard.ts` ↔ `src/forge`);
      pin Playwright (not @latest) + the `web-e2e.yml` non-required CI job;
      F1-entry-gate = pre-commit the codex fallback. Architecture-significant →
      run the Design and Architecture Council first.
- [ ] **Phase 2 — AssetProvider + codex_builtin_imagegen.** F1 CONDITIONAL-
      confirmed (`codex exec --ephemeral --dangerously-bypass-approvals-and-sandbox`,
      ≥120s, per-machine codex login; CI → placeholder). Needs D2 (user) +
      security gate on the bypass flag.
- [ ] **Phase 3 — asset QA + visual critic + repair wiring** (consumes
      `src/forge/wcag-contrast.ts` + constraints-manifest for machine-readable
      anti-pattern diffs, council condition #1/#3).
- [ ] **Phase 4 — forge eval baseline** (`src/evals/forge-baseline.ts`).
- [ ] **Phase 5 — cross-repo capability + opt-in API provider** (council gate).

## Completed this session (2026-06-23)

1. **`forgeA11yReadableTokens`** — PR #54 (master `28cdc37`), run `b8eb2e2b`
   sealed (reviewer+qa+security PASS + approval, workflow-proof
   runtime_authoritative). Fixed an archon-wide WCAG 2.1 AA contrast bug: the
   canonical `--text-muted #6B6B6B` (~3.7:1) and `--status-pending #6366F1`
   (~4.4:1) fail AA as small text. Added a 1:1 `statusTextColors` set (all
   ≥4.5:1 on every surface incl. overlay) to the canonical visual-standards
   SKILL + forge constraints-manifest (v1→2); annotated bases as fill/icon-only;
   added reusable `src/forge/wcag-contrast.ts` + computed contrast regression
   test (negative twins + positive guard).
2. **`fixSetupPlaywrightBranding`** — PR #55 (master `680101d`), run `8bb0e512`
   sealed (3 gates + approval, runtime_authoritative). Fixed a fresh-clone bug:
   `setup-playwright.ts` read `.devgod/playwright/` while the installer writes to
   `.archon/playwright/`, throwing "missing required Playwright MCP config".
   Aligned to `.archon`, exported path helpers, guarded `main()` (symlink-safe),
   cross-module anti-drift test.
3. **`forgePhase0Hardening`** — IN PROGRESS (run `707a20a7`). gitignore
   Playwright browser binaries + forge runtime artifacts + `snapshot.live.json`;
   completed the R2-C import wall in the web→src direction (eslint, verified
   firing); guarded `snapshot.ts main()` on `import.meta.url` + bounds-checked
   its output-path arg; routed the dashboard PulseDot label to AA `-text` tokens
   (added missing `--status-success/running/muted-text` to web CSS).

## Verification (latest)

- root: `npx tsc --noEmit` clean · `npm run lint` 0 warnings · `npm test`
  **1231/1231 pass**
- web: `npm run build` clean · `npm run lint` 0 warnings · import wall verified
  firing on a web→src probe

## Open risks / follow-ups

- **Release-readiness**: `src/install/setup-playwright.ts` changed (installer is
  release-sensitive) — run `/archon-release-readiness` before any tagged release.
- **Phase 1 entry items** (tracked): pin Playwright version; `ARCHON_PLAYWRIGHT_NPX_BIN`
  unvalidated (pre-existing MEDIUM, local-tool surface); contract codegen to kill
  `web/src/types/dashboard.ts` duplication; web/ has no unit-test runner yet.
- **Pre-auth / pre-live-data blocker** (security MEDIUM from `forgePhase0Hardening`):
  `web/src/index.css` loads Google Fonts via CDN `@import` with no CSP. Fine for the
  Phase-0 read-only static page, but MUST be addressed (CSP + ideally self-hosted
  Geist) before the dashboard serves auth-gated or live-runtime content (Phase 1
  wires live pg data — fix it there).
- **snapshot path guard** (LOW): `resolveSnapshotOutputPath` bounds-checks via
  `path.resolve`, not `realpathSync`; an in-repo symlink pointing out could bypass
  it. Requires pre-existing repo write access to exploit; documented, not a Phase-0
  blocker for a manual read-only generator.
- **`.devgod` branding debt** in `src/admin/db.ts` (postgres cache/state) — a
  separate latent rename, intentionally untouched.
- Carried: branch-protection PAT 403 (merge via `--admin`), hono/esbuild
  advisories.

## Prior initiatives (complete)

- **Trust-hardening** — careless-class + council-confirmed HIGH gaps closed;
  gate-integrity eval suite added; runtime-authoritative. (See git history /
  `.archon/work/briefs/brief-archon-trust-hardening.md`.)
- **Archon remediation** (9-phase Fable 5 audit) — run `d216a303`, all approved.
- **daemon.ts split** — 5702→1558 lines, PRs #39–#49.
