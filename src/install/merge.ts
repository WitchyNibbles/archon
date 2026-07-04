const CLAUDE_BEGIN = "<!-- BEGIN ARCHON MANAGED -->";
const CLAUDE_END = "<!-- END ARCHON MANAGED -->";
const DOT_CLAUDE_BEGIN = "<!-- BEGIN ARCHON KERNEL -->";
const DOT_CLAUDE_END = "<!-- END ARCHON KERNEL -->";
const workflowContractBlock = `<!-- archon-workflow-contract:start -->
workflow=archon
workflow_runtime=postgres
active_run_pointer=project_runtime_state.active_run_id
active_task_pointer=project_runtime_state.active_task_id
workflow_documents=workflow_documents
task_queue=project_runtime_state.task_queue
product_state=project_runtime_state.product_state
required_review_roles=reviewer,qa_engineer,security_reviewer
release_candidate_quality_gate=release_readiness_required
review_authority=runtime_orchestrated_only
workflow_check=npx archon workflow-proof --run-id latest --task-id <task-id>
workflow_check_scope=runtime_authority_only
review_artifact_trust=runtime_records_only
ci_scope=runtime_contract_and_export_regressions
local_live_check=bash scripts/check-archon-workflow-live.sh [--task-id <task-id>]
<!-- archon-workflow-contract:end -->`;

const managedClaudeMdBlock = `${CLAUDE_BEGIN}
## archon

- treat \`archon\` as implicitly invoked on every prompt unless the user explicitly opts out
- treat substantive requests as archon work unless the user opts out
- use \`archon-intake\` as the default first skill for substantive work

## Workflow contract

Canonical runtime contract:

${workflowContractBlock}

## Department Workflow

- root thread is engineering manager
- manager/root stays shallow: two inspections max before trivial handling or bounded investigation
- clarify ambiguous intent before planning with targeted questions or explicit assumptions
- on first ask, clarify outcome, constraints, and done criteria unless assumptions are enough
- require Design and Architecture Council review for substantive roadmap, governance, architecture-significant, or user-flow-heavy plan work unless the task is trivial or inherits an approved decision
- keep the council lean, rotating, and time-bounded with a named dissent owner
- inherited task packets must carry explicit workflow artifact refs; use \`review_exports=runtime_optional\` only when runtime authority covers the gate
- keep \`archon\` as the default workflow controller even when other tools are available
- when repo-local Grafana configuration is present, use Grafana logs as broader debugging and research evidence; if config is partial or unavailable, say so
- avoid strong negative claims from a narrow pass; gather broader evidence or test an alternate hypothesis first
- route evidence to \`solution_architect\`, then \`planner\`, then specialist owner
- use \`git_operator\` for staging, commit slicing, and commit-message prep when git work is required
- use runtime-backed archon commands for proof, status, and advancement
- substantive work completes only after \`reviewer\`, \`qa_engineer\`, and \`security_reviewer\` gates plus runtime workflow proof

## Autonomy Loop

- for full-project or multi-phase requests, \`archon\` must operate as a continuing delivery loop
- the manager must not stop after intake, planning, or one implementation slice unless product-level acceptance is complete, a real blocker needs user input, verification is blocked after repair attempts, or the user asked for planning only
- scale, latency, or item volume are not blockers by themselves when the work can be chunked, checkpointed, and resumed
- do not wait for the user to say continue between internal tasks; keep executing until the product-level stop condition is met
- long-running but tractable work must persist concrete progress and continue instead of stopping with a partial-summary handoff
- after each completed task, update runtime product state, update runtime task queue, advance the active task pointer, select the next unblocked task, and continue execution
- a completed phase is not a completed product

## Git hygiene

- branch from updated \`origin/main\` before task or plan work
- default branch prefixes are \`feature/\`, \`bugfix/\`, \`hotfix/\`, \`release/\`, \`chore/\`, \`refactor/\`, \`docs/\`, \`test/\`, \`ci/\`, and \`perf/\`
- this git-flow-style default overrides GitHub MCP naming suggestions unless a consuming repo's higher-precedence guideline says otherwise
- in consuming repos, \`git_operator\` must not stage \`.archon/\`, \`.agents/\`, \`.claude/\`, or \`CLAUDE.md\` unless the task explicitly targets archon/control-layer installation or maintenance
- do not use \`codex\` in branch names, commit subjects, PR titles, or PR bodies
- keep commits atomic and briefly named

${CLAUDE_END}`;

