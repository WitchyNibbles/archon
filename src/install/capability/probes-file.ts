/**
 * L0 (FILES) capability probes.
 *
 * L0 probes assert managed files are present and unmodified. They are the
 * cheapest probes: no external deps, no parsing — only content comparison.
 *
 * All probes take an injected ReadFileFn so they can be unit-tested with
 * a stub reader. Mirrors the DbQueryFn pattern in src/admin/db-preflight.ts.
 *
 * Probes are pure — no side effects beyond calling readFn.
 */
import type { ProbeResult } from "./types.ts";

/**
 * Injectable file reader.
 * Returns the file content as a UTF-8 string, or undefined if the file does
 * not exist. Throws only on unexpected I/O errors.
 *
 * Callers supply a real fs.readFile wrapper or a test stub.
 */
export type ReadFileFn = (absolutePath: string) => Promise<string | undefined>;

/** Input for a single managed-file L0 probe. */
export interface ManagedFileProbeInput {
  /** Capability name from the registry (e.g. 'mcp-archon'). */
  readonly capability: string;
  /** Short code prefix used to build the result code (e.g. 'managed-file'). */
  readonly code: string;
  /** Relative path for display in detail/remediation messages. */
  readonly relativePath: string;
  /** Absolute path passed to readFn. */
  readonly absolutePath: string;
  /** Expected file content; compared byte-for-byte to the actual content. */
  readonly desiredContent: string;
}

/**
 * L0 probe: asserts a managed file exists and matches its expected content.
 *
 * Returns:
 *   ok       — file present and content matches
 *   blocked  — file missing, unreadable, or content differs
 *
 * `skipped` and `degraded` are never returned — L0 file probes either pass or fail.
 * Severity (whether blocked blocks the report) is decided in report.ts, not here.
 */
export async function probeManagedFile(
  readFn: ReadFileFn,
  input: ManagedFileProbeInput
): Promise<ProbeResult> {
  let actual: string | undefined;
  try {
    actual = await readFn(input.absolutePath);
  } catch {
    return {
      capability: input.capability,
      layer: "L0",
      status: "blocked",
      code: `${input.code}-read-error`,
      detail: `Failed to read managed file: ${input.relativePath}`,
      remediation: "Run 'archon upgrade --apply' to restore managed files.",
    };
  }

  if (actual === undefined) {
    return {
      capability: input.capability,
      layer: "L0",
      status: "blocked",
      code: `${input.code}-missing`,
      detail: `Managed file is missing: ${input.relativePath}`,
      remediation: "Run 'archon upgrade --apply' to restore managed files.",
    };
  }

  if (actual !== input.desiredContent) {
    return {
      capability: input.capability,
      layer: "L0",
      status: "blocked",
      code: `${input.code}-modified`,
      detail: `Managed file has drifted from expected content: ${input.relativePath}`,
      remediation: "Run 'archon upgrade --apply' to restore managed files.",
    };
  }

  return {
    capability: input.capability,
    layer: "L0",
    status: "ok",
    code: `${input.code}-ok`,
    detail: `Managed file present and unmodified: ${input.relativePath}`,
    remediation: "",
  };
}
