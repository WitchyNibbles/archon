# Archon: Claude Code Orchestration Platform

> Adaptation of [devgod](../devgod) for Claude Code infrastructure.
> devgod transforms Codex into a structured engineering org; Archon does the same for Claude Code.

---

## Overview

Archon is a **manager-led workflow control layer** for Claude Code that enforces:
- Explicit scope and bounded task execution
- Evidence-based completion (not "the model said it was done")
- Review gates with authenticated principals
- Resumable state with checkpoint/resume
- Role-based agent orchestration with retrieval policies
- Reasoning quality discipline (fact/assumption/hypothesis separation)

## Key Adaptation Mapping

| Codex (devgod) | Claude Code (archon) | Notes |
|---|---|---|
| `.codex/config.toml` | `.claude/settings.json` + `.mcp.json` | JSON format, different schema |
| `.codex/hooks.json` | `.claude/hooks/hooks.json` | Different events & format |
| `.codex/agents/*.toml` | `.claude/agents/*/AGENT.md` | Markdown+YAML frontmatter |
| `.agents/skills/*/SKILL.md` | `.claude/skills/*/SKILL.md` | Same format (portable!) |
| `AGENTS.md` | `CLAUDE.md` | Operating rules entrypoint |
| `.devgod/rules/` | `.archon/rules/` + `.claude/rules/` | Split: path-scoped → `.claude/rules/`, workflow → `.archon/rules/` |
| `.devgod/templates/` | `.archon/templates/` | Same markdown templates |
| `.devgod/work/` | `.archon/work/` | Same filesystem state |
| `.devgod/ACTIVE` | `.archon/ACTIVE` | Same control file |
| `plugins/devgod/scripts/hook-policy.mjs` | `.claude/hooks/archon-*.mjs` | Node scripts (Claude hooks run any executable) |
| GPT model refs (gpt-5.4, gpt-5.5) | Claude model refs (opus, sonnet, haiku) | Throughout agent configs |
| `src/` TypeScript core | `src/` TypeScript core | Mostly portable |
| PostgreSQL + Qdrant | PostgreSQL + Qdrant | Same backing stores |

## Model Strategy

| devgod Role | Codex Model | Archon Model | Archon Effort | Reasoning |
|---|---|---|---|---|
| Manager/Planner | gpt-5.5 | opus | high | Deepest reasoning for orchestration |
| Solution Architect | gpt-5.5 | opus | high | Complex architecture decisions |
| Product Strategist | gpt-5.5 | opus | high | Framing and scope decisions |
| Frontend Designer | gpt-5.4 | sonnet | high | Best coding model for implementation |
| Backend Engineer | gpt-5.4 | sonnet | high | Daily coding work |
| Reviewer/QA | gpt-5.4 | sonnet | high | Code review and verification |
| Security Reviewer | gpt-5.4 | sonnet | high | Security analysis |
| Docs/Knowledge | gpt-5.4 | haiku | medium | Lightweight knowledge tasks |
| Build Resolver | gpt-5.4 | sonnet | medium | Error resolution |

---

## CRITICAL: How Sonnet Should Execute This

1. **Always read source from `origin/main`** — the local devgod working tree is dirty:
   ```bash
   git -C /home/eimi/projects/devgod show origin/main:<path>
   ```
   List files in a tree with:
   ```bash
   git -C /home/eimi/projects/devgod ls-tree -r --name-only origin/main <dir>
   ```

2. **Port, don't reinvent.** The core IP (workflow contracts, role matrices, reasoning gates, council governance, autonomous execution) is policy/algorithm — port it faithfully. Only the *integration surface* (hooks, agent configs, model names, paths) changes.

3. **Global find/replace conventions** (apply to every ported file):
   | devgod | archon |
   |---|---|
   | `DevgodCoreService` | `ArchonCoreService` |
   | `devgod` (identifiers) | `archon` |
   | `Devgod` (types/classes) | `Archon` |
   | `DEVGOD_` (env vars) | `ARCHON_` |
   | `devgod_status` (MCP tools) | `archon_status` |
   | `devgod-intake` (skills) | `archon-intake` |
   | `.devgod/` | `.archon/` |
   | `.codex/` | `.claude/` |
   | `.agents/skills/` | `.claude/skills/` |
   | `AGENTS.md` | `CLAUDE.md` |
   | `plugins/devgod/` | `.claude/hooks/` |
   | `gpt-5.4` / `gpt-5.5` | `sonnet` / `opus` |

4. **Verify each phase** with `npm run check:quality` (tsc --noEmit + vitest) before moving on.