const managedDotClaudeMdBlock = `${DOT_CLAUDE_BEGIN}
# Archon Kernel

- substantive asks default to \`archon\` unless the user opts out
- use \`archon-intake\` first for substantive work
- root thread is the manager: confirm goal, criteria, constraints, and main risk
- manager/root gets at most two shallow inspections before trivial handling or bounded delegation
- create or update \`.archon/ACTIVE\` and \`.archon/work/briefs/brief-<task-id>.md\` before moving past intake
- default sequence: evidence -> \`solution_architect\` -> \`planner\` -> task packet -> specialist owner -> \`reviewer\`, \`qa_engineer\`, \`security_reviewer\`
- for council-reviewed work, require a written decision packet before critique and assign one explicit dissent owner
- task packets need \`task_id\`, owner role, completion standard, required specialists, quality gates, write scope, acceptance criteria, verification steps, required reviews, security checks, and rollback notes
- run \`node --experimental-strip-types scripts/check-archon-workflow.ts --task-id <task-id>\` before declaring substantive work complete
- current task id must match \`.archon/ACTIVE\`, the current brief, the current plan/task, and required review files
- unresolved \`CRITICAL\` or \`HIGH\` security findings block completion
- markdown review files are evidence summaries, not reviewer authority
- trusted reviewer identity and waivers must come from runtime orchestrator-written records or another runtime-trusted principal-binding source
- branch from updated \`origin/main\` before task or plan work and prefer \`feature/\`, \`bugfix/\`, \`hotfix/\`, \`release/\`, \`chore/\`, \`refactor/\`, \`docs/\`, \`test/\`, \`ci/\`, or \`perf/\` prefixes unless a consuming repo overrides them
- keep \`codex\` out of branch names, commit subjects, PR titles, and PR bodies
- package owns \`src/\`, \`scripts/\`, \`.agents/\`, \`.claude/\`, \`.archon/rules/\`, and \`.archon/templates/\`
- live work state belongs in \`.archon/work/\`
- reviewed memory in \`.archon/memory/\` is canonical; retrieval is advisory; never store secrets there
- repo-local skills in \`.archon/skills/\` encode repo-specific procedures; check before starting domain work and update them when the agent learns something new about this repo
- when repo-local Grafana configuration is present, treat Grafana as advisory evidence for debugging and research; if configuration is partial or tools are unavailable, report that explicitly
- avoid strong negative claims from a narrow pass; gather broader evidence or test an alternate hypothesis before concluding no other cases exist
- ask before deploys, auth changes, secret rotation, destructive data operations, global config changes outside this repo, or durable memory policy changes
- use repo-local \`archon\` skills and agents when they fit; use \`caveman\` for terse internal handoffs

Gate reminders:

- substantive non-trivial work should normally use \`specialist_verified\`
- workers must not edit \`CLAUDE.md\`, \`.claude/\`, \`.agents/\`, or \`.archon/memory/\` unless the task packet allows it
- keep live work state in \`.archon/work/\`; reviewed memory is not a scratchpad

Council reminders:

- the \`Design and Architecture Council\` is a pre-implementation quality gate for substantive roadmap and plan work
- the council is a rotating 3-5 role panel with default seats from \`solution_architect\`, \`product_strategist\`, \`frontend_designer\` when a human-facing surface exists, and \`infra_engineer\` or \`security_reviewer\` when the main risk is operational or security-heavy
- every council review must name a \`dissent owner\` who argues at least one serious alternative and records unresolved objections
- the council may output \`approved\`, \`approved_with_conditions\`, \`rework_required\`, \`exception_granted\`, or \`rejected\`
- the council may propose changes to user intent, but it must not silently override user intent without user acceptance

See \`CLAUDE.md\` and \`.archon/rules/\` for the full workflow contract and policy details.
${DOT_CLAUDE_END}`;

const enforcedClaudeSettingsKeys = ["autoAcceptEdits", "permissions"] as const;

