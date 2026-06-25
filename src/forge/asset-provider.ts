/**
 * @module forge/asset-provider
 *
 * AssetProvider abstraction + three implementations for the Archon Frontend
 * Forge pipeline (Phase 2, task forgeP2AssetProvider).
 *
 * Providers:
 *   - PlaceholderSvgProvider   — always available; writes a deterministic SVG
 *   - ManualUploadProvider     — verifies the operator file already exists
 *   - CodexBuiltinImagegenProvider — headless codex $imagegen; CI-safe gated
 *
 * Security contract (D2 hard gate):
 *   1. The codex command is built as an argv ARRAY and passed to spawn with
 *      NO `shell: true`. Prompt text is a single literal argument — shell
 *      metacharacters in the prompt cannot escape into the shell.
 *   2. `--dangerously-bypass-approvals-and-sandbox` is used ONLY in the real
 *      CodexImagegenRunner.run() implementation and ONLY for the asset-gen
 *      worker subprocess. It is never used anywhere else in this module.
 *   3. All output paths are guarded via `resolveWithinRepo` before any file
 *      I/O is performed.
 *   4. The runner-supplied source image path is bounded to the codex output
 *      root (CODEX_HOME/generated_images or os.tmpdir()) via realpath
 *      resolution — an attacker-controlled runner returning "/etc/shadow"
 *      is rejected before any fs.copyFileSync.
 *   5. The codex path is gated: CI=true or no codex login → placeholder_svg;
 *      codex is NEVER invoked in CI or without a valid login.
 *      `selectAssetProvider`'s env parameter defaults to `process.env` so
 *      the CI gate fires correctly when the caller omits env.
 *   6. The subprocess is bounded by a configurable timeout; on timeout the
 *      child and its process group are killed.
 *   7. No secrets or tokens are logged.
 *
 * Import wall: this module does NOT import from web/. It may import from
 * src/forge/* (read-only), node built-ins, and nothing else.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { AssetRequest } from "./asset-contract.ts";
import { generatePlaceholderSvg } from "./placeholder-assets.ts";
import { resolveWithinRepo } from "./repo-path.ts";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * The outcome status of an asset generation attempt.
 *
 *   generated          — file written to disk at outputPath; ready for QA.
 *   needs_regeneration — generation failed (codex timeout, missing output, etc.)
 *                        Caller should retry or fall back.
 *   needs_action       — manual_upload: operator must provide the file.
 *   rejected           — hard failure (e.g. path escapes repo). Not retried.
 */
export type GenerationStatus =
  | "generated"
  | "needs_regeneration"
  | "needs_action"
  | "rejected";

/**
 * Structured result returned by every AssetProvider.generate() call.
 *
 * Carries enough information to update the AssetManifestEntry status field
 * and feed the Phase-3 QA stage. Does NOT run QA itself.
 *
 * Note: `needs_action` is also in `assetStatusValues` (asset-contract.ts) so
 * Phase-3 can round-trip this value through Zod without rejection.
 */
export interface AssetGenerationResult {
  /** Matches AssetRequest.id. */
  readonly id: string;
  /** Which provider produced (or attempted) this result. */
  readonly provider: AssetRequest["provider"];
  /** Outcome status. */
  readonly status: GenerationStatus;
  /** Absolute path where the asset was written (present when status=generated). */
  readonly outputAbsPath?: string | undefined;
  /** Human-readable reason for non-generated outcomes. */
  readonly message?: string | undefined;
}

// ---------------------------------------------------------------------------
// CodexImagegenRunner — injectable dep for testability
// ---------------------------------------------------------------------------

/**
 * Result from a CodexImagegenRunner.run() call.
 *
 * ok=true  → imagePath is the absolute path of the produced image.
 * ok=false → reason describes the failure; timedOut signals a timeout.
 *             killCalled is a test seam that the provider invokes when it
 *             detects timedOut:true — fake runners set this to let tests
 *             assert that process-group kill happened.
 */
export type CodexRunnerResult =
  | { readonly ok: true; readonly imagePath: string }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly timedOut?: boolean | undefined;
      /** Test seam: the PROVIDER calls this when it detects timedOut:true. */
      readonly killCalled?: (() => void) | undefined;
    };

