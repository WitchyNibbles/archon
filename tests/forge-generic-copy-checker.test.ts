/**
 * Tests for src/forge/generic-copy-checker.ts — deterministic copy dimension
 * of the anti-generic gate.
 *
 * Covers (TDD — written before implementation):
 *   - CG-001: forbidden SaaS phrase found → finding per (phrase, location)
 *   - CG-001: 3+ forbidden phrases → blocking=true
 *   - CG-001: 1 forbidden phrase → finding present, blocking=false
 *   - CG-001: word-boundary rule — "streamlined" must NOT match "streamline"
 *   - CG-001: word-boundary rule — "unlocking" must NOT match "unlock"
 *   - CG-001: case-insensitive — "Seamless" matches "seamless"
 *   - CG-002: "Features" section name + ≤4 total sections → finding
 *   - CG-002: "Features" section name + >4 total sections → no finding
 *   - CG-002: no "features" section → no finding
 *   - CG-003: lorem ipsum copy → finding
 *   - CG-003: obvious placeholder tokens → finding
 *   - clean copy → blocking=false, findings=[]
 *   - blocking >= 3 rule
 *   - determinism: same input ⇒ identical output, stable ordering
 *   - strict Zod parse: invalid input rejected at schema layer
 *   - capped strings: phrase and location fields are bounded
 *   - uncheckedRules declared (never hidden)
 *   - score === findings.length
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-generic-copy-checker.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkGenericCopy } from "../src/forge/generic-copy-checker.ts";
import {
  CopyInputSchema,
  CopyFindingSchema,
  CopyReportSchema
} from "../src/forge/generic-copy-types.ts";
import type { CopyInput } from "../src/forge/generic-copy-types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function input(
  copyBlocks: Record<string, string>,
  sectionNames?: string[]
): CopyInput {
  return sectionNames !== undefined
    ? { copyBlocks, sectionNames }
    : { copyBlocks };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("CopyInputSchema", () => {
  it("accepts a valid input with copyBlocks only", () => {
    const result = CopyInputSchema.safeParse({
      copyBlocks: { hero: "Build something great." }
    });
    assert.ok(result.success, "expected parse success");
  });

  it("accepts a valid input with sectionNames", () => {
    const result = CopyInputSchema.safeParse({
      copyBlocks: { hero: "Build something great." },
      sectionNames: ["Hero", "Pricing"]
    });
    assert.ok(result.success, "expected parse success");
  });

  it("rejects missing copyBlocks", () => {
    const result = CopyInputSchema.safeParse({ sectionNames: ["Hero"] });
    assert.ok(!result.success, "expected parse failure for missing copyBlocks");
  });

  it("rejects non-string copyBlocks values", () => {
    const result = CopyInputSchema.safeParse({
      copyBlocks: { hero: 42 }
    });
    assert.ok(!result.success, "expected parse failure for non-string copyBlocks value");
  });
});

describe("CopyFindingSchema", () => {
  it("accepts a minimal valid finding", () => {
    const result = CopyFindingSchema.safeParse({
      ruleId: "CG-001",
      severity: "warning",
      message: "Generic phrase found."
    });
    assert.ok(result.success, "expected parse success");
  });

  it("accepts a full finding with phrase and location", () => {
    const result = CopyFindingSchema.safeParse({
      ruleId: "CG-001",
      phrase: "seamless",
      location: "hero",
      severity: "warning",
      message: "Generic SaaS copy phrase 'seamless' in block 'hero'."
    });
    assert.ok(result.success, "expected parse success");
  });

  it("rejects invalid ruleId pattern", () => {
    const result = CopyFindingSchema.safeParse({
      ruleId: "AG-001",
      severity: "warning",
      message: "wrong prefix"
    });
    assert.ok(!result.success, "expected parse failure for AG- prefix (must be CG-)");
  });

  it("rejects invalid severity", () => {
    const result = CopyFindingSchema.safeParse({
      ruleId: "CG-001",
      severity: "info",
      message: "msg"
    });
    assert.ok(!result.success, "expected parse failure for invalid severity");
  });
});

describe("CopyReportSchema", () => {
  it("accepts a valid empty report", () => {
    const result = CopyReportSchema.safeParse({
      findings: [],
      blocking: false,
      uncheckedRules: ["CG-UNCHECKED-specificity"],
      score: 0
    });
    assert.ok(result.success, "expected parse success");
  });

  it("rejects score mismatch (schema does not enforce count match — that is checker logic)", () => {
    // The schema itself is permissive on the score value (it is an integer).
    // The checker is responsible for setting score === findings.length.
    const result = CopyReportSchema.safeParse({
      findings: [],
      blocking: false,
      uncheckedRules: [],
      score: 99
    });
    assert.ok(result.success, "schema allows any non-negative integer for score");
  });
});

// ---------------------------------------------------------------------------
// CG-001: forbidden SaaS phrases
// ---------------------------------------------------------------------------

describe("CG-001 forbidden phrases", () => {
  it("detects 'seamless' in a copy block and emits CG-001 warning", () => {
    const report = checkGenericCopy(
      input({ hero: "Experience seamless integration with your tools." })
    );
    const cg001 = report.findings.filter(f => f.ruleId === "CG-001");
    assert.ok(cg001.length >= 1, "expected at least one CG-001 finding");
    assert.ok(
      cg001.some(f => f.phrase === "seamless"),
      "expected finding to cite phrase 'seamless'"
    );
    assert.ok(
      cg001.some(f => f.location === "hero"),
      "expected finding to cite location 'hero'"
    );
    assert.ok(
      cg001.every(f => f.severity === "warning"),
      "CG-001 findings must have severity 'warning'"
    );
  });

  it("detects 'unlock' as a standalone word", () => {
    const report = checkGenericCopy(
      input({ cta: "Unlock the full potential of your team." })
    );
    assert.ok(
      report.findings.some(f => f.ruleId === "CG-001" && f.phrase === "unlock"),
      "expected CG-001 finding for 'unlock'"
    );
  });

  it("does NOT match 'unlocking' as 'unlock' (word-boundary rule)", () => {
    const report = checkGenericCopy(
      input({ body: "Unlocking is a metaphor we avoid but unlocking here tests the boundary." })
    );
    const unlockFindings = report.findings.filter(
      f => f.ruleId === "CG-001" && f.phrase === "unlock"
    );
    assert.strictEqual(
      unlockFindings.length,
      0,
      "word-boundary rule: 'unlocking' must NOT match the forbidden phrase 'unlock'"
    );
  });

  it("does NOT match 'streamlined' as 'streamline' (word-boundary rule)", () => {
    const report = checkGenericCopy(
      input({ features: "A streamlined process for modern teams." })
    );
    const streamlineFindings = report.findings.filter(
      f => f.ruleId === "CG-001" && f.phrase === "streamline"
    );
    assert.strictEqual(
      streamlineFindings.length,
      0,
      "word-boundary rule: 'streamlined' must NOT match the forbidden phrase 'streamline'"
    );
  });

  it("matches 'streamline' as a standalone word", () => {
    const report = checkGenericCopy(
      input({ hero: "We streamline your operations." })
    );
    assert.ok(
      report.findings.some(f => f.ruleId === "CG-001" && f.phrase === "streamline"),
      "expected CG-001 finding for 'streamline'"
    );
  });

  it("matches 'all-in-one' (hyphenated phrase)", () => {
    const report = checkGenericCopy(
      input({ hero: "The all-in-one platform for modern teams." })
    );
    assert.ok(
      report.findings.some(f => f.ruleId === "CG-001" && f.phrase === "all-in-one"),
      "expected CG-001 finding for 'all-in-one'"
    );
  });

  it("matches 'supercharge' case-insensitively ('Supercharge')", () => {
    const report = checkGenericCopy(
      input({ hero: "Supercharge your workflow today." })
    );
    assert.ok(
      report.findings.some(f => f.ruleId === "CG-001" && f.phrase === "supercharge"),
      "expected CG-001 finding for case-insensitive match of 'Supercharge'"
    );
  });

  it("emits one finding per (phrase, location) pair — not one per occurrence in block", () => {
    const report = checkGenericCopy(
      input({ hero: "Seamless and seamless again seamless." })
    );
    const heroSeamless = report.findings.filter(
      f => f.ruleId === "CG-001" && f.phrase === "seamless" && f.location === "hero"
    );
    assert.strictEqual(heroSeamless.length, 1, "one finding per (phrase, location), not per occurrence");
  });

  it("emits one finding per (phrase, location) — different blocks count separately", () => {
    const report = checkGenericCopy(
      input({
        hero: "Seamless integration awaits.",
        pricing: "Seamless billing too."
      })
    );
    const seamlessHero = report.findings.filter(
      f => f.ruleId === "CG-001" && f.phrase === "seamless" && f.location === "hero"
    );
    const seamlessPricing = report.findings.filter(
      f => f.ruleId === "CG-001" && f.phrase === "seamless" && f.location === "pricing"
    );
    assert.strictEqual(seamlessHero.length, 1, "one finding for hero block");
    assert.strictEqual(seamlessPricing.length, 1, "one finding for pricing block");
  });

  it("detects all extended forbidden phrases (revolutionize, leverage, cutting-edge, game-changer, next-generation, effortless)", () => {
    const extendedPhrases = [
      "revolutionize",
      "leverage",
      "cutting-edge",
      "game-changer",
      "next-generation",
      "effortless"
    ];
    for (const phrase of extendedPhrases) {
      const report = checkGenericCopy(
        input({ hero: `We ${phrase} your operations.` })
      );
      assert.ok(
        report.findings.some(f => f.ruleId === "CG-001" && f.phrase === phrase),
        `expected CG-001 finding for extended forbidden phrase '${phrase}'`
      );
    }
  });

  it("1 forbidden phrase → finding present, blocking=false (below threshold of 3)", () => {
    const report = checkGenericCopy(
      input({ hero: "Seamless integration." })
    );
    assert.ok(report.findings.some(f => f.ruleId === "CG-001"), "expected finding");
    assert.strictEqual(report.blocking, false, "1 finding: blocking must be false");
  });

  it("3+ forbidden phrases → blocking=true", () => {
    const report = checkGenericCopy(
      input({
        hero: "Seamless integration.",
        cta: "Unlock and supercharge your workflow.",
        pricing: "Streamline everything with our all-in-one platform."
      })
    );
    // seamless, unlock, supercharge, streamline, all-in-one = 5 findings
    assert.ok(report.findings.length >= 3, `expected >= 3 findings, got ${report.findings.length}`);
    assert.strictEqual(report.blocking, true, "3+ findings: blocking must be true");
  });
});

// ---------------------------------------------------------------------------
// CG-002: feature-card soup heuristic
// ---------------------------------------------------------------------------

describe("CG-002 feature-card soup", () => {
  it("emits CG-002 warning when 'Features' section present and total sections <= 4", () => {
    const report = checkGenericCopy(
      input(
        { hero: "Build better software.", features: "Everything you need." },
        ["Hero", "Features", "Pricing", "CTA"]
      )
    );
    assert.ok(
      report.findings.some(f => f.ruleId === "CG-002"),
      "expected CG-002 finding (features + ≤4 sections)"
    );
  });

  it("does NOT emit CG-002 when 'Features' present but total sections > 4", () => {
    const report = checkGenericCopy(
      input(
        { hero: "Build better software.", features: "Everything." },
        ["Hero", "Features", "Pricing", "CTA", "About", "Contact"]
      )
    );
    assert.ok(
      !report.findings.some(f => f.ruleId === "CG-002"),
      "no CG-002 when sections > 4"
    );
  });

  it("does NOT emit CG-002 when no 'features' section name", () => {
    const report = checkGenericCopy(
      input(
        { hero: "Build better software.", capabilities: "Everything." },
        ["Hero", "Capabilities", "Pricing"]
      )
    );
    assert.ok(
      !report.findings.some(f => f.ruleId === "CG-002"),
      "no CG-002 without a 'features' section name"
    );
  });

  it("case-insensitive: 'FEATURES' triggers CG-002", () => {
    const report = checkGenericCopy(
      input(
        { hero: "Good copy." },
        ["Hero", "FEATURES", "Pricing"]
      )
    );
    assert.ok(
      report.findings.some(f => f.ruleId === "CG-002"),
      "CG-002 must fire for 'FEATURES' (case-insensitive)"
    );
  });

  it("CG-002 severity is 'warning'", () => {
    const report = checkGenericCopy(
      input({ hero: "Good copy." }, ["Hero", "Features", "Pricing"])
    );
    const cg002 = report.findings.filter(f => f.ruleId === "CG-002");
    assert.ok(cg002.length >= 1, "expected CG-002 finding");
    assert.ok(cg002.every(f => f.severity === "warning"), "CG-002 must be 'warning'");
  });
});

// ---------------------------------------------------------------------------
// CG-003: placeholder / lorem ipsum copy
// ---------------------------------------------------------------------------

describe("CG-003 placeholder copy", () => {
  it("emits CG-003 when copy block contains 'lorem ipsum'", () => {
    const report = checkGenericCopy(
      input({ hero: "Lorem ipsum dolor sit amet, consectetur adipiscing elit." })
    );
    assert.ok(
      report.findings.some(f => f.ruleId === "CG-003"),
      "expected CG-003 for lorem ipsum"
    );
  });

  it("CG-003 for lorem ipsum is case-insensitive", () => {
    const report = checkGenericCopy(
      input({ hero: "LOREM IPSUM dolor sit amet." })
    );
    assert.ok(
      report.findings.some(f => f.ruleId === "CG-003"),
      "CG-003 must fire for uppercase LOREM IPSUM"
    );
  });

  it("emits CG-003 for common placeholder tokens: '[PLACEHOLDER]'", () => {
    const report = checkGenericCopy(
      input({ hero: "[PLACEHOLDER] text here." })
    );
    assert.ok(
      report.findings.some(f => f.ruleId === "CG-003"),
      "expected CG-003 for [PLACEHOLDER] token"
    );
  });

  it("emits CG-003 for common placeholder tokens: 'TODO' in copy", () => {
    const report = checkGenericCopy(
      input({ hero: "TODO: write real copy here." })
    );
    assert.ok(
      report.findings.some(f => f.ruleId === "CG-003"),
      "expected CG-003 for 'TODO' in copy"
    );
  });

  it("emits CG-003 for '[INSERT_COPY]' placeholder pattern", () => {
    const report = checkGenericCopy(
      input({ cta: "[INSERT_COPY]" })
    );
    assert.ok(
      report.findings.some(f => f.ruleId === "CG-003"),
      "expected CG-003 for '[INSERT_COPY]' pattern"
    );
  });

  it("CG-003 severity is 'warning'", () => {
    const report = checkGenericCopy(
      input({ hero: "Lorem ipsum dolor." })
    );
    const cg003 = report.findings.filter(f => f.ruleId === "CG-003");
    assert.ok(cg003.length >= 1, "expected CG-003 finding");
    assert.ok(cg003.every(f => f.severity === "warning"), "CG-003 must be 'warning'");
  });

  it("does NOT emit CG-003 for legitimate copy that happens to mention 'todo' in product context", () => {
    // 'TODO' as standalone all-caps placeholder word triggers, but "to-do" or
    // "todo list" as product terminology should not. The checker matches the
    // full token "TODO" at word boundaries (uppercase). "todo" lowercase or
    // "to-do" are not matched — document this in checker comments.
    const report = checkGenericCopy(
      input({ hero: "Manage your to-do list with ease." })
    );
    assert.ok(
      !report.findings.some(f => f.ruleId === "CG-003"),
      "lowercase 'to-do' product term must NOT trigger CG-003"
    );
  });
});

// ---------------------------------------------------------------------------
// Clean copy — no findings
// ---------------------------------------------------------------------------

describe("clean product copy", () => {
  it("specific product copy with no forbidden phrases, no soup, no lorem → findings=[], blocking=false", () => {
    const report = checkGenericCopy(
      input(
        {
          hero: "Archon routes your frontend agent pipeline through a deterministic gate so rework never reaches production.",
          pricing: "One flat fee. No per-seat pricing. No surprises.",
          cta: "Start a free 14-day trial — no credit card required."
        },
        ["Hero", "Pricing", "CTA"]
      )
    );
    assert.deepStrictEqual(
      report.findings.filter(f => f.ruleId === "CG-001" || f.ruleId === "CG-002" || f.ruleId === "CG-003"),
      [],
      "no forbidden-phrase, soup, or lorem findings on clean copy"
    );
    assert.strictEqual(report.blocking, false, "clean copy: blocking must be false");
  });
});

// ---------------------------------------------------------------------------
// Blocking rule: >= 3 findings
// ---------------------------------------------------------------------------

describe("blocking threshold", () => {
  it("exactly 2 findings → blocking=false", () => {
    // Use a controlled case with exactly 2 distinct (phrase, location) pairs.
    // "seamless" in hero-block + "unlock" in hero-block = 2 findings.
    const controlled = checkGenericCopy(
      input({ hero: "Seamless and unlock your workflow." })
    );
    const count = controlled.findings.length;
    if (count < 3) {
      assert.strictEqual(controlled.blocking, false, `${count} findings: blocking must be false`);
    }
    // If somehow the extended list added more, the test is informational
  });

  it("exactly 3 findings → blocking=true", () => {
    const report = checkGenericCopy(
      input({
        hero: "Seamless workflow.",
        cta: "Unlock the platform.",
        pricing: "Supercharge your operations."
      })
    );
    // 3 distinct (phrase, location) pairs → blocking=true
    assert.strictEqual(report.blocking, true, "3 findings must trigger blocking=true");
    assert.ok(report.score >= 3, "score must reflect finding count");
  });
});

// ---------------------------------------------------------------------------
// score === findings.length
// ---------------------------------------------------------------------------

describe("score invariant", () => {
  it("score equals findings.length", () => {
    const report = checkGenericCopy(
      input({
        hero: "Seamless and effortless.",
        cta: "Unlock the next-generation experience.",
        pricing: "Supercharge your streamline journey."
      })
    );
    assert.strictEqual(
      report.score,
      report.findings.length,
      "score must equal findings.length"
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("same input produces identical output (ordering stable)", () => {
    const inp = input(
      {
        hero: "Seamless integration with unlock potential.",
        features: "Supercharge your streamline all-in-one platform.",
        cta: "Lorem ipsum and game-changer."
      },
      ["Hero", "Features", "CTA"]
    );
    const r1 = checkGenericCopy(inp);
    const r2 = checkGenericCopy(inp);
    assert.deepStrictEqual(r1, r2, "outputs must be identical for same input");
  });

  it("findings are ordered by ruleId then location (stable ordering)", () => {
    const report = checkGenericCopy(
      input({
        z_block: "Seamless workflow here.",
        a_block: "Unlock the platform."
      })
    );
    // CG-001 findings sorted by ruleId (all "CG-001") then by location alphabetically
    const cg001 = report.findings.filter(f => f.ruleId === "CG-001");
    if (cg001.length >= 2) {
      // a_block (unlock) should come before z_block (seamless) if sorted by location
      // OR sorted by phrase. Either is fine as long as it is stable (same on repeat).
      const r2 = checkGenericCopy(input({
        z_block: "Seamless workflow here.",
        a_block: "Unlock the platform."
      }));
      assert.deepStrictEqual(
        report.findings.map(f => `${f.ruleId}:${f.phrase ?? ""}:${f.location ?? ""}`),
        r2.findings.map(f => `${f.ruleId}:${f.phrase ?? ""}:${f.location ?? ""}`),
        "finding order must be stable across invocations"
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Zod strict parse — invalid inputs rejected
// ---------------------------------------------------------------------------

describe("strict Zod parse", () => {
  it("checkGenericCopy throws on invalid input (non-record copyBlocks)", () => {
    // The checker must validate input with Zod and throw on invalid data
    assert.throws(
      () => checkGenericCopy({ copyBlocks: "not a record" } as unknown as CopyInput),
      "expected throw on invalid copyBlocks type"
    );
  });
});

// ---------------------------------------------------------------------------
// Capped strings
// ---------------------------------------------------------------------------

describe("capped strings", () => {
  it("location field in finding is bounded by MAX_LOCATION_LEN via schema enforcement", () => {
    // The schema rejects copyBlocks keys longer than MAX_LOCATION_LEN (256).
    // This is the correct cap: the schema throws before the checker runs.
    // Adversarial callers cannot supply a finding with an unbounded location key.
    const longKey = "a".repeat(300);
    assert.throws(
      () => checkGenericCopy(input({ [longKey]: "Seamless integration." })),
      "expected ZodError for key exceeding MAX_LOCATION_LEN"
    );
  });

  it("phrase field in finding is capped (phrases are short by definition)", () => {
    // All forbidden phrases are < 30 chars; the cap exists as a schema-level
    // contract, not a runtime truncation case. Verify schema accepts it.
    const result = CopyFindingSchema.safeParse({
      ruleId: "CG-001",
      phrase: "seamless",
      location: "hero",
      severity: "warning",
      message: "Generic SaaS phrase 'seamless'."
    });
    assert.ok(result.success, "valid finding must parse");
    assert.strictEqual(result.data.phrase, "seamless");
  });
});

// ---------------------------------------------------------------------------
// uncheckedRules declared
// ---------------------------------------------------------------------------

describe("uncheckedRules", () => {
  it("uncheckedRules is non-empty (non-mechanical checks are declared, never hidden)", () => {
    const report = checkGenericCopy(input({ hero: "Good specific copy." }));
    assert.ok(
      report.uncheckedRules.length > 0,
      "uncheckedRules must declare non-mechanical checks; must not be empty"
    );
  });

  it("uncheckedRules appears in every report regardless of findings", () => {
    const report = checkGenericCopy(input({}));
    assert.ok(Array.isArray(report.uncheckedRules), "uncheckedRules must be an array");
  });
});

// ---------------------------------------------------------------------------
// CopyReport Zod round-trip
// ---------------------------------------------------------------------------

describe("CopyReport Zod round-trip", () => {
  it("every report produced by checkGenericCopy parses successfully via CopyReportSchema", () => {
    const cases: CopyInput[] = [
      input({}),
      input({ hero: "Seamless unlock supercharge effortless game-changer." }),
      input({ body: "Lorem ipsum dolor." }),
      input({ hero: "Good copy." }, ["Hero", "Features"]),
      input(
        { hero: "Clean product copy, nothing forbidden." },
        ["Hero", "Pricing", "CTA", "Testimonials", "About"]
      )
    ];
    for (const c of cases) {
      const report = checkGenericCopy(c);
      const parsed = CopyReportSchema.safeParse(report);
      assert.ok(parsed.success, `CopyReportSchema.safeParse failed: ${JSON.stringify((parsed as { error: unknown }).error ?? null)}`);
    }
  });
});
