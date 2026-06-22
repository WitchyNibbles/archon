// locus-glob.ts — shared glob-matching helpers for locus filtering.
//
// Exported and used by:
//   - src/store/memory-store.ts  (MemoryMistakeLedgerStore.listAntiPatternsForLocus)
//   - src/store/postgres-store.ts (PostgresMistakeLedgerStore.listAntiPatternsForLocus)
//   - src/runtime/continuation-context.ts (locusMatchesScope, matchGlobPattern)
//
// NO imports from stores or runtime modules to prevent circular deps.
//
// Matching rules:
//   exact match          → true
//   pattern ends in /    → path.startsWith(pattern)
//   no-wildcard prefix   → path === pattern || path.startsWith(pattern + "/")
//   * wildcard           → matches any non-slash sequence
//   ** wildcard          → matches any sequence including slashes

/**
 * Match a single path against a single glob pattern with path-separator-boundary semantics.
 *
 * I/O contract:
 *   Input:  path (string), pattern (string)
 *   Output: boolean
 *   Side effects: none
 *
 * FIX (CRITICAL): no-wildcard prefix branch previously used `path.startsWith(pattern)`
 * which matched "src/store" against "src/store-extra/file.ts".
 * The correct boundary check requires `path === pattern || path.startsWith(pattern + "/")`.
 */
export function matchGlobPattern(path: string, pattern: string): boolean {
  if (path === pattern) {
    return true;
  }
  if (pattern.endsWith("/") && path.startsWith(pattern)) {
    return true;
  }
  // No-wildcard prefix: require exact match OR a path-separator boundary.
  if (!pattern.includes("*")) {
    return path.startsWith(pattern + "/");
  }
  const regexSource = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\x00")
    .replace(/\*/g, "[^/]*")
    // eslint-disable-next-line no-control-regex -- \x00 is an internal sentinel for `**`
    .replace(/\x00/g, ".*");
  const regex = new RegExp(`^${regexSource}$`);
  return regex.test(path);
}

/**
 * Returns true when locus matches any of the supplied glob patterns.
 *
 * I/O contract:
 *   Input:  locus (string | undefined), globs (readonly string[])
 *   Output: boolean
 *   Side effects: none
 *
 * Matching rules:
 *   undefined locus → universal (no file binding): always true
 *   empty globs     → universal fallback: always true
 */
export function locusMatchesGlob(
  locus: string | undefined,
  globs: readonly string[]
): boolean {
  if (locus === undefined) {
    return true;
  }
  if (globs.length === 0) {
    return true;
  }
  for (const glob of globs) {
    if (matchGlobPattern(locus, glob)) {
      return true;
    }
  }
  return false;
}
