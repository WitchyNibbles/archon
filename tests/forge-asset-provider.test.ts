/**
 * Tests for src/forge/asset-provider.ts
 *
 * TDD: tests written before implementation.
 *
 * Coverage:
 *   1. placeholder_svg provider writes a valid SVG to a repo-bounded path.
 *   2. manual_upload provider: file present → generated; missing → needs-action.
 *   3. selectAssetProvider: CI=true → placeholder, never codex.
 *   4. selectAssetProvider: no codex login → placeholder, never codex.
 *   5. selectAssetProvider: login present + not CI → codex_builtin_imagegen.
 *   6. selectAssetProvider: NO env arg, process.env.CI=true → placeholder
 *      (proves default env=process.env is live and the gate fires).
 *   7. codex argv is an ARRAY; shell metacharacters in prompt are a single arg
 *      (no shell:true — cannot inject a shell command).
 *   8. codex output missing → needs_regeneration result (no throw).
 *   9. codex output size 0 → needs_regeneration result (no throw).
 *  10. codex output wrong extension → needs_regeneration result (no throw).
 *  11. codex output valid → generated result; file copied to outputPath.
 *  12. runner returns source path outside allowed codex root → rejected; no copy.
 *  13. output path outside repo → rejected by resolveWithinRepo (throws before
 *      the runner is even called).
 *  14. codex timeout → needs_regeneration result; kill was called (no throw).
 *  15. harvestCodexImage: picks newest image written after runStartedAt.
 *  16. harvestCodexImage: returns undefined when no images newer than runStartedAt.
 *  17. needs_action status round-trips through assetStatusValues contract.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-asset-provider.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { AssetRequest } from "../src/forge/asset-contract.ts";
import { assetStatusValues } from "../src/forge/asset-contract.ts";
import {
  PlaceholderSvgProvider,
  ManualUploadProvider,
  CodexBuiltinImagegenProvider,
  selectAssetProvider,
  harvestCodexImage,
} from "../src/forge/asset-provider.ts";
import type {
  CodexImagegenRunner,
  CodexRunnerResult,
  ProviderDeps,
} from "../src/forge/asset-provider.ts";

// ---------------------------------------------------------------------------
// Temporary repo root for file I/O tests
// ---------------------------------------------------------------------------

let tmpRepo: string;
let tmpCodexHome: string;

before(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "archon-asset-provider-test-"));
  tmpCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "archon-fake-codex-"));
});

after(() => {
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  fs.rmSync(tmpCodexHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<AssetRequest> = {}): AssetRequest {
  return {
    id: "test-hero",
    provider: "placeholder_svg",
    assetType: "hero",
    purpose: "Landing-page hero visual",
    placement: "HomeHero background",
    prompt: "Dark editorial illustration",
    negativeConstraints: [],
    preferredSize: "wide",
    preferredFormat: "webp",
    background: "auto",
    outputPath: "generated/hero.webp",
    altText: "Dark editorial illustration of an AI forge",
    needsUserApproval: true,
    status: "planned",
    ...overrides,
  };
}

/** A fake CodexImagegenRunner that records the argv it receives. */
function fakeRunnerRecordingArgv(): {
  runner: CodexImagegenRunner;
  capturedArgv: string[];
} {
  const capturedArgv: string[] = [];
  const runner: CodexImagegenRunner = {
    async run(
      argv: readonly string[],
      _timeoutMs: number,
      _codexOutputRoot: string,
      _runStartedAt: number,
    ): Promise<CodexRunnerResult> {
      capturedArgv.push(...argv);
      return { ok: false, reason: "test-noop" };
    },
  };
  return { runner, capturedArgv };
}

/** A fake CodexImagegenRunner that returns failure (no image). */
function fakeRunnerMissing(): CodexImagegenRunner {
  return {
    async run(
      _argv: readonly string[],
      _timeoutMs: number,
      _codexOutputRoot: string,
      _runStartedAt: number,
    ): Promise<CodexRunnerResult> {
      return { ok: false, reason: "image not found" };
    },
  };
}

/** Build deps with the fake codex home as output root. */
function makeDeps(extra: Partial<ProviderDeps> = {}): ProviderDeps {
  return { repoRoot: tmpRepo, codexOutputRoot: tmpCodexHome, ...extra };
}

// ---------------------------------------------------------------------------
// 1. PlaceholderSvgProvider — writes valid SVG to repo-bounded path
// ---------------------------------------------------------------------------