/**
 * Injectable dep that runs the codex $imagegen subprocess and harvests its
 * output image.
 *
 * The production default (RealCodexImagegenRunner) spawns codex without
 * shell:true and harvests the newest image written to the codex output dir
 * after the run completes. Tests inject a fake that records the argv and
 * returns a deterministic result — no real codex runs in tests.
 */
export interface CodexImagegenRunner {
  /**
   * @param argv             Full argv array for the codex subprocess. The first
   *                         element is the binary name ("codex"). No shell expansion.
   * @param timeoutMs        Hard timeout in milliseconds; real runner kills on expiry.
   * @param codexOutputRoot  Root directory where codex writes generated_images/.
   *                         Injected so tests can supply a fake CODEX_HOME without
   *                         touching the real filesystem.
   * @param runStartedAt     Epoch ms just before the subprocess was launched.
   *                         Used to find only images created by THIS run.
   */
  run(
    argv: readonly string[],
    timeoutMs: number,
    codexOutputRoot: string,
    runStartedAt: number,
  ): Promise<CodexRunnerResult>;
}

// ---------------------------------------------------------------------------
// Provider deps (passed to every generate() call)
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into provider.generate() at call time.
 *
 * repoRoot        — repo root for resolveWithinRepo; defaults to process.cwd().
 * codexRunner     — only consumed by CodexBuiltinImagegenProvider; required
 *                   when that provider is used.
 * timeoutMs       — codex subprocess timeout (default: 120_000ms).
 * codexOutputRoot — root where codex writes generated_images/. Defaults to
 *                   $CODEX_HOME or ~/.codex. Injectable for tests.
 */
export interface ProviderDeps {
  readonly repoRoot?: string | undefined;
  readonly codexRunner?: CodexImagegenRunner | undefined;
  readonly timeoutMs?: number | undefined;
  readonly codexOutputRoot?: string | undefined;
}

// ---------------------------------------------------------------------------
// AssetProvider interface
// ---------------------------------------------------------------------------

/**
 * Common interface for all asset generation strategies.
 *
 * Each implementation is stateless — all state is in the deps/request args.
 */
export interface AssetProvider {
  generate(request: AssetRequest, deps: ProviderDeps): Promise<AssetGenerationResult>;
}

// ---------------------------------------------------------------------------
// Valid image extensions recognised as codex output
// ---------------------------------------------------------------------------

const VALID_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".avif",
]);

// ---------------------------------------------------------------------------
// Codex output root helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the root directory that is the allowed source for codex-produced
 * images. Codex writes images under:
 *   $CODEX_HOME/generated_images/<thread>/ig_<hash>.png
 *
 * The allowed source roots are:
 *   1. The codexOutputRoot dep (injectable — used in tests and real code).
 *   2. os.tmpdir() — codex may write to the system temp dir on some platforms.
 *
 * Both are resolved via realpathSync to defeat symlink-based escapes before
 * comparison.
 */
function resolveCodexOutputRoot(codexOutputRoot: string): string {
  try {
    return fs.realpathSync(codexOutputRoot);
  } catch {
    // Not yet created — return as-is (realpath fails on non-existent dirs).
    return codexOutputRoot;
  }
}

/**
 * Determine the default codex output root from environment.
 *
 * Codex stores its state in $CODEX_HOME (default ~/.codex).
 * Generated images land under $CODEX_HOME/generated_images/.
 */
function defaultCodexOutputRoot(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const codexHome = process.env["CODEX_HOME"] ?? path.join(home, ".codex");
  return codexHome;
}

/**
 * Assert that `imagePath` (the runner-supplied source) is inside one of the
 * permitted codex output roots (codexOutputRoot or os.tmpdir()).
 *
 * This prevents a compromised or misbehaving runner from returning an arbitrary
 * path (e.g. "/etc/shadow") that would be copied into the repo.
 *
 * The path is realpath-resolved before comparison so symlinks cannot escape.
 *
 * @throws Error if the path is outside all permitted roots.
 */