function sortObjectKeys<T>(value: T): T {
  if (Array.isArray(value) || value === null || typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nestedValue]) => [key, sortObjectKeys(nestedValue)]);

  return Object.fromEntries(entries) as T;
}

export function mergeClaudeMd(existingContent: string | undefined): string {
  if (!existingContent || existingContent.trim().length === 0) {
    return managedClaudeMdBlock;
  }

  const blockPattern = new RegExp(`${CLAUDE_BEGIN}[\\s\\S]*?${CLAUDE_END}`, "m");
  if (blockPattern.test(existingContent)) {
    return existingContent.replace(blockPattern, managedClaudeMdBlock);
  }

  return `${existingContent.trimEnd()}\n\n${managedClaudeMdBlock}\n`;
}

export function mergeDotClaudeMd(existingContent: string | undefined): string {
  if (!existingContent || existingContent.trim().length === 0) {
    return `${managedDotClaudeMdBlock}\n`;
  }

  const blockPattern = new RegExp(`${DOT_CLAUDE_BEGIN}[\\s\\S]*?${DOT_CLAUDE_END}`, "m");
  if (blockPattern.test(existingContent)) {
    return `${existingContent.replace(blockPattern, managedDotClaudeMdBlock).trimEnd()}\n`;
  }

  return `${existingContent.trimEnd()}\n\n${managedDotClaudeMdBlock}\n`;
}

function ensureStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function mergeJsonObject(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...target };

  for (const [key, value] of Object.entries(source)) {
    const targetValue = merged[key];

    if (targetValue === undefined) {
      merged[key] = value;
      continue;
    }

    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      targetValue &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      merged[key] = mergeJsonObject(
        targetValue as Record<string, unknown>,
        value as Record<string, unknown>
      );
    }
  }

  return merged;
}

function omitArchonMcpServer(
  config: Record<string, unknown>
): Record<string, unknown> {
  const mcpServers =
    config.mcpServers &&
    typeof config.mcpServers === "object" &&
    !Array.isArray(config.mcpServers)
      ? { ...(config.mcpServers as Record<string, unknown>) }
      : undefined;

  if (!mcpServers || mcpServers.archon === undefined) {
    return config;
  }

  delete mcpServers.archon;

  if (Object.keys(mcpServers).length === 0) {
    const { mcpServers: _removed, ...rest } = config;
    return rest;
  }

  return {
    ...config,
    mcpServers
  };
}

export function mergeClaudeSettings(
  existingContent: string | undefined,
  sourceContent: string
): string {
  const source = JSON.parse(sourceContent) as Record<string, unknown>;

  if (!existingContent || existingContent.trim().length === 0) {
    return `${JSON.stringify(sortObjectKeys(source), null, 2)}\n`;
  }

  const target = JSON.parse(existingContent) as Record<string, unknown>;
  const merged = mergeJsonObject(target, source);

  for (const key of enforcedClaudeSettingsKeys) {
    if (source[key] !== undefined) {
      merged[key] = source[key];
    }
  }

  const mergedFallbacks = new Set(
    ensureStringArray(source.projectDocFallbackFilenames, []).concat(
      ensureStringArray(target.projectDocFallbackFilenames, [])
    )
  );
  if (mergedFallbacks.size > 0) {
    merged.projectDocFallbackFilenames = [...mergedFallbacks];
  }

  const normalizedTarget = sortObjectKeys(target);
  const normalizedMerged = sortObjectKeys(merged);
  if (JSON.stringify(normalizedTarget) === JSON.stringify(normalizedMerged)) {
    return existingContent.endsWith("\n") ? existingContent : `${existingContent}\n`;
  }

  return `${JSON.stringify(normalizedMerged, null, 2)}\n`;
}

export function archonMcpConfigFragment(): string {
  // The archon bin (dist/cli/archon-bin.js) auto-loads .env.archon for runtime
  // commands, so no --env-file flag is needed here.
  return JSON.stringify({
    mcpServers: {
      archon: {
        command: "node",
        args: ["./node_modules/@witchynibbles/archon/dist/cli/archon-bin.js", "mcp"]
      }
    }
  }, null, 2);
}

