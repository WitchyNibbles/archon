import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { auditMaintainerOnlyPublishedPaths } from "../src/install/maintainer-boundary.ts";
import {
  grafanaMcpConfigFragment,
  mergeAgentsMd,
  mergeDotAgentsMd,
  mergeClaudeSettings,
  mergeGitignore,
  mergePackageJson,
  playwrightMcpConfigFragment
} from "../src/install/merge.ts";
import {
  installDevgodIntoProject,
  parseCliArgs,
  upgradeReasoningWorkflowArtifacts,
  upgradeDevgodInProject,
  verifyDevgodInstall
} from "../src/install/cli.ts";
import {
  listCatalogAgentArtifactPaths,
  verifyCatalogRepoLocalSkills,
  verifyAgentCatalogArtifacts
} from "../src/archon/agent-artifact-verifier.ts";
import { listCatalogRepoLocalSkillPaths } from "../src/archon/repo-local-skill-surface.ts";

const execFileAsync = promisify(execFile);

async function runNpmPackJsonDryRun(sourceRoot: string): Promise<string> {
  const npmCacheDir = await mkdtemp(path.join(tmpdir(), "archon-npm-pack-cache-"));
  const outputPath = path.join(npmCacheDir, "npm-pack-output.json");

  try {
    await execFileAsync(
      "bash",
      [
        "-lc",
        [
          "set -euo pipefail",
          `npm pack --json --dry-run --cache ${JSON.stringify(npmCacheDir)} > ${JSON.stringify(outputPath)}`
        ].join("\n")
      ],
      { cwd: sourceRoot }
    );

    return await readFile(outputPath, "utf8");
  } finally {
    await rm(npmCacheDir, { recursive: true, force: true });
  }
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  await chmod(filePath, 0o755);
}

async function writeHealthcheckNodeStub(binDir: string): Promise<void> {
  await writeExecutable(
    path.join(binDir, "node"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "-e" ]]; then',
      "  exit 0",
      "fi",
      `exec ${JSON.stringify(process.execPath)} "$@"`
    ].join("\n")
  );
}

const driftFixtureTarget = "scripts/check-archon-workflow.ts";

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

