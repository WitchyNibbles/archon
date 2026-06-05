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
    defaultSkillIds: ["archon-planning", "superpowers-writing-plans"],
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
    defaultSkillIds: ["archon-product-framing", "archon-intake", "market-research"],
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
    defaultSkillIds: ["archon-architecture", "backend-patterns", "security-review"],
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
    defaultSkillIds: ["archon-docs-research", "documentation-lookup"],
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
    defaultSkillIds: ["archon-execution", "backend-patterns", "api-design"],
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
    defaultSkillIds: ["archon-frontend-taste", "archon-design-system", "frontend-patterns", "web-design-guidelines"],
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
    defaultSkillIds: ["archon-infra-ops", "archon-setup", "archon-release-readiness"],
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
    defaultSkillIds: ["archon-review", "superpowers-verification-before-completion"],
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
    defaultSkillIds: ["archon-debugging", "superpowers-systematic-debugging"],
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
    defaultSkillIds: ["security-review", "archon-docs-research"],
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
      "anthropic-webapp-testing",
      "e2e-testing",
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
    defaultSkillIds: ["archon-tdd", "superpowers-test-driven-development"],
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
    defaultSkillIds: ["archon-e2e", "anthropic-webapp-testing", "e2e-testing"],
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
    defaultSkillIds: ["archon-memory", "strategic-compact"],
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
    defaultSkillIds: ["archon-eval-engineering", "archon-skill-evals", "eval-harness"],
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
    defaultSkillIds: ["archon-technical-writing", "documentation-lookup", "article-writing"],
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
    defaultSkillIds: ["archon-agent-runtime", "anthropic-mcp-builder", "mcp-server-patterns", "verification-loop"],
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
    defaultSkillIds: ["archon-frontend-taste", "archon-design-system", "frontend-patterns", "e2e-testing"],
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
    defaultSkillIds: ["documentation-lookup", "verification-loop"],
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
    defaultSkillIds: ["backend-patterns", "verification-loop"],
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
    defaultSkillIds: ["archon-ux-research", "archon-frontend-taste", "market-research"],
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
    defaultSkillIds: ["archon-product-analysis", "market-research"],
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
    defaultSkillIds: ["archon-compliance-review", "security-review", "documentation-lookup"],
    retrievalGuidance: ["approved memory", "repo rules", "reviewed plans", "incident notes", "audit artifacts"]
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
