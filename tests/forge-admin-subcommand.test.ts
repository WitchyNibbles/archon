/**
 * Tests for the `forge` admin subcommand (src/admin/forge.ts).
 *
 * All tests use injected deps — no real FS, no DB, no network.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-admin-subcommand.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseForgeArgs,
  executeCriticVerb,
  forgeCommand
} from "../src/admin/forge.ts";
import type { ForgeCriticDeps } from "../src/admin/forge.ts";

import {
  runAntiGenericChecker,
  RenderedSnapshotSchema
} from "../src/forge/anti-generic-checker.ts";
import type { RenderedElement, RenderedSnapshot } from "../src/forge/anti-generic-checker.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
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

function snap(elements: RenderedElement[]): RenderedSnapshot {
  return { url: "http://localhost:5173/", elements };
}

/** A snapshot that passes all anti-generic checks cleanly. */
function cleanSnapshot(): RenderedSnapshot {
  return snap([
    el({ selector: "body", tag: "body", semanticHint: "body" }),
    el({
      selector: "main",
      tag: "main",
      parentSelector: "body",
      computed: { display: "grid" }
    }),
    el({
      selector: "main > section",
      tag: "section",
      parentSelector: "main",
      textLength: 200,
      computed: { display: "block" }
    })
  ]);
}

/**
 * A snapshot with AG-013 warnings only (off-palette hex color, severity=warning,
 * not hard_fail). Useful for proving blocking=false with violations.length > 0.
 */
function ag013WarningOnlySnapshot(): RenderedSnapshot {
  return snap([
    el({
      selector: "body",
      tag: "body",
      semanticHint: "body",
      // #FF00FF is not in the canonical palette — triggers AG-013 warning
      computed: { color: "#FF00FF" }
    })
  ]);
}

/**
 * A snapshot that triggers AG-012 (three equal-width feature-card children).
 * This is the council-required falsifiability fixture (non-waivable).
 */
function genericCardSoupSnapshot(): RenderedSnapshot {
  const container = el({
    selector: "main > div.card-row",
    tag: "div",
    parentSelector: "main",
    computed: { display: "flex" }
  });

  function card(n: number): RenderedElement[] {
    const cardSel = `main > div.card-row > div.card-${n}`;
    return [
      el({
        selector: cardSel,
        tag: "div",
        parentSelector: "main > div.card-row",
        textLength: 120,
        childCount: 3,
        computed: { widthPx: 300 }
      }),
      el({ selector: `${cardSel} > svg`, tag: "svg", parentSelector: cardSel, textLength: 0 }),
      el({ selector: `${cardSel} > h3`, tag: "h3", parentSelector: cardSel, textLength: 24 }),
      el({ selector: `${cardSel} > p`, tag: "p", parentSelector: cardSel, textLength: 90 })
    ];
  }

  return snap([
    el({ selector: "body", tag: "body", semanticHint: "body" }),
    el({ selector: "main", tag: "main", parentSelector: "body" }),
    container,
    ...card(1),
    ...card(2),
    ...card(3)
  ]);
}

// ---------------------------------------------------------------------------
// parseForgeArgs
// ---------------------------------------------------------------------------

describe("parseForgeArgs", () => {
  it("extracts the verb as the first arg", () => {
    const result = parseForgeArgs(["critic", "/tmp/snap.json"]);
    assert.equal(result.verb, "critic");
  });

  it("extracts positional snapshot path for critic", () => {
    const result = parseForgeArgs(["critic", "/tmp/snap.json"]);
    assert.equal(result.snapshotPath, "/tmp/snap.json");
  });

  it("returns undefined verb when args is empty", () => {
    const result = parseForgeArgs([]);
    assert.equal(result.verb, undefined);
  });
});

// ---------------------------------------------------------------------------
// forge critic — clean snapshot
// ---------------------------------------------------------------------------

