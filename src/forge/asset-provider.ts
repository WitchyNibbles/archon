/**
 * @module forge/asset-provider
 *
 * AssetProvider abstraction + implementations for the Archon Frontend Forge pipeline.
 * Import wall: no import from web/. Only src/forge/*, node built-ins.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { AssetRequest } from "./asset-contract.ts";
import { generatePlaceholderSvg } from "./placeholder-assets.ts";
import { resolveWithinRepo } from "./repo-path.ts";
import { SpendCapBucket, getRunBucket } from "./spend-cap.ts";
// Re-export the spend-cap surface so existing importers (tests) keep working.
export { SpendCapBucket, resetRunBucket } from "./spend-cap.ts";

// Minimal secret-manager interfaces — defined inline so src/forge/ stays self-contained (CC-15).
/** Minimal secret-value interface: expose only reveal() (CC-DEC-2). */
interface ForgeSecretValue { reveal(): string; }
/** Minimal secret-manager interface consumed by forge providers. */
interface ForgeSecretManager { get(ref: string): Promise<ForgeSecretValue | undefined>; }

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Outcome status of an asset generation attempt. */
export type GenerationStatus =
  | "generated"
  | "needs_regeneration"
  | "needs_action"
  | "rejected";

/** Structured result returned by every AssetProvider.generate() call. */
export interface AssetGenerationResult {
  readonly id: string;
  readonly provider: AssetRequest["provider"];
  readonly status: GenerationStatus;
  readonly outputAbsPath?: string | undefined;
  /** Human-readable reason for non-generated outcomes. CC-8: never contains the API key. */
  readonly message?: string | undefined;
}

// ---------------------------------------------------------------------------
// CodexImagegenRunner — injectable dep for testability
// ---------------------------------------------------------------------------

/**
 * Result from a CodexImagegenRunner.run() call.
 * ok=true → imagePath is the produced image. ok=false → reason + optional timedOut/killCalled.
 */
export type CodexRunnerResult =
  | { readonly ok: true; readonly imagePath: string }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly timedOut?: boolean | undefined;
      readonly killCalled?: (() => void) | undefined;
    };

/**
 * Injectable dep that runs the codex $imagegen subprocess.
 * Production: RealCodexImagegenRunner. Tests: fake that returns deterministic results.
 */
export interface CodexImagegenRunner {
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
 * codexRunner     — only consumed by CodexBuiltinImagegenProvider.
 * timeoutMs       — codex subprocess timeout (default 120 000 ms).
 * codexOutputRoot — root where codex writes generated_images/.
 * secretManager   — optional; consumed by OpenAiApiImagegenProvider (CC-DEC-2).
 *                   Additive: existing providers ignore it.
 */
export interface ProviderDeps {
  readonly repoRoot?: string | undefined;
  readonly codexRunner?: CodexImagegenRunner | undefined;
  readonly timeoutMs?: number | undefined;
  readonly codexOutputRoot?: string | undefined;
  /** Secret-manager instance — only OpenAiApiImagegenProvider reads from this. */
  readonly secretManager?: ForgeSecretManager | undefined;
}

// ---------------------------------------------------------------------------
// AssetProvider interface
// ---------------------------------------------------------------------------

/** Common interface for all asset generation strategies. */
export interface AssetProvider {
  generate(request: AssetRequest, deps: ProviderDeps): Promise<AssetGenerationResult>;
}

// ---------------------------------------------------------------------------
// Valid image extensions
// ---------------------------------------------------------------------------

const VALID_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif",
]);

// ---------------------------------------------------------------------------
// Codex output root helpers
// ---------------------------------------------------------------------------

function resolveCodexOutputRoot(codexOutputRoot: string): string {
  try { return fs.realpathSync(codexOutputRoot); } catch { return codexOutputRoot; }
}

function defaultCodexOutputRoot(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const codexHome = process.env["CODEX_HOME"] ?? path.join(home, ".codex");
  return codexHome;
}

/**
 * Assert imagePath is inside the permitted codex output root.
 * Throws if the path escapes — prevents runner returning "/etc/shadow" being copied in.
 */
