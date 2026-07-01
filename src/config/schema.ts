/**
 * Zod schema for all ARCHON_* environment variables.
 *
 * All fields are OPTIONAL at the schema level — absence is never rejected here.
 * Presence requirements for specific commands are enforced via the `required`
 * option passed to validateArchonConfig, not in this schema.
 *
 * When a field IS present, its value is validated for correct format/shape.
 * Empty strings are normalised to undefined so that .default() chains work
 * correctly for env vars that may be explicitly set to an empty string.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Internal normalisation helpers
// ---------------------------------------------------------------------------

/** Normalise empty / whitespace-only strings to undefined. */
function ne(v: unknown): unknown {
  return typeof v === "string" && v.trim() === "" ? undefined : v;
}

/** Optional string — undefined when absent or set to empty string. */
const optStr = (): z.ZodType<string | undefined> =>
  z.preprocess(ne, z.string().optional()) as z.ZodType<string | undefined>;

/** String with a default — never undefined in the parsed output. */
const defStr = (d: string): z.ZodType<string> =>
  z.preprocess(ne, z.string().default(d)) as z.ZodType<string>;

/**
 * Coerce a raw env-var string to a number, then validate with `constraints`.
 * Non-numeric strings produce a clear parse error.
 * Empty strings and undefined are treated as "not set."
 */
function coerceEnvNum(raw: unknown): unknown {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return undefined;
  }
  const n = Number(typeof raw === "string" ? raw.trim() : raw);
  // Return NaN as-is so the downstream z.number() produces a readable error.
  return n;
}

/** Optional integer with numeric constraints. */
const optInt = (constraints: z.ZodNumber): z.ZodType<number | undefined> =>
  z.preprocess(coerceEnvNum, constraints.optional()) as z.ZodType<number | undefined>;

/** Integer with numeric constraints and a fallback default. */
const defInt = (d: number, constraints: z.ZodNumber): z.ZodType<number> =>
  z.preprocess(coerceEnvNum, constraints.optional().default(d)) as z.ZodType<number>;

// ---------------------------------------------------------------------------
// Full schema
// ---------------------------------------------------------------------------

/**
 * Canonical schema for the ARCHON_* environment surface.
 *
 * Sections match the .env.example layout:
 *   1. Required core  (DB, project identity)
 *   2. Database convenience  (docker-compose only)
 *   3. Runtime & mode
 *   4. Context / agentic loop
 *   5. Ports
 *   6. Embedding
 *   7. Review identity
 *   8. Grafana  (optional observability)
 *   9. Forge / secrets
 *  10. Advanced / internal
 */
