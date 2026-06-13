<div align="center">

# 🔮 Archon

### *A manager-led workflow control layer for Claude Code*

**Structured. Evidence-driven. Enchantingly autonomous.**

[![MIT License](https://img.shields.io/badge/license-MIT-a855f7?style=flat-square)](./LICENSE)
[![Node ≥22](https://img.shields.io/badge/node-%E2%89%A522-6366f1?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3b82f6?style=flat-square)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-0ea5e9?style=flat-square)](https://www.postgresql.org/)

</div>

---

> *In the old traditions, Archon means "ruler" — the one who holds the threads together. This is that, but for your AI engineering workflows.*

Archon is an **opt-in overlay** for [Claude Code](https://claude.ai/code) that conjures a structured, manager-led control layer over your AI development sessions. It enforces evidence-based delivery, orchestrator-backed review gates, bounded task execution, and resumable state — so your agents actually *finish things correctly* instead of hallucinating completion.

It ships **production-oriented package checks** that verify agent catalog completeness, manifest hygiene, skill file coverage, and install contract integrity before any release.

Adapted from [devgod](https://github.com/WitchyNibbles/devgod), which brought the same discipline to Codex.

---

## ✨ What Archon Does

Claude Code is powerful, but raw autonomy without structure leads to drift, unverified work, and "it's done!" when it isn't. Archon casts a **governance spell** over your sessions:

| Without Archon | With Archon |
|---|---|
| Agent says it's done → you trust it | Evidence required before completion is accepted |
| Anyone can merge anything | Authenticated reviewer, QA, and security gates |
| Session ends, context lost | Resumable state via PostgreSQL checkpoint |
| One big agent doing everything | 28 specialist roles, right model for the job |
| Ad-hoc prompting | Typed workflow skills with declared contracts |

---

## 🧿 Core Principles

- **📋 Explicit scope** — tasks declare their allowed write scope before execution starts
- **🔬 Evidence-first completion** — "the model said it was done" is never enough
- **🔐 Review gates** — `reviewer`, `qa_engineer`, and `security_reviewer` must sign off on substantive work
- **♻️ Resumable state** — checkpoint/resume so long-running work survives session breaks
- **🧠 Reasoning discipline** — facts, assumptions, and hypotheses are separated and labelled
- **⚖️ Role-based orchestration** — 28 specialist agents, each with retrieval policies and effort routing

---

## 🗂️ Architecture at a Glance

```
archon/
├── .claude/
│   ├── agents/          # 28 specialist role definitions (AGENT.md per role)
│   ├── skills/          # 42 workflow skills (SKILL.md per skill)
│   └── hooks/           # Session lifecycle hooks
├── .archon/
│   ├── rules/           # Detailed policy documents
│   ├── templates/       # Workflow document templates
│   ├── memory/          # Reviewed durable project memory
│   └── work/            # Live task queue and product state
├── src/
│   ├── archon/          # Agent catalog, task queue, autopilot
│   ├── core/            # Core runtime services
│   ├── mcp/             # MCP server (tool exposure to Claude)
│   ├── runtime/         # Workflow proof and verification
│   ├── install/         # Project installer and merge logic
│   └── ui/              # Admin UI server
├── scripts/             # Setup, install, and check scripts
└── CLAUDE.md            # Operating rules entrypoint
```

---

## 👥 The Agent Team

Archon ships **28 specialist roles** arranged into four classes:

### 🧭 Manager Roles
| Role | Purpose |
|---|---|
| `planner` | Task scoping, phase breakdown, implementation planning |
| `product_strategist` | Product framing, acceptance criteria, market context |
| `solution_architect` | System design, architectural decisions, council reviews |

### 🔨 Delivery Roles
| Role | Purpose |
|---|---|
| `backend_engineer` | API, data layers, services |
| `frontend_designer` | UI, visual taste, design system, accessibility |
| `infra_engineer` | Docker, CI, env, deploy surfaces |
| `build_resolver` | Unsticks failing builds systematically |
| `agent_runtime_engineer` | Hooks, MCP, tool contracts, automation |

### 🛡️ Quality Roles
| Role | Purpose |
|---|---|
| `reviewer` | Code correctness, reuse, simplification |
| `qa_engineer` | Functional verification, E2E, accessibility |
| `security_reviewer` | OWASP, secrets, injection, auth |
| `tdd-guide` | Test-first discipline, coverage enforcement |
| `e2e-runner` | Critical user flow verification |
| `release-readiness` | Pre-release quality gate |
| `eval_engineer` | Skill regression, grader benchmarks |
| `accessibility_engineer` | Accessibility acceptance gate — semantic HTML, keyboard, ARIA, contrast |
| `database_specialist` | Schema migrations, query optimization, PostgreSQL correctness |
| `performance_engineer` | Latency profiling, throughput, benchmark regressions |

### 📚 Knowledge Roles
| Role | Purpose |
|---|---|
| `docs_researcher` | Evidence gathering, prior art, documentation |
| `technical_writer` | Operator docs, migration notes, release notes |
| `memory_curator` | Promotes live state to durable reviewed memory |
| `git_operator` | Staging, commit slicing, branch hygiene |

### 🔬 Domain Specialists *(optional)*
`mobile_engineer` · `ml_engineer` · `data_engineer` · `ux_researcher` · `product_analyst` · `compliance_reviewer`

---

## ⚡ Effort & Model Routing

Archon routes tasks to the right Claude model automatically:

| Task Class | Model | Effort |
|---|---|---|
| Planning, architecture, council | `claude-opus-4-8` | high |
| Implementation, review, QA | `claude-sonnet-4-6` | high |
| Docs, knowledge, memory | `claude-haiku-4-5-20251001` | medium |
| Trivial mechanical tasks | `claude-haiku-4-5-20251001` | low |

---

## 🪄 Workflow Skills

Invoke any skill from within a Claude Code session with a slash command:

```
/archon-intake              ✦ Start or clarify a substantive task
/archon-planning            ✦ Structure and scope a task
/archon-architecture        ✦ Architecture council review
/archon-execution           ✦ Run a delivery task with full gates
/archon-autopilot           ✦ Run the full delivery loop autonomously
/archon-review              ✦ Invoke review gate evidence gathering
/archon-qa-verification     ✦ QA verification and regression checks
/archon-tdd                 ✦ Test-driven development enforcement
/archon-e2e                 ✦ End-to-end flow verification
/archon-accessibility-gate  ✦ Accessibility acceptance gate
/archon-performance         ✦ Performance profiling and benchmark verification
/archon-release-readiness   ✦ Pre-release quality gate
/archon-debugging           ✦ Systematic root-cause investigation
/archon-repair-loop         ✦ Autonomous repair when a task gets stuck
/archon-git-operator        ✦ Stage, slice, and commit safely
/archon-graphify            ✦ Advisory repo intelligence via graphify knowledge graph
/archon-infra-ops           ✦ Infrastructure and environment work
/archon-setup               ✦ First-time project bootstrap
/archon-docs-research       ✦ Research docs, evidence, and prior art
/archon-technical-writing   ✦ Operator docs, release notes, onboarding
/archon-memory              ✦ Promote live state to durable memory
/archon-product-framing     ✦ Product framing and acceptance clarity
/archon-product-analysis    ✦ Metrics framing and product-signal analysis
/archon-ux-research         ✦ User-flow investigation and experience quality
/archon-compliance-review   ✦ Compliance-sensitive review of policy and controls
/archon-design-system       ✦ Design system discipline and visual consistency
/archon-frontend-taste      ✦ Frontend quality and UI taste direction
/archon-agent-runtime       ✦ Hook, MCP, and tool-contract changes
/archon-eval-engineering    ✦ Benchmark datasets, graders, eval rigor
/archon-skill-evals         ✦ Skill regression and quality scoring
```

Skills live in `.claude/skills/`. Each `SKILL.md` declares its trigger, output contract, and allowed write scope.

---

## 🌙 Getting Started

### Prerequisites

- Node.js ≥ 22
- Docker (for Postgres)
- Claude Code CLI
- [everything-claude-code](https://github.com/disler/everything-claude-code) plugin — required for agent skills prefixed `everything-claude-code:*`. Install it as a Claude Code plugin before using agent roles that reference those skills.

### Installation

```bash
git clone https://github.com/WitchyNibbles/archon.git
cd archon
npm install
cp .env.example .env
# Fill in .env with your config
```

### Start the backing stores

```bash
npm run setup:local   # Spins up Postgres via Docker
npm run doctor        # Verifies the full configuration
```

### Bootstrap a project

```bash
npm run bootstrap     # Sets up archon state for this repo
npm run status        # Shows active run and task state
```

### Run the MCP server

```bash
npm run mcp           # Exposes archon tools to Claude Code
```

Add the MCP server to your Claude Code config and archon's tools become available in every session.

---

## 🔮 Memory System

Archon uses two complementary memory layers:

| Layer | Path | Purpose |
|---|---|---|
| **Durable project memory** | `.archon/memory/` | Reviewed stable facts about the project. Survives sessions. Curated by `memory_curator`. |
| **Claude session memory** | `.claude/projects/*/memory/` | Personal workflow context and session continuity. Native Claude Code cross-session memory. |

The two layers are complementary — shared project facts belong in `.archon/memory/`, personal workflow context belongs in Claude's native memory. Never store secrets in either.

---

## 🏛️ Design & Architecture Council

For substantive roadmap and plan work, Archon requires a **Design and Architecture Council** review before execution. A rotating 3–5 role panel (default: `solution_architect`, `product_strategist`, `frontend_designer`, plus `infra_engineer` or `security_reviewer` depending on risk) debates the proposal.

Every council review must name a **dissent owner** responsible for arguing at least one serious alternative. Outcomes: `approved` · `approved_with_conditions` · `rework_required` · `exception_granted` · `rejected`

---

## 🌿 Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# PostgreSQL — workflow state, task queue, run history
ARCHON_CORE_DATABASE_URL=postgresql://archon:password@127.0.0.1:5432/archon
ARCHON_POSTGRES_PORT=5432

# Runtime mode
ARCHON_RUNTIME_MODE=auto
ARCHON_RUNTIME_PROFILE=local-docker
```

---

## 🗺️ Useful Commands

```bash
npm run status          # Active run and task state
npm run health          # Service health check
npm run doctor          # Full configuration verification
npm run migrate         # Run DB migrations
npm run archon          # Admin CLI
npm run mcp             # Start MCP server
npm run ui              # Start admin UI
npm run check:workflow  # Verify workflow contract
npm run check:quality   # TypeScript + tests
```

---

## 📜 Docs & Policy

| Document | Contents |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | Operating rules, workflow contract, role chain |
| [`.archon/rules/`](./.archon/rules/) | Detailed policy: review gates, write scope, reasoning quality |
| [`docs/archon-agent-team.md`](./docs/archon-agent-team.md) | Full agent team reference matrix |
| [`docs/global-setup.md`](./docs/global-setup.md) | Installing archon into a consuming project |
| [`.claude/agents/`](./.claude/agents/) | 28 specialist role definitions |
| [`.claude/skills/`](./.claude/skills/) | 42 workflow skill definitions |

---

## 🧬 Lineage

Archon is a port of [devgod](https://github.com/WitchyNibbles/devgod), which brought the same manager-led orchestration discipline to OpenAI Codex. The core IP — workflow contracts, role matrices, reasoning gates, council governance, autonomous execution — is preserved faithfully. Only the integration surface changed: hooks format, agent config format, model names, and directory paths adapted for Claude Code's conventions.

---

## 📄 License

[MIT](./LICENSE) © 2026 WitchyNibbles

---

<div align="center">

*Built with intention. Governed by evidence. Delivered by specialists.*

**🌑 🌒 🌓 🌔 🌕**

</div>
