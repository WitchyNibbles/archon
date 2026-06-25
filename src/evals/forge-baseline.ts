/**
 * @module evals/forge-baseline
 *
 * Deterministic eval baseline for Archon Forge quality gates.
 *
 * Turns three existing forge gate modules into tracked regression cases:
 *   - anti-generic-checker: AG-012 three-card soup (MUST block) + distinctive
 *     dashboard (MUST NOT block)
 *   - asset-qa: committed placeholder SVG (MUST pass) + XSS-carrying SVG (MUST fail)
 *   - wcag-contrast: AA-pass token pair + AA-fail near-identical grays
 *
 * Pattern: mirrors src/evals/orchestration-baseline.ts and
 * src/evals/retrieval-memory-baseline.ts in interface shape, score/threshold
 * semantics, and authorityLabel conventions.
 *
 * authorityLabel "derived_only" — every verdict is derived by calling the gate
 * implementation directly. No model output, no network, no DB.
 *
 * threshold=1.0 — these are deterministic, pure-function invariants. A
 * passRate below 1.0 means the gate is broken or a fixture is wrong.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  runAntiGenericChecker,
  RenderedSnapshotSchema
} from "../forge/anti-generic-checker.ts";
import type { RenderedElement, RenderedSnapshot } from "../forge/anti-generic-checker.ts";

import { runAssetQA } from "../forge/asset-qa.ts";
import type { AssetRequest } from "../forge/asset-contract.ts";

import { meetsAA } from "../forge/wcag-contrast.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ForgeEvalArea = "anti_generic" | "asset_qa" | "contrast";
type EvalAuthorityLabel = "derived_only";

export interface ForgeEvalCaseResult {
  id: string;
  area: ForgeEvalArea;
  passed: boolean;
  score: number;
  threshold: number;
  authorityLabel: EvalAuthorityLabel;
  evidenceRefs: readonly string[];
  details: string;
}

export interface ForgeEvalSummary {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  threshold: number;
  meetsThreshold: boolean;
  authorityLabel: EvalAuthorityLabel;
}

export interface ForgeEvalReport {
  cases: ForgeEvalCaseResult[];
  summary: ForgeEvalSummary;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildResult(
  input: Omit<ForgeEvalCaseResult, "authorityLabel" | "score" | "threshold"> & {
    score?: number;
    threshold?: number;
  }
): ForgeEvalCaseResult {
  const score = input.score ?? (input.passed ? 1 : 0);
  const threshold = input.threshold ?? 1;
  return {
    ...input,
    score,
    threshold,
    authorityLabel: "derived_only"
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers (mirrors forge-anti-generic-checker.test.ts style)
// ---------------------------------------------------------------------------

function el(
  overrides: Partial<RenderedElement> & { selector: string; tag: string }
): RenderedElement {
  return {
    childCount: 0,
    textLength: 0,
    computed: {},
    parentSelector: null,
    ...overrides
  };
}

function snapshot(elements: RenderedElement[]): RenderedSnapshot {
  return RenderedSnapshotSchema.parse({ url: "http://localhost:5173/", elements });
}

/**
 * AG-012 generic fixture: flex container with 3 equal-width children each
 * having icon + short-title + body structure. This is the council-required
 * falsifiability proof (C1, non-waivable). MUST produce blocking=true.
 */
function buildThreeCardGeneric(): RenderedSnapshot {
  const containerSel = "main > div.cards";
  const container = el({
    selector: containerSel,
    tag: "div",
    childCount: 3,
    textLength: 300,
    computed: { display: "flex", widthPx: 900 },
    parentSelector: "main"
  });

  function card(index: number): RenderedElement[] {
    const cardSel = `main > div.cards > div.card:nth-child(${index})`;
    return [
      el({
        selector: cardSel,
        tag: "div",
        childCount: 3,
        textLength: 100,
        computed: { display: "block", widthPx: 300 },
        parentSelector: containerSel
      }),
      el({
        selector: `${cardSel} > svg`,
        tag: "svg",
        role: "img",
        childCount: 1,
        textLength: 0,
        computed: {},
        parentSelector: cardSel
      }),
      el({
        selector: `${cardSel} > h3`,
        tag: "h3",
        childCount: 0,
        textLength: 24,
        computed: {},
        parentSelector: cardSel
      }),
      el({
        selector: `${cardSel} > p`,
        tag: "p",
        childCount: 0,
        textLength: 90,
        computed: {},
        parentSelector: cardSel
      })
    ];
  }

  return snapshot([
    el({
      selector: "main",
      tag: "main",
      childCount: 1,
      textLength: 300,
      computed: {},
      parentSelector: null
    }),
    container,
    ...card(1),
    ...card(2),
    ...card(3)
  ]);
}