export function grafanaMcpConfigFragment(): string {
  return JSON.stringify({
    mcpServers: {
      grafana: {
        command: "node",
        args: ["./node_modules/@witchynibbles/archon/dist/grafana/mcp-server.js"]
      }
    }
  }, null, 2);
}

// Pinned @bitbonsai/mcpvault version — keeps installs reproducible and avoids
// a supply-chain hit on an untested @latest pull. Bump together with a fresh
// manual verification of the mcpvault tools when upgrading.
export const MCPVAULT_VERSION = "0.12.1";

/**
 * Validate a caller-supplied vaultPath before embedding it in a generated MCP
 * config.  Rejects path-traversal sequences and flag-like values (leading "-")
 * that could be misinterpreted by the child process.  If the value is absent
 * the config uses the ${ARCHON_OBSIDIAN_VAULT_PATH} env-var placeholder.
 */
function validateVaultPath(vaultPath: string): void {
  if (vaultPath.length === 0) {
    throw new Error(`obsidianMcpConfigFragment: vaultPath must not be empty`);
  }
  if (vaultPath.includes("\0")) {
    throw new Error(`obsidianMcpConfigFragment: vaultPath must not contain NUL bytes`);
  }
  if (/[\r\n]/.test(vaultPath)) {
    throw new Error(`obsidianMcpConfigFragment: vaultPath must not contain newline characters`);
  }
  if (vaultPath.includes("..")) {
    throw new Error(`obsidianMcpConfigFragment: vaultPath must not contain ".." (path traversal): ${JSON.stringify(vaultPath)}`);
  }
  if (vaultPath.startsWith("-")) {
    throw new Error(`obsidianMcpConfigFragment: vaultPath must not start with "-" (flag-like value): ${JSON.stringify(vaultPath)}`);
  }
}

export function obsidianMcpConfigFragment(vaultPath?: string): string {
  if (vaultPath !== undefined) {
    validateVaultPath(vaultPath);
  }
  return JSON.stringify({
    mcpServers: {
      obsidian: {
        command: "npx",
        args: [`@bitbonsai/mcpvault@${MCPVAULT_VERSION}`, vaultPath ?? "${ARCHON_OBSIDIAN_VAULT_PATH}"]
      }
    }
  }, null, 2);
}

// Pinned @playwright/mcp version — mirrors the PLAYWRIGHT_VERSION discipline in
// setup-playwright.ts so the MCP browser install tracks the tested Playwright
// release. Drop --yes (auto-confirm) to prevent silent installs; the package
// must already be installed locally. Bump together with PLAYWRIGHT_VERSION and
// re-verify the MCP browser binaries.
export const PLAYWRIGHT_MCP_VERSION = "0.0.77";

export function playwrightMcpConfigFragment(): string {
  return JSON.stringify({
    mcpServers: {
      playwright: {
        command: "npx",
        args: [`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, "--config", ".archon/playwright/mcp.json"]
      },
      playwright_vision: {
        command: "npx",
        args: [`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, "--config", ".archon/playwright/mcp.vision.json"]
      }
    }
  }, null, 2);
}

export function mergeMcpJson(
  existingContent: string | undefined,
  sourceContent: string
): string {
  const source = JSON.parse(sourceContent) as Record<string, unknown>;

  if (!existingContent || existingContent.trim().length === 0) {
    return `${JSON.stringify(sortObjectKeys(source), null, 2)}\n`;
  }

  const target = JSON.parse(existingContent) as Record<string, unknown>;
  const merged = mergeJsonObject(target, source);

  const normalizedTarget = sortObjectKeys(target);
  const normalizedMerged = sortObjectKeys(merged);
  if (JSON.stringify(normalizedTarget) === JSON.stringify(normalizedMerged)) {
    return existingContent.endsWith("\n") ? existingContent : `${existingContent}\n`;
  }

  return `${JSON.stringify(normalizedMerged, null, 2)}\n`;
}

export function stripArchonFromMcpJson(
  sourceContent: string
): string {
  const source = omitArchonMcpServer(JSON.parse(sourceContent) as Record<string, unknown>);
  return `${JSON.stringify(sortObjectKeys(source), null, 2)}\n`;
}