function assertImagePathInAllowedRoot(imagePath: string, codexOutputRoot: string): void {
  let canonicalImage: string;
  try { canonicalImage = fs.realpathSync(imagePath); }
  catch { canonicalImage = path.resolve(imagePath); }

  const allowedRoots = [resolveCodexOutputRoot(codexOutputRoot)];
  const sep = path.sep;
  const inAllowedRoot = allowedRoots.some(
    (root) => canonicalImage === root || canonicalImage.startsWith(root + sep),
  );

  if (!inAllowedRoot) {
    throw new Error(
      `Codex runner returned an image path "${imagePath}" (canonical: "${canonicalImage}") ` +
        `that is outside the permitted codex output roots: ${allowedRoots.join(", ")}. ` +
        `This path is rejected as a security measure.`,
    );
  }
}

// ---------------------------------------------------------------------------
// PlaceholderSvgProvider
// ---------------------------------------------------------------------------

/**
 * Always-available provider. Generates a deterministic placeholder SVG and writes
 * it to the repo-bounded outputPath.
 */
export class PlaceholderSvgProvider implements AssetProvider {
  async generate(request: AssetRequest, deps: ProviderDeps): Promise<AssetGenerationResult> {
    const absPath = resolveWithinRepo(request.outputPath, { repoRoot: deps.repoRoot });
    const svgContent = generatePlaceholderSvg(request);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, svgContent, "utf-8");
    return { id: request.id, provider: "placeholder_svg", status: "generated", outputAbsPath: absPath };
  }
}

// ---------------------------------------------------------------------------
// ManualUploadProvider
// ---------------------------------------------------------------------------

/**
 * No-generation provider. Verifies operator-provided file already exists at outputPath.
 * Missing → needs_action (not an error).
 */
export class ManualUploadProvider implements AssetProvider {
  async generate(request: AssetRequest, deps: ProviderDeps): Promise<AssetGenerationResult> {
    const absPath = resolveWithinRepo(request.outputPath, { repoRoot: deps.repoRoot });
    if (fs.existsSync(absPath)) {
      return { id: request.id, provider: "manual_upload", status: "generated", outputAbsPath: absPath };
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

const DEFAULT_CODEX_TIMEOUT_MS = 120_000;

/**
 * True when `filePath` exists as a regular file with mtime >= `since`.
 * Used to detect that codex wrote the asset to the exact instructed destination
 * during this run (vs a stale file left by a prior run).
 */
function freshFileAt(filePath: string, since: number): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.mtimeMs >= since;
  } catch {
    return false;
  }
}

/**
 * Find the newest image file (by mtime) under `dir` (walks up to 4 levels,
 * depth 0–3) with mtime >= `since`. Returns undefined when `dir` is absent or
 * has no qualifying image. Shared by the workspace harvest (where real codex
 * writes) and the legacy generated_images harvest. Symlinked entries are skipped
 * (Dirent.isFile() is false for symlinks), so they cannot redirect the harvest.
 */
export function findNewestImageInDir(dir: string, since: number): string | undefined {
  if (!fs.existsSync(dir)) return undefined;

  let best: { mtimeMs: number; filePath: string } | undefined;

  function walk(d: string, depth: number): void {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(fullPath, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!VALID_IMAGE_EXTENSIONS.has(ext)) continue;
      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      if (stat.mtimeMs < since) continue;
      if (best === undefined || stat.mtimeMs > best.mtimeMs) {
        best = { mtimeMs: stat.mtimeMs, filePath: fullPath };
      }
    }
  }

  walk(dir, 0);
  return best?.filePath;
}

/**
 * After codex exits 0, find the newest image written under
 * `<codexOutputRoot>/generated_images/` with mtime >= runStartedAt.
 *
 * NOTE: real codex (≥0.141, `exec` mode) does NOT write here — it saves the
 * `$imagegen` output into the `-C` working directory at the instructed filename.
 * This generated_images harvest is kept as a fallback for other codex
 * configurations/versions; the provider checks the workspace first.
 */
