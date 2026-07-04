// Resolves the package's own version at runtime so servers never advertise a
// stale hardcoded string (v0.2.0 shipped MCP servers reporting "0.1.0").
//
// The relative path works identically for both execution forms:
//   src/shared/package-version.ts  → ../../package.json (repo root)
//   dist/shared/package-version.js → ../../package.json (package root)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0";

/**
 * Read the version field from this package's package.json.
 * Fail-soft: returns "0.0.0" if the file is missing or malformed — a wrong
 * version string must never prevent a server from starting.
 */
export function getPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
    return FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}
