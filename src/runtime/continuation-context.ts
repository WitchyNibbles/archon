// Continuation Context Builder — Phase 3 of the Archon Agentic Loop Runtime.
//
// Builds a compact, bounded context bundle that the agentic loop injects into
// the next invocation's prompt.  The bundle is intentionally terse: it
// references evidence rather than transcribing it.
//
// All public methods return new objects; no in-place mutation.
//
// P3 MPL: preventive anti-pattern injection.
// When tokenBudget==="bounded" and an AntiPatternInjectorLike is supplied,
// locus-matched, non-superseded, non-stale anti-patterns are injected.
// Budget enforcement: top-K=5, char cap=4000, visible provenance.

import type { HandoffRecord } from "../store/agent-runtime-store.ts";
import type { HandoffPacketV1 } from "../domain/handoff-schemas.ts";
import { HandoffController } from "./handoff-controller.ts";
import type { HandoffStoreLike } from "./handoff-controller.ts";
import type { MemoryEntryRecord, RetrievalMetadata } from "../domain/types.ts";
import { locusMatchesGlob } from "../store/locus-glob.ts";

// Re-export matchGlobPattern so existing consumers (tests, runtime) retain their import paths.
export { matchGlobPattern } from "../store/locus-glob.ts";

// ---------------------------------------------------------------------------
// Anti-Pattern Injection Types (P3 MPL)
// ---------------------------------------------------------------------------

export interface InjectedAntiPattern {
  readonly entry: MemoryEntryRecord;
  readonly recurrenceCount: number;
  readonly severityWeight: number;
  readonly locusSpecificity: number;
  readonly score: number;
}

export interface AntiPatternInjectionOptions {
  /** Top-K cap on injected anti-patterns. Default: 5. */
  readonly topK?: number | undefined;
  /** Max chars for the entire injected block. Default: 4000. */
  readonly maxChars?: number | undefined;
  /** Max age in days before an entry is stale. Default: 180. */
  readonly defaultStaleAfterDays?: number | undefined;
}

/**
 * Store interface for listing anti-pattern entries by locus.
 * Implementations must use an indexed path (not a full JSONB scan).
 * Migration 026 adds the required index to memory_entries.
 */
export interface AntiPatternInjectorLike {
  listAntiPatternsForLocus(
    projectId: string,
    locusGlobs: readonly string[]
  ): Promise<readonly MemoryEntryRecord[]>;
}

// ---------------------------------------------------------------------------
// ContinuationBundle — returned by buildBundle()
// ---------------------------------------------------------------------------

export interface ContinuationBundle {
  /** Role the next invocation operates as. */
  role: string;
  /** Active run identifier. */
  runId: string;
  /** Active task identifier. */
  taskId: string;
  /** Latest unconsumed handoff record, or undefined if none exists. */
  latestHandoff: HandoffRecord | undefined;
  /** Compact continuation prompt string ready for injection. */
  continuationPrompt: string;
  /** Evidence refs extracted from the latest handoff packet. */
  evidenceRefs: readonly string[];
  /** Next actions extracted from the latest handoff packet. */
  nextActions: readonly string[];
  /** Allowed write scope from the handoff scope block. */
  allowedWriteScope: readonly string[];
  /** ISO timestamp when this bundle was assembled. */
  assembledAt: string;
  /** Anti-patterns injected into the prompt (P3). Empty when injection disabled. */
  injectedAntiPatterns: readonly InjectedAntiPattern[];
}

// ---------------------------------------------------------------------------
// BuildBundleParams
// ---------------------------------------------------------------------------

export interface BuildBundleParams {
  runId: string;
  taskId: string;
  role: string;
  /**
   * When true (default), the latest unconsumed handoff is included.
   * Set to false to build an initial-invocation bundle with no handoff.
   */
  includeLatestHandoff?: boolean | undefined;
  /**
   * When true (default), evidence refs from the handoff are surfaced in the bundle.
   */
  includeEvidenceRefs?: boolean | undefined;
  /**
   * Controls anti-pattern injection and truncation behavior (P3).
   * "bounded" = conservative truncation + anti-pattern injection active.
   * "full" = no truncation, injection disabled (prevents bloat in full-context invocations).
   * Default: "bounded".
   */
  tokenBudget?: "bounded" | "full" | undefined;
  /**
   * Project ID for anti-pattern locus queries (P3).
   * Falls back to runId when omitted.
   */
  projectId?: string | undefined;
}

// ---------------------------------------------------------------------------
// ContinuationContextBuilder
// ---------------------------------------------------------------------------

export class ContinuationContextBuilder {
  private readonly controller: HandoffController;