5. **Commit per phase** with conventional commits (`feat:`, `chore:`, etc.) so progress is resumable.

---

## Phase 1: Project Scaffold

**Goal**: Create the project skeleton with package.json, tsconfig, directory structure.

### Directory Layout to Create

```
archon/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
├── .env.example
├── CLAUDE.md                          # Operating rules (adapted from AGENTS.md)
├── README.md
├── .mcp.json                          # MCP server configuration
├── docker-compose.yml                 # Dev runtime (Postgres + Qdrant)
├── .claude/
│   ├── settings.json                  # Project settings
│   ├── hooks/
│   │   ├── hooks.json                 # Hook definitions
│   │   ├── archon-pre-tool.mjs        # PreToolUse hook
│   │   ├── archon-post-tool.mjs       # PostToolUse hook
│   │   ├── archon-stop.mjs            # Stop hook
│   │   ├── archon-session-start.mjs   # SessionStart hook
│   │   ├── archon-prompt-submit.mjs   # UserPromptSubmit hook
│   │   ├── hook-policy.mjs            # Shared policy logic
│   │   └── hook-utils.mjs             # Shared utilities
│   ├── agents/                        # Agent definitions (AGENT.md files)
│   ├── skills/                        # Workflow skills (SKILL.md files)
│   └── rules/                         # Path-scoped rules
├── .archon/
│   ├── ACTIVE                         # Control file (active task, write scope)
│   ├── rules/                         # Workflow policy rules
│   ├── templates/                     # Intake brief, task packet, review gate templates
│   ├── memory/                        # Approved durable project knowledge
│   └── work/                          # Live state
│       ├── briefs/
│       ├── plans/
│       ├── tasks/
│       ├── reviews/
│       ├── council/
│       ├── proofs/
│       ├── daemon/
│       ├── product-state.md
│       └── task-queue.json
├── src/
│   ├── index.ts
│   ├── admin.ts
│   ├── core/{service,policy,review-context}.ts
│   ├── domain/{types,contracts}.ts
│   ├── archon/{agent-catalog,task-queue,autopilot-status}.ts
│   ├── admin/{status,ops,report,planning-context}.ts
│   ├── store/{types,postgres-store}.ts
│   ├── runtime/{autonomous-execution,coverage-ledger,indexing}.ts
│   ├── mcp/{server,tools}.ts
│   ├── install/{cli,merge}.ts
│   └── ui/server.ts
├── scripts/
│   ├── check-archon-workflow.sh
│   └── archon-session-start.sh
├── tests/
│   ├── control-layer-contract.test.ts
│   ├── service.test.ts
│   ├── install.test.ts
│   └── workflow-integrity.test.ts
└── sql/migrations/
```

### package.json

```json
{
  "name": "archon",
  "version": "0.1.0",
  "description": "Manager-led workflow control layer for Claude Code",
  "type": "module",
  "engines": { "node": ">=22.0.0" },
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/admin.ts",
    "archon": "tsx src/admin.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "check:quality": "tsc --noEmit && vitest run",
    "check:workflow": "bash scripts/check-archon-workflow.sh",
    "setup:local": "docker compose up -d",
    "doctor": "tsx src/admin.ts doctor",
    "status": "tsx src/admin.ts status",
    "ops": "tsx src/admin.ts ops",
    "mcp": "tsx src/mcp/server.ts",
    "ui": "tsx src/ui/server.ts",
    "install:project": "tsx src/install/cli.ts",
    "scaffold:workflow": "tsx src/install/cli.ts scaffold-workflow"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "pg": "^8.13.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

Read devgod's package.json (`git show origin/main:package.json`) for the full dependency list and any additional scripts worth carrying over (e.g. `@iarna/toml` is NOT needed since we drop TOML; `promptfoo` for evals is optional).

### tsconfig.json

Use NodeNext module resolution, ES2022 target, strict mode, `outDir: dist`, `rootDir: src`. Copy devgod's tsconfig and adjust if present.

---

## Phase 2: Domain Layer

**Goal**: Port the type system and validation contracts.

### 2.1 `src/domain/types.ts`

Port from `devgod/src/domain/types.ts`. Apply global conventions. Keep all enums/interfaces identical:
- `RunStatus`, `TaskStatus`, `ReviewState`, `ReviewSeverity`
- `CompletionStandard`, `QualityGate`
- `RunRecord`, `TaskRecord`, `ReviewRecord`, `ApprovalRecord`
- `MemoryEntryRecord`, `WorkflowDocumentRecord`
- `AutonomousExecutionState`, `CoverageLedger`

### 2.2 `src/domain/contracts.ts`

Port from `devgod/src/domain/contracts.ts`. Keep all 17 quality gates, Zod schemas. Update skill IDs (`devgod-*` → `archon-*`) and paths.

**Verify**: `tsc --noEmit` passes on domain layer.

---

## Phase 3: Agent Catalog

**Goal**: Port the 26-role agent catalog with Claude model assignments + create Claude AGENT.md files.

### 3.1 `src/archon/agent-catalog.ts`

Port from `devgod/src/devgod/agent-catalog.ts`. Map every `model` field to a Claude model per the Model Strategy table. Map `defaultSkillIds` to `archon-*`. Keep role classification (`class`, `availability`, `canOwnTasks`, `canSatisfySpecialistRequirement`, `retrievalGuidance`).

### 3.2 Claude Agent Definitions (`.claude/agents/<name>/AGENT.md`)

For each role, create an AGENT.md. **Derive the prompt body from the matching `.codex/agents/<name>.toml`** (`git show origin/main:.codex/agents/<name>.toml`) — port the `instructions` field into the markdown body, translating Codex-isms to Claude Code.

Format:
```markdown
---
description: "One-line description for Claude to decide when to invoke"
model: opus|sonnet|haiku
effort: high|medium|low
tools: [Read, Grep, Glob, Bash, Edit, Write]
skills: [archon-intake, archon-planning]
---