function assertImagePathInAllowedRoot(
  imagePath: string,
  codexOutputRoot: string,
): void {
  // Realpath the candidate. If it does not exist, we will already have failed
  // the existence check before reaching this function. Use safeRealpath.
  let canonicalImage: string;
  try {
    canonicalImage = fs.realpathSync(imagePath);
  } catch {
    // Non-existent — cannot be inside any root; let the existence check handle it.
    canonicalImage = path.resolve(imagePath);
  }

  // Only the injected codexOutputRoot is allowed as a source.
  // Allowing os.tmpdir() wholesale would permit any file in /tmp to be copied
  // into the repo, which is too broad. The real runner harvests from
  // <codexOutputRoot>/generated_images/ so this root is sufficient.
  const allowedRoots = [
    resolveCodexOutputRoot(codexOutputRoot),
  ];

  const inAllowedRoot = allowedRoots.some((root) => {
    const sep = path.sep;
    return canonicalImage === root || canonicalImage.startsWith(root + sep);
  });

  if (!inAllowedRoot) {
    throw new Error(
      `Codex runner returned an image path "${imagePath}" (canonical: "${canonicalImage}") ` +
        `that is outside the permitted codex output roots: ` +
        `${allowedRoots.join(", ")}. ` +
        `This path is rejected as a security measure.`,
    );
  }
}

// ---------------------------------------------------------------------------
// PlaceholderSvgProvider
// ---------------------------------------------------------------------------

/**
 * Always-available provider. Generates a deterministic placeholder SVG from
 * the AssetRequest (via generatePlaceholderSvg) and writes it to the
 * repo-bounded outputPath.
 *
 * The SVG content is controlled entirely by the fixed vocabulary in
 * placeholder-assets.ts — no user input is interpolated into the SVG body.
 */
export class PlaceholderSvgProvider implements AssetProvider {
  async generate(
    request: AssetRequest,
    deps: ProviderDeps,
  ): Promise<AssetGenerationResult> {
    // Guard output path before any I/O.
    const absPath = resolveWithinRepo(request.outputPath, {
      repoRoot: deps.repoRoot,
    });

    // Generate SVG content (deterministic, no user text in SVG body).
    const svgContent = generatePlaceholderSvg(request);

    // Write to disk, creating parent directories as needed.
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, svgContent, "utf-8");

    return {
      id: request.id,
      provider: "placeholder_svg",
      status: "generated",
      outputAbsPath: absPath,
    };
  }
}

// ---------------------------------------------------------------------------
// ManualUploadProvider
// ---------------------------------------------------------------------------

/**
 * No-generation provider. Verifies that the operator-provided file already
 * exists at outputPath. Reports missing as a needs-action result (not an error).
 *
 * `needs_action` maps to `assetStatusValues` in asset-contract.ts so this
 * result round-trips through the Phase-3 Zod schema without rejection.
 */
export class ManualUploadProvider implements AssetProvider {
  async generate(
    request: AssetRequest,
    deps: ProviderDeps,
  ): Promise<AssetGenerationResult> {
    // Guard output path before any I/O.
    const absPath = resolveWithinRepo(request.outputPath, {
      repoRoot: deps.repoRoot,
    });

    if (fs.existsSync(absPath)) {
      return {
        id: request.id,
        provider: "manual_upload",
        status: "generated",
        outputAbsPath: absPath,
      };
    }

    return {
      id: request.id,
      provider: "manual_upload",
      status: "needs_action",
      message: `manual_upload asset not found at "${absPath}". ` +
        `Operator must place the file at the expected path before this asset can be used.`,
    };
  }
}

// ---------------------------------------------------------------------------
// RealCodexImagegenRunner (production default)
// ---------------------------------------------------------------------------

/** Default codex subprocess timeout (ms). Non-trivial; codex $imagegen is slow. */
const DEFAULT_CODEX_TIMEOUT_MS = 120_000;

/**
 * Harvest: after codex exits 0, find the newest image file written under
 * `<codexOutputRoot>/generated_images/` with a timestamp >= `runStartedAt`.
 *
 * Codex writes images to:
 *   <CODEX_HOME>/generated_images/<thread-id>/ig_<hash>.{png,webp,jpg,…}
 *
 * We do a breadth-first walk (max depth 3) and return the newest file whose
 * mtime >= runStartedAt and whose extension is in VALID_IMAGE_EXTENSIONS.
 *
 * Returns `undefined` if no such file is found.
 */
