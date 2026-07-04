// Roster catalog DATA — the agentCatalog object literal.
//
// Split out of agent-catalog.ts (audit auditP2RosterTruth) so the logic module
// (types, the shared MODEL_ALIAS_TO_ID map, and the derived helpers) stays well
// under the max-lines ceiling. This file is pure data: one entry per agent role,
// each satisfying AgentCatalogEntryV2. The `tools` and `routerDescription` fields
// are the source of truth that scripts/generate-agent-frontmatter.ts emits into
// each .claude/agents/*/AGENT.md and that agent-artifact-verifier.ts asserts.
//
// The import below is type-only, so there is no runtime cycle with agent-catalog.ts
// (which imports the agentCatalog VALUE from here).
import type { AgentCatalogEntryV2 } from "./agent-catalog.ts";

export const agentCatalog = {
  planner: {
    label: "Planner",
    description: "Owns intake synthesis, decomposition, staffing, checkpoints, and gate enforcement.",
    class: "manager",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/planner/AGENT.md",
    routerDescription:
      "Owns intake synthesis, task decomposition, staffing, checkpoints, and gate enforcement for archon.",
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
    model: "opus",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-planning", "archon-intake"],
    retrievalGuidance: ["approved memory", "reviewed briefs", "reviewed plans", "repo rules"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["scope_cartographer", "dependency_mapper", "acceptance_criteria_analyst"],
      maxChildDepth: 1,
      maxConcurrentChildren: 2,
      maxTotalChildrenPerTask: 6
    },
    subagentSpecialties: [
      {
        id: "scope_cartographer",
        label: "Scope Cartographer",
        description: "Read-only mapping of what is in and out of scope for the current task, flagging scope creep risks.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "dependency_mapper",
        label: "Dependency Mapper",
        description: "Read-only analysis of task and module dependencies to surface ordering constraints and blockers.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "acceptance_criteria_analyst",
        label: "Acceptance Criteria Analyst",
        description: "Read-only review that acceptance criteria are specific, falsifiable, and cover the stated goal.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  product_strategist: {
    label: "Product Strategist",
    description: "Turns broad asks into product framing, scope, and acceptance criteria.",
    class: "manager",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/product-strategist/AGENT.md",
    routerDescription:
      "Turns raw ideas into a product brief, scope boundaries, user flows, milestones, and acceptance criteria.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "opus",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-product-framing", "archon-intake", "ecc:market-research"],
    retrievalGuidance: ["approved briefs", "approved memory", "repo rules", "cited external research"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["user_value_checker", "risk_value_tradeoff_analyst", "persona_reader"],
      maxChildDepth: 1,
      maxConcurrentChildren: 2,
      maxTotalChildrenPerTask: 6
    },
    subagentSpecialties: [
      {
        id: "user_value_checker",
        label: "User Value Checker",
        description: "Read-only analysis of whether the proposed feature delivers clear, measurable user value.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "risk_value_tradeoff_analyst",
        label: "Risk-Value Tradeoff Analyst",
        description: "Read-only enumeration of risks vs. user value delivered, surfacing whether scope is worth the cost.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "persona_reader",
        label: "Persona Reader",
        description: "Read-only review that user personas and jobs-to-be-done are grounded in evidence, not assumptions.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  solution_architect: {
    label: "Solution Architect",
    description: "Defines boundaries, sequencing, and architecture decisions.",
    class: "manager",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/solution-architect/AGENT.md",
    routerDescription:
      "Designs system boundaries, architecture, data flow, and implementation sequencing for new products and major changes.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "opus",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-architecture", "ecc:backend-patterns", "ecc:security-review", "ecc:agentic-engineering"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "architecture notes"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["interface_contract_mapper", "architecture_risk_scout", "alternative_design_dissenter"],
      maxChildDepth: 1,
      maxConcurrentChildren: 2,
      maxTotalChildrenPerTask: 6
    },
    subagentSpecialties: [
      {
        id: "interface_contract_mapper",
        label: "Interface Contract Mapper",
        description: "Read-only enumeration of all public interfaces and their contracts, flagging missing or implicit contracts.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "architecture_risk_scout",
        label: "Architecture Risk Scout",
        description: "Read-only identification of architectural risks including coupling, scalability bottlenecks, and operational hazards.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "alternative_design_dissenter",
        label: "Alternative Design Dissenter",
        description: "Read-only adversarial review that argues for at least one serious alternative architecture and names tradeoffs.",
        defaultModel: "sonnet",
        defaultEffort: "high",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  docs_researcher: {
    label: "Docs Researcher",
    description: "Verifies APIs, release notes, specs, and current documentation behavior.",
    class: "knowledge",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/docs-researcher/AGENT.md",
    routerDescription:
      "Verifies APIs, framework behavior, release notes, and standards from official or primary sources.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "haiku",
    effort: "medium",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-docs-research", "documentation-lookup", "ecc:search-first"],
    retrievalGuidance: ["approved memory", "repo rules", "approved briefs", "local technical notes"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["source_verifier", "api_doc_reader", "version_change_scout"],
      maxChildDepth: 1,
      maxConcurrentChildren: 2,
      maxTotalChildrenPerTask: 6
    },
    subagentSpecialties: [
      {
        id: "source_verifier",
        label: "Source Verifier",
        description: "Read-only verification that claims made in research are backed by primary or official sources.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "api_doc_reader",
        label: "API Doc Reader",
        description: "Read-only deep dive into official API documentation to surface undocumented constraints and edge cases.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "version_change_scout",
        label: "Version Change Scout",
        description: "Read-only scan for breaking changes, deprecations, and migration notes across relevant version bumps.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  backend_engineer: {
    label: "Backend Engineer",
    description: "Implements services, APIs, data flows, and server-side correctness.",
    class: "delivery",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/backend-engineer/AGENT.md",
    routerDescription:
      "Implements and reviews APIs, services, auth, data models, jobs, and server-side correctness.",
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-execution", "ecc:backend-patterns", "ecc:api-design", "ecc:tdd-workflow"],
    retrievalGuidance: ["approved memory", "repo rules", "runbooks", "reviewed retrieval notes"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["codebase_scout", "test_writer", "patch_writer"],
      maxChildDepth: 2,
      maxConcurrentChildren: 3,
      maxTotalChildrenPerTask: 8
    },
    subagentSpecialties: [
      {
        id: "codebase_scout",
        label: "Codebase Scout",
        description: "Read-only exploration of the codebase to map call sites, dependencies, and invariants before writing.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "test_writer",
        label: "Test Writer",
        description: "Writes tests under tests/ matching the scope declared by the parent backend_engineer.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Write", "Edit", "Bash"],
        allowedWriteScopeMode: "explicit",
        maxTurns: 30,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "patch_writer",
        label: "Patch Writer",
        description: "Applies a bounded patch to src/ within the parent's allowed write scope.",
        defaultModel: "sonnet",
        defaultEffort: "high",
        allowedTools: ["Read", "Write", "Edit", "Bash"],
        allowedWriteScopeMode: "inherited_subset",
        maxTurns: 40,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  frontend_designer: {
    label: "Frontend Designer",
    description: "Owns UX, accessibility, interface quality, and frontend implementation.",
    class: "delivery",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/frontend-designer/AGENT.md",
    routerDescription:
      "Owns UX, UI quality, accessibility, and frontend implementation with a bias for polished, intentional interfaces. Produces developer-tool-grade UI: technically credible, information-dense, and visually distinguished from generic AI output.",
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-frontend-taste", "archon-design-system", "ecc:frontend-patterns", "web-design-guidelines"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "reviewed UI artifacts"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["component_scout", "accessibility_probe", "visual_consistency_checker", "interaction_test_writer"],
      maxChildDepth: 1,
      maxConcurrentChildren: 2,
      maxTotalChildrenPerTask: 6
    },
    subagentSpecialties: [
      {
        id: "component_scout",
        label: "Component Scout",
        description: "Read-only survey of existing UI components to identify reuse opportunities before writing new ones.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "accessibility_probe",
        label: "Accessibility Probe",
        description: "Read-only check for semantic HTML, ARIA usage, keyboard navigation, and contrast requirements.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "visual_consistency_checker",
        label: "Visual Consistency Checker",
        description: "Read-only review that the UI follows the project design system tokens, spacing, and component conventions.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "interaction_test_writer",
        label: "Interaction Test Writer",
        description: "Writes interaction tests for UI components under the parent designer's allowed write scope.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Write", "Edit", "Bash"],
        allowedWriteScopeMode: "inherited_subset",
        maxTurns: 25,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  git_operator: {
    label: "Git Operator",
    description: "Handles git hygiene, staging, commit slicing, and publish preparation.",
    class: "knowledge",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/git-operator/AGENT.md",
    routerDescription:
      "Handles git status, staging, diff hygiene, and atomic commit preparation without polluting repos with archon control artifacts.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "haiku",
    effort: "medium",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: [
      "archon-git-operator",
      "superpowers-using-git-worktrees",
      "superpowers-finishing-development-branch"
    ],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "task packets", "git status and diff evidence"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["commit_slicer", "diff_hygiene_checker", "branch_policy_checker"],
      maxChildDepth: 1,
      maxConcurrentChildren: 2,
      maxTotalChildrenPerTask: 6
    },
    subagentSpecialties: [
      {
        id: "commit_slicer",
        label: "Commit Slicer",
        description: "Read-only analysis of staged changes to propose atomic commit boundaries and ordering.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "diff_hygiene_checker",
        label: "Diff Hygiene Checker",
        description: "Read-only review of the diff for debug code, commented-out blocks, and accidental file inclusions.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "branch_policy_checker",
        label: "Branch Policy Checker",
        description: "Read-only verification that branch naming, base branch, and merge strategy comply with repo conventions.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 10,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  infra_engineer: {
    label: "Infrastructure Engineer",
    description: "Designs CI, environments, deploy safety, and operational controls.",
    class: "delivery",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/infra-engineer/AGENT.md",
    routerDescription:
      "Designs and reviews deployment, environments, secrets handling, CI/CD, observability, and operational safety.",
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-infra-ops", "archon-setup", "archon-release-readiness", "ecc:deployment-patterns", "ecc:docker-patterns"],
    retrievalGuidance: ["approved memory", "repo rules", "setup notes", "runbooks", "incident learnings"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["ci_probe", "dockerfile_checker", "env_contract_checker", "deploy_risk_checker"],
      maxChildDepth: 1,
      maxConcurrentChildren: 2,
      maxTotalChildrenPerTask: 6
    },
    subagentSpecialties: [
      {
        id: "ci_probe",
        label: "CI Probe",
        description: "Read-only analysis of CI pipeline configuration to identify gaps, missing jobs, and unsafe step ordering.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "dockerfile_checker",
        label: "Dockerfile Checker",
        description: "Read-only review of Dockerfiles for image hygiene, layer caching, and security baseline issues.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "env_contract_checker",
        label: "Env Contract Checker",
        description: "Read-only verification that all required environment variables are declared and documented.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "deploy_risk_checker",
        label: "Deploy Risk Checker",
        description: "Read-only assessment of deploy risk: migration ordering, rollback safety, and traffic cut-over strategy.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  reviewer: {
    label: "Reviewer",
    description: "Finds correctness bugs, regressions, and missing verification.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/reviewer/AGENT.md",
    routerDescription:
      "Reviews changes for correctness, regressions, and missing tests separate from security review.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-review"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "task packets", "review artifacts"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["diff_slicer", "invariant_checker", "edge_case_hunter"],
      maxChildDepth: 2,
      maxConcurrentChildren: 3,
      maxTotalChildrenPerTask: 8
    },
    subagentSpecialties: [
      {
        id: "diff_slicer",
        label: "Diff Slicer",
        description: "Read-only analysis of a git diff to identify changed surfaces and call sites.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "invariant_checker",
        label: "Invariant Checker",
        description: "Read-only verification that code invariants and type contracts hold across the changed surface.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "edge_case_hunter",
        label: "Edge Case Hunter",
        description: "Read-only exploration that enumerates missing test coverage and untested edge cases.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  build_resolver: {
    label: "Build Resolver",
    description: "Diagnoses and fixes build, typecheck, test, and setup failures.",
    class: "delivery",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/build-resolver/AGENT.md",
    routerDescription:
      "Diagnoses and fixes build, typecheck, test, and setup failures with incremental verification.",
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
    model: "sonnet",
    effort: "medium",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-debugging"],
    retrievalGuidance: ["approved memory", "repo rules", "setup notes", "incident notes", "prior fixes"]
  },
  security_reviewer: {
    label: "Security Reviewer",
    description: "Reviews trust boundaries, abuse cases, and security regressions.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/security-reviewer/AGENT.md",
    routerDescription:
      "Reviews threats, auth, trust boundaries, abuse cases, dependency risks, and secure implementation choices.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "ecc:security-review", "ecc:security-scan", "archon-docs-research"],
    retrievalGuidance: ["approved memory", "repo rules", "incident notes", "review artifacts"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["trust_boundary_mapper", "exploit_scenario_builder", "secrets_scanner"],
      maxChildDepth: 2,
      maxConcurrentChildren: 3,
      maxTotalChildrenPerTask: 8
    },
    subagentSpecialties: [
      {
        id: "trust_boundary_mapper",
        label: "Trust Boundary Mapper",
        description: "Read-only mapping of trust boundaries, privilege transitions, and cross-boundary data flows.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "exploit_scenario_builder",
        label: "Exploit Scenario Builder",
        description: "Read-only red-team analysis enumerating concrete abuse cases for the current change surface.",
        defaultModel: "sonnet",
        defaultEffort: "high",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "secrets_scanner",
        label: "Secrets Scanner",
        description: "Read-only scan for hardcoded secrets, tokens, and credential patterns in changed files.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  qa_engineer: {
    label: "QA Engineer",
    description: "Owns verification rigor, regression detection, and falsifiable completion claims.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/qa-engineer/AGENT.md",
    routerDescription:
      "Finds regressions, missing tests, flaky behavior, acceptance gaps, and release-readiness issues.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: [
      "archon-qa-verification",
      "archon-accessibility-gate",
      "ecc:e2e-testing",
      "verification-loop"
    ],
    retrievalGuidance: ["approved memory", "repo rules", "review gates", "eval artifacts"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["test_evidence_auditor", "e2e_flow_runner", "regression_probe"],
      maxChildDepth: 1,
      maxConcurrentChildren: 2,
      maxTotalChildrenPerTask: 6
    },
    subagentSpecialties: [
      {
        id: "test_evidence_auditor",
        label: "Test Evidence Auditor",
        description: "Read-only audit of test artifacts to verify coverage claims and flag missing or shallow evidence.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "e2e_flow_runner",
        label: "E2E Flow Runner",
        description: "Executes end-to-end flows for critical user paths and reports pass/fail with reproduction steps.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 30,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "regression_probe",
        label: "Regression Probe",
        description: "Read-only check for behavioral regressions across the test suite related to the changed surface.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  "tdd-guide": {
    label: "TDD Guide",
    description: "Drives red-green-refactor sequencing and test-first discipline.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/tdd-guide/AGENT.md",
    routerDescription:
      "Drives red-green-refactor sequencing, failing test design, and test-first discipline.",
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-tdd", "ecc:tdd-workflow"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "task packets", "verification artifacts"]
  },
  "e2e-runner": {
    label: "E2E Runner",
    description: "Verifies critical end-to-end, install, setup, and replay flows.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/e2e-runner/AGENT.md",
    routerDescription:
      "Verifies critical end-to-end workflows, setup paths, install flows, and regression journeys.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-e2e", "ecc:e2e-testing", "anthropic-webapp-testing"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "setup notes", "test artifacts"]
  },
  "release-readiness": {
    label: "Release Readiness",
    description: "Blocks package, migration, installer, and rollout changes that are not ready to ship.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/release-readiness/AGENT.md",
    routerDescription:
      "Blocks package, migration, installer, and rollout changes that are not ready to ship.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-release-readiness", "verification-loop"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "setup notes", "release notes"]
  },
  memory_curator: {
    label: "Memory Curator",
    description: "Promotes reviewed durable project memory.",
    class: "knowledge",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/memory-curator/AGENT.md",
    routerDescription:
      "Captures durable project memory from completed work: decisions, patterns, lessons, and stable preferences.",
    tools: ["Read", "Grep", "Glob", "Write", "Edit"],
    model: "haiku",
    effort: "medium",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-memory", "ecc:strategic-compact"],
    retrievalGuidance: ["all reviewed project artifacts"]
  },
  eval_engineer: {
    label: "Eval Engineer",
    description: "Owns benchmark datasets, graders, eval rigor, and regression evidence quality.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/eval-engineer/AGENT.md",
    routerDescription:
      "Builds and reviews benchmarks, graders, datasets, regression evidence, and measurable quality signals.",
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "claude-api", "archon-eval-engineering", "archon-skill-evals", "ecc:eval-harness"],
    retrievalGuidance: ["approved memory", "repo rules", "eval artifacts", "reviewed plans", "test artifacts"]
  },
  technical_writer: {
    label: "Technical Writer",
    description: "Owns clear operator docs, product docs, release notes, and onboarding artifacts.",
    class: "knowledge",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/technical-writer/AGENT.md",
    routerDescription:
      "Owns clear operator docs, onboarding guides, release notes, and high-signal technical writing.",
    tools: ["Read", "Grep", "Glob", "Write", "Edit"],
    model: "haiku",
    effort: "medium",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-technical-writing", "documentation-lookup", "ecc:article-writing"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "reviewed technical notes", "release notes"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["operator_doc_reviewer", "release_note_drafter", "example_validator"],
      maxChildDepth: 1,
      maxConcurrentChildren: 2,
      maxTotalChildrenPerTask: 6
    },
    subagentSpecialties: [
      {
        id: "operator_doc_reviewer",
        label: "Operator Doc Reviewer",
        description: "Read-only review of operator documentation for accuracy, completeness, and runbook coverage.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "release_note_drafter",
        label: "Release Note Drafter",
        description: "Drafts user-facing release notes from the diff and commit history for the current release slice.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "inherited_subset",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "example_validator",
        label: "Example Validator",
        description: "Read-only check that code examples in documentation are syntactically correct and match the current API.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  agent_runtime_engineer: {
    label: "Agent Runtime Engineer",
    description: "Owns prompt/runtime orchestration, tool contracts, and agent execution safety.",
    class: "delivery",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/agent-runtime-engineer/AGENT.md",
    routerDescription:
      "Owns agent orchestration, prompt/runtime contracts, tool surfaces, and execution-safety behavior.",
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "claude-api", "archon-agent-runtime", "anthropic-mcp-builder", "mcp-server-patterns", "verification-loop", "ecc:agentic-engineering", "ecc:continuous-agent-loop"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "runtime traces", "tooling integration notes"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["hook_contract_checker", "runtime_trace_reader", "agent_prompt_linter"],
      maxChildDepth: 2,
      maxConcurrentChildren: 3,
      maxTotalChildrenPerTask: 8
    },
    subagentSpecialties: [
      {
        id: "hook_contract_checker",
        label: "Hook Contract Checker",
        description: "Read-only verification that hook I/O contracts are consistent with the calling agent surface.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "runtime_trace_reader",
        label: "Runtime Trace Reader",
        description: "Read-only analysis of runtime traces to detect deadlocks, missing stop conditions, and continuation loops.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "agent_prompt_linter",
        label: "Agent Prompt Linter",
        description: "Read-only lint pass over agent prompt files to flag missing exit conditions and unsafe tool grants.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  mobile_engineer: {
    label: "Mobile Engineer",
    description: "Owns mobile-specific product surfaces, interaction quality, and platform constraints.",
    class: "domain_specialist",
    availability: "domain_optional",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/mobile-engineer/AGENT.md",
    routerDescription:
      "Implements and reviews mobile-specific product behavior, interaction flows, and platform constraints.",
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-frontend-taste", "archon-design-system", "ecc:frontend-patterns", "ecc:e2e-testing"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "reviewed UI artifacts", "test artifacts"]
  },
  ml_engineer: {
    label: "ML Engineer",
    description: "Owns model-facing product behavior, evaluation integrity, and ML integration risks.",
    class: "domain_specialist",
    availability: "domain_optional",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/ml-engineer/AGENT.md",
    routerDescription:
      "Owns model-integrated behavior, evaluation rigor, and ML-specific product or inference risks.",
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "claude-api", "archon-eval-engineering", "documentation-lookup", "verification-loop"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "model evaluations", "integration notes"]
  },
  data_engineer: {
    label: "Data Engineer",
    description: "Owns data pipelines, schema movement, and data-system reliability concerns.",
    class: "domain_specialist",
    availability: "domain_optional",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/data-engineer/AGENT.md",
    routerDescription:
      "Designs and implements data pipelines, schemas, transformations, and data-system reliability safeguards.",
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "ecc:backend-patterns", "ecc:postgres-patterns", "ecc:database-migrations", "verification-loop"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "schema notes", "runbooks"]
  },
  ux_researcher: {
    label: "UX Researcher",
    description: "Owns user-flow investigation, evidence gathering, and experience-quality feedback.",
    class: "domain_specialist",
    availability: "domain_optional",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/ux-researcher/AGENT.md",
    routerDescription:
      "Investigates user flows, evidence of friction, and experience-quality tradeoffs.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-ux-research", "archon-frontend-taste", "ecc:market-research"],
    retrievalGuidance: ["approved briefs", "approved memory", "repo rules", "reviewed plans", "reviewed UI artifacts"]
  },
  product_analyst: {
    label: "Product Analyst",
    description: "Owns metrics framing, evidence interpretation, and product-signal analysis.",
    class: "domain_specialist",
    availability: "domain_optional",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/product-analyst/AGENT.md",
    routerDescription:
      "Analyzes product signals, metrics, evidence quality, and decision-making tradeoffs.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-product-analysis", "ecc:market-research"],
    retrievalGuidance: ["approved briefs", "approved memory", "repo rules", "reviewed plans", "eval artifacts"]
  },
  compliance_reviewer: {
    label: "Compliance Reviewer",
    description: "Owns compliance-sensitive review of policy, controls, and regulated-surface risks.",
    class: "domain_specialist",
    availability: "domain_optional",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/compliance-reviewer/AGENT.md",
    routerDescription:
      "Reviews compliance-sensitive workflows, policy controls, auditability, and regulated-surface risks.",
    tools: ["Read", "Grep", "Glob", "Bash", "Write"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "archon-compliance-review", "ecc:security-review", "documentation-lookup"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "incident notes", "audit artifacts"]
  },
  accessibility_engineer: {
    label: "Accessibility Engineer",
    description: "Owns accessibility_acceptance gate: semantic HTML, keyboard navigation, ARIA discipline, contrast, and focus management.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/accessibility-engineer/AGENT.md",
    routerDescription:
      "Owns accessibility_acceptance gate: semantic HTML, keyboard navigation, ARIA discipline, contrast, and focus management.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "archon-accessibility-gate", "ecc:e2e-testing", "web-design-guidelines"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "test artifacts", "reviewed UI artifacts"]
  },
  database_specialist: {
    label: "Database Specialist",
    description: "Owns schema migrations, query optimization, index design, and data-system correctness for PostgreSQL-backed workflows.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/database-specialist/AGENT.md",
    routerDescription:
      "Owns schema migrations, query optimization, index design, and data-system correctness for PostgreSQL-backed workflows.",
    tools: ["Read", "Grep", "Glob", "Bash", "Write", "Edit"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "ecc:postgres-patterns", "ecc:database-migrations", "verification-loop"],
    retrievalGuidance: ["approved memory", "repo rules", "schema notes", "reviewed plans", "migration artifacts"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["migration_safety_checker", "query_plan_reader", "index_design_checker"],
      maxChildDepth: 1,
      maxConcurrentChildren: 2,
      maxTotalChildrenPerTask: 6
    },
    subagentSpecialties: [
      {
        id: "migration_safety_checker",
        label: "Migration Safety Checker",
        description: "Read-only review of migration files for lock contention, rollback viability, and data-loss risks.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "query_plan_reader",
        label: "Query Plan Reader",
        description: "Read-only analysis of EXPLAIN output and query patterns to identify sequential scans and N+1 risks.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "index_design_checker",
        label: "Index Design Checker",
        description: "Read-only assessment of index coverage, redundancy, and selectivity for current query patterns.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  performance_engineer: {
    label: "Performance Engineer",
    description: "Owns performance_check_required gate: profiling, latency analysis, query cost, throughput verification, and regression blocking.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/performance-engineer/AGENT.md",
    routerDescription:
      "Owns performance_check_required gate: profiling, latency analysis, query cost, throughput verification, and regression blocking.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "archon-performance", "verification-loop", "ecc:backend-patterns"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "benchmark artifacts", "profiling notes"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["benchmark_runner", "hot_path_profiler", "regression_comparator"],
      maxChildDepth: 1,
      maxConcurrentChildren: 2,
      maxTotalChildrenPerTask: 6
    },
    subagentSpecialties: [
      {
        id: "benchmark_runner",
        label: "Benchmark Runner",
        description: "Executes benchmarks and records latency, throughput, and memory metrics for the current change surface.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "hot_path_profiler",
        label: "Hot Path Profiler",
        description: "Read-only analysis of execution hot paths to identify the highest-impact optimization targets.",
        defaultModel: "sonnet",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 20,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "regression_comparator",
        label: "Regression Comparator",
        description: "Read-only comparison of current benchmark results against the baseline to detect performance regressions.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  context_manager: {
    label: "Context Manager",
    description: "Assembles retrieval context for agents from the correct authority layer: .archon/memory/, Postgres runtime, Obsidian vault, and graphify knowledge graph.",
    class: "knowledge",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/context-manager/AGENT.md",
    routerDescription:
      "Assembles retrieval context for agents: queries Qdrant, .archon/memory/, Postgres runtime records, and the Obsidian vault. Prioritizes canonical files over semantic hints.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "haiku",
    effort: "medium",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-context-retrieval", "archon-memory", "ecc:search-first", "ecc:iterative-retrieval"],
    retrievalGuidance: ["all retrieval layers", ".archon/memory/", "Postgres runtime records", "Obsidian vault", "graphify knowledge graph"],
    spawnPolicy: {
      canSpawnSubagents: true,
      allowedSubagentTypes: ["memory_reader", "graph_retrieval_scout", "runtime_history_summarizer"],
      maxChildDepth: 1,
      maxConcurrentChildren: 2,
      maxTotalChildrenPerTask: 6
    },
    subagentSpecialties: [
      {
        id: "memory_reader",
        label: "Memory Reader",
        description: "Read-only retrieval from .archon/memory/ to surface relevant durable facts for the current task.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "graph_retrieval_scout",
        label: "Graph Retrieval Scout",
        description: "Read-only query of the graphify knowledge graph to locate entity relationships relevant to the current task.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      },
      {
        id: "runtime_history_summarizer",
        label: "Runtime History Summarizer",
        description: "Read-only summary of Postgres runtime records for the current run to reconstruct prior invocation context.",
        defaultModel: "haiku",
        defaultEffort: "medium",
        allowedTools: ["Read", "Bash"],
        allowedWriteScopeMode: "read_only",
        maxTurns: 15,
        outputSchema: "SubagentResultPacketV1"
      }
    ]
  },
  observability_engineer: {
    label: "Observability Engineer",
    description: "Owns observability gate: Grafana dashboards, distributed tracing, SLI/SLO design, alerting, and log-signal quality.",
    class: "quality",
    availability: "core_optional",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/observability-engineer/AGENT.md",
    routerDescription:
      "Owns observability gate: Grafana dashboards, distributed tracing, SLI/SLO design, alerting, and log-signal quality.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "archon-performance", "verification-loop", "ecc:backend-patterns"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "runbooks", "benchmark artifacts", "Grafana config at src/grafana/"]
  },
  review_orchestrator: {
    label: "Review Orchestrator",
    description: "Spawns reviewer, qa_engineer, and security_reviewer agents and writes their findings to the DB as trusted orchestrator records.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/review-orchestrator/AGENT.md",
    routerDescription:
      "Spawns reviewer, qa_engineer, and security_reviewer agents and writes their findings to the DB as trusted orchestrator records.",
    tools: ["Bash", "Read", "Grep", "Glob", "Agent"],
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: false,
    defaultSkillIds: ["archon-review", "archon-qa-verification", "verification-loop"],
    retrievalGuidance: ["approved memory", "repo rules", "task packets", "review artifacts"]
  }
} as const satisfies Record<string, AgentCatalogEntryV2>;