# Role Name

## Identity
...

## Responsibilities
...

## Constraints
...

## Retrieval Guidance
You may access: ... (from role-retrieval-policy)
```

**Core-required agents** (create first): planner (opus), product-strategist (opus), solution-architect (opus), backend-engineer (sonnet), frontend-designer (sonnet), reviewer (sonnet), qa-engineer (sonnet), security-reviewer (sonnet), infra-engineer (sonnet), build-resolver (sonnet).

**Core-optional**: tdd-guide, e2e-runner, release-readiness, docs-researcher (haiku), git-operator (haiku), memory-curator (haiku), technical-writer (haiku), eval-engineer, agent-runtime-engineer.

**Domain specialists**: mobile-engineer, ml-engineer, data-engineer, ux-researcher, product-analyst, compliance-reviewer.

First list available source TOMLs: `git -C /home/eimi/projects/devgod ls-tree --name-only origin/main .codex/agents/`.

---

## Phase 4: Hook System

**Goal**: Port the Codex hook policy to Claude Code's hook system.

Claude Code hook events differ from Codex. Mapping:
| Codex hook | Claude Code hook |
|---|---|
| SessionStart | SessionStart |
| UserPromptSubmit | UserPromptSubmit |
| PreToolUse | PreToolUse |
| PermissionRequest | (fold into PreToolUse `decision`) |
| PostToolUse | PostToolUse |
| Stop | Stop |

### 4.1 `.claude/hooks/hooks.json`

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node .claude/hooks/archon-session-start.mjs", "timeout": 10 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node .claude/hooks/archon-prompt-submit.mjs", "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash|Write|Edit", "hooks": [{ "type": "command", "command": "node .claude/hooks/archon-pre-tool.mjs", "timeout": 5 }] }
    ],
    "PostToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node .claude/hooks/archon-post-tool.mjs", "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node .claude/hooks/archon-stop.mjs", "timeout": 5 }] }
    ]
  }
}
```

### 4.2 Hook Scripts

Port logic from `plugins/devgod/scripts/hook-policy.mjs` and `hook-utils.mjs` (read both from origin/main). **Key difference**: Claude Code hooks read JSON on **stdin** and write JSON on **stdout** (NOT the Codex envelope format). Adapt the I/O layer but keep the policy logic.

Claude Code hook I/O contract:
- **Input (stdin)**: JSON with `tool_name`, `tool_input`, `cwd`, event-specific fields.
- **Output (stdout)**: JSON. For PreToolUse: `{"decision": "allow"|"block"|"ask", "reason": "..."}` or `{"permissionDecision": "deny", "permissionDecisionReason": "..."}`. For Stop: `{"continue": false, "stopReason": "..."}`. Exit code 2 = blocking error (stderr shown to Claude).

**archon-session-start.mjs**: Read `.archon/ACTIVE`, emit `additionalContext` with active task, write scope, blocker state.

**archon-prompt-submit.mjs**: Classify request; if substantive and no active task, inject guidance to run intake.

