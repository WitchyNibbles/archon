export type AgentRoleClass = "manager" | "delivery" | "quality" | "knowledge" | "domain_specialist";
export type AgentRoleAvailability = "core_required" | "core_optional" | "domain_optional";

export interface AgentCatalogEntry {
  label: string;
  description: string;
  class: AgentRoleClass;
  availability: AgentRoleAvailability;
  shipsAgentArtifact: boolean;
  artifactPath: string;
  model: "opus" | "sonnet" | "haiku";
  effort: "high" | "medium" | "low";
  canOwnTasks: boolean;
  canSatisfySpecialistRequirement: boolean;
  defaultSkillIds: readonly string[];
  retrievalGuidance: readonly string[];
}

export const agentCatalog = {
  planner: {
    label: "Planner",
    description: "Owns intake synthesis, decomposition, staffing, checkpoints, and gate enforcement.",
    class: "manager",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/planner/AGENT.md",
    model: "opus",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-planning", "archon-intake", "everything-claude-code:planner"],
    retrievalGuidance: ["approved memory", "reviewed briefs", "reviewed plans", "repo rules"]
  },
  product_strategist: {
    label: "Product Strategist",
    description: "Turns broad asks into product framing, scope, and acceptance criteria.",
    class: "manager",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/product-strategist/AGENT.md",
    model: "opus",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-product-framing", "archon-intake", "everything-claude-code:market-research"],
    retrievalGuidance: ["approved briefs", "approved memory", "repo rules", "cited external research"]
  },
  solution_architect: {
    label: "Solution Architect",
    description: "Defines boundaries, sequencing, and architecture decisions.",
    class: "manager",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/solution-architect/AGENT.md",
    model: "opus",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-architecture", "everything-claude-code:backend-patterns", "everything-claude-code:security-review", "everything-claude-code:agentic-engineering"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "architecture notes"]
  },
  docs_researcher: {
    label: "Docs Researcher",
    description: "Verifies APIs, release notes, specs, and current documentation behavior.",
    class: "knowledge",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/docs-researcher/AGENT.md",
    model: "haiku",
    effort: "medium",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-docs-research", "documentation-lookup", "everything-claude-code:search-first"],
    retrievalGuidance: ["approved memory", "repo rules", "approved briefs", "local technical notes"]
  },
  backend_engineer: {
    label: "Backend Engineer",
    description: "Implements services, APIs, data flows, and server-side correctness.",
    class: "delivery",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/backend-engineer/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-execution", "everything-claude-code:backend-patterns", "everything-claude-code:api-design", "everything-claude-code:tdd-workflow"],
    retrievalGuidance: ["approved memory", "repo rules", "runbooks", "reviewed retrieval notes"]
  },
  frontend_designer: {
    label: "Frontend Designer",
    description: "Owns UX, accessibility, interface quality, and frontend implementation.",
    class: "delivery",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/frontend-designer/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-frontend-taste", "archon-design-system", "everything-claude-code:frontend-patterns", "web-design-guidelines"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "reviewed UI artifacts"]
  },
  git_operator: {
    label: "Git Operator",
    description: "Handles git hygiene, staging, commit slicing, and publish preparation.",
    class: "knowledge",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/git-operator/AGENT.md",
    model: "haiku",
    effort: "medium",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: [
      "archon-git-operator",
      "superpowers-using-git-worktrees",
      "superpowers-finishing-development-branch"
    ],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "task packets", "git status and diff evidence"]
  },
  infra_engineer: {
    label: "Infrastructure Engineer",
    description: "Designs CI, environments, deploy safety, and operational controls.",
    class: "delivery",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/infra-engineer/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-infra-ops", "archon-setup", "archon-release-readiness", "everything-claude-code:deployment-patterns", "everything-claude-code:docker-patterns"],
    retrievalGuidance: ["approved memory", "repo rules", "setup notes", "runbooks", "incident learnings"]
  },
  reviewer: {
    label: "Reviewer",
    description: "Finds correctness bugs, regressions, and missing verification.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/reviewer/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-review"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "task packets", "review artifacts"]
  },
  build_resolver: {
    label: "Build Resolver",
    description: "Diagnoses and fixes build, typecheck, test, and setup failures.",
    class: "delivery",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/build-resolver/AGENT.md",
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
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "everything-claude-code:security-review", "everything-claude-code:security-scan", "archon-docs-research"],
    retrievalGuidance: ["approved memory", "repo rules", "incident notes", "review artifacts"]
  },
  qa_engineer: {
    label: "QA Engineer",
    description: "Owns verification rigor, regression detection, and falsifiable completion claims.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/qa-engineer/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: [
      "archon-qa-verification",
      "archon-accessibility-gate",
      "everything-claude-code:e2e-testing",
      "verification-loop"
    ],
    retrievalGuidance: ["approved memory", "repo rules", "review gates", "eval artifacts"]
  },
  "tdd-guide": {
    label: "TDD Guide",
    description: "Drives red-green-refactor sequencing and test-first discipline.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/tdd-guide/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-tdd", "everything-claude-code:tdd-workflow"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "task packets", "verification artifacts"]
  },
  "e2e-runner": {
    label: "E2E Runner",
    description: "Verifies critical end-to-end, install, setup, and replay flows.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/e2e-runner/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-e2e", "everything-claude-code:e2e-testing", "anthropic-webapp-testing"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "setup notes", "test artifacts"]
  },
  "release-readiness": {
    label: "Release Readiness",
    description: "Blocks package, migration, installer, and rollout changes that are not ready to ship.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/release-readiness/AGENT.md",
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
    model: "haiku",
    effort: "medium",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-memory", "everything-claude-code:strategic-compact"],
    retrievalGuidance: ["all reviewed project artifacts"]
  },
  eval_engineer: {
    label: "Eval Engineer",
    description: "Owns benchmark datasets, graders, eval rigor, and regression evidence quality.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/eval-engineer/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "claude-api", "archon-eval-engineering", "archon-skill-evals", "everything-claude-code:eval-harness"],
    retrievalGuidance: ["approved memory", "repo rules", "eval artifacts", "reviewed plans", "test artifacts"]
  },
  technical_writer: {
    label: "Technical Writer",
    description: "Owns clear operator docs, product docs, release notes, and onboarding artifacts.",
    class: "knowledge",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/technical-writer/AGENT.md",
    model: "haiku",
    effort: "medium",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-technical-writing", "documentation-lookup", "everything-claude-code:article-writing"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "reviewed technical notes", "release notes"]
  },
  agent_runtime_engineer: {
    label: "Agent Runtime Engineer",
    description: "Owns prompt/runtime orchestration, tool contracts, and agent execution safety.",
    class: "delivery",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/agent-runtime-engineer/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "claude-api", "archon-agent-runtime", "anthropic-mcp-builder", "mcp-server-patterns", "verification-loop", "everything-claude-code:agentic-engineering", "everything-claude-code:continuous-agent-loop"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "runtime traces", "tooling integration notes"]
  },
  mobile_engineer: {
    label: "Mobile Engineer",
    description: "Owns mobile-specific product surfaces, interaction quality, and platform constraints.",
    class: "domain_specialist",
    availability: "domain_optional",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/mobile-engineer/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-frontend-taste", "archon-design-system", "everything-claude-code:frontend-patterns", "everything-claude-code:e2e-testing"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "reviewed UI artifacts", "test artifacts"]
  },
  ml_engineer: {
    label: "ML Engineer",
    description: "Owns model-facing product behavior, evaluation integrity, and ML integration risks.",
    class: "domain_specialist",
    availability: "domain_optional",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/ml-engineer/AGENT.md",
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
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "everything-claude-code:backend-patterns", "everything-claude-code:postgres-patterns", "everything-claude-code:database-migrations", "verification-loop"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "schema notes", "runbooks"]
  },
  ux_researcher: {
    label: "UX Researcher",
    description: "Owns user-flow investigation, evidence gathering, and experience-quality feedback.",
    class: "domain_specialist",
    availability: "domain_optional",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/ux-researcher/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-ux-research", "archon-frontend-taste", "everything-claude-code:market-research"],
    retrievalGuidance: ["approved briefs", "approved memory", "repo rules", "reviewed plans", "reviewed UI artifacts"]
  },
  product_analyst: {
    label: "Product Analyst",
    description: "Owns metrics framing, evidence interpretation, and product-signal analysis.",
    class: "domain_specialist",
    availability: "domain_optional",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/product-analyst/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-product-analysis", "everything-claude-code:market-research"],
    retrievalGuidance: ["approved briefs", "approved memory", "repo rules", "reviewed plans", "eval artifacts"]
  },
  compliance_reviewer: {
    label: "Compliance Reviewer",
    description: "Owns compliance-sensitive review of policy, controls, and regulated-surface risks.",
    class: "domain_specialist",
    availability: "domain_optional",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/compliance-reviewer/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "archon-compliance-review", "everything-claude-code:security-review", "documentation-lookup"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "incident notes", "audit artifacts"]
  },
  accessibility_engineer: {
    label: "Accessibility Engineer",
    description: "Owns accessibility_acceptance gate: semantic HTML, keyboard navigation, ARIA discipline, contrast, and focus management.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/accessibility-engineer/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "archon-accessibility-gate", "everything-claude-code:e2e-testing", "web-design-guidelines"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "test artifacts", "reviewed UI artifacts"]
  },
  database_specialist: {
    label: "Database Specialist",
    description: "Owns schema migrations, query optimization, index design, and data-system correctness for PostgreSQL-backed workflows.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/database-specialist/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "everything-claude-code:postgres-patterns", "everything-claude-code:database-migrations", "verification-loop"],
    retrievalGuidance: ["approved memory", "repo rules", "schema notes", "reviewed plans", "migration artifacts"]
  },
  performance_engineer: {
    label: "Performance Engineer",
    description: "Owns performance_check_required gate: profiling, latency analysis, query cost, throughput verification, and regression blocking.",
    class: "quality",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/performance-engineer/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "archon-performance", "verification-loop", "everything-claude-code:backend-patterns"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "benchmark artifacts", "profiling notes"]
  },
  context_manager: {
    label: "Context Manager",
    description: "Assembles retrieval context for agents from the correct authority layer: .archon/memory/, Postgres runtime, Obsidian vault, and graphify knowledge graph.",
    class: "knowledge",
    availability: "core_required",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/context-manager/AGENT.md",
    model: "haiku",
    effort: "medium",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["archon-context-retrieval", "archon-memory", "everything-claude-code:search-first", "everything-claude-code:iterative-retrieval"],
    retrievalGuidance: ["all retrieval layers", ".archon/memory/", "Postgres runtime records", "Obsidian vault", "graphify knowledge graph"]
  },
  observability_engineer: {
    label: "Observability Engineer",
    description: "Owns observability gate: Grafana dashboards, distributed tracing, SLI/SLO design, alerting, and log-signal quality.",
    class: "quality",
    availability: "core_optional",
    shipsAgentArtifact: true,
    artifactPath: ".claude/agents/observability-engineer/AGENT.md",
    model: "sonnet",
    effort: "high",
    canOwnTasks: true,
    canSatisfySpecialistRequirement: true,
    defaultSkillIds: ["caveman", "archon-performance", "verification-loop", "everything-claude-code:backend-patterns"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "runbooks", "benchmark artifacts", "Grafana config at src/grafana/"]
  }
} as const satisfies Record<string, AgentCatalogEntry>;

export type AgentRoleId = keyof typeof agentCatalog;

export const agentRoleIds = Object.freeze(Object.keys(agentCatalog) as AgentRoleId[]);

export const agentCatalogEntries = Object.freeze(
  agentRoleIds.map((id) => ({
    id,
    ...agentCatalog[id]
  }))
);

export function getAgentCatalogEntry(role: AgentRoleId): (typeof agentCatalog)[AgentRoleId] {
  return agentCatalog[role];
}
