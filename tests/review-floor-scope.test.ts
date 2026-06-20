import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VALID_TASK_CLASSES,
  OPT_OUT_TASK_CLASSES,
  REVIEW_FLOOR_DENY_PREFIXES,
  normalizeTaskClass,
  isOptOutClass,
  scopeIsReviewSafe,
  type TaskClass
} from "../src/domain/task-class.ts";
import { DEFAULT_REPO_MARKDOWN_INCLUDE_PATHS } from "../src/runtime/repo-markdown-indexer.ts";

test("canonical enum is the 7-value union of the two legacy constants", () => {
  assert.deepEqual(
    [...VALID_TASK_CLASSES].sort(),
    [
      "docs_only",
      "memory_curation",
      "prototype_slice",
      "release_candidate",
      "scaffold_only",
      "security_sensitive",
      "state_sync"
    ]
  );
});

test("legacy implementation_slice alias resolves to prototype_slice", () => {
  assert.equal(normalizeTaskClass("implementation_slice"), "prototype_slice");
  for (const cls of VALID_TASK_CLASSES) {
    assert.equal(normalizeTaskClass(cls), cls);
  }
  assert.equal(normalizeTaskClass("not_a_class"), undefined);
});

test("opt-out set is exactly the four non-code classes and each is a TaskClass", () => {
  assert.deepEqual(
    [...OPT_OUT_TASK_CLASSES].sort(),
    ["docs_only", "memory_curation", "scaffold_only", "state_sync"]
  );
  const codeClasses: TaskClass[] = ["prototype_slice", "security_sensitive", "release_candidate"];
  for (const cls of OPT_OUT_TASK_CLASSES) {
    assert.equal(isOptOutClass(cls), true);
  }
  for (const cls of codeClasses) {
    assert.equal(isOptOutClass(cls), false);
  }
});

test("deny-list contains the control-layer roots and every repo-markdown indexer path (parity)", () => {
  for (const root of [".archon/rules", ".archon/memory", ".archon/ACTIVE", "CLAUDE.md", "AGENTS.md", ".claude", ".codex"]) {
    assert.ok(REVIEW_FLOOR_DENY_PREFIXES.includes(root), `deny-list missing ${root}`);
  }
  // anti-drift: indexer paths must be a subset of the deny-list
  for (const indexed of DEFAULT_REPO_MARKDOWN_INCLUDE_PATHS) {
    assert.ok(
      REVIEW_FLOOR_DENY_PREFIXES.includes(indexed),
      `indexer path ${indexed} is not deny-listed (review-floor would reduce on indexed content)`
    );
  }
});

test("safe scopes are review-safe", () => {
  for (const scope of [[".archon/work/scratch"], ["sandbox/"], ["tmp/"], ["sandbox/a", "tmp/b"]]) {
    assert.equal(scopeIsReviewSafe(scope), true, `expected safe: ${scope.join(",")}`);
  }
});

test("each deny-listed root individually forces trio (not review-safe)", () => {
  const denyEntries = [
    ".archon/rules",
    ".archon/memory",
    ".archon/ACTIVE",
    "CLAUDE.md",
    "AGENTS.md",
    ".claude/hooks/hook-utils.mjs",
    ".codex",
    "README.md",
    "docs",
    "docs/proposals/x.md",
    ".agents/skills/foo"
  ];
  for (const entry of denyEntries) {
    assert.equal(scopeIsReviewSafe([entry]), false, `expected deny: ${entry}`);
  }
});

test("empty / dot / wildcard scopes are never review-safe (deny-by-default)", () => {
  for (const scope of [[], [""], ["."], ["./"], ["*"], ["**"], ["/"], ["*/"], ["sandbox/", ""], ["sandbox/", "*"]]) {
    assert.equal(scopeIsReviewSafe(scope), false, `expected deny: ${JSON.stringify(scope)}`);
  }
});

test("mixed safe + deny entry forces trio (one poisons all)", () => {
  assert.equal(scopeIsReviewSafe(["sandbox/a", ".claude/hooks/x.mjs"]), false);
  assert.equal(scopeIsReviewSafe(["tmp/ok", "CLAUDE.md"]), false);
});

test("adversarial normalization cannot smuggle a deny-listed root past the guard", () => {
  const adversarial = [
    ".\\claude",
    "./.claude",
    "CLAUDE.md/",
    ".claude%2Fhooks",
    ".claude/hooks/../../CLAUDE.md",
    "docs/../.claude",
    "../CLAUDE.md",
    ".claude∕hooks", // U+2215 division slash
    ".claude／hooks", // U+FF0F fullwidth solidus
    " .claude",
    ".claude ",
    "docs ",
    "\x00.claude", // null byte prefix
    "sandbox/\x00/../.claude", // null byte mid-path
    ".claude\x00" // null byte suffix
  ];
  for (const entry of adversarial) {
    assert.equal(scopeIsReviewSafe([entry]), false, `expected deny (adversarial): ${JSON.stringify(entry)}`);
  }
});

test("lookalike prefixes stay review-safe (segment-aware, not substring)", () => {
  for (const entry of ["srcdocs/x", "readme-notes/x", "claude-config/x", "docs-internal/x", ".archon/work/notes"]) {
    assert.equal(scopeIsReviewSafe([entry]), true, `expected safe (lookalike): ${entry}`);
  }
});