test("mergeAgentsMd appends and is idempotent", () => {
  const first = mergeAgentsMd("# Existing Rules\n");
  const second = mergeAgentsMd(first);
  const managedBlock = first.match(/<!-- BEGIN ARCHON MANAGED -->([\s\S]*?)<!-- END ARCHON MANAGED -->/)?.[1] ?? "";
  const managedWordCount = managedBlock.split(/\s+/).filter(Boolean).length;

  assert.match(first, /BEGIN ARCHON MANAGED/);
  assert.match(first, /## Department Workflow/);
  assert.match(first, /<!-- archon-workflow-contract:start -->/);
  assert.match(first, /<!-- archon-workflow-contract:end -->/);
  assert.match(first, /workflow=archon/);
  assert.match(first, /workflow_runtime=postgres/);
  assert.match(first, /active_task_pointer=project_runtime_state\.active_task_id/);
  assert.match(first, /local_live_check=bash scripts\/check-archon-workflow-live\.sh \[--task-id <task-id>\]/);
  assert.doesNotMatch(first, /\.archon\/ACTIVE/);
  assert.match(first, /archon-intake/);
  assert.match(first, /`solution_architect`/);
  assert.match(first, /`planner`/);
  assert.match(first, /`git_operator`/);
  assert.match(first, /workflow-proof --run-id latest --task-id/);
  assert.match(first, /## Autonomy Loop/);
  assert.match(first, /update runtime product state/i);
  assert.match(first, /update runtime task queue/i);
  assert.match(first, /a completed phase is not a completed product/i);
  assert.match(first, /clarify ambiguous intent before planning/i);
  assert.match(first, /do not wait for the user to say continue/i);
  assert.match(first, /runtime-backed archon commands/i);
  assert.match(first, /repo-local Grafana configuration/i);
  assert.match(first, /avoid strong negative claims/i);
  assert.match(first, /broader evidence/i);
  assert.match(first, /branch from updated `origin\/main`/i);
  assert.match(first, /default branch prefixes are `feature\/`, `bugfix\/`, `hotfix\/`, `release\/`, `chore\/`, `refactor\/`, `docs\/`, `test\/`, `ci\/`, and `perf\/`/i);
  assert.match(first, /overrides GitHub MCP naming suggestions/i);
  assert.match(first, /do not use `codex` in branch names, commit subjects, PR titles, or PR bodies/i);
  assert.doesNotMatch(first, /scrum_master/);
  assert.doesNotMatch(first, /test_director/);
  assert.doesNotMatch(first, /archon:codex/);
  assert.match(first, /implicitly invoked on every prompt/i);
  assert.match(first, /default workflow controller even when other tools are available/i);
  assert.ok(managedWordCount < 540, `expected slimmer managed AGENTS block, got ${managedWordCount} words`);
  assert.equal(first, second);
});

test("mergeDotAgentsMd appends and is idempotent", () => {
  const first = mergeDotAgentsMd("# local notes\n");
  const second = mergeDotAgentsMd(first);

  assert.match(first, /BEGIN ARCHON KERNEL/);
  assert.match(first, /Archon Kernel/);
  assert.match(first, /archon-intake/);
  assert.match(first, /specialist_verified/);
  assert.match(first, /repo-local Grafana configuration/i);
  assert.match(first, /avoid strong negative claims/i);
  assert.match(first, /branch from updated `origin\/main`/i);
  assert.match(first, /keep `codex` out of branch names, commit subjects, PR titles, and PR bodies/i);
  assert.equal(first, second);
});

test("mergeClaudeSettings preserves existing values and adds missing archon defaults", () => {
  const existing = JSON.stringify({ projectDocFallbackFilenames: ["CLAUDE.md"], customKey: "kept" }, null, 2) + "\n";
  const source = JSON.stringify({
    autoAcceptEdits: false,
    permissions: { allow: [], deny: [] },
    projectDocFallbackFilenames: ["CLAUDE.md", "AGENTS.md"]
  }, null, 2);

  const merged = JSON.parse(mergeClaudeSettings(existing, source)) as {
    projectDocFallbackFilenames?: string[];
    customKey?: string;
    autoAcceptEdits?: boolean;
    permissions?: unknown;
  };

  assert.equal(merged.customKey, "kept");
  assert.equal(merged.autoAcceptEdits, false);
  assert.ok(Array.isArray(merged.projectDocFallbackFilenames));
  // merged array includes both existing and source values
  assert.ok((merged.projectDocFallbackFilenames ?? []).includes("CLAUDE.md"));
});

test("mergeClaudeSettings is idempotent when content is already current", () => {
  const source = JSON.stringify({ autoAcceptEdits: false, permissions: { allow: [], deny: [] } }, null, 2) + "\n";
  const merged = mergeClaudeSettings(source, source);
  assert.equal(merged, source);
});

test("mergeClaudeSettings enforces autoAcceptEdits and permissions from source", () => {
  const existing = JSON.stringify({ autoAcceptEdits: true }, null, 2);
  const source = JSON.stringify({ autoAcceptEdits: false, permissions: { allow: ["Bash"], deny: [] } }, null, 2);
  const merged = JSON.parse(mergeClaudeSettings(existing, source)) as {
    autoAcceptEdits?: boolean;
    permissions?: { allow?: string[]; deny?: string[] };
  };

  // enforced keys take source value
  assert.equal(merged.autoAcceptEdits, false);
  assert.deepEqual(merged.permissions?.allow, ["Bash"]);
});

test("playwrightMcpConfigFragment adds Playwright MCP settings with standard and vision profiles", () => {
  // playwrightMcpConfigFragment returns JSON for .mcp.json
  const fragment = playwrightMcpConfigFragment();
  const parsed = JSON.parse(fragment) as { mcpServers?: Record<string, unknown> };

  assert.ok(parsed.mcpServers?.playwright, "expected playwright mcp server");
  assert.ok(parsed.mcpServers?.playwright_vision, "expected playwright_vision mcp server");
  const pw = parsed.mcpServers?.playwright as { args?: string[] };
  assert.ok(JSON.stringify(pw.args ?? []).includes("@playwright/mcp@latest"));
  assert.ok(JSON.stringify(pw.args ?? []).includes(".archon/playwright/mcp.json"));
  const pwv = parsed.mcpServers?.playwright_vision as { args?: string[] };
  assert.ok(JSON.stringify(pwv.args ?? []).includes(".archon/playwright/mcp.vision.json"));
});

test("grafanaMcpConfigFragment adds Grafana MCP settings without overwriting existing project config", () => {
  // grafanaMcpConfigFragment returns JSON for .mcp.json
  const fragment = grafanaMcpConfigFragment();
  const parsed = JSON.parse(fragment) as { mcpServers?: Record<string, unknown> };

  assert.ok(parsed.mcpServers?.grafana, "expected grafana mcp server");
  const grafana = parsed.mcpServers?.grafana as { command?: string; args?: string[] };
  assert.equal(grafana.command, "node");
  assert.ok(JSON.stringify(grafana.args ?? []).includes("src/grafana/mcp-server.ts"));
});

test("mergePackageJson adds archon dependency and scripts without removing existing scripts", () => {
  const merged = JSON.parse(
    mergePackageJson(
      JSON.stringify({
        name: "target-project",
        scripts: {
          test: "vitest"
        }
      }),
      "../archon"
    )
  ) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  assert.equal(merged.scripts.test, "vitest");
  assert.equal(
    merged.scripts.archon,
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts"
  );
  assert.match(merged.scripts["archon:migrate"], /node_modules\/archon\/src\/admin\/archon\.ts migrate/);
  assert.match(merged.scripts["archon:doctor"], /node_modules\/archon\/src\/admin\/archon\.ts doctor/);
  assert.match(merged.scripts["archon:heal"], /node_modules\/archon\/src\/admin\/archon\.ts doctor --repair/);
  assert.match(merged.scripts["archon:status"], /node_modules\/archon\/src\/admin\/archon\.ts status/);
  assert.equal(
    merged.scripts["archon:coverage"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts coverage --format text"
  );
  assert.equal(
    merged.scripts["archon:gaps"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts gaps --format text"
  );
  assert.equal(
    merged.scripts["archon:checkpoint"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts checkpoint --format text"
  );
  assert.equal(
    merged.scripts["archon:resume"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts resume --format text"
  );
  assert.equal(
    merged.scripts["archon:seed-workflow-proof"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts seed-workflow-proof"
  );
  assert.equal(
    merged.scripts["archon:advance-active-task"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts advance-active-task --format text"
  );
  assert.equal(
    merged.scripts["archon:reconcile"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts reconcile-runtime-state --apply --format text"
  );
  assert.equal(
    merged.scripts["archon:sync-runtime-exports"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts sync-runtime-exports --format text"
  );
  assert.equal(
    merged.scripts["archon:daemon"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts daemon --format text"
  );
  assert.equal(
    merged.scripts["archon:supervisor"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts supervisor --format text"
  );
  assert.equal(
    merged.scripts["archon:supervisor-history"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts supervisor-history --format text"
  );
  assert.equal(
    merged.scripts["archon:loop"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts loop --format text"
  );
  assert.equal(
    merged.scripts["archon:check-workflow"],
    "node --experimental-strip-types scripts/check-archon-workflow.ts"
  );
  assert.equal(
    merged.scripts["archon:report"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts report --format markdown"
  );
  assert.equal(
    merged.scripts["archon:focus"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts ops --format text"
  );
  assert.equal(
    merged.scripts["archon:refresh-retrieval"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts refresh-retrieval"
  );
  assert.equal(
    merged.scripts["archon:refresh-retrieval:fast"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts refresh-retrieval --artifacts-only"
  );
  assert.equal(
    merged.scripts["archon:refresh-repo-context"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts refresh-repo-context"
  );
  assert.equal(
    merged.scripts["archon:repair-task-queue"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts repair-task-queue"
  );
  assert.equal(
    merged.scripts["archon:autopilot-status"],
    "node --experimental-strip-types ./node_modules/archon/src/archon/autopilot-status.ts"
  );
  assert.equal(
    merged.scripts["archon:github-dispatch"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts github-dispatch --target ."
  );
  assert.equal(
    merged.scripts["archon:mcp"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts mcp"
  );
  assert.match(
    merged.scripts["archon:verify:migrations:live"],
    /node_modules\/archon\/src\/admin\/archon\.ts verify-live-migrations/
  );
  assert.equal(
    merged.scripts["archon:scaffold-workflow"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts scaffold-workflow --target ."
  );
  assert.equal(
    merged.scripts["archon:upgrade-reasoning-workflow"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts upgrade-reasoning-workflow --target ."
  );
  assert.equal(
    merged.scripts["archon:seed-happy-path-fixture"],
    "node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts seed-happy-path-fixture --target ."
  );
  assert.equal(merged.scripts["archon:check:happy-path"], "bash scripts/check-archon-happy-path.sh");
  assert.match(
    merged.scripts["archon:verify:review-identity"],
    /node_modules\/archon\/src\/admin\/archon\.ts verify-review-identity/
  );
  assert.equal(
    merged.scripts["archon:verify:git-guard"],
    "node --experimental-strip-types ./node_modules/archon/src/install/verify-git-guard.ts"
  );
  assert.match(
    merged.scripts["archon:record-review"],
    /node_modules\/archon\/src\/admin\/archon\.ts record-review --input \.archon\/review-action\.json/
  );
  assert.equal(
    merged.scripts["archon:setup:git-guard"],
    "node --experimental-strip-types ./node_modules/archon/src/install/setup-git-guard.ts"
  );
  assert.match(
    merged.scripts["archon:setup:local"],
    /node_modules\/archon\/src\/install\/setup-local\.ts/
  );
  assert.match(
    merged.scripts["archon:setup:playwright"],
    /node_modules\/archon\/src\/install\/setup-playwright\.ts/
  );
  assert.match(
    merged.scripts["archon:verify:playwright"],
    /node_modules\/archon\/src\/install\/setup-playwright\.ts --verify/
  );
  assert.equal(merged.devDependencies.archon, "file:../archon");
});

test("verifyAgentCatalogArtifacts reports missing and unexpected AGENT.md files deterministically", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "archon-agent-catalog-"));
  // Archon agents are in .claude/agents/<name>/AGENT.md
  const backendDir = path.join(repoRoot, ".claude", "agents", "backend-engineer");
  const mysteryDir = path.join(repoRoot, ".claude", "agents", "mystery-agent");
  await mkdir(backendDir, { recursive: true });
  await mkdir(mysteryDir, { recursive: true });

  // Write a valid AGENT.md for backend-engineer (exists but unexpected role mismatch won't apply since we match by directory)
  await writeFile(
    path.join(backendDir, "AGENT.md"),
    "---\ndescription: Backend engineer\nmodel: claude-sonnet-4-5\n---\n\n# Backend Engineer\n",
    "utf8"
  );
  // Write an unexpected agent directory
  await writeFile(
    path.join(mysteryDir, "AGENT.md"),
    "---\ndescription: Mystery agent\nmodel: claude-haiku-4-5\n---\n\n# Mystery Agent\n",
    "utf8"
  );

  const result = await verifyAgentCatalogArtifacts({
    repoRoot,
    roles: ["backend_engineer", "technical_writer"]
  });

  // technical_writer is missing (no dir), mystery-agent is unexpected (not in catalog roles)
  assert.deepEqual(result.missingArtifacts, [".claude/agents/technical-writer/AGENT.md"]);
  assert.deepEqual(result.unexpectedArtifacts, [".claude/agents/mystery-agent/AGENT.md"]);
  assert.deepEqual(result.metadataMismatches, []);
  assert.equal(result.ok, false);
});

test("verifyCatalogRepoLocalSkills reports missing repo-local wrapper files deterministically", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "archon-skill-catalog-"));

  try {
    for (const relativePath of listCatalogRepoLocalSkillPaths({ roles: ["planner", "git_operator"] })) {
      const targetPath = path.join(repoRoot, relativePath);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, "---\nname = \"placeholder\"\n---\n", "utf8");
    }

    await rm(path.join(repoRoot, ".claude/skills/superpowers-using-git-worktrees"), {
      recursive: true,
      force: true
    });

    const result = await verifyCatalogRepoLocalSkills({
      repoRoot,
      roles: ["planner", "git_operator"]
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingSkillFiles, [
      ".claude/skills/superpowers-using-git-worktrees/SKILL.md"
    ]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("mergePackageJson always adds graphify scripts", () => {
  const merged = JSON.parse(
    mergePackageJson(
      JSON.stringify({
        name: "target-project",
        private: true
      }),
      "../archon"
    )
  ) as {
    scripts: Record<string, string>;
  };

  assert.equal(merged.scripts["archon:graphify:build"], "graphify . --wiki");
  assert.equal(merged.scripts["archon:graphify:update"], "graphify . --update --wiki");
  assert.equal(merged.scripts["archon:graphify:report"], "graphify . --update");
});

test("mergePackageJson adds a Grafana MCP helper only when requested", () => {
  const merged = JSON.parse(
    mergePackageJson(
      JSON.stringify({
        name: "target-project",
        private: true
      }),
      "../archon",
      {
        withGrafana: true
      }
    )
  ) as {
    scripts: Record<string, string>;
  };

  assert.equal(
    merged.scripts["archon:grafana:mcp"],
    "node --experimental-strip-types ./node_modules/archon/src/grafana/mcp-server.ts"
  );
});

test("mergeGitignore adds archon env ignores once", () => {
  const first = mergeGitignore("node_modules/\n");
  const second = mergeGitignore(first);

  assert.match(first, /\.env\.archon/);
  assert.equal(first, second);
});

test("mergeGitignore always adds graphify-out selective ignore", () => {
  const first = mergeGitignore("node_modules/\n");
  const second = mergeGitignore(first);

  assert.match(first, /graphify-out\/\*/);
  assert.match(first, /!graphify-out\/GRAPH_REPORT\.md/);
  assert.match(first, /!graphify-out\/wiki\//);
  assert.equal(first, second);
});

test("ci workflow pins external actions and keeps read-only permissions", async () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const ciWorkflow = await readFile(path.join(sourceRoot, ".github/workflows/ci.yml"), "utf8");

  assert.match(ciWorkflow, /uses: actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd/);
  assert.match(ciWorkflow, /uses: actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e/);
  assert.match(ciWorkflow, /permissions:\n\s+contents: read/);
  assert.match(ciWorkflow, /merge_group:/);
  assert.match(ciWorkflow, /concurrency:\n\s+group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/);
  assert.match(
    ciWorkflow,
    /ARCHON_REVIEW_IDENTITY_BINDINGS: \.archon\/templates\/review-identity-bindings\.json/
  );
  assert.match(
    ciWorkflow,
    /ARCHON_REVIEW_IDENTITY_FIXTURES: \.archon\/templates\/review-identity-adapter\.fixture\.json/
  );
  assert.doesNotMatch(ciWorkflow, /qdrant\/qdrant/);
  assert.doesNotMatch(ciWorkflow, /ARCHON_QDRANT_URL/);
  assert.doesNotMatch(ciWorkflow, /contents: write/);
  assert.doesNotMatch(ciWorkflow, /id-token: write/);
});

test("ci workflow routes the release posture through the release overlay gate", async () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const ciWorkflow = await readFile(path.join(sourceRoot, ".github/workflows/ci.yml"), "utf8");

  assert.match(ciWorkflow, /jobs:\n {2}release-overlay:/);
  assert.match(ciWorkflow, /npm run verify:release-overlay/);
  assert.match(ciWorkflow, /jobs:[\s\S]*\n {2}live-migrations:/);
  assert.match(ciWorkflow, /jobs:[\s\S]*\n {2}required-checks:/);
  // CI triggers on the actual default branch (master), not the non-existent main.
  assert.match(ciWorkflow, /pull_request:\n\s+branches:\n\s+- master/);
  // The windows-setup-smoke and property-regressions jobs were removed as phantom
  // jobs (they referenced tests/scripts that do not exist). Assert they stay gone so
  // a future edit cannot silently reintroduce an un-runnable job.
  assert.doesNotMatch(ciWorkflow, /windows-setup-smoke:/);
  assert.doesNotMatch(ciWorkflow, /property-regressions:/);
  assert.doesNotMatch(ciWorkflow, /- run: npm run check:quality/);
  // GAP-10: unit-tests job runs the full suite under coverage (c8 ratchet gate)
  // and is gated in required-checks.
  assert.match(ciWorkflow, /jobs:[\s\S]*\n {2}unit-tests:/);
  assert.match(ciWorkflow, /- run: npm run check:coverage/);
  assert.match(ciWorkflow, /needs:[\s\S]*unit-tests/);
});

test("README frames archon as an opt-in overlay with production-oriented package checks", async () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const readme = await readFile(path.join(sourceRoot, "README.md"), "utf8");

  assert.match(readme, /opt-in overlay/i);
  assert.match(readme, /production-oriented package checks/i);
  assert.doesNotMatch(readme, /production ready/i);
});

test("package.json keeps shipped skills and agent configs explicit", async () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8")) as {
    description?: string;
    license?: string;
    files: string[];
    private?: boolean;
    scripts: Record<string, string>;
  };

  const expectedSkillFiles = [
    ".claude/skills/anthropic-mcp-builder/SKILL.md",
    ".claude/skills/anthropic-webapp-testing/SKILL.md",
    ".claude/skills/archon-accessibility-gate/SKILL.md",
    ".claude/skills/archon-agent-runtime/SKILL.md",
    ".claude/skills/archon-architecture/SKILL.md",
    ".claude/skills/archon-autopilot/SKILL.md",
    ".claude/skills/archon-compliance-review/SKILL.md",
    ".claude/skills/archon-context-retrieval/SKILL.md",
    ".claude/skills/archon-debugging/SKILL.md",
    ".claude/skills/archon-design-system/SKILL.md",
    ".claude/skills/archon-docs-research/SKILL.md",
    ".claude/skills/archon-e2e/SKILL.md",
    ".claude/skills/archon-eval-engineering/SKILL.md",
    ".claude/skills/archon-execution/SKILL.md",
    ".claude/skills/archon-forge-assets/SKILL.md",
    ".claude/skills/archon-forge-direction/SKILL.md",
    ".claude/skills/archon-forge-intent/SKILL.md",
    ".claude/skills/archon-frontend-taste/SKILL.md",
    ".claude/skills/archon-frontend/SKILL.md",
    ".claude/skills/archon-git-operator/SKILL.md",
    ".claude/skills/archon-graphify/SKILL.md",
    ".claude/skills/archon-infra-ops/SKILL.md",
    ".claude/skills/archon-intake/SKILL.md",
    ".claude/skills/archon-memory/SKILL.md",
    ".claude/skills/archon-performance/SKILL.md",
    ".claude/skills/archon-planning/SKILL.md",
    ".claude/skills/archon-product-analysis/SKILL.md",
    ".claude/skills/archon-product-framing/SKILL.md",
    ".claude/skills/archon-qa-verification/SKILL.md",
    ".claude/skills/archon-release-readiness/SKILL.md",
    ".claude/skills/archon-repair-loop/SKILL.md",
    ".claude/skills/archon-review/SKILL.md",
    ".claude/skills/archon-setup/SKILL.md",
    ".claude/skills/archon-skill-evals/SKILL.md",
    ".claude/skills/archon-tdd/SKILL.md",
    ".claude/skills/archon-technical-writing/SKILL.md",
    ".claude/skills/archon-ui-patterns/SKILL.md",
    ".claude/skills/archon-ux-research/SKILL.md",
    ".claude/skills/archon-visual-standards/SKILL.md",
    ".claude/skills/caveman/SKILL.md",
    ".claude/skills/documentation-lookup/SKILL.md",
    ".claude/skills/graphify/SKILL.md",
    ".claude/skills/mcp-server-patterns/SKILL.md",
    ".claude/skills/superpowers-finishing-development-branch/SKILL.md",
    ".claude/skills/superpowers-using-git-worktrees/SKILL.md",
    ".claude/skills/verification-loop/SKILL.md"
  ];

  const expectedAgentFiles = listCatalogAgentArtifactPaths();
  const expectedCatalogRepoLocalSkills = listCatalogRepoLocalSkillPaths();

  const shippedSkillFiles = pkg.files.filter((file) => file.startsWith(".claude/skills/")).sort();
  const shippedAgentFiles = pkg.files.filter((file) => file.startsWith(".claude/agents/")).sort();
  const overlayPortableAssets = [
    ".githooks/",
    ".env.example",
    "README.md",
    "docker-compose.yml",
    ".archon/playwright/",
    "docs/global-setup.md",
    "scripts/check-archon-branch-name.sh",
    "scripts/check-archon-commit-msg.sh",
    "scripts/check-archon-git-guard.sh",
    "scripts/check-quality.sh",
    "scripts/check-archon-happy-path.sh",
    "scripts/check-archon-workflow-live.sh",
    "scripts/check-archon-workflow.ts",
    "scripts/install-archon.ps1",
    "scripts/install-archon.sh",
    "scripts/setup-archon.ps1",
    "scripts/setup-archon.sh",
    "scripts/verify-archon-workflow-check.sh",
    "scripts/verify-release-overlay.sh",
    "src/admin.ts",
    "src/admin/",
    "src/core/",
    "src/archon/",
    "src/domain/",
    "src/evals/orchestration-baseline.ts",
    "src/evals/retrieval-memory-baseline.ts",
    "src/index.ts",
    "src/install/cli.ts",
    "src/install/git-guard.ts",
    "src/install/merge.ts",
    "src/install/setup-git-guard.ts",
    "src/install/setup-local.ts",
    "src/install/setup-playwright.ts",
    "src/install/types.ts",
    "src/install/verify-git-guard.ts",
    "src/mcp/",
    "src/runtime/",
    "src/sql/migrations/",
    "src/store/"
  ];
  const excludedOverlayFiles = [
    ".archon/install-backups/",
    ".archon/work/2026-05-04-project-state-review/BRIEF.md",
    "docs/maintainers/quality-tooling.md",
    "evals/promptfoo/maintainer-boundary.promptfooconfig.yaml",
    "scripts/",
    "scripts/check-coverage.ts",
    "src/",
    "stryker-maintainer-boundary.config.json"
  ];

  assert.deepEqual(shippedSkillFiles, expectedSkillFiles);
  assert.deepEqual(shippedAgentFiles, expectedAgentFiles);
  assert.ok(pkg.files.includes("docs/archon-agent-team.md"));
  for (const relativePath of expectedCatalogRepoLocalSkills) {
    assert.ok(shippedSkillFiles.includes(relativePath), `${relativePath} should ship because the catalog references it`);
  }

  const catalogVerification = await verifyAgentCatalogArtifacts({ repoRoot: sourceRoot });
  assert.equal(catalogVerification.ok, true);
  assert.deepEqual(catalogVerification.missingArtifacts, []);
  assert.deepEqual(catalogVerification.unexpectedArtifacts, []);
  assert.deepEqual(catalogVerification.metadataMismatches, []);
  const catalogSkillVerification = await verifyCatalogRepoLocalSkills({ repoRoot: sourceRoot });
  assert.equal(catalogSkillVerification.ok, true);
  assert.deepEqual(catalogSkillVerification.missingSkillFiles, []);
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, "MIT");
  assert.match(pkg.description ?? "", /opt-in overlay/i);
  assert.equal(pkg.scripts["check:happy-path"], "bash scripts/check-archon-happy-path.sh");
  assert.equal(
    pkg.scripts["scaffold:workflow"],
    "node --experimental-strip-types src/install/cli.ts scaffold-workflow --target ."
  );
  assert.equal(
    pkg.scripts["archon:autopilot-status"],
    "node --experimental-strip-types src/archon/autopilot-status.ts"
  );
  assert.equal(pkg.scripts["archon:loop"], "node --experimental-strip-types src/admin/archon.ts loop --format text");
  assert.equal(pkg.scripts["verify:release-overlay"], "bash scripts/verify-release-overlay.sh");
  for (const relativePath of overlayPortableAssets) {
    assert.ok(pkg.files.includes(relativePath), `${relativePath} should be shipped for the opt-in overlay`);
  }
  for (const relativePath of excludedOverlayFiles) {
    assert.ok(!pkg.files.includes(relativePath), `${relativePath} should stay out of the overlay package manifest`);
  }
  assert.deepEqual(auditMaintainerOnlyPublishedPaths(pkg.files), []);
  assert.ok(pkg.files.every((file) => !file.includes("*")));
});

test("package dry run includes the orchestration eval entrypoint exported by src/index.ts", async () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packResult = JSON.parse(await runNpmPackJsonDryRun(sourceRoot)) as Array<{
    files: Array<{
      path: string;
    }>;
  }>;

  const packedFiles = new Set(packResult[0]?.files.map((entry) => entry.path) ?? []);
  assert.ok(packedFiles.has("src/evals/orchestration-baseline.ts"));
  assert.ok(packedFiles.has("src/index.ts"));
});

test("installDevgodIntoProject dry-run reports planned changes without writing", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-install-dry-run-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    const initialPackageJson = '{ "name": "fixture", "private": true }\n';
    await writeFile(path.join(targetRoot, "package.json"), initialPackageJson, "utf8");

    const summary = await installDevgodIntoProject({
      sourceRoot,
      targetRoot,
      dryRun: true
    });

    assert.equal(summary.mode, "dry-run");
    assert.equal(summary.writesPerformed, false);
    assert.match(summary.nextSteps.join("\n"), /Rerun in apply mode to write changes/);
    assert.match(summary.nextSteps.join("\n"), /archon:setup:git-guard/);
    assert.match(summary.nextSteps.join("\n"), /archon:verify:git-guard/);
    assert.ok(summary.created.includes("CLAUDE.md"));
    assert.ok(summary.created.includes("scripts/archon-setup.sh"));
    assert.ok(summary.updated.includes("package.json"));
    assert.equal(summary.backups.length, 0);
    assert.equal(summary.plannedBackups.length, 1);
    assert.match(summary.plannedBackups[0], /\.archon\/install-backups\/.+\/package\.json/);

    assert.equal(await readFile(path.join(targetRoot, "package.json"), "utf8"), initialPackageJson);
    await assert.rejects(readFile(path.join(targetRoot, "CLAUDE.md"), "utf8"));
    await assert.rejects(readFile(path.join(targetRoot, "scripts/archon-setup.sh"), "utf8"));
    await assert.rejects(readFile(path.join(targetRoot, ".claude", "settings.json"), "utf8"));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("installDevgodIntoProject ships Playwright MCP configs and setup wiring", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-install-playwright-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n', "utf8");

    await installDevgodIntoProject({ sourceRoot, targetRoot });

    const codexConfig = await readFile(path.join(targetRoot, ".claude", "settings.json"), "utf8");
    const packageJson = JSON.parse(await readFile(path.join(targetRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const kernelAgents = await readFile(path.join(targetRoot, ".claude.md"), "utf8");
    const playwrightConfig = await readFile(path.join(targetRoot, ".archon", "playwright", "mcp.json"), "utf8");
    const playwrightVisionConfig = await readFile(
      path.join(targetRoot, ".archon", "playwright", "mcp.vision.json"),
      "utf8"
    );

    // archon uses JSON settings: mcpServers key instead of TOML [mcp_servers.*]
    assert.match(codexConfig, /"playwright"/);
    assert.match(codexConfig, /"playwright_vision"/);
    assert.equal(
      packageJson.scripts?.["archon:setup:playwright"],
      "node --experimental-strip-types ./node_modules/archon/src/install/setup-playwright.ts"
    );
    assert.equal(
      packageJson.scripts?.["archon:verify:playwright"],
      "node --experimental-strip-types ./node_modules/archon/src/install/setup-playwright.ts --verify"
    );
    assert.match(kernelAgents, /BEGIN ARCHON KERNEL/);
    assert.match(kernelAgents, /archon-intake/);
    assert.match(playwrightConfig, /"browserName": "chromium"/);
    assert.match(playwrightVisionConfig, /"vision"/);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("install CLI rejects flag-like values passed after --target", async () => {
  assert.throws(
    () => parseCliArgs(["--target", "--dry-run"]),
    /Target path must follow --target and cannot start with '-'/
  );
});

test("legacy direct install CLI invocation cannot mutate", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-install-cli-legacy-"));

  try {
    const initialPackageJson = '{ "name": "fixture", "private": true }\n';
    await writeFile(path.join(targetRoot, "package.json"), initialPackageJson, "utf8");

    assert.throws(
      () => parseCliArgs(["--target", targetRoot]),
      /Mutating installs require 'init --apply'/
    );

    assert.equal(await readFile(path.join(targetRoot, "package.json"), "utf8"), initialPackageJson);
    await assert.rejects(readFile(path.join(targetRoot, "CLAUDE.md"), "utf8"));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("install CLI init requires an explicit mode before writing", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-install-cli-init-mode-"));

  try {
    const initialPackageJson = '{ "name": "fixture", "private": true }\n';
    await writeFile(path.join(targetRoot, "package.json"), initialPackageJson, "utf8");

    assert.throws(
      () => parseCliArgs(["init", "--target", targetRoot]),
      /init requires exactly one of --apply or --dry-run/
    );

    assert.equal(await readFile(path.join(targetRoot, "package.json"), "utf8"), initialPackageJson);
    await assert.rejects(readFile(path.join(targetRoot, "CLAUDE.md"), "utf8"));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("parseCliArgs accepts upgrade-reasoning-workflow with explicit mode", () => {
  const parsed = parseCliArgs([
    "upgrade-reasoning-workflow",
    "--target",
    "/tmp/project",
    "--task-id",
    "task-123",
    "--mode",
    "strict"
  ]);

  assert.deepEqual(parsed, {
    command: "upgrade-reasoning-workflow",
    targetArg: "/tmp/project",
    taskId: "task-123",
    mode: "strict",
    force: false
  });
});

test("parseCliArgs defaults upgrade-reasoning-workflow mode to strict", () => {
  const parsed = parseCliArgs([
    "upgrade-reasoning-workflow",
    "--target",
    "/tmp/project",
    "--task-id",
    "task-123"
  ]);

  assert.deepEqual(parsed, {
    command: "upgrade-reasoning-workflow",
    targetArg: "/tmp/project",
    taskId: "task-123",
    mode: "strict",
    force: false
  });
});

test("parseCliArgs accepts Grafana install opt-in", () => {
  const parsed = parseCliArgs(["init", "--apply", "--with-grafana", "--target", "/tmp/project"]);

  assert.deepEqual(parsed, {
    command: "init",
    dryRun: false,
    targetArg: "/tmp/project",
    withGrafana: true
  });
});

test("upgradeReasoningWorkflowArtifacts backfills policy, attempts, and verdict into a legacy task packet", async () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-upgrade-reasoning-workflow-"));
  const taskId = "task-legacy-upgrade";

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n', "utf8");
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await mkdir(path.join(targetRoot, ".archon", "work", "tasks"), { recursive: true });

    await writeFile(
      path.join(targetRoot, ".archon", "work", "tasks", `task-${taskId}.md`),
      [
        "## Task ID",
        "",
        `\`${taskId}\``,
        "",
        "## Reasoning quality",
        "",
        "### Claim",
        "",
        "- legacy reasoning claim",
        "",
        "### Evidence refs",
        "",
        "- `src/core/service.ts`",
        "",
        "### Verification plan",
        "",
        "- `npm test`"
      ].join("\n"),
      "utf8"
    );

    const summary = await upgradeReasoningWorkflowArtifacts({
      sourceRoot,
      targetRoot,
      taskId,
      mode: "dual"
    });

    assert.deepEqual(summary.created, []);
    assert.deepEqual(summary.updated, [`.archon/work/tasks/task-${taskId}.md`]);

    const taskContent = await readFile(
      path.join(targetRoot, ".archon", "work", "tasks", `task-${taskId}.md`),
      "utf8"
    );
    assert.match(taskContent, /## Reasoning policy/);
    assert.match(taskContent, /`dual`/);
    assert.match(taskContent, /## Reasoning attempts/);
    assert.match(taskContent, /### Attempt records/);
    assert.match(taskContent, /### Verification records/);
    assert.match(taskContent, /### Verdict/);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("installDevgodIntoProject first apply backs up divergent managed content", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-install-backup-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const originalPackageJson = JSON.stringify(
    {
      name: "fixture",
      private: true,
      scripts: {
        test: "vitest"
      }
    },
    null,
    2
  ) + "\n";

  try {
    await writeFile(path.join(targetRoot, "package.json"), originalPackageJson, "utf8");

    const summary = await installDevgodIntoProject({
      sourceRoot,
      targetRoot
    });

    assert.equal(summary.mode, "apply");
    assert.equal(summary.backups.length, 1);
    assert.match(summary.backups[0], /^\.archon\/install-backups\/.+\/package\.json$/);

    const backupContent = await readFile(path.join(targetRoot, summary.backups[0]), "utf8");
    assert.equal(backupContent, originalPackageJson);

    const installedPackageJson = JSON.parse(
      await readFile(path.join(targetRoot, "package.json"), "utf8")
    ) as { devDependencies: Record<string, string>; scripts: Record<string, string> };
    assert.equal(installedPackageJson.scripts.test, "vitest");
    assert.ok(installedPackageJson.devDependencies.archon);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("installDevgodIntoProject always adds graphify scripts and selective gitignore", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-install-graphify-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');

    const summary = await installDevgodIntoProject({ sourceRoot, targetRoot });
    const packageJson = JSON.parse(await readFile(path.join(targetRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const gitignore = await readFile(path.join(targetRoot, ".gitignore"), "utf8");

    assert.equal(packageJson.scripts["archon:graphify:build"], "graphify . --wiki");
    assert.equal(packageJson.scripts["archon:graphify:update"], "graphify . --update --wiki");
    assert.match(gitignore, /graphify-out\/\*/);
    assert.match(gitignore, /!graphify-out\/GRAPH_REPORT\.md/);
    assert.match(summary.nextSteps.join("\n"), /archon:setup:git-guard/);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("installDevgodIntoProject opt-in Grafana setup adds MCP config, env guidance, and helper script", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-install-grafana-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');

    const summary = await installDevgodIntoProject({
      sourceRoot,
      targetRoot,
      withGrafana: true
    });

    const packageJson = JSON.parse(await readFile(path.join(targetRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const codexConfig = await readFile(path.join(targetRoot, ".claude", "settings.json"), "utf8");
    const envExample = await readFile(path.join(targetRoot, ".env.archon.example"), "utf8");

    assert.equal(
      packageJson.scripts["archon:grafana:mcp"],
      "node --experimental-strip-types ./node_modules/archon/src/grafana/mcp-server.ts"
    );
    // archon uses JSON settings (not TOML), check JSON patterns
    assert.match(codexConfig, /"grafana"/);
    assert.match(codexConfig, /src\/grafana\/mcp-server\.ts/);
    assert.match(envExample, /ARCHON_GRAFANA_URL=/);
    assert.match(envExample, /ARCHON_GRAFANA_LOGS_DATASOURCE_UID=/);
    assert.match(summary.nextSteps.join("\n"), /ARCHON_GRAFANA_URL/);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("installDevgodIntoProject auto-detects configured Grafana env and adds MCP wiring", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-install-grafana-detected-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await writeFile(
      path.join(targetRoot, ".env.archon"),
      [
        "ARCHON_GRAFANA_URL=https://grafana.example.com",
        "ARCHON_GRAFANA_TOKEN=env-file-token",
        ""
      ].join("\n"),
      "utf8"
    );

    await installDevgodIntoProject({
      sourceRoot,
      targetRoot
    });

    const packageJson = JSON.parse(await readFile(path.join(targetRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const codexConfig = await readFile(path.join(targetRoot, ".claude", "settings.json"), "utf8");

    assert.equal(
      packageJson.scripts["archon:grafana:mcp"],
      "node --experimental-strip-types ./node_modules/archon/src/grafana/mcp-server.ts"
    );
    // archon uses JSON settings (not TOML)
    assert.match(codexConfig, /"grafana"/);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("install CLI init --apply is explicit, replay-safe, and does not run docker", async () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-install-cli-apply-"));
  const binDir = path.join(targetRoot, "bin");
  const dockerSentinel = path.join(targetRoot, "docker-called");

  try {
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');

    await writeExecutable(
      path.join(binDir, "docker"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `: > "${dockerSentinel}"`,
        "exit 0"
      ].join("\n")
    );

    await execFileAsync(
      "node",
      ["--experimental-strip-types", "src/install/cli.ts", "init", "--apply", "--target", targetRoot],
      {
        cwd: sourceRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`
        }
      }
    );

    const installedPackageJson = JSON.parse(
      await readFile(path.join(targetRoot, "package.json"), "utf8")
    ) as { devDependencies: Record<string, string> };
    assert.ok(installedPackageJson.devDependencies.archon);

    const reviewIdentityAdapter = await readFile(
      path.join(targetRoot, "archon/review-identity-adapter.ts"),
      "utf8"
    );
    assert.match(reviewIdentityAdapter, /Implement archon\/review-identity-adapter\.ts/);

    await assert.rejects(readFile(path.join(targetRoot, ".env"), "utf8"));
    await assert.rejects(readFile(dockerSentinel, "utf8"));

    await execFileAsync(
      "node",
      ["--experimental-strip-types", "src/install/cli.ts", "init", "--apply", "--target", targetRoot],
      {
        cwd: sourceRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`
        }
      }
    );

    const manifestContent = await readFile(
      path.join(targetRoot, ".archon", "install-manifest.json"),
      "utf8"
    );
    assert.match(manifestContent, /"target": "CLAUDE\.md"/);
    await assert.rejects(readFile(dockerSentinel, "utf8"));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("verifyDevgodInstall verifies graphify-enabled install correctly", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-verify-graphify-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });

    const summary = await verifyDevgodInstall({
      sourceRoot,
      targetRoot
    });

    assert.equal(summary.ok, true);
    assert.deepEqual(summary.missing, []);
    assert.deepEqual(summary.modified, []);
    assert.deepEqual(summary.orphans, []);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("verifyDevgodInstall auto-detects the Grafana install option", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-verify-grafana-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot, withGrafana: true });

    const summary = await verifyDevgodInstall({
      sourceRoot,
      targetRoot
    });

    assert.equal(summary.ok, true);
    assert.deepEqual(summary.missing, []);
    assert.deepEqual(summary.modified, []);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("upgradeDevgodInProject preserves graphify scripts without repeating the flag", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-upgrade-graphify-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });

    const replay = await upgradeDevgodInProject({
      sourceRoot,
      targetRoot
    });

    assert.equal(replay.conflicts.length, 0);
    assert.deepEqual(replay.created.sort(), [
      ".archon/runtime/backup-manifest.json",
      ".archon/runtime/migration-report.json",
      ".archon/runtime/registration-intent.json"
    ]);
    assert.equal(replay.updated.length, 0);
    assert.equal(replay.writesPerformed, true);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("upgradeDevgodInProject dry-run reports managed drift without writing", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-upgrade-dry-run-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const driftedContent = "#!/usr/bin/env bash\necho drifted-managed-file\n";
  const unmanagedFile = path.join(targetRoot, "notes.txt");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await writeFile(path.join(targetRoot, driftFixtureTarget), driftedContent, "utf8");
    await writeFile(unmanagedFile, "leave me alone\n", "utf8");

    const summary = await upgradeDevgodInProject({
      sourceRoot,
      targetRoot,
      dryRun: true
    });

    assert.equal(summary.mode, "dry-run");
    assert.equal(summary.writesPerformed, false);
    assert.ok(summary.updated.includes(driftFixtureTarget));
    assert.equal(summary.backups.length, 0);
    assert.equal(summary.plannedBackups.length, 1);
    assert.match(
      summary.plannedBackups[0],
      /^\.archon\/install-backups\/.+\/scripts\/check-archon-workflow\.ts$/
    );
    assert.equal(await readFile(path.join(targetRoot, driftFixtureTarget), "utf8"), driftedContent);
    assert.equal(await readFile(unmanagedFile, "utf8"), "leave me alone\n");
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("upgradeDevgodInProject apply restores managed drift and backs it up", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-upgrade-apply-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const driftedContent = "#!/usr/bin/env bash\necho drifted-managed-file\n";
  const unmanagedFile = path.join(targetRoot, "notes.txt");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await writeFile(path.join(targetRoot, driftFixtureTarget), driftedContent, "utf8");
    await writeFile(unmanagedFile, "leave me alone\n", "utf8");

    const summary = await upgradeDevgodInProject({
      sourceRoot,
      targetRoot
    });

    assert.equal(summary.mode, "apply");
    assert.ok(summary.updated.includes(driftFixtureTarget));
    assert.equal(summary.backups.length, 1);
    assert.match(summary.backups[0], /^\.archon\/install-backups\/.+\/scripts\/check-archon-workflow\.ts$/);

    const backupContent = await readFile(path.join(targetRoot, summary.backups[0]), "utf8");
    assert.equal(backupContent, driftedContent);
    assert.equal(
      await readFile(path.join(targetRoot, driftFixtureTarget), "utf8"),
      await readFile(path.join(sourceRoot, driftFixtureTarget), "utf8")
    );
    assert.equal(await readFile(unmanagedFile, "utf8"), "leave me alone\n");
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("upgradeDevgodInProject replay apply is a no-op after drift is reconciled", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-upgrade-replay-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await writeFile(path.join(targetRoot, driftFixtureTarget), "#!/usr/bin/env bash\necho drifted-managed-file\n", "utf8");

    await upgradeDevgodInProject({
      sourceRoot,
      targetRoot
    });

    const replay = await upgradeDevgodInProject({
      sourceRoot,
      targetRoot
    });

    assert.equal(replay.mode, "apply");
    assert.equal(replay.created.length, 0);
    assert.equal(replay.updated.length, 0);
    assert.equal(replay.backups.length, 0);
    assert.equal(replay.plannedBackups.length, 0);
    assert.equal(replay.writesPerformed, false);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("verifyDevgodInstall passes when managed files match the install manifest", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-verify-pass-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });

    const summary = await verifyDevgodInstall({
      sourceRoot,
      targetRoot
    });

    assert.equal(summary.ok, true);
    assert.deepEqual(summary.missing, []);
    assert.deepEqual(summary.modified, []);
    assert.deepEqual(summary.orphans, []);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("verifyDevgodInstall reports missing managed files", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-verify-missing-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await rm(path.join(targetRoot, driftFixtureTarget));

    const summary = await verifyDevgodInstall({
      sourceRoot,
      targetRoot
    });

    assert.equal(summary.ok, false);
    assert.ok(summary.missing.includes(driftFixtureTarget));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("verifyDevgodInstall reports modified managed files", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-verify-modified-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await writeFile(path.join(targetRoot, driftFixtureTarget), "#!/usr/bin/env bash\necho drifted-managed-file\n", "utf8");

    const summary = await verifyDevgodInstall({
      sourceRoot,
      targetRoot
    });

    assert.equal(summary.ok, false);
    assert.ok(summary.modified.includes(driftFixtureTarget));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("verify CLI succeeds for legacy installs without an install manifest", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-verify-cli-legacy-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await rm(path.join(targetRoot, ".archon", "install-manifest.json"));

    await execFileAsync(
      "node",
      ["--experimental-strip-types", "src/install/cli.ts", "verify", "--target", targetRoot],
      { cwd: sourceRoot }
    );
    const summary = await verifyDevgodInstall({
      sourceRoot,
      targetRoot
    });
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.missing, []);
    assert.deepEqual(summary.modified, []);
    assert.deepEqual(summary.orphans, []);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("upgradeDevgodInProject legacy installs backfill the manifest and count manifest-only writes", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-upgrade-legacy-backfill-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await rm(path.join(targetRoot, ".archon", "install-manifest.json"));

    const summary = await upgradeDevgodInProject({
      sourceRoot,
      targetRoot
    });

    assert.equal(summary.mode, "apply");
    assert.deepEqual(summary.created.sort(), [
      ".archon/runtime/backup-manifest.json",
      ".archon/runtime/migration-report.json",
      ".archon/runtime/registration-intent.json"
    ]);
    assert.equal(summary.updated.length, 0);
    assert.equal(summary.backups.length, 0);
    assert.equal(summary.writesPerformed, true);

    const manifest = JSON.parse(
      await readFile(path.join(targetRoot, ".archon", "install-manifest.json"), "utf8")
    ) as { files: Array<{ target: string }> };
    assert.ok(manifest.files.some((entry) => entry.target === driftFixtureTarget));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("upgradeDevgodInProject writes runtime migration artifacts for legacy installs", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-upgrade-runtime-artifacts-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await rm(path.join(targetRoot, ".archon", "install-manifest.json"));

    const summary = await upgradeDevgodInProject({
      sourceRoot,
      targetRoot
    });

    assert.equal(summary.mode, "apply");
    assert.equal(summary.runtimeRegistration, ".archon/runtime/registration-intent.json");
    assert.equal(summary.runtimeBackupManifest, ".archon/runtime/backup-manifest.json");
    assert.equal(summary.runtimeMigrationReport, ".archon/runtime/migration-report.json");

    const registration = JSON.parse(
      await readFile(path.join(targetRoot, summary.runtimeRegistration ?? ""), "utf8")
    ) as {
      repoPath: string;
      runtimeProfile: string;
    };
    assert.equal(registration.repoPath, targetRoot);
    assert.equal(registration.runtimeProfile, "local-docker");

    const backupManifest = JSON.parse(
      await readFile(path.join(targetRoot, summary.runtimeBackupManifest ?? ""), "utf8")
    ) as {
      files: Array<{ target: string }>;
    };
    assert.ok(backupManifest.files.some((entry) => entry.target === "CLAUDE.md"));

    const migrationReport = JSON.parse(
      await readFile(path.join(targetRoot, summary.runtimeMigrationReport ?? ""), "utf8")
    ) as {
      status: string;
      verification: {
        commands: string[];
      };
    };
    assert.equal(migrationReport.status, "planned");
    assert.deepEqual(migrationReport.verification.commands, [
      "npm run archon:doctor",
      "npm run archon:verify:setup"
    ]);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("upgradeDevgodInProject derives runtime migration artifacts from target repo env", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-upgrade-runtime-env-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await writeFile(
      path.join(targetRoot, ".env.archon"),
      [
        "ARCHON_RUNTIME_DATA_ROOT=./runtime-state",
        ""
      ].join("\n"),
      "utf8"
    );
    await rm(path.join(targetRoot, ".archon", "install-manifest.json"));

    const summary = await upgradeDevgodInProject({
      sourceRoot,
      targetRoot
    });
    const registration = JSON.parse(
      await readFile(path.join(targetRoot, summary.runtimeRegistration ?? ""), "utf8")
    ) as {
      dataRoot: string;
    };

    assert.equal(registration.dataRoot, path.join(targetRoot, "runtime-state"));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("upgradeDevgodInProject refuses to follow runtime artifact symlinks outside the target root", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-upgrade-runtime-symlink-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "archon-upgrade-runtime-symlink-outside-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await rm(path.join(targetRoot, ".archon"), { recursive: true, force: true });
    await mkdir(path.join(targetRoot, ".archon"), { recursive: true });
    await symlink(path.join(outsideRoot, "runtime"), path.join(targetRoot, ".archon", "runtime"));
    await rm(path.join(targetRoot, ".archon", "install-manifest.json"), { force: true });

    await assert.rejects(
      upgradeDevgodInProject({
        sourceRoot,
        targetRoot
      }),
      /Runtime artifact at \.archon\/runtime\/registration-intent\.json is not an in-root regular file/
    );
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("upgradeDevgodInProject reports orphaned manifest-managed files", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-upgrade-orphans-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const orphanTarget = "scripts/legacy-managed.sh";

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await writeFile(path.join(targetRoot, orphanTarget), "#!/usr/bin/env bash\necho orphan\n", "utf8");

    const manifestPath = path.join(targetRoot, ".archon", "install-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      files: Array<{ contentHash: string; strategy: "merge" | "replace"; target: string }>;
      version: number;
    };
    manifest.files.push({
      target: orphanTarget,
      strategy: "replace",
      contentHash: hashContent("#!/usr/bin/env bash\necho orphan\n")
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const summary = await upgradeDevgodInProject({
      sourceRoot,
      targetRoot,
      dryRun: true
    });

    assert.deepEqual(summary.orphans, [orphanTarget]);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("upgradeDevgodInProject reports conflicts when the manifest baseline diverges from target and desired content", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-upgrade-conflict-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await writeFile(path.join(targetRoot, driftFixtureTarget), "#!/usr/bin/env bash\necho local-drift\n", "utf8");

    const manifestPath = path.join(targetRoot, ".archon", "install-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      files: Array<{ contentHash: string; strategy: "merge" | "replace"; target: string }>;
      version: number;
    };
    const record = manifest.files.find((entry) => entry.target === driftFixtureTarget);
    assert.ok(record);
    record.contentHash = hashContent("#!/usr/bin/env bash\necho stale-baseline\n");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const summary = await upgradeDevgodInProject({
      sourceRoot,
      targetRoot,
      dryRun: true
    });

    assert.deepEqual(summary.conflicts, [driftFixtureTarget]);
    assert.equal(summary.updated.length, 0);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("verifyDevgodInstall treats managed symlinks as drift and does not read through them", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-verify-symlink-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "archon-outside-"));
  const outsideFile = path.join(outsideRoot, "outside-check-archon-workflow.sh");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await writeFile(outsideFile, "#!/usr/bin/env bash\necho outside\n", "utf8");
    await rm(path.join(targetRoot, driftFixtureTarget));
    await symlink(outsideFile, path.join(targetRoot, driftFixtureTarget));

    const summary = await verifyDevgodInstall({
      sourceRoot,
      targetRoot
    });

    assert.equal(summary.ok, false);
    assert.ok(summary.modified.includes(driftFixtureTarget));
    assert.equal(await readFile(outsideFile, "utf8"), "#!/usr/bin/env bash\necho outside\n");
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("upgradeDevgodInProject refuses to follow managed symlinks outside the target root", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-upgrade-symlink-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "archon-upgrade-symlink-outside-"));
  const outsideFile = path.join(outsideRoot, "outside-check-archon-workflow.sh");

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await writeFile(outsideFile, "#!/usr/bin/env bash\necho outside\n", "utf8");
    await rm(path.join(targetRoot, driftFixtureTarget));
    await symlink(outsideFile, path.join(targetRoot, driftFixtureTarget));

    const summary = await upgradeDevgodInProject({
      sourceRoot,
      targetRoot
    });

    assert.deepEqual(summary.conflicts, [driftFixtureTarget]);
    assert.equal(summary.updated.length, 0);
    assert.equal(summary.writesPerformed, false);
    assert.equal(await readFile(outsideFile, "utf8"), "#!/usr/bin/env bash\necho outside\n");
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("installDevgodIntoProject seeds scaffolding but not live work or reviewed memory", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-install-test-"));
  await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');

  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await installDevgodIntoProject({ sourceRoot, targetRoot });

  const agentsMd = await readFile(path.join(targetRoot, "CLAUDE.md"), "utf8");
  assert.match(agentsMd, /## Department Workflow/);
  assert.match(agentsMd, /<!-- archon-workflow-contract:start -->/);
  assert.match(agentsMd, /<!-- archon-workflow-contract:end -->/);
  assert.match(agentsMd, /workflow=archon/);
  assert.match(agentsMd, /workflow_runtime=postgres/);
  assert.match(agentsMd, /local_live_check=bash scripts\/check-archon-workflow-live\.sh \[--task-id <task-id>\]/);
  assert.doesNotMatch(agentsMd, /\.archon\/ACTIVE/);
  assert.match(agentsMd, /`reviewer`, `qa_engineer`, and `security_reviewer` gates/);
  assert.match(agentsMd, /workflow-proof --run-id latest --task-id/);
  assert.match(agentsMd, /explicit workflow artifact refs/);
  assert.match(agentsMd, /review_exports=runtime_optional/);

  const memoryReadme = await readFile(path.join(targetRoot, ".archon/memory/README.md"), "utf8");
  assert.match(memoryReadme, /archon memory/i);

  const installedSkills = [
    ".claude/skills/anthropic-mcp-builder/SKILL.md",
    ".claude/skills/anthropic-webapp-testing/SKILL.md",
    ".claude/skills/archon-accessibility-gate/SKILL.md",
    ".claude/skills/archon-agent-runtime/SKILL.md",
    ".claude/skills/archon-architecture/SKILL.md",
    ".claude/skills/archon-autopilot/SKILL.md",
    ".claude/skills/archon-compliance-review/SKILL.md",
    ".claude/skills/archon-context-retrieval/SKILL.md",
    ".claude/skills/archon-debugging/SKILL.md",
    ".claude/skills/archon-design-system/SKILL.md",
    ".claude/skills/archon-docs-research/SKILL.md",
    ".claude/skills/archon-e2e/SKILL.md",
    ".claude/skills/archon-eval-engineering/SKILL.md",
    ".claude/skills/archon-execution/SKILL.md",
    ".claude/skills/archon-frontend-taste/SKILL.md",
    ".claude/skills/archon-git-operator/SKILL.md",
    ".claude/skills/archon-graphify/SKILL.md",
    ".claude/skills/archon-infra-ops/SKILL.md",
    ".claude/skills/archon-intake/SKILL.md",
    ".claude/skills/archon-memory/SKILL.md",
    ".claude/skills/archon-planning/SKILL.md",
    ".claude/skills/archon-product-analysis/SKILL.md",
    ".claude/skills/archon-product-framing/SKILL.md",
    ".claude/skills/archon-qa-verification/SKILL.md",
    ".claude/skills/archon-release-readiness/SKILL.md",
    ".claude/skills/archon-repair-loop/SKILL.md",
    ".claude/skills/archon-review/SKILL.md",
    ".claude/skills/archon-setup/SKILL.md",
    ".claude/skills/archon-skill-evals/SKILL.md",
    ".claude/skills/archon-tdd/SKILL.md",
    ".claude/skills/archon-technical-writing/SKILL.md",
    ".claude/skills/archon-ui-patterns/SKILL.md",
    ".claude/skills/archon-ux-research/SKILL.md",
    ".claude/skills/archon-visual-standards/SKILL.md",
    ".claude/skills/superpowers-finishing-development-branch/SKILL.md",
    ".claude/skills/superpowers-using-git-worktrees/SKILL.md"
  ];

  for (const relativePath of installedSkills) {
    const content = await readFile(path.join(targetRoot, relativePath), "utf8");
    assert.match(content, /^---/m, `${relativePath} should install a skill file`);
  }
  const installedCatalogSkillVerification = await verifyCatalogRepoLocalSkills({ repoRoot: targetRoot });
  assert.equal(installedCatalogSkillVerification.ok, true);
  assert.deepEqual(installedCatalogSkillVerification.missingSkillFiles, []);

  const productStateTemplate = await readFile(
    path.join(targetRoot, ".archon", "templates", "product-state.md"),
    "utf8"
  );
  assert.match(productStateTemplate, /# Product State/);

  const reviewGateTemplate = await readFile(
    path.join(targetRoot, ".archon", "templates", "review-gate.md"),
    "utf8"
  );
  assert.match(reviewGateTemplate, /Playwright evidence refs/i);
  assert.match(reviewGateTemplate, /desktop\/mobile coverage/i);

  const taskQueueTemplate = await readFile(
    path.join(targetRoot, ".archon", "templates", "task-queue.json"),
    "utf8"
  );
  assert.match(taskQueueTemplate, /"project_status": "not_started"/);

  const installedWorkflowChecker = await readFile(
    path.join(targetRoot, "scripts/check-archon-workflow.ts"),
    "utf8"
  );
  assert.match(installedWorkflowChecker, /archon workflow artifact check passed/);

  const installedLiveWorkflowChecker = await readFile(
    path.join(targetRoot, "scripts/check-archon-workflow-live.sh"),
    "utf8"
  );
  assert.match(installedLiveWorkflowChecker, /scripts\/check-archon-workflow\.ts/);

  const installedAgents = [
    ".claude/agents/build-resolver/AGENT.md",
    ".claude/agents/docs-researcher/AGENT.md",
    ".claude/agents/git-operator/AGENT.md",
    ".claude/agents/reviewer/AGENT.md",
    ".claude/agents/tdd-guide/AGENT.md",
    ".claude/agents/e2e-runner/AGENT.md",
    ".claude/agents/release-readiness/AGENT.md"
  ];

  for (const relativePath of installedAgents) {
    const content = await readFile(path.join(targetRoot, relativePath), "utf8");
    assert.match(content, /^---/m, `${relativePath} should install an agent file`);
  }

  const retrievalPolicy = await readFile(
    path.join(targetRoot, ".archon/rules/role-retrieval-policy.md"),
    "utf8"
  );
  assert.match(retrievalPolicy, /Derived retrieval is a hint layer/i);

  const reviewIdentityBindings = await readFile(
    path.join(targetRoot, ".archon/review-identity-bindings.json"),
    "utf8"
  );
  assert.match(reviewIdentityBindings, /replace-with-authenticated-user-id/);

  const reviewIdentityFixtures = await readFile(
    path.join(targetRoot, ".archon/review-identity-adapter.fixture.json"),
    "utf8"
  );
  assert.match(reviewIdentityFixtures, /deny unverified principal/);

  const reviewIdentityAdapter = await readFile(
    path.join(targetRoot, "archon/review-identity-adapter.ts"),
    "utf8"
  );
  assert.match(reviewIdentityAdapter, /Implement archon\/review-identity-adapter\.ts/);

  const targetPackageJson = JSON.parse(
    await readFile(path.join(targetRoot, "package.json"), "utf8")
  ) as { scripts: Record<string, string> };
  assert.match(
    targetPackageJson.scripts["archon:upgrade-reasoning-workflow"],
    /node_modules\/archon\/src\/admin\/archon\.ts upgrade-reasoning-workflow --target \./
  );
  assert.match(
    targetPackageJson.scripts["archon:seed-happy-path-fixture"],
    /node_modules\/archon\/src\/admin\/archon\.ts seed-happy-path-fixture --target \./
  );
  assert.match(
    targetPackageJson.scripts["archon:seed-workflow-proof"],
    /node_modules\/archon\/src\/admin\/archon\.ts seed-workflow-proof/
  );
  assert.match(targetPackageJson.scripts.archon, /node_modules\/archon\/src\/admin\/archon\.ts/);
  assert.match(
    targetPackageJson.scripts["archon:status"],
    /node_modules\/archon\/src\/admin\/archon\.ts status/
  );
  assert.match(
    targetPackageJson.scripts["archon:coverage"],
    /node_modules\/archon\/src\/admin\/archon\.ts coverage --format text/
  );
  assert.match(
    targetPackageJson.scripts["archon:gaps"],
    /node_modules\/archon\/src\/admin\/archon\.ts gaps --format text/
  );
  assert.match(
    targetPackageJson.scripts["archon:checkpoint"],
    /node_modules\/archon\/src\/admin\/archon\.ts checkpoint --format text/
  );
  assert.match(
    targetPackageJson.scripts["archon:resume"],
    /node_modules\/archon\/src\/admin\/archon\.ts resume --format text/
  );
  assert.match(
    targetPackageJson.scripts["archon:supervisor-history"],
    /node_modules\/archon\/src\/admin\/archon\.ts supervisor-history --format text/
  );
  assert.match(
    targetPackageJson.scripts["archon:heal"],
    /node_modules\/archon\/src\/admin\/archon\.ts doctor --repair/
  );
  assert.match(
    targetPackageJson.scripts["archon:reconcile"],
    /node_modules\/archon\/src\/admin\/archon\.ts reconcile-runtime-state --apply --format text/
  );
  assert.match(
    targetPackageJson.scripts["archon:verify:review-identity"],
    /node_modules\/archon\/src\/admin\/archon\.ts verify-review-identity/
  );
  assert.match(
    targetPackageJson.scripts["archon:refresh-repo-context"],
    /node_modules\/archon\/src\/admin\/archon\.ts refresh-repo-context/
  );
  assert.match(
    targetPackageJson.scripts["archon:repair-task-queue"],
    /node_modules\/archon\/src\/admin\/archon\.ts repair-task-queue/
  );
  assert.match(
    targetPackageJson.scripts["archon:autopilot-status"],
    /node_modules\/archon\/src\/archon\/autopilot-status\.ts/
  );
  assert.equal(
    targetPackageJson.scripts["archon:verify:git-guard"],
    "node --experimental-strip-types ./node_modules/archon/src/install/verify-git-guard.ts"
  );
  assert.match(
    targetPackageJson.scripts["archon:record-review"],
    /node_modules\/archon\/src\/admin\/archon\.ts record-review --input \.archon\/review-action\.json/
  );
  assert.equal(
    targetPackageJson.scripts["archon:setup:git-guard"],
    "node --experimental-strip-types ./node_modules/archon/src/install/setup-git-guard.ts"
  );

  await assert.rejects(
    readFile(path.join(targetRoot, ".archon/memory/project-profile.md"), "utf8")
  );
  await assert.rejects(
    readFile(path.join(targetRoot, ".archon/work/briefs/brief-2026-04-25-bitbat-rebuild.md"), "utf8")
  );
});

test("setup scripts treat env files as data and keep repo defaults aligned", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-setup-guard-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const binDir = path.join(targetRoot, "bin");
  const captureFile = path.join(targetRoot, "captured-env.txt");
  const sentinel = path.join(targetRoot, "env-executed");

  try {
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');

    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await writeHealthcheckNodeStub(binDir);

    const setupScriptPath = path.join(targetRoot, "scripts", "archon-setup.sh");
    const setupScript = await readFile(setupScriptPath, "utf8");
    const setupPowerShell = await readFile(path.join(targetRoot, "scripts", "archon-setup.ps1"), "utf8");

    assert.doesNotMatch(setupScript, /\bsource\s+\.\/\.env\.archon\b/);
    assert.doesNotMatch(setupPowerShell, /Get-Content "\.env\.archon"/);
    assert.match(setupPowerShell, /Test-ArchonSafeEnvKey/);
    assert.match(setupPowerShell, /Strip-ArchonUnquotedComment/);
    assert.match(setupPowerShell, /Unescape-ArchonDoubleQuotedValue/);
    assert.match(setupPowerShell, /\^ARCHON_\[A-Z0-9_\]\+\$/);
    assert.match(setupPowerShell, /ToLowerInvariant\(\)/);

    await writeFile(
      path.join(targetRoot, ".env"),
      [
        "ARCHON_WORKSPACE_SLUG=team # trailing comment",
        'ARCHON_PROJECT_NAME="Alpha Team" # trailing comment',
        'ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE="./archon/review-identity-adapter.ts" # module comment',
        'ARCHON_POSTGRES_USER=\'quoted user\'',
        'ARCHON_POSTGRES_PASSWORD="pa\\"ss # literal"',
        "PATH=/tmp/evil",
        `NODE_OPTIONS=--require ${sentinel}`,
        `BASH_ENV=${sentinel}`,
        `LD_PRELOAD=${sentinel}`,
        `npm_config_cache=${sentinel}`,
        ""
      ].join("\n"),
      "utf8"
    );

    await writeFile(
      path.join(binDir, "docker"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "${1:-}" == "version" ]]; then exit 0; fi',
        'if [[ "${1:-}" == "compose" ]]; then exit 0; fi',
        'if [[ "${1:-}" == "inspect" ]]; then printf "healthy"; exit 0; fi',
        'if [[ "${1:-}" == "logs" ]]; then exit 0; fi',
        'exit 0'
      ].join("\n") + "\n",
      "utf8"
    );
    await chmod(path.join(binDir, "docker"), 0o755);

    await writeFile(
      path.join(binDir, "npm"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'capture="${ARCHON_ENV_CAPTURE_FILE:?missing capture file}"',
        'cat > "$capture" <<EOF',
        "PATH=$PATH",
        "NODE_OPTIONS=${NODE_OPTIONS:-}",
        "BASH_ENV=${BASH_ENV:-}",
        "LD_PRELOAD=${LD_PRELOAD:-}",
        "npm_config_cache=${npm_config_cache:-}",
        "ARCHON_WORKSPACE_SLUG=${ARCHON_WORKSPACE_SLUG:-}",
        "ARCHON_PROJECT_NAME=${ARCHON_PROJECT_NAME:-}",
        "ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE=${ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE:-}",
        "ARCHON_POSTGRES_USER=${ARCHON_POSTGRES_USER:-}",
        "ARCHON_POSTGRES_PASSWORD=${ARCHON_POSTGRES_PASSWORD:-}",
        'EOF',
        "exit 0"
      ].join("\n") + "\n",
      "utf8"
    );
    await chmod(path.join(binDir, "npm"), 0o755);

    await execFileAsync("bash", [setupScriptPath], {
      cwd: targetRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        NODE_OPTIONS: "baseline-node-options",
        BASH_ENV: "baseline-bash-env",
        LD_PRELOAD: "baseline-ld-preload",
        npm_config_cache: "baseline-npm-cache",
        ARCHON_ENV_CAPTURE_FILE: captureFile
      }
    });

    const captured = await readFile(captureFile, "utf8");
    assert.match(captured, /^PATH=.+/m);
    assert.match(captured, /NODE_OPTIONS=baseline-node-options/);
    assert.match(captured, /BASH_ENV=baseline-bash-env/);
    assert.match(captured, /LD_PRELOAD=baseline-ld-preload/);
    assert.match(captured, /npm_config_cache=baseline-npm-cache/);
    assert.match(captured, /ARCHON_WORKSPACE_SLUG=team/);
    assert.match(captured, /ARCHON_PROJECT_NAME=Alpha Team/);
    assert.match(captured, /ARCHON_REVIEW_IDENTITY_ADAPTER_MODULE=\.\/archon\/review-identity-adapter\.ts/);
    assert.match(captured, /ARCHON_POSTGRES_USER=quoted user/);
    assert.match(captured, /ARCHON_POSTGRES_PASSWORD=pa"ss # literal/);
    await assert.rejects(readFile(sentinel, "utf8"));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("installed setup script bootstraps a clean workspace with synthetic docker and npm", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-setup-smoke-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const binDir = path.join(targetRoot, "bin");
  const dockerLog = path.join(targetRoot, "docker-log.txt");
  const dockerComposeSentinel = path.join(targetRoot, "docker-compose-called");
  const npmLog = path.join(targetRoot, "npm-log.txt");
  const npmEnvCapture = path.join(targetRoot, "npm-env.txt");

  try {
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await writeFile(
      path.join(targetRoot, ".env.example"),
      await readFile(path.join(sourceRoot, ".env.example"), "utf8"),
      "utf8"
    );

    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await writeHealthcheckNodeStub(binDir);

    await writeExecutable(
      path.join(binDir, "docker"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'log_file="${ARCHON_DOCKER_LOG_FILE:?missing docker log file}"',
        "case \"${1:-}\" in",
        "  version)",
        '    printf "%s\\n" "version" >> "$log_file"',
        "    exit 0",
        "    ;;",
        "  compose)",
        '    printf "%s\\n" "$*" >> "$log_file"',
        '    : > "${ARCHON_DOCKER_COMPOSE_SENTINEL:?missing compose sentinel}"',
        "    exit 0",
        "    ;;",
        "  inspect)",
        '    printf "%s\\n" "$*" >> "$log_file"',
        '    [[ -f "${ARCHON_DOCKER_COMPOSE_SENTINEL:?missing compose sentinel}" ]]',
        '    printf "%s" "healthy"',
        "    exit 0",
        "    ;;",
        "  logs)",
        '    printf "%s\\n" "$*" >> "$log_file"',
        "    exit 0",
        "    ;;",
        "  *)",
        '    printf "unexpected docker call: %s\\n" "$*" >&2',
        "    exit 1",
        "    ;;",
        "esac"
      ].join("\n")
    );

    await writeExecutable(
      path.join(binDir, "npm"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "%s\\n" "$*" >> "${ARCHON_NPM_LOG_FILE:?missing npm log file}"',
        'capture_file="${ARCHON_NPM_ENV_CAPTURE_FILE:?missing npm env capture file}"',
        'if [[ ! -f "$capture_file" ]]; then',
        '  cat > "$capture_file" <<EOF',
        "ARCHON_WORKSPACE_SLUG=${ARCHON_WORKSPACE_SLUG:-}",
        "ARCHON_PROJECT_SLUG=${ARCHON_PROJECT_SLUG:-}",
        "ARCHON_PROJECT_NAME=${ARCHON_PROJECT_NAME:-}",
        "ARCHON_PROJECT_REPO_PATH=${ARCHON_PROJECT_REPO_PATH:-}",
        "ARCHON_DOCKER_CONTAINER_NAME=${ARCHON_DOCKER_CONTAINER_NAME:-}",
        "EOF",
        "fi",
        "case \"${1:-}\" in",
        "  install)",
        "    exit 0",
        "    ;;",
        "  run)",
        "    case \"${2:-}\" in",
        "      archon:setup:playwright|archon:migrate|archon:bootstrap|archon:repair-task-queue|archon:refresh-repo-context|archon:verify:setup|archon:verify:playwright|archon:refresh-retrieval|archon:refresh-retrieval:fast)",
        "        exit 0",
        "        ;;",
        "    esac",
        "    ;;",
        "esac",
        'printf "unexpected npm call: %s\\n" "$*" >&2',
        "exit 1"
      ].join("\n")
    );

    await execFileAsync("bash", [path.join(targetRoot, "scripts", "archon-setup.sh")], {
      cwd: targetRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHON_DOCKER_LOG_FILE: dockerLog,
        ARCHON_DOCKER_COMPOSE_SENTINEL: dockerComposeSentinel,
        ARCHON_NPM_LOG_FILE: npmLog,
        ARCHON_NPM_ENV_CAPTURE_FILE: npmEnvCapture
      }
    });

    const npmCalls = (await readFile(npmLog, "utf8")).trim().split(/\n+/);
    assert.deepEqual(npmCalls, [
      "install",
      "run archon:setup:playwright",
      "run archon:migrate",
      "run archon:bootstrap",
      "run archon:refresh-repo-context",
      "run archon:refresh-retrieval:fast",
      "run archon:verify:setup",
      "run archon:verify:playwright"
    ]);

    const dockerCalls = (await readFile(dockerLog, "utf8")).trim().split(/\n+/);
    assert.deepEqual(dockerCalls, [
      "version",
      "version",
      "compose up -d archon-postgres",
      "inspect -f {{.State.Health.Status}} archon-postgres"
    ]);

    const npmEnv = await readFile(npmEnvCapture, "utf8");
    assert.match(npmEnv, /ARCHON_WORKSPACE_SLUG=default/);
    assert.match(npmEnv, /ARCHON_PROJECT_SLUG=archon/);
    assert.match(npmEnv, /ARCHON_PROJECT_NAME=archon/);
    assert.match(npmEnv, new RegExp(`ARCHON_PROJECT_REPO_PATH=${targetRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(npmEnv, /ARCHON_DOCKER_CONTAINER_NAME=archon-postgres/);

    const copiedEnv = await readFile(path.join(targetRoot, ".env"), "utf8");
    assert.match(copiedEnv, /ARCHON_PROJECT_REPO_PATH=\/absolute\/path\/to\/repo/);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("installed setup script falls back to native Linux services when docker is unavailable", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-setup-native-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const binDir = path.join(targetRoot, "bin");
  const dockerLog = path.join(targetRoot, "docker-log.txt");
  const systemctlLog = path.join(targetRoot, "systemctl-log.txt");
  const sudoLog = path.join(targetRoot, "sudo-log.txt");
  const psqlLog = path.join(targetRoot, "psql-log.txt");
  const npmLog = path.join(targetRoot, "npm-log.txt");
  const unitDir = path.join(targetRoot, "systemd");

  try {
    await mkdir(binDir, { recursive: true });
    await mkdir(unitDir, { recursive: true });
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await writeHealthcheckNodeStub(binDir);

    await writeExecutable(
      path.join(binDir, "docker"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "%s\\n" "$*" >> "${ARCHON_DOCKER_LOG_FILE:?missing docker log}"',
        'if [[ "${1:-}" == "version" ]]; then',
        "  exit 1",
        "fi",
        "exit 1"
      ].join("\n")
    );

    await writeExecutable(
      path.join(binDir, "systemctl"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "%s\\n" "$*" >> "${ARCHON_SYSTEMCTL_LOG_FILE:?missing systemctl log}"',
        'case "${1:-}" in',
        "  is-system-running)",
        '    printf "%s\\n" "running"',
        "    exit 0",
        "    ;;",
        "  daemon-reload|enable|start|enable\\ --now)",
        "    exit 0",
        "    ;;",
        "  is-active)",
        "    exit 0",
        "    ;;",
        "esac",
        "exit 0"
      ].join("\n")
    );

    await writeExecutable(
      path.join(binDir, "sudo"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "%s\\n" "$*" >> "${ARCHON_SUDO_LOG_FILE:?missing sudo log}"',
        'if [[ "${1:-}" == "-u" ]]; then',
        "  shift 2",
        "fi",
        'if [[ "${1:-}" == "--non-interactive" ]]; then',
        "  shift",
        "fi",
        'exec "$@"'
      ].join("\n")
    );

    await writeExecutable(
      path.join(binDir, "pg_isready"),
      "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n"
    );

    await writeExecutable(
      path.join(binDir, "psql"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "%s\\n" "$*" >> "${ARCHON_PSQL_LOG_FILE:?missing psql log}"',
        'if printf "%s" "$*" | grep -Fq "pg_available_extensions"; then',
        '  printf "%s\\n" "1"',
        "fi",
        "exit 0"
      ].join("\n")
    );

    await writeExecutable(
      path.join(binDir, "npm"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "%s\\n" "$*" >> "${ARCHON_NPM_LOG_FILE:?missing npm log}"',
        'case "${1:-}" in',
        "  install)",
        "    exit 0",
        "    ;;",
        "  run)",
        '    case "${2:-}" in',
        "      archon:setup:playwright|archon:migrate|archon:bootstrap|archon:repair-task-queue|archon:refresh-repo-context|archon:verify:setup|archon:verify:playwright|archon:refresh-retrieval|archon:refresh-retrieval:fast)",
        "        exit 0",
        "        ;;",
        "    esac",
        "    ;;",
        "esac",
        'printf "unexpected npm call: %s\\n" "$*" >&2',
        "exit 1"
      ].join("\n")
    );

    await execFileAsync("bash", [path.join(targetRoot, "scripts", "archon-setup.sh")], {
      cwd: targetRoot,
      env: {
        ...process.env,
        HOME: targetRoot,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHON_POSTGRES_PASSWORD: "fixture-local-password",
        ARCHON_DOCKER_LOG_FILE: dockerLog,
        ARCHON_SYSTEMCTL_LOG_FILE: systemctlLog,
        ARCHON_SUDO_LOG_FILE: sudoLog,
        ARCHON_PSQL_LOG_FILE: psqlLog,
        ARCHON_NPM_LOG_FILE: npmLog,
        ARCHON_NATIVE_SYSTEMD_UNIT_DIR: unitDir
      }
    });

    const dockerCalls = (await readFile(dockerLog, "utf8")).trim().split(/\n+/);
    assert.deepEqual(dockerCalls, ["version"]);

    const systemctlCalls = (await readFile(systemctlLog, "utf8")).trim().split(/\n+/);
    assert.match(systemctlCalls.join("\n"), /is-system-running/);
    assert.match(systemctlCalls.join("\n"), /enable --now postgresql/);

    const sudoCalls = await readFile(sudoLog, "utf8");
    assert.match(sudoCalls, /-u postgres psql/);

    const npmCalls = (await readFile(npmLog, "utf8")).trim().split(/\n+/);
    assert.deepEqual(npmCalls, [
      "install",
      "run archon:setup:playwright",
      "run archon:migrate",
      "run archon:bootstrap",
      "run archon:refresh-repo-context",
      "run archon:refresh-retrieval:fast",
      "run archon:verify:setup",
      "run archon:verify:playwright"
    ]);

    const unitFiles = await readdir(unitDir);
    assert.ok(unitFiles.every((f) => !f.startsWith("archon-qdrant-")), "no qdrant systemd unit files expected");
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("installed setup script honors managed runtime mode without taking service ownership", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-setup-managed-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const binDir = path.join(targetRoot, "bin");
  const dockerLog = path.join(targetRoot, "docker-log.txt");
  const systemctlLog = path.join(targetRoot, "systemctl-log.txt");
  const npmLog = path.join(targetRoot, "npm-log.txt");

  try {
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await writeFile(
      path.join(targetRoot, ".env.example"),
      await readFile(path.join(sourceRoot, ".env.example"), "utf8"),
      "utf8"
    );
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await writeHealthcheckNodeStub(binDir);

    await writeExecutable(
      path.join(binDir, "docker"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "%s\\n" "$*" >> "${ARCHON_DOCKER_LOG_FILE:?missing docker log}"',
        "exit 99"
      ].join("\n")
    );

    await writeExecutable(
      path.join(binDir, "systemctl"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "%s\\n" "$*" >> "${ARCHON_SYSTEMCTL_LOG_FILE:?missing systemctl log}"',
        "exit 99"
      ].join("\n")
    );

    await writeExecutable(
      path.join(binDir, "npm"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf "%s\\n" "$*" >> "${ARCHON_NPM_LOG_FILE:?missing npm log}"',
        'case "${1:-}" in',
        "  install)",
        "    exit 0",
        "    ;;",
        "  run)",
        '    case "${2:-}" in',
        "      archon:setup:playwright|archon:migrate|archon:bootstrap|archon:repair-task-queue|archon:refresh-repo-context|archon:verify:setup|archon:verify:playwright|archon:refresh-retrieval|archon:refresh-retrieval:fast)",
        "        exit 0",
        "        ;;",
        "    esac",
        "    ;;",
        "esac",
        'printf "unexpected npm call: %s\\n" "$*" >&2',
        "exit 1"
      ].join("\n")
    );

    await execFileAsync("bash", [path.join(targetRoot, "scripts", "archon-setup.sh")], {
      cwd: targetRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ARCHON_RUNTIME_MODE: "managed",
        ARCHON_DOCKER_LOG_FILE: dockerLog,
        ARCHON_SYSTEMCTL_LOG_FILE: systemctlLog,
        ARCHON_NPM_LOG_FILE: npmLog
      }
    });

    await assert.rejects(readFile(dockerLog, "utf8"));
    await assert.rejects(readFile(systemctlLog, "utf8"));
    const npmCalls = (await readFile(npmLog, "utf8")).trim().split(/\n+/);
    assert.deepEqual(npmCalls, [
      "install",
      "run archon:setup:playwright",
      "run archon:migrate",
      "run archon:bootstrap",
      "run archon:refresh-repo-context",
      "run archon:refresh-retrieval:fast",
      "run archon:verify:setup",
      "run archon:verify:playwright"
    ]);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("workflow live wrapper forwards the active task id to the workflow checker", async () => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-workflow-live-smoke-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const checkArgsLog = path.join(targetRoot, "workflow-check-args.txt");
  const proofArgsLog = path.join(targetRoot, "workflow-proof-args.txt");
  const stubRoot = await mkdtemp(path.join(tmpdir(), "archon-workflow-proof-install-stub-"));

  try {
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');
    await installDevgodIntoProject({ sourceRoot, targetRoot });
    await mkdir(path.join(stubRoot, "src", "admin"), { recursive: true });
    await writeFile(
      path.join(stubRoot, "package.json"),
      JSON.stringify({ name: "archon", private: true, type: "module" }, null, 2) + "\n",
      "utf8"
    );
    await writeFile(
      path.join(stubRoot, "src", "admin", "archon.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.env.ARCHON_WORKFLOW_PROOF_ARGS_LOG, process.argv.slice(2).join(" "), "utf8");',
        'process.stdout.write(JSON.stringify({ authorityLabel: "runtime_authoritative", taskStatus: "approved" }) + "\\n");'
      ].join("\n"),
      "utf8"
    );
    const packageJsonPath = path.join(targetRoot, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    packageJson.devDependencies = {
      ...(packageJson.devDependencies ?? {}),
      archon: `file:${stubRoot}`
    };
    await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n", "utf8");

    await writeFile(
      path.join(targetRoot, "scripts", "check-archon-workflow.ts"),
      [
        'import fs from "node:fs";',
        'const logPath = process.env.ARCHON_WORKFLOW_CHECK_ARGS_LOG;',
        'if (!logPath) {',
        '  throw new Error("missing workflow args log");',
        '}',
        'fs.writeFileSync(logPath, `${process.argv.slice(2).join(" ")}\\n`, "utf8");',
        ""
      ].join("\n"),
      "utf8"
    );

    await writeFile(
      path.join(targetRoot, ".archon", "ACTIVE"),
      "task_id=DG-004-smoke\nworkflow=archon\nstate=active\n",
      "utf8"
    );

    await execFileAsync("bash", [path.join(targetRoot, "scripts", "check-archon-workflow-live.sh")], {
      cwd: targetRoot,
      env: {
        ...process.env,
        ARCHON_WORKFLOW_CHECK_ARGS_LOG: checkArgsLog,
        ARCHON_WORKFLOW_PROOF_ARGS_LOG: proofArgsLog
      }
    });

    const proofArgs = await readFile(proofArgsLog, "utf8");
    assert.match(proofArgs, /workflow-proof/);
    assert.match(proofArgs, /--task-id DG-004-smoke/);
    assert.match(proofArgs, /--run-id latest/);

    const checkArgs = await readFile(checkArgsLog, "utf8");
    assert.match(checkArgs, /--repo-root \S+archon-workflow-live-smoke-\S+/);
    assert.match(checkArgs, /--task-id DG-004-smoke/);
    assert.match(checkArgs, /--external-review-authority/);
  } finally {
    await rm(stubRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("setup-git-guard configures hooks and blocks managed control-layer commits", async (t) => {
  const targetRoot = await mkdtemp(path.join(tmpdir(), "archon-git-guard-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    try {
      await execFileAsync("git", ["--version"]);
    } catch {
      t.skip("git is not available in this environment");
      return;
    }

    await execFileAsync("git", ["init"], { cwd: targetRoot });
    await execFileAsync("git", ["config", "user.email", "archon@example.com"], { cwd: targetRoot });
    await execFileAsync("git", ["config", "user.name", "Devgod Test"], { cwd: targetRoot });
    await writeFile(path.join(targetRoot, "package.json"), '{ "name": "fixture", "private": true }\n');

    await installDevgodIntoProject({ sourceRoot, targetRoot });

    const setup = await execFileAsync(
      "node",
      ["--experimental-strip-types", path.join(sourceRoot, "src/install/setup-git-guard.ts")],
      { cwd: targetRoot }
    );
    assert.doesNotMatch(setup.stderr, /Error:/);

    const hooksPath = await execFileAsync("git", ["config", "--local", "--get", "core.hooksPath"], {
      cwd: targetRoot
    });
    assert.equal(hooksPath.stdout.trim(), ".githooks");

    const verify = await execFileAsync(
      "node",
      ["--experimental-strip-types", path.join(sourceRoot, "src/install/verify-git-guard.ts")],
      { cwd: targetRoot }
    );
    assert.doesNotMatch(verify.stderr, /Error:/);

    await execFileAsync("git", ["add", "."], { cwd: targetRoot });
    await execFileAsync("git", ["commit", "-m", "chore: install archon overlay"], {
      cwd: targetRoot,
      env: {
        ...process.env,
        ARCHON_ALLOW_MANAGED_COMMITS: "1"
      }
    });

    await execFileAsync("git", ["switch", "-c", "codex/bad-branch"], { cwd: targetRoot });
    await mkdir(path.join(targetRoot, "src"), { recursive: true });
    await writeFile(path.join(targetRoot, "src", "app.ts"), "export const value = 1;\n", "utf8");
    await execFileAsync("git", ["add", "src/app.ts"], { cwd: targetRoot });
    await assert.rejects(
      execFileAsync("git", ["commit", "-m", "feat: add app stub"], { cwd: targetRoot }),
      (error: unknown) => {
        assert.equal(typeof error, "object");
        assert.ok(error !== null);
        assert.match(
          String((error as { stderr?: string }).stderr ?? ""),
          /archon branch guard: do not use 'codex' in branch names/
        );
        return true;
      }
    );

    await execFileAsync("git", ["switch", "-c", "feature/add-app-stub"], { cwd: targetRoot });
    await execFileAsync("git", ["commit", "-m", "feat: add app stub"], { cwd: targetRoot });

    const agentsMd = await readFile(path.join(targetRoot, "CLAUDE.md"), "utf8");
    await writeFile(path.join(targetRoot, "CLAUDE.md"), `${agentsMd}\n<!-- guard test -->\n`, "utf8");
    await execFileAsync("git", ["add", "CLAUDE.md"], { cwd: targetRoot });
    await assert.rejects(
      execFileAsync("git", ["commit", "-m", "docs: update agents overlay"], { cwd: targetRoot }),
      (error: unknown) => {
        assert.equal(typeof error, "object");
        assert.ok(error !== null);
        assert.match(
          String((error as { stderr?: string }).stderr ?? ""),
          /archon git guard blocked managed control-layer files/
        );
        return true;
      }
    );
    await execFileAsync("git", ["reset", "HEAD", "CLAUDE.md"], { cwd: targetRoot });

    await writeFile(path.join(targetRoot, "notes.md"), "guard check\n", "utf8");
    await execFileAsync("git", ["add", "notes.md"], { cwd: targetRoot });
    await assert.rejects(
      execFileAsync("git", ["commit", "-m", "chore: codex cleanup"], { cwd: targetRoot }),
      (error: unknown) => {
        assert.equal(typeof error, "object");
        assert.ok(error !== null);
        assert.match(
          String((error as { stderr?: string }).stderr ?? ""),
          /do not use 'codex' in the commit subject/
        );
        return true;
      }
    );

    await assert.rejects(
      execFileAsync("git", ["commit", "-m", "bad message"], { cwd: targetRoot }),
      (error: unknown) => {
        assert.equal(typeof error, "object");
        assert.ok(error !== null);
        assert.match(
          String((error as { stderr?: string }).stderr ?? ""),
          /archon commit message guard/
        );
        return true;
      }
    );
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("PowerShell setup script keeps the same env-import safety contract textually", async () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const setupPowerShell = await readFile(path.join(sourceRoot, "scripts/setup-archon.ps1"), "utf8");

  assert.match(setupPowerShell, /Test-ArchonSafeEnvKey/);
  assert.match(setupPowerShell, /Strip-ArchonUnquotedComment/);
  assert.match(setupPowerShell, /Unescape-ArchonDoubleQuotedValue/);
  assert.match(setupPowerShell, /\^ARCHON_\[A-Z0-9_\]\+\$/);
  assert.match(setupPowerShell, /archon:setup:git-guard/);
  assert.doesNotMatch(setupPowerShell, /Set-Item -Path "Env:PATH"/);
  assert.doesNotMatch(setupPowerShell, /Get-Content -LiteralPath "\.env"/);
});

test("npm pack dry run includes the new agent, skill, and retrieval policy surface", async () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const output = JSON.parse(await runNpmPackJsonDryRun(sourceRoot)) as Array<{
    files: Array<{ path: string }>;
  }>;
  const packedFiles = new Set(output.flatMap((entry) => entry.files.map((file) => file.path)));

  const expectedSkillFiles = [
    ".claude/skills/anthropic-mcp-builder/SKILL.md",
    ".claude/skills/anthropic-webapp-testing/SKILL.md",
    ".claude/skills/archon-accessibility-gate/SKILL.md",
    ".claude/skills/archon-agent-runtime/SKILL.md",
    ".claude/skills/archon-architecture/SKILL.md",
    ".claude/skills/archon-autopilot/SKILL.md",
    ".claude/skills/archon-compliance-review/SKILL.md",
    ".claude/skills/archon-context-retrieval/SKILL.md",
    ".claude/skills/archon-debugging/SKILL.md",
    ".claude/skills/archon-design-system/SKILL.md",
    ".claude/skills/archon-docs-research/SKILL.md",
    ".claude/skills/archon-e2e/SKILL.md",
    ".claude/skills/archon-eval-engineering/SKILL.md",
    ".claude/skills/archon-execution/SKILL.md",
    ".claude/skills/archon-forge-assets/SKILL.md",
    ".claude/skills/archon-forge-direction/SKILL.md",
    ".claude/skills/archon-forge-intent/SKILL.md",
    ".claude/skills/archon-frontend-taste/SKILL.md",
    ".claude/skills/archon-frontend/SKILL.md",
    ".claude/skills/archon-git-operator/SKILL.md",
    ".claude/skills/archon-graphify/SKILL.md",
    ".claude/skills/archon-infra-ops/SKILL.md",
    ".claude/skills/archon-intake/SKILL.md",
    ".claude/skills/archon-memory/SKILL.md",
    ".claude/skills/archon-performance/SKILL.md",
    ".claude/skills/archon-planning/SKILL.md",
    ".claude/skills/archon-product-analysis/SKILL.md",
    ".claude/skills/archon-product-framing/SKILL.md",
    ".claude/skills/archon-qa-verification/SKILL.md",
    ".claude/skills/archon-release-readiness/SKILL.md",
    ".claude/skills/archon-repair-loop/SKILL.md",
    ".claude/skills/archon-review/SKILL.md",
    ".claude/skills/archon-setup/SKILL.md",
    ".claude/skills/archon-skill-evals/SKILL.md",
    ".claude/skills/archon-tdd/SKILL.md",
    ".claude/skills/archon-technical-writing/SKILL.md",
    ".claude/skills/archon-ui-patterns/SKILL.md",
    ".claude/skills/archon-ux-research/SKILL.md",
    ".claude/skills/archon-visual-standards/SKILL.md",
    ".claude/skills/caveman/SKILL.md",
    ".claude/skills/documentation-lookup/SKILL.md",
    ".claude/skills/graphify/SKILL.md",
    ".claude/skills/mcp-server-patterns/SKILL.md",
    ".claude/skills/superpowers-finishing-development-branch/SKILL.md",
    ".claude/skills/superpowers-using-git-worktrees/SKILL.md",
    ".claude/skills/verification-loop/SKILL.md"
  ];

  const expectedAgentFiles = listCatalogAgentArtifactPaths();
  const expectedCatalogRepoLocalSkills = listCatalogRepoLocalSkillPaths();

  const packedSkillFiles = [...packedFiles].filter((file) => file.startsWith(".claude/skills/")).sort();
  const packedAgentFiles = [...packedFiles].filter((file) => file.startsWith(".claude/agents/")).sort();

  assert.deepEqual(packedSkillFiles, expectedSkillFiles);
  assert.deepEqual(packedAgentFiles, expectedAgentFiles);
  assert.ok(packedFiles.has("docs/archon-agent-team.md"));
  for (const relativePath of expectedCatalogRepoLocalSkills) {
    assert.ok(packedSkillFiles.includes(relativePath), `${relativePath} should be packed because the catalog references it`);
  }

  for (const expectedPath of [
    ".githooks/commit-msg",
    ".githooks/pre-commit",
    ".archon/rules/role-retrieval-policy.md",
    ".archon/templates/product-state.md",
    ".archon/templates/task-queue.json",
    ".archon/templates/review-identity-bindings.json",
    ".archon/templates/review-identity-adapter.fixture.json",
    "scripts/check-archon-branch-name.sh",
    "scripts/check-archon-commit-msg.sh",
    "scripts/check-archon-git-guard.sh",
    "scripts/check-archon-workflow.ts",
    "scripts/check-archon-workflow-live.sh",
    "scripts/check-quality.sh",
    "scripts/archon-session-start.sh",
    "scripts/verify-archon-workflow-check.sh",
    "scripts/verify-release-overlay.sh",
    ".claude/hooks/hook-utils.mjs",
    ".claude/hooks/hook-policy.mjs",
    ".claude/hooks/archon-pre-tool.mjs",
    ".claude/hooks/archon-post-tool.mjs",
    ".claude/hooks/archon-session-start.mjs",
    ".claude/hooks/archon-stop.mjs",
    ".claude/hooks/archon-prompt-submit.mjs",
    "src/admin.ts",
    "src/archon/autopilot-status.ts",
    "src/archon/task-queue.ts",
    "src/index.ts",
    "src/install/cli.ts",
    "src/install/git-guard.ts",
    "src/install/setup-git-guard.ts",
    "src/install/setup-local.ts",
    "src/install/verify-git-guard.ts",
    "src/sql/migrations/001_initial_schema.sql"
  ]) {
    assert.ok(packedFiles.has(expectedPath), `${expectedPath} should be present in npm pack --dry-run output`);
  }

  for (const excludedPath of [
    ".archon/work/2026-05-04-project-state-review/BRIEF.md",
    "scripts/check-coverage.ts",
    "tests/install.test.ts"
  ]) {
    assert.ok(!packedFiles.has(excludedPath), `${excludedPath} should not be present in npm pack --dry-run output`);
  }
});