describe("forge critic verb — clean snapshot", () => {
  function makeCriticDeps(snapshot: RenderedSnapshot): ForgeCriticDeps & {
    stdoutOutput: () => string;
    stderrOutput: () => string;
  } {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    return {
      readFile: async (_path: string) => JSON.stringify(snapshot),
      runChecker: runAntiGenericChecker,
      writeStdout: (d) => stdoutChunks.push(d),
      writeStderr: (d) => stderrChunks.push(d),
      stdoutOutput: () => stdoutChunks.join(""),
      stderrOutput: () => stderrChunks.join("")
    };
  }

  it("returns blocking=false and exitCode=0 for a clean snapshot", async () => {
    const deps = makeCriticDeps(cleanSnapshot());
    const result = await executeCriticVerb(["/tmp/snap.json"], deps);
    assert.equal(result.blocking, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.blocking, false);
  });

  it("prints JSON report to stdout for clean snapshot", async () => {
    const deps = makeCriticDeps(cleanSnapshot());
    await executeCriticVerb(["/tmp/snap.json"], deps);
    const output = JSON.parse(deps.stdoutOutput());
    assert.ok("violations" in output, "expected violations field");
    assert.ok("blocking" in output, "expected blocking field");
    assert.ok("uncheckedRules" in output, "expected uncheckedRules field");
  });

  it("prints human summary to stderr", async () => {
    const deps = makeCriticDeps(cleanSnapshot());
    await executeCriticVerb(["/tmp/snap.json"], deps);
    const summary = deps.stderrOutput();
    assert.ok(summary.includes("forge critic:"), "expected 'forge critic:' prefix in stderr");
    assert.ok(summary.includes("blocking="), "expected blocking= in stderr summary");
  });
});

// ---------------------------------------------------------------------------
// forge critic — AG-013 warnings only (blocking=false, violations.length > 0)
// ---------------------------------------------------------------------------

describe("forge critic verb — AG-013 warnings only", () => {
  it("returns blocking=false with non-zero violations for warning-only snapshot", async () => {
    const chunks: string[] = [];
    const deps: ForgeCriticDeps = {
      readFile: async () => JSON.stringify(ag013WarningOnlySnapshot()),
      runChecker: runAntiGenericChecker,
      writeStdout: (d) => chunks.push(d),
      writeStderr: () => { /* noop */ }
    };
    const result = await executeCriticVerb(["/tmp/snap.json"], deps);
    assert.equal(result.blocking, false, "AG-013 warnings must not set blocking=true");
    assert.equal(result.exitCode, 0, "warning-only snapshot must have exitCode=0");
    assert.ok(result.report.violations.length > 0, "expected at least one warning violation");
    assert.ok(
      result.report.violations.every((v) => v.severity === "warning"),
      "all violations in this fixture must be warnings, not hard_fail"
    );
    const ag013 = result.report.violations.find((v) => v.agId === "AG-013");
    assert.ok(ag013, "expected at least one AG-013 violation");
  });
});

// ---------------------------------------------------------------------------
// forge critic — generic card soup (must block)
// ---------------------------------------------------------------------------

describe("forge critic verb — generic card soup snapshot", () => {
  function makeCriticDeps(snapshot: RenderedSnapshot): ForgeCriticDeps & {
    stdoutOutput: () => string;
  } {
    const chunks: string[] = [];
    return {
      readFile: async (_path: string) => JSON.stringify(snapshot),
      runChecker: runAntiGenericChecker,
      writeStdout: (d) => chunks.push(d),
      writeStderr: () => { /* noop */ },
      stdoutOutput: () => chunks.join("")
    };
  }

  it("returns blocking=true and exitCode=1 for three-equal-card soup", async () => {
    const deps = makeCriticDeps(genericCardSoupSnapshot());
    const result = await executeCriticVerb(["/tmp/snap.json"], deps);

    // Assert BEFORE any process.exitCode mutation (the function must not set it).
    assert.equal(result.blocking, true, "expected blocking=true for generic card soup");
    assert.equal(result.exitCode, 1, "expected exitCode=1 when blocking");
    assert.ok(
      result.report.violations.some((v) => v.severity === "hard_fail"),
      "expected at least one hard_fail violation"
    );
    // executeCriticVerb must NOT have mutated process.exitCode itself.
    // (If it did, this would be 1 — we check it's 0 since no forgeCommand wrapper ran.)
    assert.equal(process.exitCode ?? 0, 0, "executeCriticVerb must not mutate process.exitCode");
  });

  it("report JSON contains AG-012 violation", async () => {
    const deps = makeCriticDeps(genericCardSoupSnapshot());
    const result = await executeCriticVerb(["/tmp/snap.json"], deps);
    // exitCode returned (not set on process) — no reset needed.
    assert.equal(result.exitCode, 1);
    const ag012 = result.report.violations.find((v) => v.agId === "AG-012");
    assert.ok(ag012, "expected AG-012 violation in report");
    assert.equal(ag012.severity, "hard_fail");
  });
});

// ---------------------------------------------------------------------------
// forge critic — malformed input
// ---------------------------------------------------------------------------