export function harvestCodexImage(
  codexOutputRoot: string,
  runStartedAt: number,
): string | undefined {
  const generatedImagesDir = path.join(codexOutputRoot, "generated_images");
  if (!fs.existsSync(generatedImagesDir)) {
    return undefined;
  }

  let best: { mtimeMs: number; filePath: string } | undefined;

  function walk(dir: string, depth: number): void {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!VALID_IMAGE_EXTENSIONS.has(ext)) continue;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        if (stat.mtimeMs < runStartedAt) continue;
        if (best === undefined || stat.mtimeMs > best.mtimeMs) {
          best = { mtimeMs: stat.mtimeMs, filePath: fullPath };
        }
      }
    }
  }

  walk(generatedImagesDir, 0);
  return best?.filePath;
}

/**
 * Production CodexImagegenRunner. Spawns codex with shell:false, bounds the
 * subprocess with a configurable timeout, then harvests the newest image from
 * the codex output directory.
 *
 * Security rationale for --dangerously-bypass-approvals-and-sandbox:
 *   Codex's default interactive mode requires human approval for every tool
 *   call. Running headless (no TTY, no interactive session) requires bypassing
 *   that gate. The bypass is scoped ONLY to this asset-gen subprocess and is
 *   NOT a project-wide setting. The workspace is ephemeral (--ephemeral flag)
 *   so no state persists between runs. The prompt is passed as a single argv
 *   argument, never interpolated into a shell string, so prompt injection cannot
 *   escalate to shell command injection.
 *
 * Process-group kill: on timeout we kill the entire process group (negative PID
 * + SIGKILL) so any child subprocesses spawned by codex are also terminated.
 * This prevents unbounded hangs even if codex forks children.
 */
export class RealCodexImagegenRunner implements CodexImagegenRunner {
  async run(
    argv: readonly string[],
    timeoutMs: number,
    codexOutputRoot: string,
    runStartedAt: number,
  ): Promise<CodexRunnerResult> {
    const [bin, ...args] = argv;
    if (bin === undefined) {
      return { ok: false, reason: "empty argv" };
    }

    let childPid: number | undefined;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const killGroup = (): void => {
      if (childPid === undefined) return;
      try {
        // Negative PID → send signal to the entire process group.
        // SIGKILL: no chance for the child to ignore or defer.
        process.kill(-childPid, "SIGKILL");
      } catch {
        // Process already exited — ignore.
      }
    };

    try {
      const spawnResult = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
        // spawn with shell:false (default) — argv elements are literal strings.
        // Detached so we can kill the entire process group on timeout.
        const child = spawn(bin, args, {
          // Detached: lets us kill the entire process group on timeout.
          detached: true,
          // shell: false is the default for spawn; explicit for clarity.
          shell: false,
          // Ignore stdin; pipe stdout/stderr so the process doesn't block on TTY.
          stdio: ["ignore", "pipe", "pipe"],
        });

        childPid = child.pid;

        // Detach so Node's event loop doesn't wait for codex.
        child.unref();

        child.on("error", (err: Error) => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          if (!timedOut) {
            resolve({ ok: false, reason: `codex spawn error: ${err.message}` });
          }
        });

        child.on("close", (code: number | null) => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          if (timedOut) return;
          if (code !== 0) {
            resolve({
              ok: false,
              reason: `codex exited with code ${code ?? "null"}`,
            });
            return;
          }
          resolve({ ok: true });
        });

        timer = setTimeout(() => {
          timedOut = true;
          killGroup();
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          resolve({
            ok: false,
            reason: "codex $imagegen timed out",
          });
        }, timeoutMs);
      });

      if (timedOut) {
        return { ok: false, reason: "codex $imagegen timed out", timedOut: true };
      }

      if (!spawnResult.ok) {
        return { ok: false, reason: spawnResult.reason ?? "codex failed" };
      }

      // Harvest the generated image from the codex output directory.
      const imagePath = harvestCodexImage(codexOutputRoot, runStartedAt);
      if (imagePath === undefined) {
        return {
          ok: false,
          reason: `codex exited 0 but no image found in ${codexOutputRoot}/generated_images/ ` +
            `with mtime >= ${runStartedAt}`,
        };
      }

      return { ok: true, imagePath };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CodexBuiltinImagegenProvider
