#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_root=""
keep_target=0
workspace_slug="default"
task_id="harness-proof"
with_grafana=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 2 ]] || { printf 'missing value for %s\n' "$1" >&2; exit 2; }
      target_root="$2"
      shift 2
      ;;
    --keep-target)
      keep_target=1
      shift
      ;;
    --workspace-slug)
      [[ $# -ge 2 ]] || { printf 'missing value for %s\n' "$1" >&2; exit 2; }
      workspace_slug="$2"
      shift 2
      ;;
    --task-id)
      [[ $# -ge 2 ]] || { printf 'missing value for %s\n' "$1" >&2; exit 2; }
      task_id="$2"
      shift 2
      ;;
    --with-grafana)
      with_grafana=1
      shift
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

created_target=0
if [[ -z "$target_root" ]]; then
  target_root="$(mktemp -d -t archon-installed-harness-XXXXXX)"
  created_target=1
fi

cleanup() {
  if [[ "$created_target" -eq 1 && "$keep_target" -eq 0 ]]; then
    python3 -c "import shutil, sys; shutil.rmtree(sys.argv[1], ignore_errors=True)" "$target_root"
  fi
}
trap cleanup EXIT

mkdir -p "$target_root"
printf '{"name":"archon-installed-harness","private":true}\n' > "$target_root/package.json"

project_slug="$(basename "$target_root" | tr "[:upper:]" "[:lower:]")"

sanitize_env() {
  env \
    -u ARCHON_PROJECT_SLUG \
    -u ARCHON_PROJECT_NAME \
    -u ARCHON_WORKSPACE_SLUG \
    -u ARCHON_RUNTIME_PROFILE \
    -u ARCHON_RUNTIME_MODE \
    -u ARCHON_RUNTIME_DATA_ROOT \
    -u ARCHON_DOCKER_CONTAINER_NAME \
    -u ARCHON_QDRANT_CONTAINER_NAME \
    "$@"
}

run_target() {
  (
    cd "$target_root"
    sanitize_env ARCHON_WORKSPACE_SLUG="$workspace_slug" ARCHON_PROJECT_SLUG="$project_slug" "$@"
  )
}

install_args=(init --apply --target "$target_root")
if [[ "$with_grafana" -eq 1 ]]; then
  install_args+=(--with-grafana)
fi

node --experimental-strip-types "$repo_root/src/install/cli.ts" "${install_args[@]}" >/dev/null

(
  cd "$target_root"
  npm install >/dev/null
)

run_target npm run archon:setup:playwright >/dev/null

run_target npm run archon:scaffold-workflow -- --task-id "$task_id" --force-active >/dev/null
run_target node --experimental-strip-types --input-type=module - "$workspace_slug" "$project_slug" "$task_id" <<'EOF'
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  executeReportCommandFromArgs,
  executeSeedModernizationProofCommandFromArgs,
  executeStatusCommandFromArgs
} from "./node_modules/archon/src/admin.ts";
import { createReviewActionContextResolver } from "./node_modules/archon/src/core/review-context.ts";
import { ArchonCoreService, MemoryStore } from "./node_modules/archon/src/index.ts";

const [, , workspaceSlug, projectSlug, taskId] = process.argv;
const cwd = process.cwd();
const env = {
  ...process.env,
  ARCHON_WORKSPACE_SLUG: workspaceSlug,
  ARCHON_PROJECT_SLUG: projectSlug
};
const store = new MemoryStore();
const service = new ArchonCoreService(store, {
  resolveReviewActionContext: createReviewActionContextResolver({
    bindings: {
      bindings: [
        {
          principal: { provider: "archon-local-seed", subject: "reviewer-actor" },
          actors: [{ actor: "reviewer-actor", roles: ["reviewer"] }]
        },
        {
          principal: { provider: "archon-local-seed", subject: "security-actor" },
          actors: [{ actor: "security-actor", roles: ["security_reviewer"] }]
        },
        {
          principal: { provider: "archon-local-seed", subject: "qa-actor" },
          actors: [{ actor: "qa-actor", roles: ["qa_engineer"] }]
        }
      ]
    },
    async resolveAuthenticatedPrincipal(input) {
      return {
        provider: "archon-local-seed",
        subject: input.actor,
        verified: true
      };
    }
  })
});

const reviewIdentity = async () => ({
  authorityLabel: "derived_only",
  adapterConfigured: false,
  adapterExists: true,
  availableBackends: [],
  bindingsPresent: true,
  bindingsPath: join(cwd, ".archon", "review-identity-bindings.json"),
  bindingsUseShippedTemplate: true,
  liveTrustReady: false,
  notes: ["installed harness fixture uses an in-memory review adapter"]
});

const gitNexus = async () => ({
  authorityLabel: "derived_only",
  state: "unconfigured",
  configured: false,
  configuredScopes: [],
  configPaths: [],
  repoIndexed: false,
  indexRoot: join(cwd, ".gitnexus"),
  metaPath: join(cwd, ".gitnexus", "meta.json"),
  recommendedCommand: "npx gitnexus analyze --skip-agents-md",
  notes: ["installed harness fixture does not require GitNexus indexing"]
});

const projectContext = await store.ensureProjectContext({
  workspaceSlug,
  projectSlug,
  repoPath: cwd
});
await store.saveProjectRuntimeState({
  projectId: projectContext.project.id,
  workspaceId: projectContext.workspace.id,
  activeRunId: undefined,
  activeTaskId: taskId,
  taskQueue: {
    project_status: "ready",
    current_task_id: null,
    tasks: []
  },
  productState: { status: "ready", items: [] },
  lastVerifiedRunId: undefined,
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

await executeSeedModernizationProofCommandFromArgs(
  ["--workspace-slug", workspaceSlug, "--project-slug", projectSlug, "--task-id", taskId],
  {
    cwd,
    env,
    getProjectContext(params) {
      return store.getProjectContext(params);
    },
    getProjectRuntimeState(projectId) {
      return store.getProjectRuntimeState(projectId);
    },
    saveProjectRuntimeState(state) {
      return store.saveProjectRuntimeState(state);
    },
    intakeRequest(input) {
      return service.intakeRequest(input);
    },
    createTaskGraph(runId, taskPackets) {
      return service.createTaskGraph(runId, taskPackets);
    },
    claimTask(runId, activeTaskId, actor) {
      return service.claimTask(runId, activeTaskId, actor);
    },
    submitHandoff(runId, activeTaskId, handoff) {
      return service.submitHandoff(runId, activeTaskId, handoff);
    },
    recordReview(runId, activeTaskId, actor, review) {
      return service.recordReview(runId, activeTaskId, actor, review);
    },
    configureAutonomousExecution(runId, input) {
      return service.configureAutonomousExecution(runId, input);
    },
    upsertCoverageItems(runId, items) {
      return service.upsertCoverageItems(runId, items);
    },
    upsertUnderstandingMaps(runId, maps) {
      return service.upsertUnderstandingMaps(runId, maps);
    },
    upsertRuntimeTraces(runId, traces) {
      return service.upsertRuntimeTraces(runId, traces);
    },
    upsertDuplicateFamilies(runId, records) {
      return service.upsertDuplicateFamilies(runId, records);
    },
    upsertArchitectureDecisions(runId, records) {
      return service.upsertArchitectureDecisions(runId, records);
    },
    upsertMigrationLedgerEntries(runId, records) {
      return service.upsertMigrationLedgerEntries(runId, records);
    },
    upsertParityRequirements(runId, records) {
      return service.upsertParityRequirements(runId, records);
    },
    getStatusSnapshot(runId) {
      return service.getStatus(runId);
    },
    getReviews(runId, activeTaskId) {
      return store.getReviews(runId, activeTaskId);
    },
    getApprovals(runId, activeTaskId) {
      return store.getApprovals(runId, activeTaskId);
    }
  }
);

const status = await executeStatusCommandFromArgs([], {
  cwd,
  env,
  findLatestRun(candidateWorkspaceSlug, candidateProjectSlug) {
    return store.findLatestRun({
      workspaceSlug: candidateWorkspaceSlug,
      projectSlug: candidateProjectSlug
    });
  },
  getStatusSnapshot(runId) {
    return service.getStatus(runId);
  },
  inspectReviewIdentity: reviewIdentity,
  inspectGitNexus: gitNexus
});

const report = await executeReportCommandFromArgs(["--format", "json"], {
  cwd,
  env,
  findLatestRun(candidateWorkspaceSlug, candidateProjectSlug) {
    return store.findLatestRun({
      workspaceSlug: candidateWorkspaceSlug,
      projectSlug: candidateProjectSlug
    });
  },
  getStatusSnapshot(runId) {
    return service.getStatus(runId);
  },
  getExecutionPlan(runId, staleAfterHours) {
    return service.getExecutionPlan(runId, { staleAfterHours });
  },
  getRoutingReport(runId) {
    return service.recommendRouting(runId);
  },
  inspectRecovery(runId, staleAfterHours) {
    return service.inspectRecovery(runId, { staleAfterHours });
  },
  getHandoffs(runId, activeTaskId) {
    return store.getHandoffs(runId, activeTaskId);
  },
  getReviews(runId, activeTaskId) {
    return store.getReviews(runId, activeTaskId);
  },
  getApprovals(runId, activeTaskId) {
    return store.getApprovals(runId, activeTaskId);
  },
  inspectReviewIdentity: reviewIdentity,
  inspectGitNexus: gitNexus
});

assert.ok(status.tasks.byStatus.approved.includes(taskId));
assert.equal(status.autonomous.configured, true);
assert.equal(status.autonomous.profile, "modernization_program");
assert.equal(status.autonomous.comprehensionSummary?.rewriteReadiness, "ready");
assert.equal(report.report.autonomous.comprehensionSummary?.rewriteReadiness, "ready");

const activeExport = await readFile(join(cwd, ".archon", "ACTIVE"), "utf8");
const settingsJson = await readFile(join(cwd, ".claude", "settings.json"), "utf8");
assert.equal(activeExport, `task_id=${taskId}\nworkflow=archon\nstate=active\n`);

console.log(
  JSON.stringify({
    hasGrafana: /"grafana"/.test(settingsJson)
  })
);
EOF

grafana_status="disabled"
if [[ "$with_grafana" -eq 1 ]]; then
  grafana_status="enabled"
fi

printf 'installed repo harness passed\n'
printf 'workspace: %s\n' "$workspace_slug"
printf 'project: %s\n' "$project_slug"
printf 'task: %s\n' "$task_id"
printf 'profile: modernization_program\n'
printf 'rewrite_readiness: ready\n'
printf 'grafana-opt-in: %s\n' "$grafana_status"
printf 'target: %s\n' "$target_root"