/**
 * Distinctive dashboard fixture: sidebar nav (widthPx=240) + main content
 * (widthPx=860). Width ratio ≈ 3.6 → widthUniformity returns "unequal" →
 * AG-012 MUST NOT fire. Used to verify no false-positive on dashboard layouts.
 */
function buildDistinctiveDashboard(): RenderedSnapshot {
  return snapshot([
    el({
      selector: "body",
      tag: "body",
      semanticHint: "body",
      childCount: 1,
      textLength: 500,
      computed: { backgroundColor: "#0A0A0A" },
      parentSelector: null
    }),
    el({
      selector: "div.layout",
      tag: "div",
      childCount: 2,
      textLength: 500,
      computed: { display: "flex" },
      parentSelector: "body"
    }),
    el({
      selector: "nav.sidebar",
      tag: "nav",
      childCount: 5,
      textLength: 120,
      computed: { widthPx: 240 },
      parentSelector: "div.layout"
    }),
    el({
      selector: "main.content",
      tag: "main",
      childCount: 3,
      textLength: 380,
      computed: { widthPx: 860 },
      parentSelector: "div.layout"
    }),
    el({
      selector: "main.content > section.header-row",
      tag: "section",
      childCount: 2,
      textLength: 80,
      computed: { widthPx: 860 },
      parentSelector: "main.content"
    }),
    el({
      selector: "main.content > table.task-list",
      tag: "table",
      childCount: 8,
      textLength: 300,
      computed: { widthPx: 860 },
      parentSelector: "main.content"
    }),
    el({
      selector: "main.content > div.metrics",
      tag: "div",
      childCount: 2,
      textLength: 0,
      computed: { widthPx: 860 },
      parentSelector: "main.content"
    })
  ]);
}

// ---------------------------------------------------------------------------
// Resolve committed SVG path relative to this file (works in both src and dist)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// This file lives in src/evals/; web/ is two levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const COMMITTED_SVG = path.join(REPO_ROOT, "web", "public", "fallbacks", "icon.svg");

// ---------------------------------------------------------------------------
// Asset request builders
// ---------------------------------------------------------------------------

function goodAssetRequest(): AssetRequest {
  return {
    id: "eval-icon",
    provider: "placeholder_svg",
    assetType: "icon",
    purpose: "Eval baseline: committed placeholder icon asset",
    placement: "Forge eval suite",
    prompt: "Archon icon placeholder for eval baseline",
    negativeConstraints: [],
    preferredSize: "square",
    preferredFormat: "svg",
    background: "transparent",
    outputPath: "web/public/fallbacks/icon.svg",
    altText: "Archon icon placeholder",
    needsUserApproval: false,
    status: "planned"
  };
}