  constructor(store: HandoffStoreLike) {
    this.controller = new HandoffController(store);
  }

  // -------------------------------------------------------------------------
  // buildBundle — assemble a compact ContinuationBundle
  // -------------------------------------------------------------------------

  /**
   * Build a ContinuationBundle for a given run, task, and role.
   *
   * I/O contract:
   *   Input:  BuildBundleParams, optional AntiPatternInjectorLike
   *   Output: ContinuationBundle (immutable, no side effects)
   *   Side effects: read-only store queries only
   *
   * P3 anti-pattern injection:
   *   Active when tokenBudget === "bounded" AND injector is provided.
   *   Uses allowedWriteScope from handoff packet as the locus filter.
   *   Council conditions 6+7: supersededBy exclusion, top-K=5, char cap=4000.
   */
  async buildBundle(
    params: BuildBundleParams,
    injector?: AntiPatternInjectorLike | undefined
  ): Promise<ContinuationBundle> {
    const includeLatestHandoff = params.includeLatestHandoff ?? true;
    const includeEvidenceRefs = params.includeEvidenceRefs ?? true;

    let latestHandoff: HandoffRecord | undefined;

    if (includeLatestHandoff) {
      latestHandoff = await this.controller.getLatestForTask(
        params.runId,
        params.taskId
      );
    }

    let continuationPrompt: string;
    let evidenceRefs: readonly string[] = [];
    let nextActions: readonly string[] = [];
    let allowedWriteScope: readonly string[] = [];
    let tokenBudgetFromPacket: "bounded" | "full" | undefined;

    if (latestHandoff !== undefined) {
      continuationPrompt = this.controller.buildContinuationPrompt(latestHandoff);

      const packet = latestHandoff.packet as Partial<HandoffPacketV1>;

      if (includeEvidenceRefs && Array.isArray(packet.evidenceRefs)) {
        evidenceRefs = Object.freeze([...packet.evidenceRefs]);
      }

      if (Array.isArray(packet.nextActions)) {
        nextActions = Object.freeze([...packet.nextActions]);
      }

      const scope = packet.scope;
      if (scope !== undefined && Array.isArray(scope.allowedWriteScope)) {
        allowedWriteScope = Object.freeze([...scope.allowedWriteScope]);
      }

      // P3: read tokenBudget from packet scope (written by handoff-controller).
      // tokenBudget is an advisory field not in the Zod schema — read via cast.
      const scopeExtra = scope as (typeof scope & { tokenBudget?: unknown }) | undefined;
      if (scopeExtra !== undefined) {
        if (scopeExtra.tokenBudget === "bounded" || scopeExtra.tokenBudget === "full") {
          tokenBudgetFromPacket = scopeExtra.tokenBudget as "bounded" | "full";
        }
      }
    } else {
      continuationPrompt = buildInitialPrompt(params.role, params.taskId, params.runId);
    }

    // Effective tokenBudget: params overrides packet, then defaults to "bounded"
    const effectiveTokenBudget = params.tokenBudget ?? tokenBudgetFromPacket ?? "bounded";

    // P3: inject anti-patterns when tokenBudget === "bounded" and injector provided
    let injectedAntiPatterns: readonly InjectedAntiPattern[] = Object.freeze([]);
    let injectionBlock = "";

    if (
      effectiveTokenBudget === "bounded" &&
      injector !== undefined &&
      allowedWriteScope.length > 0
    ) {
      const projectId = params.projectId ?? params.runId;
      const entries = await injector
        .listAntiPatternsForLocus(projectId, allowedWriteScope)
        .catch(() => [] as readonly MemoryEntryRecord[]);

      if (entries.length > 0) {
        // FIX 2 (HIGH): Compute the included set ONCE via buildAntiPatternInjectionWithIncluded.
        // Previously filterAndRankEntries was called separately, ignoring the char-cap truncation
        // applied inside buildAntiPatternInjection. Now injectedAntiPatterns contains EXACTLY
        // the entries rendered into continuationPrompt after char-cap — no overcounting.
        const injection = buildAntiPatternInjectionWithIncluded(entries, allowedWriteScope, {});
        injectionBlock = injection.block;
        injectedAntiPatterns = Object.freeze(injection.included);
      }
    }

    const finalPrompt =
      injectionBlock.length > 0
        ? `${continuationPrompt}\n\n${injectionBlock}`
        : continuationPrompt;

    return Object.freeze({
      role: params.role,
      runId: params.runId,
      taskId: params.taskId,
      latestHandoff,
      continuationPrompt: finalPrompt,
      evidenceRefs,
      nextActions,
      allowedWriteScope,
      assembledAt: new Date().toISOString(),
      injectedAntiPatterns
    });
  }
}

