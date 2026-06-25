/**
 * @module forge/asset-qa
 *
 * Deterministic asset QA validator for the Archon Frontend Forge pipeline
 * (P1-S6).
 *
 * Style mirrors src/forge/anti-generic-checker.ts:
 *   - Findings carry a stable QA-NNN id + measured-vs-expected
 *   - Non-mechanical checks emit explicit unchecked=true flags (never hidden)
 *   - Pure synchronous function — no side effects, no DB, no network
 *
 * Mechanically-checkable QA rules (deterministic):
 *   QA-001  File exists at the given path
 *   QA-002  File extension matches preferredFormat
 *   QA-003  altText present and non-empty (from the AssetRequest)
 *   QA-004  SVG contains no <script> tags
 *   QA-005  SVG contains no <image> elements (no raster embedding)
 *   QA-006  SVG contains no on* event attributes
 *   QA-007  Byte size is reasonable (≤ MAX_ASSET_BYTES)
 *   QA-008  SVG is structurally well-formed (opens with <svg, closes with </svg>)
 *   QA-009  SVG contains no xlink:href attributes
 *
 * Non-mechanical checks (declared as unchecked — never hidden):
 *   QA-U01  Prompt match (requires subjective judgment or model review)
 *   QA-U02  Brand fit (requires design-system context)
 *   QA-U03  Composition / crop safety (requires visual inspection)
 *
 * Zero archon-service dependencies — safe to import from any tooling layer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AssetRequest } from "./asset-contract.ts";
import { resolveWithinRepo } from "./repo-path.ts";

// ---------------------------------------------------------------------------
// Finding severity + shape
// ---------------------------------------------------------------------------

export type QAFindingSeverity = "pass" | "fail" | "warn";

/**
 * A single QA finding. Every finding has a stable id so the repair loop can
 * address specific issues by id. Numeric findings carry measured + expected.
 */
export interface QAFinding {
  /** Stable id for this check (QA-NNN or QA-UNNN for unchecked). */
  id: string;
  /** pass = check ran and passed; fail = check ran and failed; warn = advisory */
  severity: QAFindingSeverity;
  /** Human-readable description of the outcome. */
  message: string;
  /** What was actually measured (e.g. file extension, byte count). */
  measured?: string;
  /** What was expected (e.g. "svg", "≤ 512000 bytes"). */
  expected?: string;
  /**
   * True when this finding is declared but NOT mechanically checkable.
   * Non-mechanical checks are ALWAYS declared explicitly — never hidden.
   */
  unchecked?: true;
}

/**
 * The structured QA report returned by runAssetQA.
 */