export function mergeGitignore(
  existingContent: string | undefined
): string {
  const requiredLines = [
    ".env",
    ".env.*",
    ".env.local",
    ".env.*.local",
    ".env.archon",
    ".env.archon.*",
    "graphify-out/*",
    "!graphify-out/GRAPH_REPORT.md",
    "!graphify-out/wiki/",
    // Runtime-written local artifact; must not be committed to the consumer repo.
    ".archon/ecc-plugin-record.json",
    // Live workflow state (audit auditDebt202607 §3.6 / F8). The consumer repo OWNS
    // its `.archon/work/` tree and `.archon/ACTIVE` pointer — both are regenerated by
    // the runtime, hooks, daemon, init-task, and reconcile, and must never be
    // committed. These mirror the shared-package repo's own ignore entries.
    ".archon/work/",
    ".archon/ACTIVE"
  ];
  const existingLines = new Set(
    (existingContent ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );

  const missing = requiredLines.filter((line) => !existingLines.has(line));
  if (missing.length === 0) {
    return existingContent ?? "";
  }

  const prefix = existingContent && existingContent.trim().length > 0 ? `${existingContent.trimEnd()}\n` : "";
  return `${prefix}\n# archon\n${missing.join("\n")}\n`;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function prefixedFileDependency(relativePath: string): string {
  const normalized = toPosixPath(relativePath);
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return `file:${normalized}`;
  }
  if (normalized.startsWith(".")) {
    return `file:${normalized}`;
  }
  return `file:./${normalized}`;
}

export function mergePackageJson(
  existingContent: string | undefined,
  dependencyPathFromTarget: string,
  options: { withGrafana?: boolean } = {}
): string {
  const packageJson = existingContent && existingContent.trim().length > 0
    ? (JSON.parse(existingContent) as Record<string, unknown>)
    : {
        name: "project-with-archon",
        private: true
      };

  const scripts =
    packageJson.scripts && typeof packageJson.scripts === "object" && !Array.isArray(packageJson.scripts)
      ? { ...(packageJson.scripts as Record<string, string>) }
      : {};
  const devDependencies =
    packageJson.devDependencies &&
    typeof packageJson.devDependencies === "object" &&
    !Array.isArray(packageJson.devDependencies)
      ? { ...(packageJson.devDependencies as Record<string, string>) }
      : {};

  // npm scripts run with ./node_modules/.bin prepended to PATH, so the bare
  // "archon" name resolves to the installed bin without --experimental-strip-types
  // or a full path.  This works cross-platform; npm creates the appropriate .cmd
  // wrapper on Windows.  Standalone scripts that bypass the bin router (setup-*,
  // verify-git-guard, autopilot-status, grafana-mcp) reference the compiled dist
  // file directly — they are not sub-commands of the main bin router.
  scripts["archon"] = "archon";
  scripts["archon:migrate"] = "archon migrate";
  scripts["archon:health"] = "archon health";
  scripts["archon:doctor"] = "archon doctor";
  scripts["archon:heal"] = "archon doctor --repair";
  scripts["archon:bootstrap"] = "archon bootstrap-project";
  scripts["archon:verify:setup"] = "archon verify-setup";
  scripts["archon:status"] = "archon status";
  scripts["archon:coverage"] = "archon coverage --format text";
  scripts["archon:gaps"] = "archon gaps --format text";
  scripts["archon:checkpoint"] = "archon checkpoint --format text";
  scripts["archon:resume"] = "archon resume --format text";
  scripts["archon:seed-workflow-proof"] = "archon seed-workflow-proof";
  scripts["archon:advance-active-task"] = "archon advance-active-task --format text";
  scripts["archon:reconcile"] = "archon reconcile-runtime-state --apply --format text";
  scripts["archon:sync-runtime-exports"] = "archon sync-runtime-exports --format text";
  scripts["archon:daemon"] = "archon daemon --format text";
  scripts["archon:supervisor"] = "archon supervisor --format text";
  scripts["archon:supervisor-history"] = "archon supervisor-history --format text";
  scripts["archon:ops"] = "archon ops --format text";
  scripts["archon:focus"] = "archon ops --format text";
  scripts["archon:loop"] = "archon loop --format text";
  scripts["archon:recover"] = "archon recover";
  scripts["archon:report"] = "archon report --format markdown";
  scripts["archon:plan-context"] = "archon plan-context";
  scripts["archon:refresh-retrieval"] = "archon refresh-retrieval";
  scripts["archon:refresh-retrieval:fast"] = "archon refresh-retrieval --artifacts-only";
  scripts["archon:refresh-repo-context"] = "archon refresh-repo-context";
  scripts["archon:repair-task-queue"] = "archon repair-task-queue";
  scripts["archon:export-docs"] = "archon export-docs";
  // autopilot-status is a standalone script not routed through the bin router
  scripts["archon:autopilot-status"] =
    "node ./node_modules/@witchynibbles/archon/dist/archon/autopilot-status.js";
  scripts["archon:github-dispatch"] = "archon github-dispatch --target .";
  scripts["archon:mcp"] = "archon mcp";
  scripts["archon:scaffold-workflow"] = "archon scaffold-workflow --target .";
  scripts["archon:upgrade-reasoning-workflow"] = "archon upgrade-reasoning-workflow --target .";
  scripts["archon:seed-happy-path-fixture"] = "archon seed-happy-path-fixture --target .";
  scripts["archon:check:happy-path"] = "bash scripts/check-archon-happy-path.sh";
  // check-archon-workflow.ts is a consumer-owned TypeScript file installed in
  // scripts/ (not in node_modules/@witchynibbles/archon/src/) — --experimental-strip-types here
  // is for the consumer's own local TS helper, not archon source.
  scripts["archon:check-workflow"] = "node --experimental-strip-types scripts/check-archon-workflow.ts";
  scripts["archon:verify:migrations:live"] = "archon verify-live-migrations";
  scripts["archon:verify:review-identity"] = "archon verify-review-identity";
  // verify-git-guard and setup-* are standalone scripts not in the bin router.
  // They reference the scoped package install path (@witchynibbles/archon) directly
  // because they are not sub-commands of the main bin router and are invoked outside
  // npm's PATH-prepend mechanism (e.g. from git hooks and shell scripts).
  scripts["archon:verify:git-guard"] =
    "node ./node_modules/@witchynibbles/archon/dist/install/verify-git-guard.js";
  scripts["archon:record-review"] = "archon record-review --input .archon/review-action.json";
  scripts["archon:setup:git-guard"] =
    "node ./node_modules/@witchynibbles/archon/dist/install/setup-git-guard.js";
  scripts["archon:setup:local"] = "node ./node_modules/@witchynibbles/archon/dist/install/setup-local.js";
  scripts["archon:setup:playwright"] =
    "node ./node_modules/@witchynibbles/archon/dist/install/setup-playwright.js";
  scripts["archon:verify:playwright"] =
    "node ./node_modules/@witchynibbles/archon/dist/install/setup-playwright.js --verify";

  if (options.withGrafana) {
    // grafana-mcp is a standalone server not routed through the bin router
    scripts["archon:grafana:mcp"] =
      "node ./node_modules/@witchynibbles/archon/dist/grafana/mcp-server.js";
  }

  scripts["archon:graphify:build"] = "graphify . --wiki";
  scripts["archon:graphify:update"] = "graphify . --update --wiki";
  scripts["archon:graphify:report"] = "graphify . --update";

  // Only add a file: devDependency when the path is NOT inside node_modules.
  // When running from an installed package (sourceRoot = node_modules/...),
  // the relative path starts with "node_modules/" — adding a file: reference
  // back to node_modules creates a circular devDependency that breaks npm install.
  // In that case, the package is already a real dependency; skip the devDep.
  if (!dependencyPathFromTarget.startsWith("node_modules")) {
    devDependencies["@witchynibbles/archon"] = prefixedFileDependency(dependencyPathFromTarget);
  }

  packageJson.scripts = sortObjectKeys(scripts);
  packageJson.devDependencies = sortObjectKeys(devDependencies);

  return `${JSON.stringify(sortObjectKeys(packageJson), null, 2)}\n`;
}

export function claudeMdManagedBlock(): string {
  return managedClaudeMdBlock;
}

export function dotClaudeMdManagedBlock(): string {
  return managedDotClaudeMdBlock;
}

// Backward-compatibility aliases (devgod names → archon names)
export const mergeAgentsMd = mergeClaudeMd;
export const mergeDotAgentsMd = mergeDotClaudeMd;