// ---------------------------------------------------------------------------
// buildInitialPrompt — first-invocation prompt (no handoff)
// ---------------------------------------------------------------------------

function buildInitialPrompt(role: string, taskId: string, runId: string): string {
  return `Operate as \`${role}\` for Archon task \`${taskId}\`.

Runtime authority:
- Active run: \`${runId}\`
- Active task: \`${taskId}\`
- No prior handoff — this is the first invocation.

Rules:
- If context reaches 70%, commit a handoff packet before continuing.
- If you spawn subagents, each must return \`subagent_result_packet_v1\`.
`;
}

// ---------------------------------------------------------------------------
// Anti-Pattern Injection Utilities (P3 MPL)
// Exported for testing and external use.
// ---------------------------------------------------------------------------

const DEFAULT_STALE_AFTER_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ANTI_PATTERN_TOP_K = 5;
const ANTI_PATTERN_MAX_CHARS = 4000;

const SEVERITY_WEIGHTS: Readonly<Record<string, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

/**
 * FIX 5 (security MEDIUM): Guard against string-typed supersededBy.
 * A string value has .length > 0 even when it is empty "", so we must
 * ensure supersededBy is an array before treating it as one.
 * supersededBy: [] → not superseded (empty array is safe).
 * supersededBy: "some-id" → treated as superseded (string guard).
 * supersededBy: undefined → not superseded.
 */
function isSuperseded(entry: MemoryEntryRecord): boolean {
  // Cast through unknown so TS permits the string-guard on a value typed string[]|undefined.
  // Runtime defense: guard against string-typed supersededBy (malformed metadata).
  const sb: unknown = (entry.metadata as RetrievalMetadata).supersededBy;
  if (sb === undefined || sb === null) {
    return false;
  }
  if (typeof sb === "string") {
    return sb.length > 0;
  }
  if (Array.isArray(sb)) {
    return sb.length > 0;
  }
  return false;
}

function isStaleEntry(
  entry: MemoryEntryRecord,
  defaultStaleAfterDays: number
): boolean {
  const staleAfterDays =
    (entry.metadata as RetrievalMetadata).staleAfterDays ?? defaultStaleAfterDays;
  const createdAtMs = Date.parse(entry.createdAt);
  if (Number.isNaN(createdAtMs)) {
    return false;
  }
  const ageDays = (Date.now() - createdAtMs) / MS_PER_DAY;
  return ageDays > staleAfterDays;
}

/** Extract symbolLocus from memory entry tags. */
export function symbolLocusFromTags(tags: readonly string[]): string | undefined {
  for (const tag of tags) {
    if (tag.startsWith("locus:")) {
      return tag.slice("locus:".length);
    }
  }
  return undefined;
}

function recurrenceCountFromTags(tags: readonly string[]): number {
  for (const tag of tags) {
    if (tag.startsWith("recurrence:")) {
      const n = parseInt(tag.slice("recurrence:".length), 10);
      return Number.isFinite(n) ? n : 1;
    }
  }
  return 1;
}

function severityWeightFromTags(tags: readonly string[]): number {
  for (const tag of tags) {
    if (tag.startsWith("severity:")) {
      const sev = tag.slice("severity:".length);
      return SEVERITY_WEIGHTS[sev] ?? 2;
    }
  }
  return 2;
}

/**
 * Returns true when symbolLocus matches any scope glob.
 *
 * I/O contract:
 *   Input:  symbolLocus (string | undefined), scopeGlobs (readonly string[])
 *   Output: boolean
 *   Side effects: none
 *
 * Matching rules:
 *   undefined symbolLocus → universal (no file binding): always true
 *   empty scopeGlobs → universal fallback: always true
 *   glob: * = non-slash chars; ** = any; prefix ending in / = startsWith
 */
export function locusMatchesScope(
  symbolLocus: string | undefined,
  scopeGlobs: readonly string[]
): boolean {
  return locusMatchesGlob(symbolLocus, scopeGlobs);
}

/**
 * Rank anti-patterns by recurrence × severity × locus-specificity, descending.
 * Caps output at topK.
 *
 * I/O contract:
 *   Input:  candidates (InjectedAntiPattern[]), options
 *   Output: ranked + capped slice (new array, immutable)
 *   Side effects: none
 */