// ---------------------------------------------------------------------------

/**
 * Headless codex $imagegen provider.
 *
 * Builds the codex argv as a literal string array (NO shell expansion), calls
 * the injected CodexImagegenRunner, then validates + copies the produced image
 * to the repo-bounded outputPath.
 *
 * The runner-supplied source image path is additionally bounded to the codex
 * output root (via assertImagePathInAllowedRoot) before any copy is attempted.
 *
 * All failure modes return a structured result — never an uncaught throw.
 */
export class CodexBuiltinImagegenProvider implements AssetProvider {
  async generate(
    request: AssetRequest,
    deps: ProviderDeps,
  ): Promise<AssetGenerationResult> {
    // 1. Guard output path BEFORE calling the runner.
    //    This is the first I/O gate — an invalid path is rejected here,
    //    not after we've spent ≥120s waiting for codex.
    const absOutputPath = resolveWithinRepo(request.outputPath, {
      repoRoot: deps.repoRoot,
    });

    const runner = deps.codexRunner;
    if (runner === undefined) {
      return {
        id: request.id,
        provider: "codex_builtin_imagegen",
        status: "needs_regeneration",
        message: "No CodexImagegenRunner injected; cannot invoke codex.",
      };
    }

    const timeoutMs = deps.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
    const codexOutputRoot = deps.codexOutputRoot ?? defaultCodexOutputRoot();
    const runStartedAt = Date.now();

    // 2. Build the codex argv ARRAY.
    //
    //    Structure:
    //      codex exec --ephemeral --dangerously-bypass-approvals-and-sandbox
    //            -C <workspace> '<$imagegen instruction>'
    //
    //    The $imagegen instruction string embeds the full prompt as a single
    //    argv element. No shell expansion occurs because we never use
    //    shell:true — spawn receives these as literal process arguments.
    //    A prompt containing "; rm -rf /" is passed verbatim to codex, not
    //    to a shell, so no injection is possible.
    //
    //    Security note: --dangerously-bypass-approvals-and-sandbox is required
    //    here because headless codex has no TTY and cannot present interactive
    //    approval prompts. The flag is scoped to THIS subprocess only.
    const workspace = path.dirname(absOutputPath);
    const outputFilename = path.basename(absOutputPath);
    const imagegenInstruction =
      `$imagegen ${request.prompt}. Save as ${outputFilename}.`;

    const argv: readonly string[] = [
      "codex",
      "exec",
      "--ephemeral",
      // SECURITY: required for headless execution only; scoped to asset-gen subprocess.
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      workspace,
      imagegenInstruction,
    ];

    // 3. Invoke the runner (injected dep — real or fake).
    const runResult = await runner.run(argv, timeoutMs, codexOutputRoot, runStartedAt);

    // 4. If the runner reports a timeout, invoke the kill callback (test seam).
    //    The real runner kills the process group itself before returning timedOut:true.
    //    Fake runners set killCalled so tests can assert kill happened.
    if (!runResult.ok && runResult.timedOut && runResult.killCalled !== undefined) {
      runResult.killCalled();
    }

    if (!runResult.ok) {
      return {
        id: request.id,
        provider: "codex_builtin_imagegen",
        status: "needs_regeneration",
        message: `codex runner failed: ${runResult.reason}`,
      };
    }

    const imagePath = runResult.imagePath;

    // 5a. Validate existence before the source-root guard (non-existence means
    //     there is nothing to check or copy).
    if (!fs.existsSync(imagePath)) {
      return {
        id: request.id,
        provider: "codex_builtin_imagegen",
        status: "needs_regeneration",
        message: `codex produced image path "${imagePath}" does not exist on disk.`,
      };
    }

    // 5b. Guard the SOURCE path to the codex output root (security gate).
    //     This prevents a runner returning "/etc/shadow" from being copied in.
    //     assertImagePathInAllowedRoot throws if the path escapes the root.
    try {
      assertImagePathInAllowedRoot(imagePath, codexOutputRoot);
    } catch (err) {
      return {
        id: request.id,
        provider: "codex_builtin_imagegen",
        status: "needs_regeneration",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 5c. Validate size > 0.
    const stat = fs.statSync(imagePath);
    if (stat.size === 0) {
      return {
        id: request.id,
        provider: "codex_builtin_imagegen",
        status: "needs_regeneration",
        message: `codex produced an empty file at "${imagePath}" (0 bytes).`,
      };
    }

    // 5d. Validate extension is a recognised image format.
    const ext = path.extname(imagePath).toLowerCase();
    if (!VALID_IMAGE_EXTENSIONS.has(ext)) {
      return {
        id: request.id,
        provider: "codex_builtin_imagegen",
        status: "needs_regeneration",
        message: `codex output "${imagePath}" has unrecognised extension "${ext}". ` +
          `Expected one of: ${[...VALID_IMAGE_EXTENSIONS].join(", ")}.`,
      };
    }

    // 5e. Copy to the repo-bounded output path.
    fs.mkdirSync(path.dirname(absOutputPath), { recursive: true });
    fs.copyFileSync(imagePath, absOutputPath);

    return {
      id: request.id,
      provider: "codex_builtin_imagegen",
      status: "generated",
      outputAbsPath: absOutputPath,
    };
  }
}

// ---------------------------------------------------------------------------
// selectAssetProvider — provider selection with injected availability check
// ---------------------------------------------------------------------------

/**
 * A function that checks whether codex is available on this machine.
 *
 * The real implementation checks for a stored codex login token.
 * Tests inject () => true or () => false to test the gating logic without
 * touching the filesystem.
 */
export type CodexAvailabilityCheck = () => boolean;

/**
 * Default availability check: look for a codex login token file.
 *
 * Codex stores its auth token in $CODEX_HOME (default ~/.codex) or the
 * standard config directories. We check the most common location without
 * importing codex internals.
 *
 * This is a best-effort check; the real runner will fail if the token is
 * stale, at which point the result will be needs_regeneration.
 */
function defaultCodexAvailability(): boolean {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const codexHome = process.env["CODEX_HOME"] ?? path.join(home, ".codex");
  // Codex stores credentials in auth.json or similar within the codex home.
  const authCandidates = [
    path.join(codexHome, "auth.json"),
    path.join(codexHome, "config.json"),
    path.join(codexHome, ".credentials"),
  ];
  return authCandidates.some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/**
 * Select the appropriate AssetProvider for the given request and environment.
 *
 * Selection rules (evaluated in priority order):
 *   1. If request.provider === "manual_upload" → ManualUploadProvider.
 *   2. If request.provider === "placeholder_svg" → PlaceholderSvgProvider.
 *   3. If request.provider === "codex_builtin_imagegen":
 *      a. env.CI === "true" → PlaceholderSvgProvider (NEVER codex in CI).
 *      b. availabilityCheck() returns false → PlaceholderSvgProvider.
 *      c. Otherwise → CodexBuiltinImagegenProvider.
 *
 * The availability check is injectable so tests can probe the CI/no-login
 * gating without touching the real filesystem or environment.
 *
 * @param request           The AssetRequest being processed.
 * @param env               Environment variables. Defaults to `process.env` so
 *                          a production caller that omits this argument
 *                          automatically inherits CI=true when running in CI.
 *                          Pass a custom object only when testing.
 * @param availabilityCheck Optional override for the codex login check.
 */
export function selectAssetProvider(
  request: AssetRequest,
  env: Partial<Record<string, string>> = process.env,
  availabilityCheck: CodexAvailabilityCheck = defaultCodexAvailability,
): AssetProvider {
  // Honour explicit manual_upload requests regardless of availability.
  if (request.provider === "manual_upload") {
    return new ManualUploadProvider();
  }

  // Honour explicit placeholder_svg requests.
  if (request.provider === "placeholder_svg") {
    return new PlaceholderSvgProvider();
  }

  // codex_builtin_imagegen: gate on CI and login availability.
  // CI=true → NEVER attempt codex, even if a token exists.
  if (env["CI"] === "true") {
    return new PlaceholderSvgProvider();
  }

  // No codex login token → fall back to placeholder.
  if (!availabilityCheck()) {
    return new PlaceholderSvgProvider();
  }

  return new CodexBuiltinImagegenProvider();
}