function badAssetRequest(): AssetRequest {
  return {
    id: "eval-bad-asset",
    provider: "placeholder_svg",
    assetType: "spot_illustration",
    purpose: "Eval baseline: malicious SVG with embedded script",
    placement: "Forge eval suite",
    prompt: "Eval bad asset fixture",
    negativeConstraints: [],
    preferredSize: "square",
    preferredFormat: "svg",
    background: "transparent",
    outputPath: "web/public/fallbacks/spot_illustration.svg",
    altText: "Eval bad asset",
    needsUserApproval: false,
    status: "planned"
  };
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/**
 * Run all forge gate eval cases and return a deterministic report.
 *
 * Threshold = 1.0: every gate case is a must-hold invariant over pure,
 * synchronous functions. A passRate below 1.0 means a gate regression has
 * occurred and the baseline is blocking.
 */
export function runForgeBaseline(): ForgeEvalReport {
  const cases: ForgeEvalCaseResult[] = [];

  // -------------------------------------------------------------------------
  // Anti-generic gate — AG-012 generic soup (MUST block)
  // -------------------------------------------------------------------------
  {
    const genericSnapshot = buildThreeCardGeneric();
    const report = runAntiGenericChecker(genericSnapshot);
    const passed = report.blocking === true;
    cases.push(
      buildResult({
        id: "anti_generic_three_card_soup_blocks",
        area: "anti_generic",
        passed,
        evidenceRefs: [
          "src/forge/anti-generic-checker.ts",
          "src/evals/forge-baseline.ts"
        ],
        details: `blocking=${report.blocking} violations=${report.violations.length} ag012=${report.violations.some((v) => v.agId === "AG-012") ? "present" : "absent"}`
      })
    );
  }

  // -------------------------------------------------------------------------
  // Anti-generic gate — distinctive dashboard (MUST NOT block)
  // -------------------------------------------------------------------------
  {
    const dashboardSnapshot = buildDistinctiveDashboard();
    const report = runAntiGenericChecker(dashboardSnapshot);
    const passed = report.blocking === false;
    cases.push(
      buildResult({
        id: "anti_generic_distinctive_dashboard_passes",
        area: "anti_generic",
        passed,
        evidenceRefs: [
          "src/forge/anti-generic-checker.ts",
          "src/evals/forge-baseline.ts"
        ],
        details: `blocking=${report.blocking} violations=${report.violations.length} hardFails=${report.violations.filter((v) => v.severity === "hard_fail").length}`
      })
    );
  }

  // -------------------------------------------------------------------------
  // Asset QA gate — committed SVG (MUST pass)
  // -------------------------------------------------------------------------
  {
    const report = runAssetQA(COMMITTED_SVG, goodAssetRequest());
    const passed = report.pass === true;
    cases.push(
      buildResult({
        id: "asset_qa_committed_svg_passes",
        area: "asset_qa",
        passed,
        evidenceRefs: [
          "src/forge/asset-qa.ts",
          "web/public/fallbacks/icon.svg",
          "src/evals/forge-baseline.ts"
        ],
        details: `pass=${report.pass} fails=${report.findings.filter((f) => f.severity === "fail" && !f.unchecked).map((f) => f.id).join(",") || "none"}`
      })
    );
  }

  // -------------------------------------------------------------------------
  // Asset QA gate — XSS SVG in OS temp dir (MUST fail); cleanup after check
  // -------------------------------------------------------------------------
  {
    const badContent = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><script>alert(1)</script></svg>`;
    const tmpDir = os.tmpdir();
    // Use a random suffix to avoid parallel CI shard collisions on the fixed filename.
    const randSuffix = crypto.randomBytes(8).toString("hex");
    const tmpPath = path.join(tmpDir, `archon-eval-bad-asset-${randSuffix}.svg`);
    let report;
    try {
      fs.writeFileSync(tmpPath, badContent, "utf8");
      report = runAssetQA(tmpPath, badAssetRequest());
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    }
    const passed = report.pass === false;
    cases.push(
      buildResult({
        id: "asset_qa_xss_svg_fails",
        area: "asset_qa",
        passed,
        evidenceRefs: [
          "src/forge/asset-qa.ts",
          "src/evals/forge-baseline.ts"
        ],
        details: `pass=${report.pass} failIds=${report.findings.filter((f) => f.severity === "fail" && !f.unchecked).map((f) => f.id).join(",") || "none"}`
      })
    );
  }

  // -------------------------------------------------------------------------
  // Contrast gate — AA-pass token pair: #EDEDED text on #0A0A0A surface
  // -------------------------------------------------------------------------
  {
    const fg = "#EDEDED";
    const bg = "#0A0A0A";
    const result = meetsAA(fg, bg);
    const passed = result === true;
    cases.push(
      buildResult({
        id: "contrast_aa_pass_text_on_surface",
        area: "contrast",
        passed,
        evidenceRefs: [
          "src/forge/wcag-contrast.ts",
          "src/evals/forge-baseline.ts"
        ],
        details: `meetsAA(${fg}, ${bg})=${result} expected=true`
      })
    );
  }

  // -------------------------------------------------------------------------
  // Contrast gate — AA-fail near-identical grays: #888888 on #777777 (ratio ≈ 1.26)
  // -------------------------------------------------------------------------
  {
    const fg = "#888888";
    const bg = "#777777";
    const result = meetsAA(fg, bg);
    const passed = result === false;
    cases.push(
      buildResult({
        id: "contrast_aa_fail_near_identical_grays",
        area: "contrast",
        passed,
        evidenceRefs: [
          "src/forge/wcag-contrast.ts",
          "src/evals/forge-baseline.ts"
        ],
        details: `meetsAA(${fg}, ${bg})=${result} expected=false`
      })
    );
  }

  // -------------------------------------------------------------------------
  // Aggregate
  // -------------------------------------------------------------------------
  const passedCases = cases.filter((c) => c.passed).length;
  const failedCases = cases.length - passedCases;
  const passRate = cases.length === 0 ? 1 : passedCases / cases.length;
  const threshold = 1.0;

  return {
    cases,
    summary: {
      totalCases: cases.length,
      passedCases,
      failedCases,
      passRate,
      threshold,
      meetsThreshold: passRate >= threshold,
      authorityLabel: "derived_only"
    }
  };
}