export function rankAntiPatterns(
  candidates: readonly InjectedAntiPattern[],
  options: { topK?: number | undefined } = {}
): readonly InjectedAntiPattern[] {
  const topK = options.topK ?? ANTI_PATTERN_TOP_K;
  return [...candidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function buildInjectedEntry(entry: MemoryEntryRecord): InjectedAntiPattern {
  const tags = (entry.metadata as RetrievalMetadata).tags ?? [];
  const recurrenceCount = recurrenceCountFromTags(tags);
  const severityWeight = severityWeightFromTags(tags);
  const symbolLocus = symbolLocusFromTags(tags);
  const locusSpecificity = symbolLocus !== undefined ? 2 : 1;
  const score = recurrenceCount * severityWeight * locusSpecificity;
  return { entry, recurrenceCount, severityWeight, locusSpecificity, score };
}

/**
 * Filter and rank entries for injection.
 * Used internally by both buildAntiPatternInjection and buildBundle.
 */
function filterAndRankEntries(
  entries: readonly MemoryEntryRecord[],
  scopeGlobs: readonly string[],
  options: AntiPatternInjectionOptions
): InjectedAntiPattern[] {
  const topK = options.topK ?? ANTI_PATTERN_TOP_K;
  const defaultStaleAfterDays = options.defaultStaleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;

  const eligible = entries.filter(
    (entry) => !isSuperseded(entry) && !isStaleEntry(entry, defaultStaleAfterDays)
  );

  const locusMatched = eligible.filter((entry) => {
    const tags = (entry.metadata as RetrievalMetadata).tags ?? [];
    const symbolLocus = symbolLocusFromTags(tags);
    return locusMatchesScope(symbolLocus, scopeGlobs);
  });

  const candidates = locusMatched.map(buildInjectedEntry);
  return [...rankAntiPatterns(candidates, { topK })] as InjectedAntiPattern[];
}

/**
 * Sanitize a single rendered fragment from an anti-pattern entry for safe
 * injection into the continuation prompt.
 *
 * Neutralization steps (prompt-injection defence-in-depth):
 *   1. Strip control characters (U+0000–U+0008, U+000B–U+001F; keep \t, \n, \r).
 *   2. Collapse all remaining newline/carriage-return sequences to a single space,
 *      preventing newline-injection attacks that forge extra block lines.
 *   3. Neutralize any literal `[ANTI-PATTERN` or `[/ANTI-PATTERN]` sequences so
 *      content cannot forge or close a block delimiter.
 *   4. Cap length at maxLen characters (default 300) after the above steps.
 *
 * I/O contract:
 *   Input:  raw fragment string from entry content
 *   Output: sanitized string, single-line, capped at maxLen chars
 *   Side effects: none
 */
function sanitizeFragment(raw: string, maxLen: number = 300): string {
  // Step 1: strip control characters — C0 (keep tab \t=\x09, newline \n=\x0a,
  // CR \r=\x0d), DEL \x7f, and C1 controls \x80-\x9f EXCEPT NEL \x85 (which step 2
  // collapses as a line break). Prevents terminal/control sequences in content.
  // eslint-disable-next-line no-control-regex
  const noControl = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x84\x86-\x9f]/g, "");
  // Step 2: collapse ALL line separators to a space so embedded breaks can't forge
  // extra prompt lines — LF/CR plus Unicode NEL (U+0085), LS (U+2028), PS (U+2029).
  const singleLine = noControl.replace(/[\n\r\u0085\u2028\u2029]+/g, " ").trim();
  // Step 3: neutralize block delimiter sequences.
  const noDelimiters = singleLine
    .replace(/\[ANTI-PATTERN/gi, "[ANTI\\u2010PATTERN")
    .replace(/\[\/ANTI-PATTERN\]/gi, "[/ANTI\\u2010PATTERN]");
  // Step 4: cap length.
  return noDelimiters.length > maxLen ? noDelimiters.slice(0, maxLen) : noDelimiters;
}

/**
 * Format a single anti-pattern entry in compact caveman style.
 *
 * Includes visible provenance: fingerprint prefix + representative run IDs.
 * Council condition 6: bad injection is traceable and revocable.
 *
 * I/O contract:
 *   Input:  entry (MemoryEntryRecord)
 *   Output: string (compact text, ≤ ~600 chars per entry)
 *   Side effects: none
 *
 * Sanitization (mplInjectionHardening FIX 2):
 *   All rendered content fragments are passed through sanitizeFragment before
 *   insertion into the prompt block. This neutralizes:
 *     - Embedded block delimiters ([ANTI-PATTERN / [/ANTI-PATTERN])
 *     - Newline injection (collapsed to single space)
 *     - Control characters (stripped)
 *     - Overlong fragments (capped at 300 chars)
 */
export function formatInjectedAntiPattern(entry: MemoryEntryRecord): string {
  const fingerprint = (entry.metadata as RetrievalMetadata).mistakeFingerprint ?? "unknown";
  // Include full fingerprint for provenance traceability. SHA-256 (64 hex chars)
  // is truncated to 24 for display brevity while remaining unambiguous.
  const fpShort = fingerprint.length > 24 ? fingerprint.slice(0, 24) : fingerprint;

  const lines = entry.content.split("\n");
  const categoryLine =
    lines.find((l) => l.startsWith("Anti-pattern:")) ?? `Anti-pattern: ${entry.entryType}`;
  const anchorLine = lines.find((l) => l.startsWith("Policy anchor:")) ?? "";
  const recurrenceLine = lines.find((l) => l.startsWith("Recurrence:")) ?? "";
  const provenanceLines = lines.filter((l) => l.trim().startsWith("run=")).slice(0, 2);

  // Extract raw values, then sanitize each fragment before rendering.
  const category = sanitizeFragment(categoryLine.replace("Anti-pattern:", "").trim());
  const anchor = sanitizeFragment(anchorLine.replace("Policy anchor:", "").trim());
  const recurrence = sanitizeFragment(recurrenceLine.replace("Recurrence:", "").trim());

  const guidanceStart = lines.findIndex(
    (l) => l.includes("Prevention") || l.includes("detection guidance")
  );
  const guidanceLines =
    guidanceStart !== -1
      ? lines
          .slice(guidanceStart + 1)
          .filter((l) => l.trim().startsWith("-"))
          .slice(0, 2)
          .map((l) => sanitizeFragment(l.trim()))
      : [];

  return [
    `[ANTI-PATTERN] ${category}`,
    `anchor:${anchor || "unknown"} fp:${sanitizeFragment(fpShort)}`,
    recurrence ? `seen:${recurrence}` : "",
    ...provenanceLines.map((l) => sanitizeFragment(l.trim())),
    ...guidanceLines
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

/**
 * Build the injected anti-pattern block string and return the exact set of
 * included entries after char-cap truncation.
 *
 * FIX 2 (HIGH): Previously buildBundle called filterAndRankEntries twice —
 * once inside buildAntiPatternInjection (with char-cap) and once directly
 * (without char-cap). This caused injectedAntiPatterns to contain entries
 * that were dropped by the char-cap, overcounting archon_injection_prevention_hit_rate.
 *
 * This internal form returns both the block string and the included entries,
 * letting buildBundle derive injectedAntiPatterns from EXACTLY the entries
 * that appear in continuationPrompt after char-cap truncation.
 *
 * I/O contract:
 *   Input:  entries (MemoryEntryRecord[]), scopeGlobs, options
 *   Output: { block: string, included: InjectedAntiPattern[] }
 *   Side effects: none
 */
function buildAntiPatternInjectionWithIncluded(
  entries: readonly MemoryEntryRecord[],
  scopeGlobs: readonly string[],
  options: AntiPatternInjectionOptions
): { block: string; included: InjectedAntiPattern[] } {
  const maxChars = options.maxChars ?? ANTI_PATTERN_MAX_CHARS;
  const ranked = filterAndRankEntries(entries, scopeGlobs, options);

  if (ranked.length === 0) {
    return { block: "", included: [] };
  }

  const sections: string[] = [];
  const included: InjectedAntiPattern[] = [];
  let totalChars = 0;

  const header = "=== PREVENTIVE INJECTION (locus-matched) ===\n";
  totalChars += header.length;

  for (const item of ranked) {
    const formatted = formatInjectedAntiPattern(item.entry);
    const sectionText = `${formatted}\n---\n`;
    if (totalChars + sectionText.length > maxChars) {
      break;
    }
    sections.push(sectionText);
    included.push(item);
    totalChars += sectionText.length;
  }

  if (sections.length === 0) {
    return { block: "", included: [] };
  }

  return { block: header + sections.join(""), included };
}

/**
 * Build the injected anti-pattern block string.
 *
 * Council conditions enforced:
 *   6: supersededBy entries excluded
 *   7: top-K cap, char cap
 *
 * I/O contract:
 *   Input:  entries (MemoryEntryRecord[]), scopeGlobs, options
 *   Output: string (injection block or "")
 *   Side effects: none
 */
export function buildAntiPatternInjection(
  entries: readonly MemoryEntryRecord[],
  scopeGlobs: readonly string[],
  options: AntiPatternInjectionOptions
): string {
  return buildAntiPatternInjectionWithIncluded(entries, scopeGlobs, options).block;
}
