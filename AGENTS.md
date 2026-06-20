# Archon Agent Operating Rules

This file provides vendor-neutral agent operating instructions mirroring the
workflow contract in CLAUDE.md. It is required by the workflow integrity check
(`scripts/check-archon-workflow.ts`) and must be kept in sync with CLAUDE.md.

## Default mode

- treat substantive product, code, infra, auth, data, and deploy asks as `archon` work unless the user opts out
- use `/archon-intake` as the default first skill for substantive work
- when a role has a repo-local `archon-*` workflow skill for the active domain, invoke it before generic secondary skills
- root thread acts as engineering manager on first contact
- keep manager/root shallow: triage, routing, synthesis, scope enforcement, final reporting
- keep package assets reusable; do not absorb project-specific live state

## Workflow contract

<!-- archon-workflow-contract:start -->
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
workflow_check=npx tsx ./src/admin.ts workflow-proof --run-id latest --task-id <task-id>
workflow_check_scope=runtime_authority_only
review_artifact_trust=runtime_records_only
ci_scope=runtime_contract_and_export_regressions
local_live_check=bash scripts/check-archon-workflow-live.sh [--task-id <task-id>]
<!-- archon-workflow-contract:end -->

## Manager kernel

- confirm goal, success criteria, constraints, and main risk before execution
- after at most two shallow inspections, either stay on the trivial fast path or delegate bounded investigation
- create or update `.archon/ACTIVE` and the matching brief before moving past intake
- require Design and Architecture Council review for substantive roadmap, governance, architecture-significant, or user-flow-heavy plan work unless the task is explicitly trivial or inherits an approved parent council decision
- use bounded investigation packets: owner role, question, read scope, forbidden write scope, evidence required, max output, stop condition
- require task packets to declare explicit workflow artifact refs whenever they inherit a parent brief or plan, or when runtime authority may satisfy review gates before markdown review exports exist
- do not activate a task unless its allowed write scope covers every required workflow export, or the task explicitly uses `review_exports=runtime_optional` under runtime authority
- treat `strict` as the default reasoning mode for substantive work (advisory — not runtime-enforced)
- evidence first, then `solution_architect`, then `planner`, then explicit task packets, then specialist execution
- substantive work completes only after `reviewer`, `qa_engineer`, and `security_reviewer` gates plus the workflow check
- release-sensitive work also requires `release_readiness_required` quality-gate evidence

## Agent delegation

Delegate to roles matching an agent name from `.claude/agents/`.

Model routing:
- high-effort planning and reasoning: planner, product-strategist, solution-architect
- knowledge and coordination: docs-researcher, memory-curator, technical-writer, git-operator
- all other delivery and quality roles: default model

For parallel specialist work, use `isolation: "worktree"` to run independent slices in separate git worktrees.

Effort levels:
- `high`: manager, planner, architect, council review
- `medium`: knowledge, research, docs, memory
- `low`: trivial mechanical tasks

## Autonomy loop

For full-project or multi-phase requests, the agent must operate as a continuing delivery loop.

Do not stop after intake, architecture, planning, or one implementation slice unless:

- the product-level acceptance criteria are complete
- a real blocker requires user input
- verification cannot proceed after documented repair attempts
- or the user explicitly requested planning only

After each completed task:

1. update `.archon/work/product-state.md`
2. update `.archon/work/task-queue.json`
3. update `.archon/ACTIVE`
4. select the next unblocked task
5. continue execution

## Default role chain

- planning and routing: `planner`, `product_strategist`, `solution_architect`
- delivery: `backend_engineer`, `frontend_designer`, `infra_engineer`, `build_resolver`
- repo operations: `git_operator`
- quality: `reviewer`, `qa_engineer`, `security_reviewer`, `tdd-guide`, `e2e-runner`, `release-readiness`, `performance-engineer`, `database-specialist`, `accessibility-engineer`
- memory: `memory_curator`

## Gate rules

- unresolved `CRITICAL` or `HIGH` security findings block completion
- missing required review, specialist evidence, quality-gate evidence, or verification evidence blocks completion
- runtime workflow proof is the completion authority; exported markdown remains evidence
- trusted reviewer identity and waivers must come from runtime (orchestrator-written DB records) or another trusted orchestrator source
- current task id must align across `.archon/ACTIVE`, brief, plan/task, and review artifacts
- workers must not edit `CLAUDE.md`, `.claude/`, or `.archon/memory/` unless the task packet assigns that scope

## Setup and memory

- if `archon` is not configured, invoke `/archon-setup`
- do not claim `archon` is operational until setup verification passes
- `.archon/memory/` is reviewed durable memory; shared backend retrieval is advisory only
- never store secrets, tokens, credentials, or private keys in durable memory
