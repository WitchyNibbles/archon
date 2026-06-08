# Archon Operating Rules

This repo is the shared-package source of truth for `archon`. It owns reusable runtime,
installer, rules, templates, skills, and agent profiles. Consuming repos own live
`.archon/work/` state, env files, and repo-specific overlays.

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
review_authority=runtime_authenticated_only
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
- require `Design and Architecture Council` review for substantive roadmap, governance, architecture-significant, or user-flow-heavy plan work unless the task is explicitly trivial or inherits an approved parent council decision
- use bounded investigation packets: owner role, question, read scope, forbidden write scope, evidence required, max output, stop condition
- require task packets to declare explicit workflow artifact refs whenever they inherit a parent brief or plan, or when runtime authority may satisfy review gates before markdown review exports exist
- do not activate a task unless its allowed write scope covers every required workflow export, or the task explicitly uses `review_exports=runtime_optional` under runtime authority
- treat `strict` as the default reasoning mode for substantive work
- evidence first, then `solution_architect`, then `planner`, then explicit task packets, then specialist execution
- substantive work completes only after `reviewer`, `qa_engineer`, and `security_reviewer` gates plus the workflow check
- release-sensitive work also requires `release_readiness_required` quality-gate evidence

## Agent delegation

Delegate via the `Agent` tool with a `subagent_type` matching an agent name from `.claude/agents/`.

Model routing:
- `claude-opus-4-8`: planner, product-strategist, solution-architect (high-effort planning and reasoning)
- `claude-haiku-4-5-20251001`: docs-researcher, memory-curator, technical-writer, git-operator (knowledge and coordination)
- `claude-sonnet-4-6`: all other delivery and quality roles

For parallel specialist work, use `isolation: "worktree"` to run independent slices in separate git worktrees.

Effort levels:
- `high`: manager, planner, architect, council review
- `medium`: knowledge, research, docs, memory
- `low`: trivial mechanical tasks

Invoke skills with `/archon-<name>` (e.g. `/archon-intake`, `/archon-review`, `/archon-planning`).

## Autonomy loop

For full-project or multi-phase requests, archon must operate as a continuing delivery loop.

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

Prefer repo-local `archon-*` skills and `.claude/agents/` roles when available.

Specialist agents available on demand (invoke explicitly when the task domain matches):
`context-manager`, `compliance-reviewer`, `data-engineer`, `ml-engineer`,
`mobile-engineer`, `observability-engineer`, `product-analyst`, `ux-researcher`

## Design And Architecture Council

- the `Design and Architecture Council` is a pre-implementation quality gate for substantive roadmap and plan work
- rotating 3-5 role panel: default seats from `solution_architect`, `product_strategist`, `frontend_designer`, and `infra_engineer` or `security_reviewer` when the main risk is operational or security-heavy
- every council review must name a `dissent owner` responsible for arguing at least one serious alternative
- outcomes: `approved`, `approved_with_conditions`, `rework_required`, `exception_granted`, or `rejected`
- exceptions must be explicit, owned, and time-bounded — never indefinite
- the council may not silently override user intent without user acceptance
- trivial work, local bug fixes, and tasks covered by an approved parent council packet may bypass the council

## Recurring control-layer routing

Use a repo-local `archon-*` workflow skill before generic secondary skills when it fits the domain. Each skill's description declares its trigger domain.

Key routing shortcuts:
- agent runtime, hook, tool-contract, automation, or continuation changes:
  invoke `archon-agent-runtime` skill first; delegate to `agent-runtime-engineer` agent
  for implementation work that touches `src/archon/`, `src/runtime/`, or hook scripts
- benchmark, grader, or skill-regression work: `archon-eval-engineering` and `archon-skill-evals`
- operator docs, migration notes, release notes, workflow-document clarity, or `src/docs-export/` changes: `archon-technical-writing`
- any CSS, UI component, visual, or design-system work: `archon-frontend`
- specialist gates: `performance-engineer`, `database-specialist`, `accessibility-engineer`

## Git hygiene

- use `git_operator` for staging, commit slicing, and commit-message prep
- branch from updated `origin/main` before task or plan work
- default branch prefixes: `feature/`, `bugfix/`, `hotfix/`, `release/`, `chore/`, `refactor/`, `docs/`, `test/`, `ci/`, `perf/`
- workers must not stage `.archon/`, `.claude/agents/`, `.claude/skills/archon-*`, or `CLAUDE.md` unless the task packet assigns that scope

## Gate rules

- unresolved `CRITICAL` or `HIGH` security findings block completion
- missing required review, specialist evidence, quality-gate evidence, or verification evidence blocks completion
- runtime workflow proof is the completion authority; exported markdown remains evidence
- trusted reviewer identity and waivers must come from runtime or another authenticated source
- current task id must align across `.archon/ACTIVE`, brief, plan/task, and review artifacts
- workers must not edit `CLAUDE.md`, `.claude/`, or `.archon/memory/` unless the task packet assigns that scope

## Setup and memory

- the `everything-claude-code` plugin is a required external dependency — agent skills prefixed `everything-claude-code:*` resolve only when it is installed; see README.md Prerequisites for install instructions
- if `archon` is not configured, invoke `/archon-setup`
- do not claim `archon` is operational until setup verification passes
- `.archon/memory/` is reviewed durable memory; shared backend retrieval is advisory only
- `.claude/projects/*/memory/` is Claude Code's native cross-session memory layer; use it for personal workflow context and session continuity, not for shared project facts
- repo-local durable memory and Claude project memory are complementary, not competing; reviewed facts belong in `.archon/memory/`, personal session context belongs in `.claude/projects/*/memory/`
- never store secrets, tokens, credentials, or private keys in durable memory

## Details

Use `.archon/rules/` for the detailed policy set:

- `policy-precedence.md`
- `review-gate-policy.md`
- `review-identity-policy.md`
- `role-retrieval-policy.md`
- `write-scope.md`
- `git-conventions.md` — branch prefixes, commit format, and PR conventions
- `reasoning-quality.md`
- `task-quality-matrix.md`
- `design-council-policy.md`
- `skill-format.md` — SKILL.md format and naming rules for repo-local skills

Frontend and design standards:
- `frontend-acceptance.md` — acceptance criteria for frontend changes
- `frontend-quality-rubric.md` — quality rubric for UI work
- `frontend-inspiration-sources.md` — approved design references

Memory and graphify:
- `memory-promotion.md` — policy for promoting retrieval hints to durable memory
- `memory-vocabulary.md` — canonical memory terms
- `graphify-advisory-policy.md` — when and how graphify results may be used
