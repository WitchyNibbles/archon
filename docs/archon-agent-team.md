# Archon Agent Team

This document records the shipped day-one archon team shape and the default skill posture for each role.

The canonical source of truth is [`src/archon/agent-catalog.ts`](/home/eimi/projects/archon/src/archon/agent-catalog.ts). The reviewed `.claude/agents/*/AGENT.md` files remain the explicit shipped agent artifacts, and CI is expected to fail if the catalog and shipped artifacts drift.

## Control Model

- The universal blocking review trio remains `reviewer`, `qa_engineer`, and `security_reviewer`.
- The `Design and Architecture Council` is a quality gate for substantive roadmap and plan work, not a fourth blocking review role.
- Optional or domain-specific roles are valid for ownership and specialist evidence when chosen, but they are not silent global blockers.
- Catalog drift is a verification failure, not a runtime continuation deadlock.

## Role Matrix

| Role | Class | Availability | Primary skills |
|---|---|---|---|
| `planner` | manager | core_required | `archon-planning`, `superpowers-writing-plans` |
| `product_strategist` | manager | core_required | `archon-product-framing`, `archon-intake`, `market-research` |
| `solution_architect` | manager | core_required | `archon-architecture`, `backend-patterns`, `security-review` |
| `docs_researcher` | knowledge | core_required | `archon-docs-research`, `documentation-lookup` |
| `backend_engineer` | delivery | core_required | `archon-execution`, `backend-patterns`, `api-design` |
| `frontend_designer` | delivery | core_required | `archon-frontend-taste`, `archon-design-system`, `frontend-patterns`, `web-design-guidelines` |
| `git_operator` | knowledge | core_required | `archon-git-operator`, `superpowers-using-git-worktrees`, `superpowers-finishing-development-branch` |
| `infra_engineer` | delivery | core_required | `archon-infra-ops`, `archon-setup`, `archon-release-readiness` |
| `reviewer` | quality | core_required | `archon-review`, `superpowers-verification-before-completion` |
| `build_resolver` | delivery | core_required | `archon-debugging`, `superpowers-systematic-debugging` |
| `security_reviewer` | quality | core_required | `security-review`, `archon-docs-research` |
| `qa_engineer` | quality | core_required | `archon-qa-verification`, `archon-accessibility-gate`, `anthropic-webapp-testing`, `e2e-testing`, `verification-loop` |
| `tdd-guide` | quality | core_required | `archon-tdd`, `superpowers-test-driven-development` |
| `e2e-runner` | quality | core_required | `archon-e2e`, `anthropic-webapp-testing`, `e2e-testing` |
| `release-readiness` | quality | core_required | `archon-release-readiness`, `verification-loop` |
| `memory_curator` | knowledge | core_required | `archon-memory`, `strategic-compact` |
| `eval_engineer` | quality | core_required | `archon-eval-engineering`, `archon-skill-evals`, `eval-harness` |
| `technical_writer` | knowledge | core_required | `archon-technical-writing`, `documentation-lookup`, `article-writing` |
| `agent_runtime_engineer` | delivery | core_required | `archon-agent-runtime`, `anthropic-mcp-builder`, `mcp-server-patterns`, `verification-loop` |
| `mobile_engineer` | domain_specialist | domain_optional | `archon-frontend-taste`, `archon-design-system`, `frontend-patterns`, `e2e-testing` |
| `ml_engineer` | domain_specialist | domain_optional | `documentation-lookup`, `verification-loop` |
| `data_engineer` | domain_specialist | domain_optional | `backend-patterns`, `verification-loop` |
| `ux_researcher` | domain_specialist | domain_optional | `archon-ux-research`, `archon-frontend-taste`, `market-research` |
| `product_analyst` | domain_specialist | domain_optional | `archon-product-analysis`, `market-research` |
| `compliance_reviewer` | domain_specialist | domain_optional | `archon-compliance-review`, `security-review`, `documentation-lookup` |
| `accessibility_engineer` | quality | core_required | `archon-accessibility-gate`, `e2e-testing`, `web-design-guidelines` |
| `database_specialist` | quality | core_required | `postgres-patterns`, `database-migrations`, `verification-loop` |
| `performance_engineer` | quality | core_required | `archon-performance`, `verification-loop`, `backend-patterns` |

## Notes

- Skills are intentionally sparse. Each role should have one primary workflow discipline and at most a small number of secondary skills.
- Repo-local workflow skills should be the default identity for roles with recurring `archon`-specific decision loops; generic pattern skills remain secondary support.
- Frontend-facing roles now use repo-local wrappers for visual taste, design-system discipline, and accessibility gating so UI quality does not depend on ambient global skill installs.
- Planning, debugging, TDD, review-completion discipline, browser verification, MCP implementation, and git handoff hygiene now also ship as repo-local wrapper skills instead of relying on ambient global installs.
- Repo-wide policy belongs in `CLAUDE.md`; specialist workflow details belong in role-specific skills and agent instructions.
- Roles that participate in the `Design and Architecture Council` should critique with explicit alternatives, dissent ownership, and user/problem/value framing rather than taste-only feedback or passive agreement.
- Optional domain roles still stay intentionally thin until repeated repo-local workload justifies a dedicated `archon-*` workflow skill.
- UI-affecting tasks should declare their UI surface explicitly and carry browser evidence through `qa_engineer` before workflow-proof approval.
- If a future role is added, update the catalog first, then the shipped agent artifact, then the package/tests/docs surfaces that verify drift.