export interface AssetQAReport {
  /** Absolute or repo-relative path of the asset that was checked. */
  assetPath: string;
  /** True iff no finding has severity === "fail" (excluding unchecked findings). */
  pass: boolean;
  /** All findings — both mechanical (checked) and non-mechanical (unchecked). */
  findings: QAFinding[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum reasonable byte size for a committed placeholder SVG or generated asset.
 * 512 KB. Assets above this threshold should be regenerated or optimised.
 */
const MAX_ASSET_BYTES = 512_000;

/**
 * Extension-to-format map for QA-002.
 * All lowercase, without the leading dot.
 */
const EXT_TO_FORMAT: Readonly<Record<string, string>> = {
  webp: "webp",
  png:  "png",
  jpg:  "jpeg",
  jpeg: "jpeg",
  svg:  "svg"
};

// ---------------------------------------------------------------------------
// Non-mechanical (unchecked) findings — always declared
// ---------------------------------------------------------------------------

const UNCHECKED_FINDINGS: readonly QAFinding[] = [
  {
    id: "QA-U01",
    severity: "warn",
    message: "QA-U01 [unchecked]: Prompt match cannot be verified mechanically — requires visual inspection or model review of the generated asset against the prompt and negative constraints.",
    unchecked: true
  },
  {
    id: "QA-U02",
    severity: "warn",
    message: "QA-U02 [unchecked]: Brand fit cannot be verified mechanically — requires design-system context, visual critic, or operator approval.",
    unchecked: true
  },
  {
    id: "QA-U03",
    severity: "warn",
    message: "QA-U03 [unchecked]: Composition and mobile-crop safety cannot be verified mechanically — requires visual inspection at target viewport sizes.",
    unchecked: true
  }
];

// ---------------------------------------------------------------------------
// Individual check functions (pure, synchronous)
// ---------------------------------------------------------------------------

/** QA-001: File exists at the given path. */
function checkFileExists(assetPath: string): QAFinding {
  const exists = fs.existsSync(assetPath);
  return {
    id: "QA-001",
    severity: exists ? "pass" : "fail",
    message: exists
      ? `QA-001 [pass]: File exists at "${assetPath}".`
      : `QA-001 [fail]: File does not exist at "${assetPath}".`,
    measured: exists ? "file present" : "file absent",
    expected: "file present"
  };
}

/** QA-002: File extension matches preferredFormat. */
function checkFormatMatch(assetPath: string, preferredFormat: string): QAFinding {
  const ext = path.extname(assetPath).slice(1).toLowerCase();
  const mappedFormat = EXT_TO_FORMAT[ext] ?? ext;
  const match = mappedFormat === preferredFormat.toLowerCase();
  return {
    id: "QA-002",
    severity: match ? "pass" : "fail",
    message: match
      ? `QA-002 [pass]: File extension ".${ext}" matches preferredFormat "${preferredFormat}".`
      : `QA-002 [fail]: File extension ".${ext}" (${mappedFormat}) does not match preferredFormat "${preferredFormat}".`,
    measured: mappedFormat,
    expected: preferredFormat.toLowerCase()
  };
}

/** QA-003: altText is present and non-empty (whitespace-only = fail). */
function checkAltText(altText: string): QAFinding {
  const trimmed = altText.trim();
  const ok = trimmed.length > 0;
  return {
    id: "QA-003",
    severity: ok ? "pass" : "fail",
    message: ok
      ? `QA-003 [pass]: altText is present and non-empty.`
      : `QA-003 [fail]: altText is missing or empty — required for accessibility.`,
    measured: ok ? `"${trimmed.slice(0, 60)}"` : "(empty)",
    expected: "non-empty string"
  };
}

/**
 * QA-004: SVG contains no <script> tags.
 * Case-insensitive search to catch <Script>, <SCRIPT>, etc.
 */
function checkNoScript(content: string): QAFinding {
  const hasScript = /<script[\s>]/i.test(content);
  return {
    id: "QA-004",
    severity: hasScript ? "fail" : "pass",
    message: hasScript
      ? `QA-004 [fail]: SVG contains a <script> tag — forbidden (security).`
      : `QA-004 [pass]: No <script> tags detected.`,
    measured: hasScript ? "<script> present" : "<script> absent",
    expected: "<script> absent"
  };
}

/**
 * QA-005: SVG contains no <image> elements (no raster embedding).
 * Both <image ...> and <image/> forms are checked.
 */
function checkNoRasterImage(content: string): QAFinding {
  const hasImage = /<image[\s>/]/i.test(content);
  return {
    id: "QA-005",
    severity: hasImage ? "fail" : "pass",
    message: hasImage
      ? `QA-005 [fail]: SVG contains an <image> element — no raster embedding permitted.`
      : `QA-005 [pass]: No <image> elements detected.`,
    measured: hasImage ? "<image> present" : "<image> absent",
    expected: "<image> absent"
  };
}

/**
 * QA-006: SVG contains no on* event attributes (e.g. onclick, onload, onerror).
 * Pattern: \bon\w+\s*= anywhere in the SVG content.
 */
function checkNoEventAttributes(content: string): QAFinding {
  const hasEvent = /\bon\w+\s*=/i.test(content);
  return {
    id: "QA-006",
    severity: hasEvent ? "fail" : "pass",
    message: hasEvent
      ? `QA-006 [fail]: SVG contains on* event attribute(s) — forbidden (security).`
      : `QA-006 [pass]: No on* event attributes detected.`,
    measured: hasEvent ? "on* event attribute present" : "on* event attributes absent",
    expected: "on* event attributes absent"
  };
}

/**
 * QA-007: Byte size is reasonable (≤ MAX_ASSET_BYTES).
 * Uses the byte length of the read content (UTF-8 for SVG).
 */
function checkByteSize(byteSize: number): QAFinding {
  const ok = byteSize <= MAX_ASSET_BYTES;
  return {
    id: "QA-007",
    severity: ok ? "pass" : "fail",
    message: ok
      ? `QA-007 [pass]: Byte size ${byteSize.toLocaleString()} ≤ ${MAX_ASSET_BYTES.toLocaleString()}.`
      : `QA-007 [fail]: Byte size ${byteSize.toLocaleString()} exceeds max ${MAX_ASSET_BYTES.toLocaleString()} — regenerate or optimise.`,
    measured: `${byteSize} bytes`,
    expected: `≤ ${MAX_ASSET_BYTES} bytes`
  };
}

/**
 * QA-008: SVG is structurally well-formed (starts with <svg, ends with </svg>).
 * Minimal structural check — not a full XML parse.
 */
function checkSvgWellFormed(content: string): QAFinding {
  const trimmed = content.trim();
  const ok = /^<svg[\s>]/i.test(trimmed) && /<\/svg>\s*$/.test(trimmed);
  return {
    id: "QA-008",
    severity: ok ? "pass" : "fail",
    message: ok
      ? `QA-008 [pass]: SVG appears structurally well-formed.`
      : `QA-008 [fail]: SVG does not appear structurally well-formed (expected to start with <svg and end with </svg>).`,
    measured: ok ? "well-formed" : "malformed",
    expected: "starts with <svg, ends with </svg>"
  };
}

/**
 * QA-009: SVG contains no xlink:href attributes (deprecated + external-ref risk).
 */
function checkNoXlinkHref(content: string): QAFinding {
  const hasXlink = /xlink:href/i.test(content);
  return {
    id: "QA-009",
    severity: hasXlink ? "fail" : "pass",
    message: hasXlink
      ? `QA-009 [fail]: SVG contains xlink:href — deprecated and potential external-reference risk.`
      : `QA-009 [pass]: No xlink:href attributes detected.`,
    measured: hasXlink ? "xlink:href present" : "xlink:href absent",
    expected: "xlink:href absent"
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run deterministic QA checks on the given asset file against its request.
 *
 * This function is PURE and SYNCHRONOUS:
 *   - No DB writes
 *   - No network calls
 *   - No random values
 *   - Same input => same output
 *
 * Non-mechanical checks (prompt match, brand fit, crop safety) are ALWAYS
 * declared as unchecked findings — they are never silently skipped.
 *
 * @param assetPath - Absolute or repo-relative path to the asset file.
 * @param request   - The AssetRequest that generated (or describes) this asset.
 * @param repoRoot  - Optional repo root. When provided, the assetPath MUST
 *                    resolve within this root (defense-in-depth path guard,
 *                    symlinks resolved). When omitted, no bounds check is run.
 * @returns A structured AssetQAReport.
 * @throws  When `repoRoot` is provided and `assetPath` escapes it.
 */
export function runAssetQA(
  assetPath: string,
  request: AssetRequest,
  repoRoot?: string | undefined
): AssetQAReport {
  // Defense-in-depth: verify the asset path stays within the repo before
  // any file I/O. Runs only when the caller supplies a repoRoot.
  if (repoRoot !== undefined) {
    resolveWithinRepo(assetPath, { repoRoot });
  }
  const findings: QAFinding[] = [];

  // QA-001: file existence (must run first; if absent, skip content checks)
  const existsFinding = checkFileExists(assetPath);
  findings.push(existsFinding);

  // QA-002: format match (runs regardless of file existence)
  findings.push(checkFormatMatch(assetPath, request.preferredFormat));

  // QA-003: altText presence (runs regardless of file existence)
  findings.push(checkAltText(request.altText));

  if (existsFinding.severity === "pass") {
    // Read file content for SVG-specific checks
    let content: string;
    let byteSize: number;
    try {
      const buffer = fs.readFileSync(assetPath);
      byteSize = buffer.length;
      content = buffer.toString("utf8");
    } catch (err: unknown) {
      // Defensive: file disappeared between existence check and read
      findings.push({
        id: "QA-ERR",
        severity: "fail",
        message: `QA-ERR [fail]: Could not read file at "${assetPath}": ${err instanceof Error ? err.message : String(err)}`
      });
      // Add unchecked findings before returning
      findings.push(...UNCHECKED_FINDINGS);
      return buildReport(assetPath, findings);
    }

    // QA-007: byte size
    findings.push(checkByteSize(byteSize));

    // SVG-specific checks (only when the format is or should be SVG)
    const ext = path.extname(assetPath).slice(1).toLowerCase();
    const isSvgContent = ext === "svg" || request.preferredFormat === "svg";

    if (isSvgContent) {
      findings.push(checkSvgWellFormed(content));
      findings.push(checkNoScript(content));
      findings.push(checkNoRasterImage(content));
      findings.push(checkNoEventAttributes(content));
      findings.push(checkNoXlinkHref(content));
    }
  }

  // Always declare non-mechanical checks explicitly (never silently skip)
  findings.push(...UNCHECKED_FINDINGS);

  return buildReport(assetPath, findings);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildReport(assetPath: string, findings: QAFinding[]): AssetQAReport {
  // pass = no finding with severity "fail" AND not unchecked
  const failed = findings.some((f) => f.severity === "fail" && !f.unchecked);
  return {
    assetPath,
    pass: !failed,
    findings
  };
}