**archon-pre-tool.mjs**: Block destructive commands (rm -rf, git reset --hard, git push --force, mkfs); enforce write scope from `.archon/ACTIVE`; protect managed paths (`.claude/`, `.archon/memory/`, `CLAUDE.md`) unless task-scoped.

**archon-post-tool.mjs**: Classify bash failures; persist blocker state to `.archon/work/daemon/hook-blocker-state.json`; flag verification failures.

**archon-stop.mjs**: Hold exit if active task in-progress or unresolved blocker.

### 4.3 settings.json hook registration

Claude Code can also reference hooks from `.claude/settings.json`. Put the hooks block there OR in `.claude/hooks/hooks.json` (both supported). Recommend `.claude/settings.json` for the canonical project install. Mirror the structure above.

---

## Phase 5: Skills

**Goal**: Port workflow skills from `.agents/skills/` to `.claude/skills/`.

devgod skills use `SKILL.md` with YAML frontmatter — **already the format Claude Code expects**. List sources: `git -C /home/eimi/projects/devgod ls-tree --name-only origin/main .agents/skills/`.

Port each (rename `devgod-*` → `archon-*`):
1. archon-intake, 2. archon-planning, 3. archon-review, 4. archon-debugging, 5. archon-ui-art-direction, 6. archon-frontend-taste, 7. archon-design-system, 8. archon-qa-verification, 9. archon-git-operator, 10. archon-agent-runtime, 11. archon-docs-research, 12. archon-release-readiness (and any others present).

**Adapt**: path refs (`.devgod/`→`.archon/`, `.codex/`→`.claude/`); tool names → Claude Code tools (Read/Write/Edit/Bash/Glob/Grep/Agent); frontmatter `model`/`tools`. Keep procedural content (checklists, gates, criteria) — that's the core IP. Add Claude-specific frontmatter where useful: `model`, `effort`, `disable-model-invocation`.

---

## Phase 6: Operating Rules (CLAUDE.md)

**Goal**: Port AGENTS.md → CLAUDE.md as canonical operating rules.

Read `git show origin/main:AGENTS.md`. Port these sections, translating Codex → Claude Code:
- **Manager Kernel** (root thread triage/routing behavior)
- **Workflow Pipeline** (intake → brief → plan → task packet → execution → reviews → proof)
- **Role Chain** (planner → solution_architect → specialists → review trio)
- **Design & Architecture Council** (3-5 panel, dissent owner, outcomes)
- **Quality Gates** (all 17, with triggers)
- **Review Authority** (reviewer, qa_engineer, security_reviewer)
- **Write Scope Enforcement**
- **Evidence Discipline** (facts/assumptions/hypotheses/counter-evidence)
- **Completion Standards** (artifact_complete vs specialist_verified)

**Claude-specific additions**:
- Delegation via the `Agent` tool with `subagent_type` + `model` routing.
- Worktree isolation (`isolation: "worktree"`) for parallel specialist work.
- Effort levels per task class.
- Skill invocation (`/archon-intake`, `/archon-review`).
- Keep CLAUDE.md lean (<200 lines core); use `@.archon/rules/<file>.md` imports for detail, or point to `.archon/rules/`.

---

## Phase 7: Rules & Templates

### 7.1 Path-Scoped Rules (`.claude/rules/`)

For language/path-specific rules, use Claude Code's `paths` frontmatter:
```markdown
---
paths: ["src/**/*.ts"]
---
# TypeScript rules...
```

### 7.2 Workflow Rules (`.archon/rules/`)

Port from `.devgod/rules/` (list: `git -C /home/eimi/projects/devgod ls-tree --name-only origin/main .devgod/rules/`):
task-quality-matrix.md, role-retrieval-policy.md, review-gate-policy.md, write-scope.md, reasoning-quality.md, frontend-quality-rubric.md, frontend-inspiration-sources.md, design-council-policy.md.

### 7.3 Templates (`.archon/templates/`)

Port intake-brief.md, task-packet.md, review-gate.md (and any others). Update `devgod`→`archon` references and Codex→Claude language.

---

## Phase 8: Core Service

**Goal**: Port `ArchonCoreService`.

### 8.1 `src/core/service.ts`

Port from `devgod/src/core/service.ts` (~2,700 lines — the largest file; read in chunks via `git show origin/main:src/core/service.ts`). Rename class, update paths/models. Keep all logic: run lifecycle, task state machine, reviews/approvals, autonomous execution state, checkpoint/resume, coverage tracking.

### 8.2 `src/core/policy.ts` — role retrieval (pure functions, portable).
### 8.3 `src/core/review-context.ts` — review context resolution.