export const archonConfigSchema = z.object({
  // -------------------------------------------------------------------------
  // 1. REQUIRED CORE
  //    Set these for a DB-backed archon runtime.  Absent or empty → local-only
  //    mode (no Postgres-backed workflow proof available).
  // -------------------------------------------------------------------------

  /**
   * PostgreSQL connection string for archon's state store.
   * Must start with postgresql:// or postgres://.
   * Omit (or comment out) to run in local-only mode.
   */
  ARCHON_CORE_DATABASE_URL: z.preprocess(
    ne,
    z
      .string()
      .refine(
        (v) => {
          try {
            const proto = new URL(v).protocol.replace(/:$/, "");
            return proto === "postgres" || proto === "postgresql";
          } catch {
            return false;
          }
        },
        { message: "must be a valid postgresql:// or postgres:// connection URL" }
      )
      .optional()
  ) as z.ZodType<string | undefined>,

  /**
   * Workspace identifier (used to scope projects).
   * Default: default.
   */
  ARCHON_WORKSPACE_SLUG: defStr("default"),

  /** Workspace display name. */
  ARCHON_WORKSPACE_NAME: optStr(),

  /**
   * Project identifier within the workspace.
   * Required by most project-scoped commands (status, daemon, loop, etc.).
   */
  ARCHON_PROJECT_SLUG: optStr(),

  /** Project display name. */
  ARCHON_PROJECT_NAME: optStr(),

  /** Absolute path to the project repository root (used by retrieval commands). */
  ARCHON_PROJECT_REPO_PATH: optStr(),

  // -------------------------------------------------------------------------
  // 2. DATABASE CONVENIENCE
  //    Used only by docker-compose and the setup script to build
  //    ARCHON_CORE_DATABASE_URL.  Not consumed by the runtime directly.
  // -------------------------------------------------------------------------

  ARCHON_POSTGRES_DB: optStr(),
  ARCHON_POSTGRES_USER: optStr(),
  ARCHON_POSTGRES_PASSWORD: optStr(),
  ARCHON_POSTGRES_PORT: optInt(z.number().int().min(1).max(65535)),
  ARCHON_DOCKER_CONTAINER_NAME: optStr(),

  // -------------------------------------------------------------------------
  // 3. RUNTIME & MODE
  // -------------------------------------------------------------------------

  /**
   * Runtime execution mode.
   * auto (default) — derive from ARCHON_RUNTIME_PROFILE.
   * docker | native | managed — explicit override.
   */
  ARCHON_RUNTIME_MODE: z.preprocess(
    ne,
    z.enum(["auto", "docker", "native", "managed"]).default("auto")
  ),

  /**
   * Runtime profile (e.g. local-docker, local-native, managed).
   * Used when ARCHON_RUNTIME_MODE=auto. Default: local-docker.
   */
  ARCHON_RUNTIME_PROFILE: defStr("local-docker"),

  /**
   * Override the runtime data root (absolute path).
   * Default: platform-specific user data directory.
   * Linux: ~/.local/share/archon/<project-slug>
   */
  ARCHON_RUNTIME_DATA_ROOT: optStr(),

  /**
   * Fallback data root for prune/sweep output files.
   * Default: current working directory at command time.
   */
  ARCHON_DATA_ROOT: optStr(),

  /** Path to the install manifest JSON. Default: <cwd>/.archon/install-manifest.json. */
  ARCHON_INSTALL_MANIFEST_PATH: optStr(),

  // -------------------------------------------------------------------------
  // 4. CONTEXT / AGENTIC LOOP
  // -------------------------------------------------------------------------

  /**
   * Context-window warning threshold (0–100 %).
   * The daemon logs a warning when usage reaches this level. Default: 60.
   */
  ARCHON_CONTEXT_WARNING_PCT: defInt(60, z.number().int().min(0).max(100)),

  /**
   * Context-window handoff threshold (0–100 %).
   * The daemon transitions to handoff_required at this level. Default: 70.
   */
  ARCHON_CONTEXT_HANDOFF_PCT: defInt(70, z.number().int().min(0).max(100)),

  /**
   * Context-window hard-stop threshold (0–100 %).
   * The daemon triggers an immediate reset at this level. Default: 80.
   */
  ARCHON_CONTEXT_HARD_STOP_PCT: defInt(80, z.number().int().min(0).max(100)),

  /**
   * Context monitor mode.
   * enforce (default) — apply state transitions; auto-respawn on handoff/hard-stop.
   * observe — kill switch: suppress daemon auto-respawn; sample without resetting.
   */
  ARCHON_CONTEXT_MONITOR: z.preprocess(
    ne,
    z.enum(["enforce", "observe"]).default("enforce")
  ),

  /**
   * Maximum daemon respawns per task (integer 1–50).
   * Caps the auto-respawn loop when ARCHON_CONTEXT_MONITOR=enforce. Default: 8.
   */
  ARCHON_MAX_RESPAWNS_PER_TASK: defInt(8, z.number().int().min(1).max(50)),

  /**
   * Override the model context window size in tokens.
   * Default: model-reported value.
   */
  ARCHON_MODEL_CONTEXT_TOKENS: optInt(z.number().int().positive()),

  // -------------------------------------------------------------------------
  // 5. PORTS
  // -------------------------------------------------------------------------

  /** MCP server listening port. Default: 3000. */
  ARCHON_MCP_PORT: defInt(3000, z.number().int().min(1).max(65535)),

  /** UI / dashboard server listening port. Default: 3001. */
  ARCHON_UI_PORT: defInt(3001, z.number().int().min(1).max(65535)),

  // -------------------------------------------------------------------------
  // 6. EMBEDDING
  // -------------------------------------------------------------------------

  /**
   * Embedding model identifier.
   * Default: archon-local-hash-1536 (local deterministic hash).
   */
  ARCHON_EMBEDDING_MODEL: defStr("archon-local-hash-1536"),

  /** Custom embedding provider module (absolute or relative path). */
  ARCHON_EMBEDDING_PROVIDER_MODULE: optStr(),

  /** Max records per embedding job batch. Default: unlimited. */
  ARCHON_EMBEDDING_JOB_LIMIT: optInt(z.number().int().positive()),

  // -------------------------------------------------------------------------
  // 7. REVIEW IDENTITY
  // -------------------------------------------------------------------------

  /** Path to review-identity bindings JSON file. */
  ARCHON_REVIEW_IDENTITY_BINDINGS: optStr(),

  /** Path to review-identity fixture JSON file (for testing). */
  ARCHON_REVIEW_IDENTITY_FIXTURES: optStr(),

  /** Path to the project-local review-identity adapter module. */
  ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE: optStr(),

  /** Review-identity backend selector. */
  ARCHON_REVIEW_IDENTITY_BACKEND: optStr(),

  // -------------------------------------------------------------------------
  // 8. GRAFANA (optional observability integration)
  // -------------------------------------------------------------------------

  /** Grafana instance base URL (e.g. https://grafana.example.com). Must be https:// or http://. */
  ARCHON_GRAFANA_URL: z.preprocess(
    ne,
    z.string().url().optional()
  ) as z.ZodType<string | undefined>,

  /** Grafana service-account token. */
  ARCHON_GRAFANA_TOKEN: optStr(),

  /** Grafana username (basic auth). */
  ARCHON_GRAFANA_USERNAME: optStr(),

  /** Grafana password (basic auth). Never commit this. */
  ARCHON_GRAFANA_PASSWORD: optStr(),

  /** Grafana organisation ID. */
  ARCHON_GRAFANA_ORG_ID: optStr(),

  /** Loki / logs datasource UID. */
  ARCHON_GRAFANA_LOGS_DATASOURCE_UID: optStr(),

  /** Loki tenant ID (X-Scope-OrgID header). */
  ARCHON_GRAFANA_LOKI_TENANT_ID: optStr(),

  /** Request timeout for Grafana API calls (ms). Default: 15000. */
  ARCHON_GRAFANA_TIMEOUT_MS: defInt(15000, z.number().int().positive()),

  // -------------------------------------------------------------------------
  // 9. FORGE / SECRETS
  // -------------------------------------------------------------------------

  /**
   * Secret-manager backend selector.
   * Accepted values: encrypted_file (the only implemented backend). Default: encrypted_file.
   */
  ARCHON_SECRETS_BACKEND: z.preprocess(
    ne,
    z.enum(["encrypted_file"]).default("encrypted_file")
  ),

  /**
   * Master key for the encrypted secret store.
   * Must be exactly 64 hexadecimal characters (32 bytes).
   * Generate one: openssl rand -hex 32
   * NEVER store this in a tracked file or commit it to version control.
   */
  ARCHON_SECRETS_MASTER_KEY: z.preprocess(
    ne,
    z
      .string()
      .refine(
        (v) => /^[0-9a-fA-F]{64}$/.test(v),
        { message: "must be a 64-character hex string — generate with: openssl rand -hex 32" }
      )
      .optional()
  ) as z.ZodType<string | undefined>,

  /**
   * Enable the OpenAI image-generation provider for Forge.
   * Must be exactly "true" to activate.  All other values → disabled.
   */
  ARCHON_FORGE_API_PROVIDER_ENABLED: optStr(),

  /**
   * Run-level cap on image generations (positive integer).
   * Absent, zero, negative, or non-integer → all generation requests are denied.
   */
  ARCHON_FORGE_API_SPEND_CAP: optInt(z.number().int().positive()),

  // -------------------------------------------------------------------------
  // 10. ADVANCED / INTERNAL
  //     Usually set by daemon scripts or automation, not by operators directly.
  // -------------------------------------------------------------------------

  /** Subagent spawning gate. Default: enabled. */
  ARCHON_SUBAGENTS: z.preprocess(ne, z.enum(["enabled", "disabled"]).default("enabled")),

  /** Multi-agent debate gate. Default: enabled. */
  ARCHON_DEBATE_GATE: z.preprocess(ne, z.enum(["enabled", "disabled"]).default("enabled")),

  /**
   * Review-floor reduction.
   * Set to "1" or "true" to allow trivial tasks to close on a single reviewer
   * instead of the full trio (reviewer + qa_engineer + security_reviewer).
   * Default: off (require full trio).
   */
  ARCHON_REVIEW_FLOOR_REDUCTION: optStr(),

  ARCHON_CLAUDE_BIN: optStr(),
  ARCHON_CLAUDE_APP_AUTOMATION: optStr(),
  ARCHON_CLAUDE_APP_STANDALONE_AUTOMATION: optStr(),
  ARCHON_CLAUDE_APP_THREAD_AUTOMATION: optStr(),
  ARCHON_CLAUDE_CLI_SCHEDULER: optStr(),
  ARCHON_ALLOW_MANAGED_COMMITS: optStr(),
  ARCHON_AUTO_REFRESH_REPO_CONTEXT: optStr(),
  ARCHON_AUTO_REFRESH_RETRIEVAL: optStr(),
  ARCHON_RETRIEVAL_REFRESH_MODE: optStr(),
  ARCHON_SUPERVISOR_REVIEWER_ACTOR: optStr(),
  ARCHON_SUPERVISOR_QA_ENGINEER_ACTOR: optStr(),
  ARCHON_SUPERVISOR_SECURITY_REVIEWER_ACTOR: optStr(),
  ARCHON_SUPERVISOR_OPERATOR_NOTES: optStr(),
  ARCHON_DAEMON_SUPERVISOR_HISTORY_SCOPE: optStr(),
  ARCHON_SUPERVISOR_HISTORY_RETENTION: optStr(),
  ARCHON_REPO_MARKDOWN_ROOT: optStr(),
  ARCHON_REPO_MARKDOWN_INCLUDE: optStr(),
  ARCHON_REVIEW_INPUT_DIR: optStr(),
  ARCHON_OPERATOR_ACTION_DIR: optStr(),
  ARCHON_PLAYWRIGHT_INSTALL_DEPS: optStr(),
  ARCHON_PLAYWRIGHT_NPX_BIN: optStr(),
  ARCHON_OBSIDIAN_VAULT_PATH: optStr(),
  ARCHON_OBSIDIAN_TIMEZONE: optStr(),
  ARCHON_FORCE_CLI_ENTRYPOINT: optStr(),
});

/** Fully-parsed, type-safe archon configuration with defaults applied. */
export type ArchonConfig = z.output<typeof archonConfigSchema>;
