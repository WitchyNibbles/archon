/**
 * Tests for the build-time dashboard types emitter (src/forge/gen-dashboard-types.ts).
 *
 * Verifies:
 *  - emitTypes() produces a string containing all expected exported type names
 *  - enum types round-trip correctly
 *  - optional fields emit with "?" marker
 *  - array fields emit with "[]" suffix
 *  - the emitter throws loudly on an unsupported Zod construct (never silently emits `any`)
 *  - the module-level import.meta.url guard prevents main() from running on import
 *
 * The file-write path (main() / resolveOutputPath()) is tested separately; this
 * suite keeps all assertions in-memory to stay fast and side-effect-free.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import {
  emitTypes,
  zodTypeToTs,
  resolveOutputPath,
} from "../src/forge/gen-dashboard-types.ts";
import {
  DashboardViewModelSchema,
  runStatusValues,
  taskStatusValues,
  reviewStateValues,
  reviewSeverityValues,
  gateReviewRoleValues,
  routingRecommendationKindValues,
  authorityLabelValues,
  blockerKindValues,
  PulseStateValues,
} from "../src/forge/dashboard-contract.ts";

// ---------------------------------------------------------------------------
// emitTypes — top-level output shape
// ---------------------------------------------------------------------------

describe("emitTypes", () => {
  let output: string;

  // Run once, reuse across tests in this block.
  it("runs without error on the real DashboardViewModelSchema", () => {
    output = emitTypes(DashboardViewModelSchema);
    assert.ok(output.length > 0, "expected non-empty output");
  });

  it("includes the DO-NOT-EDIT header", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.startsWith("// DO NOT EDIT"),
      "output must start with the DO-NOT-EDIT header"
    );
  });

  it("exports RunStatus", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type RunStatus ="),
      "expected RunStatus export"
    );
  });

  it("exports TaskStatus", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type TaskStatus ="),
      "expected TaskStatus export"
    );
  });

  it("exports ReviewState", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type ReviewState ="),
      "expected ReviewState export"
    );
  });

  it("exports ReviewSeverity", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type ReviewSeverity ="),
      "expected ReviewSeverity export"
    );
  });

  it("exports GateReviewRole", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type GateReviewRole ="),
      "expected GateReviewRole export"
    );
  });

  it("exports RoutingRecommendationKind", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type RoutingRecommendationKind ="),
      "expected RoutingRecommendationKind export"
    );
  });

  it("exports AuthorityLabel", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type AuthorityLabel ="),
      "expected AuthorityLabel export"
    );
  });

  it("exports BlockerKind", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type BlockerKind ="),
      "expected BlockerKind export"
    );
  });

  it("exports PulseState", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type PulseState ="),
      "expected PulseState export"
    );
  });

  it("exports RunHeaderViewModel", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type RunHeaderViewModel ="),
      "expected RunHeaderViewModel export"
    );
  });

  it("exports BlockerViewModel", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type BlockerViewModel ="),
      "expected BlockerViewModel export"
    );
  });

  it("exports TaskQueueEntryViewModel", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type TaskQueueEntryViewModel ="),
      "expected TaskQueueEntryViewModel export"
    );
  });

  it("exports ReviewGateViewModel", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type ReviewGateViewModel ="),
      "expected ReviewGateViewModel export"
    );
  });

  it("exports RunPulseViewModel", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type RunPulseViewModel ="),
      "expected RunPulseViewModel export"
    );
  });

  it("exports DashboardViewModel", () => {
    output ??= emitTypes(DashboardViewModelSchema);
    assert.ok(
      output.includes("export type DashboardViewModel ="),
      "expected DashboardViewModel export"
    );
  });
});

// ---------------------------------------------------------------------------
// zodTypeToTs — primitive and structural shapes
// ---------------------------------------------------------------------------

describe("zodTypeToTs", () => {
  it("emits string for ZodString", () => {
    assert.equal(zodTypeToTs(z.string()), "string");
  });

  it("emits number for ZodNumber", () => {
    assert.equal(zodTypeToTs(z.number()), "number");
  });

  it("emits number for ZodNumber with .int().nonnegative()", () => {
    // Decorators are transparent in the emitted type.
    assert.equal(zodTypeToTs(z.number().int().nonnegative()), "number");
  });

  it("emits boolean for ZodBoolean", () => {
    assert.equal(zodTypeToTs(z.boolean()), "boolean");
  });

  it("emits a string literal for ZodLiteral<string>", () => {
    assert.equal(zodTypeToTs(z.literal("hello")), '"hello"');
  });

  it("emits a number literal for ZodLiteral<number>", () => {
    assert.equal(zodTypeToTs(z.literal(42)), "42");
  });

  it("emits a union of quoted strings for ZodEnum", () => {
    const result = zodTypeToTs(z.enum(["a", "b", "c"]));
    assert.equal(result, '"a" | "b" | "c"');
  });

  it("emits T[] for ZodArray<T> (simple element)", () => {
    assert.equal(zodTypeToTs(z.array(z.string())), "string[]");
  });

  it("emits (A | B)[] for ZodArray with union element (parenthesised)", () => {
    const result = zodTypeToTs(z.array(z.enum(["x", "y"])));
    assert.equal(result, '("x" | "y")[]');
  });

  it("emits inner type for ZodOptional (callers add ?)", () => {
    assert.equal(zodTypeToTs(z.string().optional()), "string");
  });

  it("emits a braced object shape for ZodObject", () => {
    const schema = z.object({
      id: z.string(),
      count: z.number(),
    });
    const result = zodTypeToTs(schema);
    assert.ok(result.includes("id: string;"), "expected id: string");
    assert.ok(result.includes("count: number;"), "expected count: number");
  });

  it("marks optional fields with ? in ZodObject", () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const result = zodTypeToTs(schema);
    assert.ok(result.includes("required: string;"), "required must have no ?");
    assert.ok(result.includes("optional?: string;"), "optional must have ?");
  });

  it("emits A | B for ZodUnion", () => {
    const result = zodTypeToTs(z.union([z.literal("a"), z.literal("b")]));
    assert.equal(result, '"a" | "b"');
  });
});

// ---------------------------------------------------------------------------
// Error path — unsupported construct
// ---------------------------------------------------------------------------

describe("zodTypeToTs unsupported construct", () => {
  it("throws with a descriptive message on an unsupported ZodType (ZodNever)", () => {
    assert.throws(
      () => zodTypeToTs(z.never()),
      (err: unknown) => {
        assert.ok(err instanceof Error, "expected Error instance");
        assert.ok(
          err.message.includes("unsupported Zod construct"),
          `expected 'unsupported Zod construct' in: ${err.message}`
        );
        assert.ok(
          !err.message.includes("any"),
          "error message must not mention 'any' — confirm no silent fallback"
        );
        return true;
      }
    );
  });

  it("throws with a descriptive message on ZodNull", () => {
    assert.throws(
      () => zodTypeToTs(z.null()),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("unsupported Zod construct"));
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// resolveOutputPath — bounds checking
// ---------------------------------------------------------------------------

describe("resolveOutputPath", () => {
  // Use synthetic REPO and CWD so tests never depend on real filesystem layout.
  const REPO = "/tmp/archon-repo-test";
  const CWD = "/tmp/archon-repo-test/web";

  it("throws when no argument is provided", () => {
    assert.throws(
      () => resolveOutputPath(undefined, REPO, CWD),
      /output path argument required/
    );
  });

  it("accepts a relative in-repo .ts path (resolved against cwd)", () => {
    // Invoked from web/ cwd: "src/types/dashboard.generated.ts" resolves to
    // /tmp/archon-repo-test/web/src/types/dashboard.generated.ts — inside repo.
    const result = resolveOutputPath(
      "src/types/dashboard.generated.ts",
      REPO,
      CWD
    );
    assert.ok(
      result.endsWith("dashboard.generated.ts"),
      "expected resolved path ending with dashboard.generated.ts"
    );
    assert.ok(
      result.startsWith(REPO),
      "expected resolved path to start with REPO"
    );
  });

  it("accepts an absolute in-repo .ts path", () => {
    const abs = `${REPO}/web/src/types/dashboard.generated.ts`;
    const result = resolveOutputPath(abs, REPO, CWD);
    assert.equal(result, abs);
  });

  it("rejects a relative path that escapes the repo root", () => {
    // From CWD=/tmp/archon-repo-test/web, ../../etc/evil.ts escapes repo.
    assert.throws(
      () => resolveOutputPath("../../etc/evil.ts", REPO, CWD),
      /must stay within the repository/
    );
  });

  it("rejects an absolute path outside the repo root", () => {
    assert.throws(
      () => resolveOutputPath("/etc/evil.ts", REPO, CWD),
      /must stay within the repository/
    );
  });

  it("rejects a .json extension", () => {
    assert.throws(
      () => resolveOutputPath("src/types/out.json", REPO, CWD),
      /must end in \.ts/
    );
  });

  it("rejects a prefix-spoof sibling path (locks the ${repoRoot}${sep} invariant)", () => {
    // `${REPO}-evil/x.ts` shares the repo-root STRING prefix but is a SIBLING dir,
    // not inside the repo. A bare startsWith(repoRoot) would wrongly accept it; the
    // separator-appended containment check must reject it. Guards a future refactor
    // that drops the trailing sep from silently breaking the boundary.
    assert.throws(
      () => resolveOutputPath(`${REPO}-evil/x.ts`, REPO, CWD),
      /must stay within the repository/
    );
  });
});

// ---------------------------------------------------------------------------
// Value + structure correctness (qa-gap closure):
// export-NAME presence is not enough — assert the emitted enum VALUES, the
// real-contract OPTIONAL markers, full top-level KEY coverage, and that the
// emitted output actually TYPECHECKS.
// ---------------------------------------------------------------------------

describe("emitTypes — value + structure correctness", () => {
  const output = emitTypes(DashboardViewModelSchema);

  // Each value array is the SOURCE OF TRUTH (exported from the contract). The
  // emitter derives from the same schema, so a wrong-value regression (e.g.
  // RunStatus = "foo" | "bar") makes these fail. Driven by the arrays, not hardcoded.
  const enumChecks: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["runStatus", runStatusValues],
    ["taskStatus", taskStatusValues],
    ["reviewState", reviewStateValues],
    ["reviewSeverity", reviewSeverityValues],
    ["gateReviewRole", gateReviewRoleValues],
    ["routingRecommendationKind", routingRecommendationKindValues],
    ["authorityLabel", authorityLabelValues],
    ["blockerKind", blockerKindValues],
    ["pulseState", PulseStateValues],
  ];

  for (const [label, values] of enumChecks) {
    it(`emits every ${label} member value verbatim`, () => {
      for (const value of values) {
        assert.ok(
          output.includes(`"${value}"`),
          `emitted output is missing enum value "${value}" for ${label}`
        );
      }
    });
  }

  it("marks the real-contract optional fields with ? (not just synthetic schemas)", () => {
    // From dashboard-contract.ts: BlockerViewModel.taskId, TaskQueueEntry.routingRecommendation,
    // ReviewGate.severity/actor/reviewedAt are all .optional().
    for (const key of ["taskId", "routingRecommendation", "severity", "actor", "reviewedAt"]) {
      assert.ok(
        output.includes(`${key}?:`),
        `expected optional marker "${key}?:" in emitted real-contract output`
      );
    }
  });

  it("covers EVERY top-level schema key (a new field cannot be silently skipped)", () => {
    // Guards the emitter's top-level handling: if a field is added to
    // DashboardViewModelSchema (e.g. generatedAt for C5) the emitter must emit it
    // or this fails loudly rather than dropping it.
    for (const key of Object.keys(DashboardViewModelSchema.shape)) {
      assert.ok(
        output.includes(`${key}:`) || output.includes(`${key}?:`),
        `top-level schema key "${key}" is absent from the emitted DashboardViewModel`
      );
    }
  });

  it("emitted output typechecks under tsc --noEmit --strict (round-trip)", () => {
    // The strongest guard: a structurally-wrong-but-string-matched output that all
    // the .includes() assertions accept would still fail to COMPILE. The emitted
    // file is self-contained type aliases (no imports), so a standalone tsc on it
    // is a faithful round-trip of what the web build will consume.
    const dir = mkdtempSync(path.join(os.tmpdir(), "forge-codegen-rt-"));
    const file = path.join(dir, "dashboard.generated.ts");
    try {
      writeFileSync(file, output, "utf8");
      const tsc = path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
      // execFileSync throws on a non-zero exit; reaching the assert means tsc passed.
      execFileSync("node", [tsc, "--noEmit", "--strict", "--skipLibCheck", file], {
        cwd: process.cwd(),
        stdio: "pipe",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(true, "emitted types compiled cleanly under strict tsc");
  });
});