export function harvestCodexImage(codexOutputRoot: string, runStartedAt: number): string | undefined {
  return findNewestImageInDir(path.join(codexOutputRoot, "generated_images"), runStartedAt);
}

/**
 * Validate an image file that is already at a repo-bounded path (the workspace
 * harvest: no allowed-root check needed because resolveWithinRepo already bounded
 * it). Returns an error message string, or undefined when the file is valid.
 */
function validateRepoBoundImage(imagePath: string): string | undefined {
  let stat: fs.Stats;
  try { stat = fs.statSync(imagePath); }
  catch { return `expected image "${imagePath}" does not exist on disk.`; }
  if (stat.size === 0) return `codex produced an empty file at "${imagePath}" (0 bytes).`;
  const ext = path.extname(imagePath).toLowerCase();
  if (!VALID_IMAGE_EXTENSIONS.has(ext)) {
    return `codex output "${imagePath}" has unrecognised extension "${ext}". ` +
      `Expected one of: ${[...VALID_IMAGE_EXTENSIONS].join(", ")}.`;
  }
  return undefined;
}

/**
 * Production CodexImagegenRunner. Spawns codex with shell:false, bounds with configurable
 * timeout, then harvests the newest image from the codex output directory.
 *
 * Security: --dangerously-bypass-approvals-and-sandbox is required for headless execution;
 * scoped ONLY to this asset-gen subprocess. Prompt is a single argv arg — no shell injection.
 * On timeout the entire process group is killed (negative PID + SIGKILL).
 */