**Verify**: `tsc --noEmit`.

---

## Phase 9: Task Queue & Autopilot

### 9.1 `src/archon/task-queue.ts`
Port from `devgod/src/devgod/task-queue.ts` (~400 lines): `selectNextUnblockedTask()`, `advanceTaskQueue()`, `validateWorkflowTaskQueue()`.

### 9.2 `src/archon/autopilot-status.ts`
Port autonomous status reporting.

---

## Phase 10: Storage Layer

### 10.1 `src/store/types.ts` — store interface (portable).
### 10.2 `src/store/postgres-store.ts` — PostgreSQL impl (same schema/queries).
### 10.3 `sql/migrations/` — port migration files (`git ls-tree origin/main src/sql/migrations/` or wherever they live).
### 10.4 `docker-compose.yml` — Postgres + Qdrant.

Update `DEVGOD_*` env vars → `ARCHON_*`.

---

## Phase 11: MCP Server

### 11.1 `src/mcp/server.ts` & `src/mcp/tools.ts`
Port 6 tools: archon_status, archon_runtime_health, archon_ops, archon_loop, archon_report, archon_plan_context.

### 11.2 `.mcp.json`
```json
{
  "mcpServers": {
    "archon": { "command": "tsx", "args": ["src/mcp/server.ts"] }
  }
}
```

---

## Phase 12: Admin CLI & Operator Surfaces

Port `src/admin.ts` (CLI entry: doctor, status, ops, report, etc.) and `src/admin/{status,ops,report,planning-context}.ts`.

---

## Phase 13: Install System

Port `src/install/cli.ts` and `src/install/merge.ts`. **Key adaptations**: install into `.claude/` not `.codex/`; generate `CLAUDE.md` not `AGENTS.md`; ship `.claude/agents/`, `.claude/skills/`, `.claude/hooks/`; manifest at `.archon/install-manifest.json`. The merge logic for JSON (`.claude/settings.json`, `.mcp.json`) replaces the TOML merge logic — adapt accordingly (drop `@iarna/toml`, use JSON merge).

---

## Phase 14: Runtime & Autonomous Execution

Port `src/runtime/{autonomous-execution,coverage-ledger,indexing}.ts`. **Claude-native additions**: worktree isolation for parallel specialists, effort routing per task complexity, extended-thinking budget for complex decisions, subagent orchestration via Agent tool with model routing.

---

## Phase 15: Tests

Port `tests/{control-layer-contract,service,install,workflow-integrity}.test.ts`. Update all `devgod`→`archon` refs, path assertions (`.devgod/`→`.archon/`, `.codex/`→`.claude/`), model-name assertions, skill-ID assertions. The contract test is the key gate — it should assert the catalog, skills, gates, and templates are wired correctly.

**Verify**: `npm run check:quality` green.

---

## Phase 16: Scripts & Verification

Port `scripts/check-archon-workflow.sh` (workflow verification) and `scripts/archon-session-start.sh`. Update paths.

---

## Phase 17: Claude-Native Enhancements

1. **Worktree parallel execution**: subagents with `isolation: "worktree"` for independent/risky/parallel-review work.
2. **Dynamic effort routing**: manager=high/max, implementation=high, docs/knowledge=medium/low.
3. **Skill-based workflow**: `/archon-intake`, `/archon-review`, `/archon-status`.
4. **Memory integration**: use `.claude/projects/*/memory/` for cross-session knowledge.
5. **Plugin packaging (future)**: wrap as a Claude Code plugin (`.claude-plugin/plugin.json` + skills/agents/hooks/.mcp.json) for one-command install.

---

## Execution Order (Waves)

**Wave 1 (Foundation, sequential)**: Phase 1 → Phase 2.
**Wave 2 (Core systems, parallelizable)**: Phase 3 ∥ Phase 5 ∥ Phase 7.
**Wave 3 (Infra, sequential)**: Phase 4 → Phase 6.
**Wave 4 (Backend)**: Phase 10 ∥ Phase 9, then Phase 8.
**Wave 5 (Surfaces, parallelizable)**: Phase 11 ∥ Phase 12 ∥ Phase 13.
**Wave 6**: Phase 14 → Phase 15 → Phase 16.
**Wave 7**: Phase 17.

Run `npm run check:quality` after Waves 2, 4, 5, 6. Commit per phase.

---

## Source Reference

Clean source always from origin/main:
```bash
git -C /home/eimi/projects/devgod show origin/main:<path>
git -C /home/eimi/projects/devgod ls-tree -r --name-only origin/main <dir>
```