describe("forge critic verb — error handling", () => {
  it("throws a readable error when JSON is malformed (not a raw Zod stack)", async () => {
    const deps: ForgeCriticDeps = {
      readFile: async () => "{ this is not valid json !!!",
      runChecker: runAntiGenericChecker,
      writeStdout: () => { /* noop */ },
      writeStderr: () => { /* noop */ }
    };
    await assert.rejects(
      () => executeCriticVerb(["/tmp/snap.json"], deps),
      (err: unknown) => {
        assert.ok(err instanceof Error, "expected Error instance");
        assert.ok(
          err.message.includes("forge critic:") && err.message.includes("not valid JSON"),
          `expected readable error message, got: ${err.message}`
        );
        assert.ok(!err.message.includes("ZodError"), "must not expose raw ZodError");
        return true;
      }
    );
  });

  it("throws a readable error when schema validation fails (not a raw Zod stack)", async () => {
    const badPayload = { url: "not-a-valid-url", elements: "wrong-type" };
    const deps: ForgeCriticDeps = {
      readFile: async () => JSON.stringify(badPayload),
      runChecker: runAntiGenericChecker,
      writeStdout: () => { /* noop */ },
      writeStderr: () => { /* noop */ }
    };
    await assert.rejects(
      () => executeCriticVerb(["/tmp/snap.json"], deps),
      (err: unknown) => {
        assert.ok(err instanceof Error, "expected Error instance");
        assert.ok(
          err.message.includes("forge critic:") && err.message.includes("schema validation"),
          `expected schema validation error, got: ${err.message}`
        );
        assert.ok(!err.message.includes("ZodError"), "must not expose raw ZodError class name");
        return true;
      }
    );
  });

  it("throws a readable error when the file cannot be read", async () => {
    const deps: ForgeCriticDeps = {
      readFile: async (p: string) => {
        throw new Error(`ENOENT: no such file or directory, open '${p}'`);
      },
      runChecker: runAntiGenericChecker,
      writeStdout: () => { /* noop */ },
      writeStderr: () => { /* noop */ }
    };
    await assert.rejects(
      () => executeCriticVerb(["/tmp/snap.json"], deps),
      (err: unknown) => {
        assert.ok(err instanceof Error, "expected Error instance");
        assert.ok(
          err.message.includes("forge critic:") && err.message.includes("could not read file"),
          `expected file-read error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("throws a readable error when snapshot path arg is missing", async () => {
    const deps: ForgeCriticDeps = {
      readFile: async () => "",
      runChecker: runAntiGenericChecker,
      writeStdout: () => { /* noop */ },
      writeStderr: () => { /* noop */ }
    };
    await assert.rejects(
      () => executeCriticVerb([], deps),
      (err: unknown) => {
        assert.ok(err instanceof Error, "expected Error instance");
        assert.ok(
          err.message.includes("forge critic:") && err.message.includes("missing"),
          `expected missing-arg error, got: ${err.message}`
        );
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// forgeCommand routing integration tests
// ---------------------------------------------------------------------------

describe("forgeCommand routing integration", () => {
  it("dispatches 'critic' verb with injected deps (clean snapshot → exitCode 0)", async () => {
    const stdoutChunks: string[] = [];
    const savedExitCode = process.exitCode;

    await forgeCommand(["critic", "/tmp/snap.json"], {
      critic: {
        readFile: async () => JSON.stringify(cleanSnapshot()),
        runChecker: runAntiGenericChecker,
        writeStdout: (d) => stdoutChunks.push(d),
        writeStderr: () => { /* noop */ }
      }
    });

    const report = JSON.parse(stdoutChunks.join(""));
    assert.equal(report.blocking, false, "clean snapshot must not block");
    // process.exitCode must not have been set to 1 for a non-blocking result.
    assert.equal(process.exitCode ?? 0, savedExitCode ?? 0,
      "forgeCommand must not set process.exitCode=1 for non-blocking result");
  });

  it("dispatches 'critic' verb and sets process.exitCode=1 when blocking", async () => {
    const savedExitCode = process.exitCode;
    try {
      await forgeCommand(["critic", "/tmp/snap.json"], {
        critic: {
          readFile: async () => JSON.stringify(genericCardSoupSnapshot()),
          runChecker: runAntiGenericChecker,
          writeStdout: () => { /* noop */ },
          writeStderr: () => { /* noop */ }
        }
      });
      // Assert BEFORE restoring exitCode.
      assert.equal(process.exitCode, 1, "forgeCommand must set process.exitCode=1 when blocking");
    } finally {
      // Restore so the test process doesn't exit non-zero.
      process.exitCode = savedExitCode;
    }
  });
});

// ---------------------------------------------------------------------------
// forgeCommand — unknown and missing verb
// ---------------------------------------------------------------------------

describe("forgeCommand — unknown and missing verb", () => {
  it("throws a usage error listing critic for unknown verb", async () => {
    await assert.rejects(
      () => forgeCommand(["unknownverb"]),
      (err: unknown) => {
        assert.ok(err instanceof Error, "expected Error instance");
        const msg = err.message;
        assert.ok(msg.includes("critic"), `expected 'critic' in usage, got: ${msg}`);
        assert.ok(
          msg.includes("unknown verb") || msg.includes("unknownverb"),
          `expected unknown-verb signal, got: ${msg}`
        );
        return true;
      }
    );
  });

  it("throws a usage error listing critic when no verb given", async () => {
    await assert.rejects(
      () => forgeCommand([]),
      (err: unknown) => {
        assert.ok(err instanceof Error, "expected Error instance");
        const msg = err.message;
        assert.ok(msg.includes("critic"), `expected 'critic' in usage, got: ${msg}`);
        assert.ok(
          msg.includes("verb required") || msg.includes("verb"),
          `expected verb-required signal, got: ${msg}`
        );
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// forge critic — defense-in-depth path guard (repoRoot in deps)
// ---------------------------------------------------------------------------

describe("forge critic verb — defense-in-depth path guard", () => {
  it("throws a repo-escape error when snapshotPath escapes the repoRoot", async () => {
    const syntheticRepo = "/tmp/archon-critic-guard-test-repo";
    // /etc/passwd is obviously outside syntheticRepo.
    const outsidePath = "/etc/passwd";
    const deps: ForgeCriticDeps = {
      readFile: async () => { throw new Error("readFile must not be called"); },
      runChecker: runAntiGenericChecker,
      writeStdout: () => { /* noop */ },
      writeStderr: () => { /* noop */ },
      repoRoot: syntheticRepo
    };
    await assert.rejects(
      () => executeCriticVerb([outsidePath], deps),
      (err: unknown) => {
        assert.ok(err instanceof Error, "expected Error");
        assert.ok(
          err.message.includes("forge critic:") && err.message.includes("outside the repository"),
          `expected repo-escape error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("does not apply path guard when repoRoot is omitted from deps", async () => {
    // snapshotPath = /etc/passwd would normally escape any repo, but with no
    // repoRoot the guard is skipped. The readFile dep throws a predictable error
    // so we can distinguish "guard error" from "read error".
    const deps: ForgeCriticDeps = {
      readFile: async (p: string) => { throw new Error(`ENOENT: no such file '${p}'`); },
      runChecker: runAntiGenericChecker,
      writeStdout: () => { /* noop */ },
      writeStderr: () => { /* noop */ }
      // repoRoot intentionally omitted
    };
    await assert.rejects(
      () => executeCriticVerb(["/etc/passwd"], deps),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // Must be a file-read error, NOT a path-guard error.
        assert.ok(
          err.message.includes("could not read file"),
          `expected file-read error (guard skipped), got: ${err.message}`
        );
        assert.ok(
          !err.message.includes("outside the repository"),
          "must not have path-guard error when repoRoot omitted"
        );
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Schema validation: RenderedSnapshotSchema round-trip
// ---------------------------------------------------------------------------

describe("RenderedSnapshotSchema — forge critic validator", () => {
  it("accepts a valid clean snapshot", () => {
    const result = RenderedSnapshotSchema.safeParse(cleanSnapshot());
    assert.ok(result.success, "expected valid clean snapshot to pass schema");
  });

  it("accepts the generic card soup snapshot", () => {
    const result = RenderedSnapshotSchema.safeParse(genericCardSoupSnapshot());
    assert.ok(result.success, "expected card soup snapshot to pass schema");
  });

  it("rejects when url is not a valid URL", () => {
    const result = RenderedSnapshotSchema.safeParse({ url: "not-a-url", elements: [] });
    assert.ok(!result.success, "expected invalid url to fail schema");
  });

  it("rejects when elements is not an array", () => {
    const result = RenderedSnapshotSchema.safeParse({ url: "http://localhost/", elements: "bad" });
    assert.ok(!result.success, "expected non-array elements to fail schema");
  });
});
