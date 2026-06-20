// Canonical task-class source of truth (Option B, condition 2).
//
// Historically two divergent enums existed: `ALLOWED_TASK_CLASSES`
// (src/archon/task-queue.ts) and `VALID_TASK_CLASSES` (src/admin/init-task.ts).
// This module unifies them into one auditable union plus the review-floor
// security primitives (opt-out set + deny-by-default scope guard) that the
// review-floor relaxation depends on. No gate-trusted value is ever derived from
// a worker-writable field — class is explicit and validated here.

import { DEFAULT_REPO_MARKDOWN_INCLUDE_PATHS } from "../runtime/repo-markdown-indexer.ts";

// The 7-value union: the union of the two legacy constants.
export const VALID_TASK_CLASSES = [
  "prototype_slice",
  "security_sensitive",
  "release_candidate",
  "docs_only",
  "memory_curation",
  "state_sync",
  "scaffold_only"
] as const;

export type TaskClass = (typeof VALID_TASK_CLASSES)[number];

// Preserve the legacy alias from task-queue.ts so historical packets resolve.
const LEGACY_TASK_CLASS_ALIASES: Readonly<Record<string, TaskClass>> = {
  implementation_slice: "prototype_slice"
};

const VALID_TASK_CLASS_SET: ReadonlySet<string> = new Set(VALID_TASK_CLASSES);

// Resolve a raw string to a canonical TaskClass, applying legacy aliases.
// Returns undefined for unknown values (caller decides how to reject).
export function normalizeTaskClass(raw: string): TaskClass | undefined {
  if (VALID_TASK_CLASS_SET.has(raw)) {
    return raw as TaskClass;
  }
  return LEGACY_TASK_CLASS_ALIASES[raw];
}

export function isTaskClass(raw: string): raw is TaskClass {
  return VALID_TASK_CLASS_SET.has(raw);
}

// Classes eligible for review-floor reduction (genuinely non-code, non-control).
// Reduction is gated on class membership here AND scopeIsReviewSafe(); neither
// alone is sufficient.
export const OPT_OUT_TASK_CLASSES = [
  "docs_only",
  "state_sync",
  "memory_curation",
  "scaffold_only"
] as const;

export type OptOutClass = (typeof OPT_OUT_TASK_CLASSES)[number];

// Compile-time guarantee that every opt-out class is a valid TaskClass.
type _AssertOptOutSubset = OptOutClass extends TaskClass ? true : never;
const _optOutSubsetCheck: _AssertOptOutSubset = true;
void _optOutSubsetCheck;

// Exhaustive classifier with a `never` default so adding a TaskClass without
// classifying it is a compile error.
export function isOptOutClass(cls: TaskClass): cls is OptOutClass {
  switch (cls) {
    case "docs_only":
    case "state_sync":
    case "memory_curation":
    case "scaffold_only":
      return true;
    case "prototype_slice":
    case "security_sensitive":
    case "release_candidate":
      return false;
    default: {
      const exhaustive: never = cls;
      return exhaustive;
    }
  }
}

// Control-layer roots that must always force the full review trio, plus every
// path the repo-markdown indexer ingests (imported, so future include paths
// auto-deny — a parity test asserts the subset relationship). De-duplicated.
export const REVIEW_FLOOR_DENY_PREFIXES: readonly string[] = [
  ...new Set<string>([
    ".archon/rules",
    ".archon/memory",
    ".archon/ACTIVE",
    "CLAUDE.md",
    "AGENTS.md",
    ".claude",
    ".codex",
    ...DEFAULT_REPO_MARKDOWN_INCLUDE_PATHS
  ])
];

// Normalize a single scope entry for the review-floor guard. Returns the
// canonical slash-form path, or null when the entry is suspicious and must be
// treated as unsafe (deny-by-default). Hardening notes:
//   - reject null bytes outright
//   - NFKC fold (collapses fullwidth solidus ／ U+FF0F -> ASCII '/')
//   - URL-decode exactly once, then re-check (defeats `.claude%2Fhooks`)
//   - reject ANY backslash (stricter than the design's backslash->slash: a
//     backslash in a POSIX scope path that is about to drive a review REDUCTION
//     is anomalous; rejecting it can only force MORE review, never less)
//   - reject ANY non-ASCII char (stricter than "non-ASCII separators only":
//     catches U+2215 division slash and homoglyphs; fail-safe direction)
//   - reject `.`/`..`/empty/wildcard segments (no traversal, no globs)
function normalizeScopeEntryForFloor(raw: string): string | null {
  if (typeof raw !== "string" || raw.includes("\0")) {
    return null;
  }
  let value = raw.trim();
  if (value.length === 0) {
    return null;
  }
  value = value.normalize("NFKC");
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (value.includes("\0") || value.includes("\\")) {
    return null;
  }
  // Reject any non-ASCII character (covers unicode separators / homoglyphs).
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) {
      return null;
    }
  }
  // Strip leading "./" repetitions and trailing slashes.
  value = value.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (value.length === 0) {
    return null;
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes("*")) {
      return null;
    }
  }
  return segments.join("/");
}

function entryMatchesDenyPrefix(normalized: string): boolean {
  return REVIEW_FLOOR_DENY_PREFIXES.some(
    (prefix) =>
      // exact match, the entry is inside the deny root, OR the entry is an
      // ANCESTOR of a deny root (e.g. scope ".archon" contains ".archon/rules")
      normalized === prefix ||
      normalized.startsWith(`${prefix}/`) ||
      prefix.startsWith(`${normalized}/`)
  );
}

// Deny-by-default: a scope is review-safe only if it is non-empty and EVERY
// entry normalizes cleanly and matches no deny prefix. One bad entry poisons the
// whole task → full trio (Conditions 4 + 7).
export function scopeIsReviewSafe(scope: readonly string[] | undefined): boolean {
  if (!scope || scope.length === 0) {
    return false;
  }
  for (const rawEntry of scope) {
    const normalized = normalizeScopeEntryForFloor(rawEntry);
    if (normalized === null) {
      return false;
    }
    if (entryMatchesDenyPrefix(normalized)) {
      return false;
    }
  }
  return true;
}
