/**
 * @module secrets/secret-store-factory
 *
 * Factory that creates the production SecretManager wired to the runtime
 * data root (P5-S4, Decision B.3).
 *
 * ## Responsibilities
 *   - Resolve `<dataRoot>/secrets/` via `resolveRuntimeEnvironmentConfig` — never
 *     a hardcoded path.
 *   - Read the backend selector from `ARCHON_SECRETS_BACKEND` (default:
 *     `encrypted_file`).  An unknown value throws a clear error.
 *   - Return an `EncryptedFileSecretManager` for that directory with the
 *     default env master-key provider.
 *
 * ## Injectable for tests
 *   `createSecretManager` accepts an optional `deps` parameter so unit tests can
 *   inject a sandboxed env + override the secrets directory without touching real
 *   FS or real env.
 */

import path from "node:path";
import { resolveRuntimeEnvironmentConfig } from "../runtime/config.ts";
import {
  EncryptedFileSecretManager,
  makeEnvMasterKeyProvider,
} from "./encrypted-file-backend.ts";
import type { SecretManager } from "./secret-manager.ts";

// ---------------------------------------------------------------------------
// Supported backend selectors
// ---------------------------------------------------------------------------

/** The only implemented backend selector at this revision. */
const BACKEND_ENCRYPTED_FILE = "encrypted_file";

/**
 * Dependencies injectable for testing.
 *
 * All fields are optional — omitting a field uses the real production default.
 */
export interface SecretManagerFactoryDeps {
  /**
   * Environment object to read backend selector and config from.
   * Defaults to `process.env`.
   */
  readonly env?: NodeJS.ProcessEnv;

  /**
   * Override the secrets directory instead of deriving it from the data root.
   * Useful in tests that already have a temp dir and want to skip config resolution.
   */
  readonly secretsDirOverride?: string;

  /**
   * Current working directory passed to `resolveRuntimeEnvironmentConfig`.
   * Defaults to `process.cwd()`.
   */
  readonly cwd?: string;

  /**
   * Project slug passed to `resolveRuntimeEnvironmentConfig`.
   * Defaults to `"archon"`.
   */
  readonly projectSlug?: string;
}

/**
 * Creates the production `SecretManager` wired to the runtime data root.
 *
 * Resolution order:
 *   1. If `deps.secretsDirOverride` is set, use it directly (test shortcut).
 *   2. Otherwise call `resolveRuntimeEnvironmentConfig` with `deps.env` and
 *      `deps.cwd` / `deps.projectSlug` to get `dataRoot`, then append `secrets/`.
 *
 * Backend selector:
 *   Reads `ARCHON_SECRETS_BACKEND` from `deps.env` (or `process.env`).
 *   Default: `"encrypted_file"`.
 *   Unknown value: throws with a descriptive message (Decision B.3).
 *
 * @throws If `ARCHON_SECRETS_BACKEND` is set to an unknown value.
 */
export function createSecretManager(deps?: SecretManagerFactoryDeps): SecretManager {
  const env: NodeJS.ProcessEnv = deps?.env ?? process.env;

  // --- Backend selector (B.3) ---
  const backendSelector = env["ARCHON_SECRETS_BACKEND"]?.trim() || BACKEND_ENCRYPTED_FILE;

  if (backendSelector !== BACKEND_ENCRYPTED_FILE) {
    throw new Error(
      `Unknown secret backend selector: "${backendSelector}". ` +
        `Supported values: "${BACKEND_ENCRYPTED_FILE}". ` +
        "Check the ARCHON_SECRETS_BACKEND environment variable.",
    );
  }

  // --- Secrets directory (B.3 / dataRoot wiring) ---
  const secretsDir = resolveSecretsDir(env, deps);

  // --- Master-key provider (CC-4) ---
  // Uses the sandbox env so tests never touch real process.env.
  const keyProvider = makeEnvMasterKeyProvider(env);

  return new EncryptedFileSecretManager(secretsDir, keyProvider, "cli");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the absolute path to the secrets directory.
 *
 * If `deps.secretsDirOverride` is set, that path is used as-is.
 * Otherwise `resolveRuntimeEnvironmentConfig` is called to determine the
 * runtime data root, and `secrets/` is appended.
 */
function resolveSecretsDir(env: NodeJS.ProcessEnv, deps: SecretManagerFactoryDeps | undefined): string {
  if (deps?.secretsDirOverride !== undefined) {
    return deps.secretsDirOverride;
  }

  const projectSlug = deps?.projectSlug ?? "archon";
  const cwd = deps?.cwd;

  const config = resolveRuntimeEnvironmentConfig(env, { projectSlug, cwd });
  return path.join(config.dataRoot, "secrets");
}