describe("PlaceholderSvgProvider", () => {
  it("writes a valid SVG to the guarded output path and returns generated status", async () => {
    const outputPath = path.join(tmpRepo, "generated", "hero.svg");
    const request = makeRequest({
      provider: "placeholder_svg",
      assetType: "hero",
      outputPath: "generated/hero.svg",
      preferredFormat: "svg",
    });

    const provider = new PlaceholderSvgProvider();
    const result = await provider.generate(request, { repoRoot: tmpRepo });

    assert.equal(result.status, "generated");
    assert.equal(result.id, "test-hero");
    assert.equal(result.provider, "placeholder_svg");
    assert.ok(fs.existsSync(outputPath), "SVG file must exist on disk");
    const content = fs.readFileSync(outputPath, "utf-8");
    assert.ok(content.startsWith("<svg"), "File must start with <svg");
    assert.ok(content.includes("</svg>"), "File must be a closed SVG");
  });

  it("creates parent directories if they do not exist", async () => {
    const request = makeRequest({
      provider: "placeholder_svg",
      assetType: "icon",
      outputPath: "deep/nested/dir/icon.svg",
      preferredFormat: "svg",
    });

    const provider = new PlaceholderSvgProvider();
    const result = await provider.generate(request, { repoRoot: tmpRepo });

    assert.equal(result.status, "generated");
    const outputPath = path.join(tmpRepo, "deep", "nested", "dir", "icon.svg");
    assert.ok(fs.existsSync(outputPath), "Output file in nested dir must exist");
  });

  it("rejects an output path that escapes the repo root", async () => {
    const request = makeRequest({
      provider: "placeholder_svg",
      outputPath: "../../etc/passwd",
    });

    const provider = new PlaceholderSvgProvider();
    await assert.rejects(
      () => provider.generate(request, { repoRoot: tmpRepo }),
      /outside the repository root/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. ManualUploadProvider — detects present / missing file
// ---------------------------------------------------------------------------

describe("ManualUploadProvider", () => {
  it("returns generated when the file already exists at outputPath", async () => {
    const outputPath = path.join(tmpRepo, "manual", "logo.png");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic

    const request = makeRequest({
      provider: "manual_upload",
      outputPath: "manual/logo.png",
    });

    const provider = new ManualUploadProvider();
    const result = await provider.generate(request, { repoRoot: tmpRepo });

    assert.equal(result.status, "generated");
    assert.equal(result.provider, "manual_upload");
  });

  it("returns needs_action when the file is missing", async () => {
    const request = makeRequest({
      provider: "manual_upload",
      outputPath: "manual/missing-asset.png",
    });

    const provider = new ManualUploadProvider();
    const result = await provider.generate(request, { repoRoot: tmpRepo });

    assert.equal(result.status, "needs_action");
    assert.ok(
      result.message?.includes("not found") || result.message?.includes("missing"),
      `Expected message to mention missing/not found; got: ${result.message}`,
    );
  });

  it("rejects a path that escapes the repo root", async () => {
    const request = makeRequest({
      provider: "manual_upload",
      outputPath: "../outside/asset.png",
    });

    const provider = new ManualUploadProvider();
    await assert.rejects(
      () => provider.generate(request, { repoRoot: tmpRepo }),
      /outside the repository root/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3–6. selectAssetProvider — provider selection logic
// ---------------------------------------------------------------------------

describe("selectAssetProvider — selection logic", () => {
  it("returns placeholder_svg when CI=true (never codex)", () => {
    const request = makeRequest({ provider: "codex_builtin_imagegen" });
    const env = { CI: "true" };
    // availability check always returns true to isolate the CI gate
    const provider = selectAssetProvider(request, env, () => true);
    assert.ok(provider instanceof PlaceholderSvgProvider,
      "CI=true must always yield PlaceholderSvgProvider");
  });

  it("returns placeholder_svg when codex login is unavailable (never codex)", () => {
    const request = makeRequest({ provider: "codex_builtin_imagegen" });
    const env = { CI: "false" };
    // availability check returns false (no codex login)
    const provider = selectAssetProvider(request, env, () => false);
    assert.ok(provider instanceof PlaceholderSvgProvider,
      "No codex login must yield PlaceholderSvgProvider");
  });

  it("returns placeholder_svg when CI is absent and login unavailable", () => {
    const request = makeRequest({ provider: "codex_builtin_imagegen" });
    const env = {};
    const provider = selectAssetProvider(request, env, () => false);
    assert.ok(provider instanceof PlaceholderSvgProvider);
  });

  it("returns CodexBuiltinImagegenProvider when login present and not CI", () => {
    const request = makeRequest({ provider: "codex_builtin_imagegen" });
    const env = { CI: "false" };
    const provider = selectAssetProvider(request, env, () => true);
    assert.ok(provider instanceof CodexBuiltinImagegenProvider,
      "login+not-CI must yield CodexBuiltinImagegenProvider");
  });

  it("returns ManualUploadProvider when request provider is manual_upload", () => {
    const request = makeRequest({ provider: "manual_upload" });
    const env = { CI: "false" };
    const provider = selectAssetProvider(request, env, () => true);
    assert.ok(provider instanceof ManualUploadProvider,
      "manual_upload request must yield ManualUploadProvider");
  });

  it("returns placeholder_svg for placeholder_svg request regardless of availability", () => {
    const request = makeRequest({ provider: "placeholder_svg" });
    const env = { CI: "false" };
    const provider = selectAssetProvider(request, env, () => true);
    assert.ok(provider instanceof PlaceholderSvgProvider);
  });

  it("NO env arg + process.env.CI=true → placeholder_svg (env default=process.env gate)", () => {
    // This test verifies that omitting the env arg in production code does NOT
    // silently bypass the CI gate — the default must be process.env.
    const savedCI = process.env["CI"];
    try {
      process.env["CI"] = "true";
      const request = makeRequest({ provider: "codex_builtin_imagegen" });
      // No env arg — must pick up process.env.CI via the default
      const provider = selectAssetProvider(request, undefined, () => true);
      assert.ok(
        provider instanceof PlaceholderSvgProvider,
        "When process.env.CI=true and no env arg is passed, must return PlaceholderSvgProvider",
      );
    } finally {
      if (savedCI === undefined) {
        delete process.env["CI"];
      } else {
        process.env["CI"] = savedCI;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. CodexBuiltinImagegenProvider — argv is an array, no shell injection
// ---------------------------------------------------------------------------

describe("CodexBuiltinImagegenProvider — argv construction", () => {
  it("passes the prompt as a single argv arg; shell metacharacters cannot inject", async () => {
    const evilPrompt = "nice picture; rm -rf /; echo pwned";
    const { runner, capturedArgv } = fakeRunnerRecordingArgv();

    // Output path must exist to appear as a codex workspace reference
    const outputPath = path.join(tmpRepo, "argv-test", "icon.png");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const request = makeRequest({
      provider: "codex_builtin_imagegen",
      assetType: "icon",
      outputPath: "argv-test/icon.png",
      prompt: evilPrompt,
    });

    const deps = makeDeps({ codexRunner: runner });
    const provider = new CodexBuiltinImagegenProvider();
    // Result will be needs_regeneration (fake runner returns failure), that's fine
    await provider.generate(request, deps);

    // The entire argv must be an array (not a shell string)
    assert.ok(capturedArgv.length > 0, "Runner must have been called with args");

    // The evil prompt string must appear as a SINGLE argument, not split
    // The $imagegen instruction embedding the prompt must be a single string element
    const imagegenArg = capturedArgv.find(
      (arg) => arg.includes("$imagegen") && arg.includes(evilPrompt),
    );
    assert.ok(
      imagegenArg !== undefined,
      `Expected prompt embedded as single arg containing '$imagegen' and the full prompt. ` +
        `Args received: ${JSON.stringify(capturedArgv)}`,
    );

    // The rm and echo parts must NOT appear as separate argv elements
    const hasRmArg = capturedArgv.some((arg) => arg === "rm" || arg === "-rf");
    assert.equal(hasRmArg, false,
      "Shell metacharacters in prompt must NOT split into separate argv elements");

    // No element should be a bare semicolon
    const hasBareSemicolon = capturedArgv.some((arg) => arg === ";");
    assert.equal(hasBareSemicolon, false,
      "Semicolon in prompt must NOT appear as a separate argv element");
  });

  it("argv includes --dangerously-bypass-approvals-and-sandbox flag", async () => {
    const { runner, capturedArgv } = fakeRunnerRecordingArgv();
    const request = makeRequest({
      provider: "codex_builtin_imagegen",
      prompt: "a safe prompt",
    });

    const deps = makeDeps({ codexRunner: runner });
    const provider = new CodexBuiltinImagegenProvider();
    await provider.generate(request, deps);

    assert.ok(
      capturedArgv.includes("--dangerously-bypass-approvals-and-sandbox"),
      "The bypass flag must appear in the argv array",
    );
  });

  it("argv includes exec, --ephemeral flags (codex shape)", async () => {
    const { runner, capturedArgv } = fakeRunnerRecordingArgv();
    const request = makeRequest({
      provider: "codex_builtin_imagegen",
      prompt: "a prompt",
    });

    const deps = makeDeps({ codexRunner: runner });
    const provider = new CodexBuiltinImagegenProvider();
    await provider.generate(request, deps);

    assert.ok(capturedArgv.includes("exec"), "argv must include 'exec'");
    assert.ok(capturedArgv.includes("--ephemeral"), "argv must include '--ephemeral'");
  });
});

// ---------------------------------------------------------------------------
// 8–11. CodexBuiltinImagegenProvider — output validation
// ---------------------------------------------------------------------------

describe("CodexBuiltinImagegenProvider — output validation", () => {
  it("returns needs_regeneration when runner returns ok:false (no image)", async () => {
    const request = makeRequest({
      provider: "codex_builtin_imagegen",
      outputPath: "generated/missing.png",
    });

    const deps = makeDeps({ codexRunner: fakeRunnerMissing() });
    const provider = new CodexBuiltinImagegenProvider();
    const result = await provider.generate(request, deps);

    assert.equal(result.status, "needs_regeneration");
    assert.doesNotThrow(() => result); // no uncaught throw
  });

  it("returns needs_regeneration when runner returns a zero-byte image", async () => {
    // Place the fake image inside the fake codex home so the source guard passes
    const fakeImagesDir = path.join(tmpCodexHome, "generated_images", "thread-zero");
    fs.mkdirSync(fakeImagesDir, { recursive: true });
    const fakeImagePath = path.join(fakeImagesDir, "ig_zero.png");
    fs.writeFileSync(fakeImagePath, Buffer.alloc(0));

    const runner: CodexImagegenRunner = {
      async run(_argv, _timeout, _root, _startedAt) {
        return { ok: true, imagePath: fakeImagePath };
      },
    };

    const request = makeRequest({
      provider: "codex_builtin_imagegen",
      outputPath: "generated/zero.png",
    });

    const deps = makeDeps({ codexRunner: runner });
    const provider = new CodexBuiltinImagegenProvider();
    const result = await provider.generate(request, deps);

    assert.equal(result.status, "needs_regeneration");
  });

  it("returns needs_regeneration when runner returns file with wrong extension", async () => {
    // Place inside allowed codex root
    const fakeImagesDir = path.join(tmpCodexHome, "generated_images", "thread-bad");
    fs.mkdirSync(fakeImagesDir, { recursive: true });
    const fakeImagePath = path.join(fakeImagesDir, "ig_bad.txt");
    fs.writeFileSync(fakeImagePath, "not an image at all");

    const runner: CodexImagegenRunner = {
      async run(_argv, _timeout, _root, _startedAt) {
        return { ok: true, imagePath: fakeImagePath };
      },
    };

    const request = makeRequest({
      provider: "codex_builtin_imagegen",
      outputPath: "generated/bad.png",
    });

    const deps = makeDeps({ codexRunner: runner });
    const provider = new CodexBuiltinImagegenProvider();
    const result = await provider.generate(request, deps);

    assert.equal(result.status, "needs_regeneration");
  });

  it("returns generated and copies image to outputPath when runner succeeds", async () => {
    // Create a fake PNG-like file inside the allowed codex root
    const fakeImagesDir = path.join(tmpCodexHome, "generated_images", "thread-ok");
    fs.mkdirSync(fakeImagesDir, { recursive: true });
    const fakeImagePath = path.join(fakeImagesDir, "ig_valid.png");
    const fakePngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
      ...Array<number>(512).fill(0x00),
    ]);
    fs.writeFileSync(fakeImagePath, fakePngBytes);

    const runner: CodexImagegenRunner = {
      async run(_argv, _timeout, _root, _startedAt) {
        return { ok: true, imagePath: fakeImagePath };
      },
    };

    const request = makeRequest({
      provider: "codex_builtin_imagegen",
      outputPath: "codex-result/hero.png",
    });

    const deps = makeDeps({ codexRunner: runner });
    const provider = new CodexBuiltinImagegenProvider();
    const result = await provider.generate(request, deps);

    assert.equal(result.status, "generated");
    assert.equal(result.provider, "codex_builtin_imagegen");

    const destPath = path.join(tmpRepo, "codex-result", "hero.png");
    assert.ok(fs.existsSync(destPath), "Image must be copied to the output path");
    const destBytes = fs.readFileSync(destPath);
    assert.equal(destBytes.length, fakePngBytes.length, "Copied bytes must match source");
  });
});

// ---------------------------------------------------------------------------
// 12. Source path outside codex output root → rejected before copy
// ---------------------------------------------------------------------------

describe("CodexBuiltinImagegenProvider — source image path guard", () => {
  it("rejects imagePath outside the allowed codex root; no copy occurs", async () => {
    // Create a file OUTSIDE the allowed codex root (inside tmpRepo, not codexHome)
    const outsideImagePath = path.join(tmpRepo, "outside-codex", "sneaky.png");
    fs.mkdirSync(path.dirname(outsideImagePath), { recursive: true });
    fs.writeFileSync(outsideImagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...Array<number>(64).fill(0x00),
    ]));

    const runner: CodexImagegenRunner = {
      async run(_argv, _timeout, _root, _startedAt) {
        return { ok: true, imagePath: outsideImagePath };
      },
    };

    const request = makeRequest({
      provider: "codex_builtin_imagegen",
      outputPath: "codex-result/guarded.png",
    });

    const deps = makeDeps({ codexRunner: runner });
    const provider = new CodexBuiltinImagegenProvider();
    const result = await provider.generate(request, deps);

    // Must return needs_regeneration, not throw, and must NOT copy the file
    assert.equal(result.status, "needs_regeneration");
    assert.ok(
      result.message?.includes("outside the permitted codex output roots"),
      `Expected rejection message; got: ${result.message}`,
    );

    const destPath = path.join(tmpRepo, "codex-result", "guarded.png");
    assert.equal(
      fs.existsSync(destPath),
      false,
      "File must NOT be copied when source is outside allowed root",
    );
  });
});

// ---------------------------------------------------------------------------
// 13. Output path outside repo → rejected by resolveWithinRepo
// ---------------------------------------------------------------------------

describe("CodexBuiltinImagegenProvider — repo bounds guard", () => {
  it("rejects an output path that escapes the repo root before calling the runner", async () => {
    let runnerCalled = false;
    const runner: CodexImagegenRunner = {
      async run(_argv, _timeout, _root, _startedAt) {
        runnerCalled = true;
        return { ok: false, reason: "should not be called" };
      },
    };

    const request = makeRequest({
      provider: "codex_builtin_imagegen",
      outputPath: "../../etc/evil.png",
    });

    const deps = makeDeps({ codexRunner: runner });
    const provider = new CodexBuiltinImagegenProvider();

    await assert.rejects(
      () => provider.generate(request, deps),
      /outside the repository root/,
    );

    assert.equal(runnerCalled, false, "Runner must NOT be called when path escapes repo");
  });
});

// ---------------------------------------------------------------------------
// 14. Timeout path — needs_regeneration, kill called
// ---------------------------------------------------------------------------

describe("CodexBuiltinImagegenProvider — timeout handling", () => {
  it("returns needs_regeneration on timeout; does not throw", async () => {
    let killWasCalled = false;

    const runner: CodexImagegenRunner = {
      async run(_argv, _timeout, _root, _startedAt) {
        return {
          ok: false,
          reason: "timeout",
          timedOut: true,
          // Test seam: the real runner kills the process group itself.
          // Fake runners set killCalled so the test asserts kill happened.
          killCalled: () => { killWasCalled = true; },
        };
      },
    };

    const request = makeRequest({
      provider: "codex_builtin_imagegen",
      outputPath: "generated/timeout.png",
    });

    const deps = makeDeps({ codexRunner: runner });
    const provider = new CodexBuiltinImagegenProvider();
    const result = await provider.generate(request, deps);

    assert.equal(result.status, "needs_regeneration");
    assert.equal(killWasCalled, true, "Kill callback must have been invoked on timeout");
  });
});

// ---------------------------------------------------------------------------
// 15–16. harvestCodexImage — unit tests for the harvest helper
// ---------------------------------------------------------------------------

describe("harvestCodexImage", () => {
  it("returns the newest image file with mtime >= runStartedAt", () => {
    // Build a fake generated_images tree
    const harvestRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "archon-harvest-test-"),
    );
    try {
      const genDir = path.join(harvestRoot, "generated_images", "t1");
      fs.mkdirSync(genDir, { recursive: true });

      // Old image — explicitly set to 5 seconds in the past.
      const oldImg = path.join(genDir, "ig_old.png");
      fs.writeFileSync(oldImg, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const oldTime = new Date(Date.now() - 5000);
      fs.utimesSync(oldImg, oldTime, oldTime);

      // runStartedAt is 2 seconds in the past — both new images are newer.
      const runStartedAt = Date.now() - 2000;

      // Newer image — explicitly set to 1 second in the past (>= runStartedAt).
      const newImg = path.join(genDir, "ig_new.png");
      fs.writeFileSync(newImg, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
      const newTime = new Date(Date.now() - 1000);
      fs.utimesSync(newImg, newTime, newTime);

      // Even newer image — set to now (the winner by mtime).
      const newestImg = path.join(genDir, "ig_newest.webp");
      fs.writeFileSync(newestImg, Buffer.from([0x52, 0x49, 0x46, 0x46])); // RIFF (webp)
      const newestTime = new Date(); // now
      fs.utimesSync(newestImg, newestTime, newestTime);

      const result = harvestCodexImage(harvestRoot, runStartedAt);
      assert.ok(result !== undefined, "harvestCodexImage must find an image");
      // The returned file must have a valid image extension
      const ext = path.extname(result ?? "").toLowerCase();
      assert.ok(
        [".png", ".webp", ".jpg", ".jpeg", ".gif", ".avif"].includes(ext),
        `Expected image extension; got: ${ext}`,
      );
      // Must not return the old image (mtime 5s before runStartedAt)
      assert.notEqual(result, oldImg, "Must not return the image with mtime before runStartedAt");
      // Must return the newest (highest mtime) of the two eligible images
      assert.equal(result, newestImg, "Must return the image with the highest mtime");
    } finally {
      fs.rmSync(harvestRoot, { recursive: true, force: true });
    }
  });

  it("returns undefined when no images newer than runStartedAt exist", () => {
    const harvestRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "archon-harvest-empty-"),
    );
    try {
      const genDir = path.join(harvestRoot, "generated_images", "t1");
      fs.mkdirSync(genDir, { recursive: true });

      // Create an image and explicitly set its mtime to 5 seconds ago.
      const oldImg = path.join(genDir, "ig_old.png");
      fs.writeFileSync(oldImg, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const oldTime = new Date(Date.now() - 5000);
      fs.utimesSync(oldImg, oldTime, oldTime);

      // runStartedAt is 1 second ago — older than the image's 5-second-ago mtime.
      // Actually we want runStartedAt to be AFTER the image's mtime.
      // Image mtime = now-5s. runStartedAt = now-1s. now-5s < now-1s → image is skipped.
      const runStartedAt = Date.now() - 1000;

      const result = harvestCodexImage(harvestRoot, runStartedAt);
      assert.equal(result, undefined,
        "Must return undefined when no images have mtime >= runStartedAt");
    } finally {
      fs.rmSync(harvestRoot, { recursive: true, force: true });
    }
  });

  it("returns undefined when the generated_images dir does not exist", () => {
    const emptyRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "archon-harvest-nodir-"),
    );
    try {
      const result = harvestCodexImage(emptyRoot, Date.now());
      assert.equal(result, undefined);
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 17. needs_action is in the assetStatusValues contract (round-trip test)
// ---------------------------------------------------------------------------

describe("needs_action contract round-trip", () => {
  it("needs_action is present in assetStatusValues so GenerationResult parses cleanly", () => {
    assert.ok(
      (assetStatusValues as readonly string[]).includes("needs_action"),
      "assetStatusValues must include 'needs_action' so Phase-3 Zod parse does not reject it",
    );
  });

  it("ManualUploadProvider result.status matches an assetStatusValues entry", async () => {
    const request = makeRequest({
      provider: "manual_upload",
      outputPath: "manual/not-there.png",
    });

    const provider = new ManualUploadProvider();
    const result = await provider.generate(request, { repoRoot: tmpRepo });

    assert.equal(result.status, "needs_action");
    assert.ok(
      (assetStatusValues as readonly string[]).includes(result.status),
      `result.status "${result.status}" must be in assetStatusValues`,
    );
  });
});
