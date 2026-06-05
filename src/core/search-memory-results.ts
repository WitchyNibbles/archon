import type { SearchMemoryResult } from "../domain/types.ts";

export function isProvenancedSearchResult(result: SearchMemoryResult): boolean {
  if (result.citation.canonicalRef.trim().length === 0) {
    return false;
  }

  if (result.scope === "project" && result.authority.source === "shared_backend_memory") {
    return Boolean(result.authority.reviewedBy && result.authority.reviewedBy.trim().length > 0);
  }

  return true;
}

export function annotateConflictSignals(
  results: readonly SearchMemoryResult[]
): SearchMemoryResult[] {
  const conflictMap = new Map<string, Set<string>>();

  for (let leftIndex = 0; leftIndex < results.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < results.length; rightIndex += 1) {
      const left = results[leftIndex];
      const right = results[rightIndex];
      if (!left || !right) {
        continue;
      }

      const explicitConflict =
        left.metadata.contradicts.includes(right.id) ||
        right.metadata.contradicts.includes(left.id) ||
        left.metadata.supersededBy.includes(right.id) ||
        right.metadata.supersededBy.includes(left.id);

      if (!explicitConflict && !hasConflictingClaims(left, right)) {
        continue;
      }

      const leftConflicts = conflictMap.get(left.id) ?? new Set<string>();
      leftConflicts.add(right.id);
      conflictMap.set(left.id, leftConflicts);

      const rightConflicts = conflictMap.get(right.id) ?? new Set<string>();
      rightConflicts.add(left.id);
      conflictMap.set(right.id, rightConflicts);
    }
  }

  return results.flatMap((result) => {
    if (!result) {
      return [];
    }

    return [
      {
        ...result,
        conflict: {
          detected: (conflictMap.get(result.id)?.size ?? 0) > 0,
          relatedIds: [...(conflictMap.get(result.id) ?? new Set<string>())].sort()
        }
      }
    ];
  });
}

const conflictPairs = [
  ["adopt", "delay"],
  ["enable", "disable"],
  ["allow", "block"],
  ["use", "avoid"],
  ["prefer", "reject"]
] as const;

const conflictActionTerms: ReadonlySet<string> = new Set(conflictPairs.flat());

function hasConflictingClaims(left: SearchMemoryResult, right: SearchMemoryResult): boolean {
  const leftTerms = tokenizeConflictTerms(`${left.title} ${left.content}`);
  const rightTerms = tokenizeConflictTerms(`${right.title} ${right.content}`);

  if (!hasSharedTopicTerms(leftTerms, rightTerms)) {
    return false;
  }

  return conflictPairs.some(
    ([positive, negative]) =>
      (leftTerms.has(positive) && rightTerms.has(negative)) ||
      (leftTerms.has(negative) && rightTerms.has(positive))
  );
}

function tokenizeConflictTerms(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function hasSharedTopicTerms(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const term of left) {
    if (conflictActionTerms.has(term)) {
      continue;
    }

    if (right.has(term)) {
      return true;
    }
  }

  return false;
}
