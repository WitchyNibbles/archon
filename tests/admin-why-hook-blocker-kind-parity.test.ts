import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { hookBlockerKinds } from "../src/domain/types.ts";

// Round-14 CRITICAL fix: domain/types.ts hand-mirrors .claude/hooks/hook-
// utils.mjs's module-private `hookBlockerKinds` Set (the same "kept in
// lockstep" pattern already used for councilApprovedOutcomes — see
// admin-why-council-parity.test.ts). That comment must be backed by a test
// that actually compares the two sets, or the tables WILL drift silently and
// why.ts's read-time enum validation will disagree with what the hook
// actually writes.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function extractHookBlockerKindsFromSource(source: string): Set<string> {
  const match = source.match(/hookBlockerKinds\s*=\s*new Set\(([^)]*)\)/s);
  assert.ok(match, "hookBlockerKinds literal not found in hook-utils.mjs");
  const listBody = match![1]!;
  const tokens = [...listBody.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]!);
  assert.ok(tokens.length > 0, "no string tokens parsed from hookBlockerKinds literal");
  return new Set(tokens);
}

test("parity: domain/types.ts hookBlockerKinds matches hook-utils.mjs's set exactly", async () => {
  const hookUtilsSource = await readFile(resolve(repoRoot, ".claude/hooks/hook-utils.mjs"), "utf8");
  const hookSet = extractHookBlockerKindsFromSource(hookUtilsSource);
  const typesSet = new Set<string>(hookBlockerKinds);

  const onlyInHook = [...hookSet].filter((v) => !typesSet.has(v));
  const onlyInTypes = [...typesSet].filter((v) => !hookSet.has(v));

  assert.deepEqual(onlyInHook, [], `hook-utils.mjs has blocker kinds domain/types.ts is missing: ${onlyInHook.join(", ")}`);
  assert.deepEqual(
    onlyInTypes,
    [],
    `domain/types.ts has blocker kinds hook-utils.mjs does not recognize: ${onlyInTypes.join(", ")}`
  );
});