export class RealCodexImagegenRunner implements CodexImagegenRunner {
  async run(
    argv: readonly string[],
    timeoutMs: number,
    codexOutputRoot: string,
    runStartedAt: number,
  ): Promise<CodexRunnerResult> {
    const [bin, ...args] = argv;
    if (bin === undefined) return { ok: false, reason: "empty argv" };

    let childPid: number | undefined;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const killGroup = (): void => {
      if (childPid === undefined) return;
      try { process.kill(-childPid, "SIGKILL"); } catch { /* already exited */ }
    };

    try {
      const spawnResult = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
        const child = spawn(bin, args, { detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        childPid = child.pid;
        child.unref();

        child.on("error", (err: Error) => {
          if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
          if (!timedOut) resolve({ ok: false, reason: `codex spawn error: ${err.message}` });
        });

        child.on("close", (code: number | null) => {
          if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
          if (timedOut) return;
          if (code !== 0) { resolve({ ok: false, reason: `codex exited with code ${code ?? "null"}` }); return; }
          resolve({ ok: true });
        });

        timer = setTimeout(() => {
          timedOut = true;
          killGroup();
          if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
          resolve({ ok: false, reason: "codex $imagegen timed out" });
        }, timeoutMs);
      });

      if (timedOut) return { ok: false, reason: "codex $imagegen timed out", timedOut: true };
      if (!spawnResult.ok) return { ok: false, reason: spawnResult.reason ?? "codex failed" };

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
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// CodexBuiltinImagegenProvider
// ---------------------------------------------------------------------------

/**
 * Headless codex $imagegen provider. Builds argv as a literal string array
 * (no shell expansion), calls the injected runner, validates + copies the result
 * to the repo-bounded outputPath. All failure modes return structured results.
 */
export class CodexBuiltinImagegenProvider implements AssetProvider {
  async generate(request: AssetRequest, deps: ProviderDeps): Promise<AssetGenerationResult> {
    const absOutputPath = resolveWithinRepo(request.outputPath, { repoRoot: deps.repoRoot });
    const runner = deps.codexRunner;
    if (runner === undefined) {
      return { id: request.id, provider: "codex_builtin_imagegen", status: "needs_regeneration",
        message: "No CodexImagegenRunner injected; cannot invoke codex." };
    }

    const timeoutMs = deps.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
    const codexOutputRoot = deps.codexOutputRoot ?? defaultCodexOutputRoot();
    const runStartedAt = Date.now();

    const workspace = path.dirname(absOutputPath);
    const outputFilename = path.basename(absOutputPath);
    const imagegenInstruction = `$imagegen ${request.prompt}. Save as ${outputFilename}.`;

    // codex `exec -C <workspace>` fails immediately ("No such file or directory",
    // exit 1) if the working directory does not exist. The output dir is often a
    // not-yet-created location (e.g. web/public/generated/), so create it before
    // spawning codex — otherwise generation fails before it starts.
    fs.mkdirSync(workspace, { recursive: true });

    const argv: readonly string[] = [
      "codex", "exec", "--ephemeral",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C", workspace, imagegenInstruction,
    ];

    const runResult = await runner.run(argv, timeoutMs, codexOutputRoot, runStartedAt);

    // Timeout is TERMINAL. codex was SIGKILLed mid-run and may have left a
    // partial file in the workspace — a truncated image can still have a non-zero
    // size and a valid extension. Return before the workspace scan so a partial
    // write can never be reported as "generated" (preserves the pre-fix contract
    // that a timed-out run always yields needs_regeneration).
    if (!runResult.ok && runResult.timedOut) {
      if (runResult.killCalled !== undefined) runResult.killCalled();
      return { id: request.id, provider: "codex_builtin_imagegen", status: "needs_regeneration",
        message: `codex runner failed: ${runResult.reason}` };
    }

    // PRIMARY (real-CLI behavior): codex (≥0.141, exec mode) writes the $imagegen
    // output into the -C workspace at the instructed filename — i.e. directly into
    // the repo at (or beside) absOutputPath — NOT to ~/.codex/generated_images/.
    // So look in the workspace first. Any hit here is already repo-bounded (the
    // workspace is dirname(absOutputPath), which resolveWithinRepo guarded), so no
    // allowed-root check is required, and no copy is needed when it is already at
    // the destination. This is checked even when the runner reports a non-timeout
    // failure, because the runner's generated_images harvest returns ok:false
    // ("no image found") in exactly this case despite codex having succeeded.
    //
    // Prefer the EXACT instructed destination (codex saved as <basename>) over a
    // directory scan: this avoids a concurrent-generate mtime race when two calls
    // share a parent dir, and only falls back to the newest workspace image when
    // codex chose a different filename.
    const workspaceHit = freshFileAt(absOutputPath, runStartedAt)
      ? absOutputPath
      : findNewestImageInDir(workspace, runStartedAt);
    if (workspaceHit !== undefined) {
      const invalid = validateRepoBoundImage(workspaceHit);
      if (invalid !== undefined) {
        return { id: request.id, provider: "codex_builtin_imagegen", status: "needs_regeneration",
          message: invalid };
      }
      if (path.resolve(workspaceHit) !== path.resolve(absOutputPath)) {
        fs.mkdirSync(path.dirname(absOutputPath), { recursive: true });
        fs.copyFileSync(workspaceHit, absOutputPath);
      }
      return { id: request.id, provider: "codex_builtin_imagegen", status: "generated",
        outputAbsPath: absOutputPath };
    }

    // FALLBACK: codex wrote to its own generated_images root (older/other configs).
    if (!runResult.ok) {
      return { id: request.id, provider: "codex_builtin_imagegen", status: "needs_regeneration",
        message: `codex runner failed: ${runResult.reason}` };
    }

    const imagePath = runResult.imagePath;

    if (!fs.existsSync(imagePath)) {
      return { id: request.id, provider: "codex_builtin_imagegen", status: "needs_regeneration",
        message: `codex produced image path "${imagePath}" does not exist on disk.` };
    }

    try { assertImagePathInAllowedRoot(imagePath, codexOutputRoot); }
    catch (err) {
      return { id: request.id, provider: "codex_builtin_imagegen", status: "needs_regeneration",
        message: err instanceof Error ? err.message : String(err) };
    }

    const stat = fs.statSync(imagePath);
    if (stat.size === 0) {
      return { id: request.id, provider: "codex_builtin_imagegen", status: "needs_regeneration",
        message: `codex produced an empty file at "${imagePath}" (0 bytes).` };
    }

    const ext = path.extname(imagePath).toLowerCase();
    if (!VALID_IMAGE_EXTENSIONS.has(ext)) {
      return { id: request.id, provider: "codex_builtin_imagegen", status: "needs_regeneration",
        message: `codex output "${imagePath}" has unrecognised extension "${ext}". ` +
          `Expected one of: ${[...VALID_IMAGE_EXTENSIONS].join(", ")}.` };
    }

    fs.mkdirSync(path.dirname(absOutputPath), { recursive: true });
    fs.copyFileSync(imagePath, absOutputPath);
    return { id: request.id, provider: "codex_builtin_imagegen", status: "generated", outputAbsPath: absOutputPath };
  }
}

// ---------------------------------------------------------------------------
// CC-9: sanitizeErrorMessage — strips credential/header fragments (P5-S5)
// ---------------------------------------------------------------------------

/**
 * Strips any fragment resembling an Authorization header value or API key from `msg`.
 * Called on every error message before it reaches AssetGenerationResult or the manifest.
 * (CC-9)
 *
 * KNOWN LIMITATION: this matches plain `Authorization: Bearer <tok>`, `Bearer <tok>`,
 * `sk-...` keys, and long base64-ish runs. It does NOT decode percent/URL-encoded
 * credentials (e.g. a `https://user:sk-...@host` style userinfo that got URL-encoded).
 * The primary containment is that the key is NEVER placed into a message in the first
 * place (CC-8 — only HTTP status + asset id are recorded); this sanitizer is the
 * defence-in-depth backstop, and `globalThis.fetch` does not emit encoded-credential
 * errors. If a future code path could surface encoded credentials, extend this.
 */
export function sanitizeErrorMessage(msg: string): string {
  let s = msg.replace(/authorization\s*:\s*bearer\s+\S+/gi, "[REDACTED]");
  s = s.replace(/bearer\s+\S{8,}/gi, "[REDACTED]");
  s = s.replace(/sk-[A-Za-z0-9\-_]{20,}/g, "[REDACTED]");
  s = s.replace(/[A-Za-z0-9+/=_-]{32,}/g, "[REDACTED]");
  return s;
}

// ---------------------------------------------------------------------------
// OpenAiApiImagegenProvider (P5-S5)
// ---------------------------------------------------------------------------

const DEFAULT_API_TIMEOUT_MS = 60_000;

/**
 * OpenAI REST API image-generation provider (gpt-image-1). Opt-in, disabled by default.
 *
 * CC-8: Authorization header value never logged/serialized/in-message. On failure: HTTP status + asset id only.
 * CC-9: All error messages pass through sanitizeErrorMessage().
 * CC-10: SpendCapBucket debited BEFORE network call.
 * CC-DEC-2: Key read via SecretManager.get("forge.openai_api_key").reveal() inside generate().
 */
export class OpenAiApiImagegenProvider implements AssetProvider {
  readonly #bucket: SpendCapBucket;
  readonly #timeoutMs: number;

  constructor(bucket: SpendCapBucket, timeoutMs: number = DEFAULT_API_TIMEOUT_MS) {
    this.#bucket = bucket;
    this.#timeoutMs = timeoutMs;
  }

  async generate(request: AssetRequest, deps: ProviderDeps): Promise<AssetGenerationResult> {
    // 1. Guard output path BEFORE any I/O or network call.
    let absOutputPath: string;
    try {
      absOutputPath = resolveWithinRepo(request.outputPath, { repoRoot: deps.repoRoot });
    } catch (err) {
      return { id: request.id, provider: "openai_api_later_optional", status: "rejected",
        message: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)) };
    }

    // 2. Atomically reserve budget BEFORE the network call (CC-10). tryDebit is a single
    //    check-and-decrement so concurrent generate() calls cannot both spend the last unit.
    if (!this.#bucket.tryDebit()) {
      return { id: request.id, provider: "openai_api_later_optional", status: "needs_regeneration",
        message: `cap_exceeded: spend cap exhausted (asset ${request.id})` };
    }

    // 3. Read key via secret-manager at point-of-use (CC-DEC-2). Never stored in deps.
    const secretManager = deps.secretManager;
    if (secretManager === undefined) {
      return { id: request.id, provider: "openai_api_later_optional", status: "needs_regeneration",
        message: `no_key: SecretManager not available for asset ${request.id}` };
    }

    let rawKey: string;
    try {
      // Pass the ref as a plain string — ForgeSecretManager.get() accepts string.
      // The ref "forge.openai_api_key" is the canonical name (matches SecretRef allowlist).
      const secretValue = await secretManager.get("forge.openai_api_key");
      if (secretValue === undefined) {
        return { id: request.id, provider: "openai_api_later_optional", status: "needs_regeneration",
          message: `no_key: forge.openai_api_key not in secret-manager (asset ${request.id})` };
      }
      rawKey = secretValue.reveal(); // reveal at point-of-use; not stored beyond this block
    } catch (err) {
      return { id: request.id, provider: "openai_api_later_optional", status: "needs_regeneration",
        message: sanitizeErrorMessage(
          `key-read error for asset ${request.id}: ` + (err instanceof Error ? err.message : String(err))) };
    }

    // 4. Call the API (built-in fetch + AbortController). rawKey used ONLY for Authorization header.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let responseStatus: number | undefined;

    try {
      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        signal: controller.signal,
        headers: {
          // CC-8: rawKey used here only; never logged, spread, or put in any message/error.
          "Authorization": `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt: request.prompt,
          n: 1,
          size: mapPreferredSize(request.preferredSize ?? "wide"),
          response_format: "b64_json",
        }),
      });

      responseStatus = response.status;

      if (!response.ok) {
        // CC-8: report only HTTP status + asset id; never the key.
        return { id: request.id, provider: "openai_api_later_optional", status: "needs_regeneration",
          message: `API error HTTP ${responseStatus} for asset ${request.id}` };
      }

      const json = await response.json() as unknown;
      const b64 = extractB64Json(json);
      if (b64 === undefined) {
        return { id: request.id, provider: "openai_api_later_optional", status: "needs_regeneration",
          message: `API response missing b64_json data for asset ${request.id}` };
      }

      const imageBytes = Buffer.from(b64, "base64");
      if (imageBytes.byteLength === 0) {
        return { id: request.id, provider: "openai_api_later_optional", status: "needs_regeneration",
          message: `API returned empty image body for asset ${request.id}` };
      }

      const ext = path.extname(absOutputPath).toLowerCase();
      if (!VALID_IMAGE_EXTENSIONS.has(ext)) {
        return { id: request.id, provider: "openai_api_later_optional", status: "needs_regeneration",
          message: `Output path "${absOutputPath}" has unrecognised extension "${ext}".` };
      }

      fs.mkdirSync(path.dirname(absOutputPath), { recursive: true });
      fs.writeFileSync(absOutputPath, imageBytes);

      return { id: request.id, provider: "openai_api_later_optional", status: "generated",
        outputAbsPath: absOutputPath };

    } catch (fetchErr) {
      if (controller.signal.aborted) {
        return { id: request.id, provider: "openai_api_later_optional", status: "needs_regeneration",
          message: sanitizeErrorMessage(`API timeout after ${this.#timeoutMs}ms for asset ${request.id}`) };
      }
      return { id: request.id, provider: "openai_api_later_optional", status: "needs_regeneration",
        // CC-9: sanitize — fetch error must not carry Authorization header fragments
        message: sanitizeErrorMessage(
          `API fetch error for asset ${request.id}: ` +
            (fetchErr instanceof Error ? fetchErr.message : String(fetchErr))) };
    } finally {
      clearTimeout(timer);
      // CC-8: rawKey is no longer referenced after this point. GC will collect it.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers for OpenAiApiImagegenProvider
// ---------------------------------------------------------------------------

function mapPreferredSize(preferredSize: string): string {
  switch (preferredSize) {
    case "square": return "1024x1024";
    case "portrait": return "1024x1792";
    case "landscape": case "wide": return "1792x1024";
    default: return "1024x1024";
  }
}

function extractB64Json(json: unknown): string | undefined {
  if (json === null || typeof json !== "object" || !("data" in json)) return undefined;
  const data = (json as { data: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = data[0];
  if (first === null || typeof first !== "object" || !("b64_json" in first)) return undefined;
  const b64 = (first as { b64_json: unknown }).b64_json;
  if (typeof b64 !== "string" || b64.length === 0) return undefined;
  return b64;
}

// ---------------------------------------------------------------------------
// selectAssetProvider — provider selection
// ---------------------------------------------------------------------------

/** A function that checks whether codex is available on this machine. */
export type CodexAvailabilityCheck = () => boolean;

function defaultCodexAvailability(): boolean {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const codexHome = process.env["CODEX_HOME"] ?? path.join(home, ".codex");
  const authCandidates = [
    path.join(codexHome, "auth.json"),
    path.join(codexHome, "config.json"),
    path.join(codexHome, ".credentials"),
  ];
  return authCandidates.some((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

// ---------------------------------------------------------------------------
// SelectionReason — structured reason for every selectAssetProviderWithReason result
// ---------------------------------------------------------------------------

/**
 * Structured reason for each selectAssetProviderWithReason outcome (CC-11).
 *
 * explicit_manual      — request.provider === "manual_upload"
 * explicit_placeholder — request.provider === "placeholder_svg"
 * codex_available      — codex login present and not CI (codex provider selected)
 * api_available        — openai_api_later_optional enabled + key + budget (API provider selected)
 * ci                   — env.CI === "true" (codex or openai_api_later_optional)
 * no_login             — codex availability check returned false
 * provider_disabled    — ARCHON_FORGE_API_PROVIDER_ENABLED !== "true" (openai)
 * no_key               — key not in secret-manager (openai)
 * no_spend_cap         — cap absent/zero/invalid/negative (openai, CC-10)
 * cap_exceeded         — run-level bucket exhausted (openai, CC-10)
 */
export type SelectionReason =
  | "explicit_manual"
  | "explicit_placeholder"
  | "codex_available"
  | "api_available"
  | "ci"
  | "no_login"
  | "provider_disabled"
  | "no_key"
  | "no_spend_cap"
  | "cap_exceeded";

/** Result of selectAssetProviderWithReason. */
export interface SelectionResult {
  readonly provider: AssetProvider;
  readonly reason: SelectionReason;
}

// ---------------------------------------------------------------------------
// selectAssetProviderWithReason (CC-11/12/C-DEC-1) — ADDITIVE
// ---------------------------------------------------------------------------

/**
 * Extended deps for selectAssetProviderWithReason: injectable overrides for testing.
 * Not part of the core ProviderDeps interface (additive; existing callers unaffected).
 *
 * spendCapBucket — pre-built bucket (bypasses the process-level singleton in tests).
 * secretManager  — for future async selection path; not used in synchronous selection.
 * keyAvailable   — pre-resolved boolean from an async secret-manager look-up.
 *                  When false and provider === "openai_api_later_optional", selection
 *                  returns { reason: "no_key" }. Defaults to true (unknown = optimistic;
 *                  the provider's generate() will catch a missing key at call time).
 *                  Tests inject false to assert the no_key selection path.
 */
export interface SelectionDeps {
  readonly spendCapBucket?: SpendCapBucket | undefined;
  readonly secretManager?: ForgeSecretManager | undefined;
  readonly keyAvailable?: boolean | undefined;
}

/**
 * Select the AssetProvider for a request with a structured reason (CC-11, C-DEC-1).
 *
 * For openai_api_later_optional, evaluates in order:
 *   CI=true → placeholder (ci)
 *   ARCHON_FORGE_API_PROVIDER_ENABLED !== "true" → placeholder (provider_disabled)
 *   no key in secret-manager (sync check not possible; checked synchronously via capString)
 *   cap absent/zero/invalid → placeholder (no_spend_cap)
 *   cap exhausted → placeholder (cap_exceeded)
 *   else → OpenAiApiImagegenProvider
 *
 * The existing codex paths are also attributed:
 *   manual_upload → explicit_manual
 *   placeholder_svg → explicit_placeholder
 *   codex + CI=true → ci (placeholder)
 *   codex + no login → no_login (placeholder)
 *   codex + login → codex_available
 *
 * @param request            The AssetRequest.
 * @param env                Environment variables (default: process.env).
 * @param availabilityCheck  Codex login check (injectable for tests).
 * @param selectionDeps      Optional bucket + secretManager overrides for tests.
 */
export function selectAssetProviderWithReason(
  request: AssetRequest,
  env: Partial<Record<string, string>> = process.env,
  availabilityCheck: CodexAvailabilityCheck = defaultCodexAvailability,
  selectionDeps: SelectionDeps = {},
): SelectionResult {
  // Existing explicit providers — unchanged behaviour.
  if (request.provider === "manual_upload") {
    return { provider: new ManualUploadProvider(), reason: "explicit_manual" };
  }
  if (request.provider === "placeholder_svg") {
    return { provider: new PlaceholderSvgProvider(), reason: "explicit_placeholder" };
  }

  // codex_builtin_imagegen — existing gating logic, now attributed.
  if (request.provider === "codex_builtin_imagegen") {
    if (env["CI"] === "true") {
      return { provider: new PlaceholderSvgProvider(), reason: "ci" };
    }
    if (!availabilityCheck()) {
      return { provider: new PlaceholderSvgProvider(), reason: "no_login" };
    }
    return { provider: new CodexBuiltinImagegenProvider(), reason: "codex_available" };
  }

  // openai_api_later_optional — two-layer disable + spend cap (CC-11/12/C-DEC-1/CC-10).
  if (request.provider === "openai_api_later_optional") {
    // Layer 1: CI gate — placeholder always (CC-12).
    if (env["CI"] === "true") {
      return { provider: new PlaceholderSvgProvider(), reason: "ci" };
    }
    // Layer 1: explicit opt-in (C-DEC-1).
    if (env["ARCHON_FORGE_API_PROVIDER_ENABLED"] !== "true") {
      return { provider: new PlaceholderSvgProvider(), reason: "provider_disabled" };
    }
    // Layer 2: key presence check. The selection function is synchronous; callers
    // that need the selection-level no_key reason must pre-resolve key availability
    // and pass it as selectionDeps.keyAvailable. When false → placeholder (no_key).
    // When undefined (unknown) the selection is optimistic; the provider generate()
    // will return no_key at call time if the key is actually absent.
    if (selectionDeps.keyAvailable === false) {
      return { provider: new PlaceholderSvgProvider(), reason: "no_key" };
    }
    // Layer 2: spend cap (CC-10 — deny-by-default).
    const capString = env["ARCHON_FORGE_API_SPEND_CAP"];
    const bucket = selectionDeps.spendCapBucket ?? getRunBucket(capString);

    if (!bucket.isConfigured) {
      return { provider: new PlaceholderSvgProvider(), reason: "no_spend_cap" };
    }
    if (!bucket.hasRemaining) {
      return { provider: new PlaceholderSvgProvider(), reason: "cap_exceeded" };
    }

    return { provider: new OpenAiApiImagegenProvider(bucket), reason: "api_available" };
  }

  // Fallback for any future unhandled provider value: placeholder.
  return { provider: new PlaceholderSvgProvider(), reason: "explicit_placeholder" };
}

// ---------------------------------------------------------------------------
// selectAssetProvider — existing API; now delegates to selectAssetProviderWithReason
// ---------------------------------------------------------------------------

/**
 * Select the appropriate AssetProvider for the given request and environment.
 *
 * Delegates to selectAssetProviderWithReason and returns only the provider.
 * Existing callers are unaffected (same signature, same behaviour).
 *
 * @param request           The AssetRequest being processed.
 * @param env               Environment variables. Defaults to `process.env`.
 * @param availabilityCheck Optional override for the codex login check.
 */
export function selectAssetProvider(
  request: AssetRequest,
  env: Partial<Record<string, string>> = process.env,
  availabilityCheck: CodexAvailabilityCheck = defaultCodexAvailability,
): AssetProvider {
  return selectAssetProviderWithReason(request, env, availabilityCheck).provider;
}
