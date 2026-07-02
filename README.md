<div align="center">

# Archon

### *A manager-led workflow control layer for Claude Code*

**Structured. Evidence-driven. Enchantingly autonomous.**

[![MIT License](https://img.shields.io/badge/license-MIT-a855f7?style=flat-square)](./LICENSE)
[![Node >=22](https://img.shields.io/badge/node-%E2%89%A522-6366f1?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3b82f6?style=flat-square)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-0ea5e9?style=flat-square)](https://www.postgresql.org/)

</div>

---

> *In the old traditions, Archon means "ruler" — the one who holds the threads together. This is that, but for your AI engineering workflows.*

Archon is an **opt-in overlay** for [Claude Code](https://claude.ai/code) that conjures a structured, manager-led control layer over your AI development sessions. It enforces evidence-based delivery, orchestrator-backed review gates, bounded task execution, and resumable state — so your agents actually *finish things correctly* instead of hallucinating completion.

It ships **production-oriented package checks** that verify agent catalog completeness, manifest hygiene, skill file coverage, and install contract integrity before any release.

Adapted from [devgod](https://github.com/WitchyNibbles/devgod), which brought the same discipline to Codex.

---

## What Archon Does

Claude Code is powerful, but raw autonomy without structure leads to drift, unverified work, and "it's done!" when it isn't. Archon casts a **governance spell** over your sessions:

| Without Archon | With Archon |
|---|---|
| Agent says it's done — you trust it | Evidence required before completion is accepted |
| Anyone can merge anything | Authenticated reviewer, QA, and security gates |
| Session ends, context lost | Resumable state via PostgreSQL checkpoint |
| One big agent doing everything | 31 specialist roles, right model for the job |
| Ad-hoc prompting | Typed workflow skills with declared contracts |

---

## Core Principles

- **Explicit scope** — tasks declare their allowed write scope before execution starts
- **Evidence-first completion** — "the model said it was done" is never enough
- **Review gates** — `reviewer`, `qa_engineer`, and `security_reviewer` must sign off on substantive work
- **Resumable state** — checkpoint/resume so long-running work survives session breaks
- **Reasoning discipline** — facts, assumptions, and hypotheses are separated and labelled
- **Role-based orchestration** — 31 specialist agents, each with retrieval policies and effort routing

---

## Architecture at a Glance

```
archon/
├── .claude/
│   ├── agents/          # 31 specialist role definitions (AGENT.md per role)
│   ├── skills/          # 46 workflow skills (SKILL.md per skill)
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
│   └── install/         # Project installer and merge logic
├── dist/                # Compiled output (ships in the npm package)
├── scripts/             # Setup, install, and check scripts
└── CLAUDE.md            # Operating rules entrypoint
```

---

## The Agent Team

Archon ships **31 specialist roles** arranged into four classes:

### Manager Roles
| Role | Purpose |
|---|---|
| `planner` | Task scoping, phase breakdown, implementation planning |
| `product_strategist` | Product framing, acceptance criteria, market context |
| `solution_architect` | System design, architectural decisions, council reviews |

### Delivery Roles
| Role | Purpose |
|---|---|
| `backend_engineer` | API, data layers, services |
| `frontend_designer` | UI, visual taste, design system, accessibility |
| `infra_engineer` | Docker, CI, env, deploy surfaces |
| `build_resolver` | Unsticks failing builds systematically |
| `agent_runtime_engineer` | Hooks, MCP, tool contracts, automation |

### Quality Roles
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
| `observability_engineer` | Dashboards, tracing, SLI/SLO design, alerting, log-signal quality |
| `review_orchestrator` | Spawns review gate agents and writes their findings as trusted runtime records |

### Knowledge Roles
| Role | Purpose |
|---|---|
| `docs_researcher` | Evidence gathering, prior art, documentation |
| `technical_writer` | Operator docs, migration notes, release notes |
| `memory_curator` | Promotes live state to durable reviewed memory |
| `git_operator` | Staging, commit slicing, branch hygiene |
| `context_manager` | Assembles retrieval context from memory, runtime, and the vault |

### Domain Specialists *(optional)*
`mobile_engineer` · `ml_engineer` · `data_engineer` · `ux_researcher` · `product_analyst` · `compliance_reviewer`

---

## Effort & Model Routing

Archon routes tasks to the right Claude model automatically:

| Task Class | Model | Effort |
|---|---|---|
| Planning, architecture, council | `claude-opus-4-8` | high |
| Implementation, review, QA | `claude-sonnet-4-6` | high |
| Docs, knowledge, memory | `claude-haiku-4-5-20251001` | medium |
| Trivial mechanical tasks | `claude-haiku-4-5-20251001` | low |

---

## Workflow Skills

Invoke any skill from within a Claude Code session with a slash command:

```
/archon-intake              Start or clarify a substantive task
/archon-planning            Structure and scope a task
/archon-architecture        Architecture council review
/archon-execution           Run a delivery task with full gates
/archon-subtask             Scope and run a bounded subtask
/archon-autopilot           Run the full delivery loop autonomously
/archon-review              Invoke review gate evidence gathering
/archon-qa-verification     QA verification and regression checks
/archon-tdd                 Test-driven development enforcement
/archon-e2e                 End-to-end flow verification
/archon-accessibility-gate  Accessibility acceptance gate
/archon-performance         Performance profiling and benchmark verification
/archon-release-readiness   Pre-release quality gate
/archon-debugging           Systematic root-cause investigation
/archon-repair-loop         Autonomous repair when a task gets stuck
/archon-git-operator        Stage, slice, and commit safely
/archon-graphify            Advisory repo intelligence via graphify knowledge graph
/archon-infra-ops           Infrastructure and environment work
/archon-setup               First-time project bootstrap
/archon-handoff             Write a handoff packet to continue work later
/archon-docs-research       Research docs, evidence, and prior art
/archon-context-retrieval   Assemble retrieval context within a token budget
/archon-technical-writing   Operator docs, release notes, onboarding
/archon-memory              Promote live state to durable memory
/archon-product-framing     Product framing and acceptance clarity
/archon-product-analysis    Metrics framing and product-signal analysis
/archon-ux-research         User-flow investigation and experience quality
/archon-compliance-review   Compliance-sensitive review of policy and controls
/archon-frontend            Hub for all frontend work on Archon UIs
/archon-design-system       Design system discipline and visual consistency
/archon-visual-standards    Canonical color, type, motion, and surface tokens
/archon-ui-patterns         Concrete dashboard and workflow UI component patterns
/archon-frontend-taste      Frontend quality and UI taste direction
/archon-agent-runtime       Hook, MCP, and tool-contract changes
/archon-eval-engineering    Benchmark datasets, graders, eval rigor
/archon-skill-evals         Skill regression and quality scoring
/archon-skill-evolution     Create, update, and manage repo-local skills
```

Skills live in `.claude/skills/`. Each `SKILL.md` declares its trigger, output contract, and allowed write scope.

---

## Getting Started

### Prerequisites

- Node.js >= 22
- A pgvector-capable PostgreSQL instance (see DB Setup below)
- Claude Code CLI
- [everything-claude-code](https://github.com/disler/everything-claude-code) plugin — required for skills prefixed `everything-claude-code:*`. Install it as a Claude Code plugin before using agent roles that reference those skills.

### Install

Add archon as a dev dependency in your project:

```bash
npm install -D @witchynibbles/archon
```

### Initialize

Run the guided installer from inside your project root:

```bash
npx archon init --apply --target .
```

This merges the archon overlay (agents, skills, hooks, settings, `CLAUDE.md`) into your project. Re-run any time you upgrade the package to pull in updated assets.

After init, install your updated dependencies:

```bash
npm install
```

### DB Setup

Archon needs a pgvector-capable PostgreSQL instance pointed at by `ARCHON_CORE_DATABASE_URL`. Two options:

**Option A — Docker convenience (recommended for local dev):**

The package ships `docker-compose.yml`. Copy `.env.example` to `.env.archon` and set your password:

```bash
cp node_modules/@witchynibbles/archon/.env.example .env.archon
# Edit .env.archon — set ARCHON_POSTGRES_PASSWORD and ARCHON_CORE_DATABASE_URL
```

Then start Postgres:

```bash
docker compose -f node_modules/@witchynibbles/archon/docker-compose.yml up -d
```

Or use the wired npm script that init added to your `package.json`:

```bash
npm run archon:setup:local
```

**Option B — Bring your own Postgres:**

Set `ARCHON_CORE_DATABASE_URL` to any pgvector-capable Postgres (local native, managed cloud, CI service). The DB must have the `vector` extension available.

```bash
# .env.archon
ARCHON_CORE_DATABASE_URL=postgresql://user:password@host:5432/dbname
```

Managed providers that support pgvector: Supabase, Neon, Railway, Google AlloyDB, Amazon Aurora (pgvector extension). For any managed provider, run `CREATE EXTENSION IF NOT EXISTS vector;` once after DB creation.

### Verify

Run the doctor check to confirm the DB is reachable, pgvector is enabled, and all migrations are applied:

```bash
npx archon doctor
```

Pass `--repair` to automatically run pending migrations:

```bash
npx archon doctor --repair
```

### Bootstrap workflow state

```bash
npm run archon:bootstrap   # Initialises the active run and task queue
npm run archon:status      # Shows active run and task state
```

### MCP server (optional)

```bash
npm run archon:mcp    # Exposes archon tools to Claude Code
```

Add the MCP server to your Claude Code config and archon's tools become available in every session.

For a complete, step-by-step install guide (including agent-followable runbook), see [`docs/global-setup.md`](./docs/global-setup.md).

---

## Full Runtime vs. Local-Only Mode

Archon runs in one of two modes depending on whether `ARCHON_CORE_DATABASE_URL` is set:

| Mode | When | Behavior |
|---|---|---|
| **Full runtime** | `ARCHON_CORE_DATABASE_URL` set and Postgres reachable | Postgres is the workflow completion authority — `workflow-proof`, runtime review gates, and run history are available. |
| **Local-only** | `ARCHON_CORE_DATABASE_URL` unset (commented out) | The agent workflow runs from local `.archon/` state with no database. The Postgres-backed runtime proof is unavailable; everything else works. |

> **Common onboarding pitfall:** if `ARCHON_CORE_DATABASE_URL` is set but Postgres is not reachable (e.g. you copied `.env.example` into a consuming repo but never started Postgres), runtime commands fail with a connection error and the workflow blocks. To recover: start Postgres, fix the URL — or comment out `ARCHON_CORE_DATABASE_URL` to fall back to local-only mode.

---

## Memory System

Archon uses two complementary memory layers:

| Layer | Path | Purpose |
|---|---|---|
| **Durable project memory** | `.archon/memory/` | Reviewed stable facts about the project. Survives sessions. Curated by `memory_curator`. |
| **Claude session memory** | `.claude/projects/*/memory/` | Personal workflow context and session continuity. Native Claude Code cross-session memory. |

The two layers are complementary — shared project facts belong in `.archon/memory/`, personal workflow context belongs in Claude's native memory. Never store secrets in either.

---

## Design & Architecture Council

For substantive roadmap and plan work, Archon requires a **Design and Architecture Council** review before execution. A rotating 3-5 role panel (default: `solution_architect`, `product_strategist`, `frontend_designer`, plus `infra_engineer` or `security_reviewer` depending on risk) debates the proposal.

Every council review must name a **dissent owner** responsible for arguing at least one serious alternative. Outcomes: `approved` · `approved_with_conditions` · `rework_required` · `exception_granted` · `rejected`

---

## Environment Variables

Copy `.env.example` and configure it. The runtime loader checks **`.env.archon` first, then `.env`** — in a consuming project use `.env.archon` at the project root; in this repo use `.env`. Variables must reach the runtime/daemon process environment; restart a long-running daemon/MCP after changing them.

```bash
# PostgreSQL — workflow state, task queue, run history
ARCHON_CORE_DATABASE_URL=postgresql://archon:CHANGEME_SET_A_STRONG_PASSWORD@127.0.0.1:5533/archon

# Runtime mode
ARCHON_RUNTIME_MODE=auto
ARCHON_RUNTIME_PROFILE=local-docker

# Optional: let genuinely trivial, scope-safe opt-out tasks close on a single
# reviewer instead of the full trio (default OFF). Per-deployment opt-in.
# ARCHON_REVIEW_FLOOR_REDUCTION=1
```

See [`.env.example`](./.env.example) for the full set (review identity, context-handoff thresholds, subagent/debate gates, MCP/UI ports, Grafana).

---

## Useful Commands

These assume archon is installed as a dependency and the npm scripts have been merged into your `package.json` by `archon init`:

```bash
npm run archon:status          # Active run and task state
npm run archon:health          # Service health check
npm run archon:migrate         # Run DB migrations
npm run archon:bootstrap       # Bootstrap workflow state
npm run archon:verify:setup    # Verify the full install
npm run archon:mcp             # Start MCP server
```

Or invoke the bin directly:

```bash
npx archon doctor              # Full configuration verification
npx archon doctor --repair     # Verify and repair (run pending migrations)
npx archon status              # Active run and task state
npx archon health              # Service health check
npx archon migrate             # Run DB migrations
npx archon mcp                 # Start MCP server
```

---

## Docs & Policy

| Document | Contents |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | Operating rules, workflow contract, role chain |
| [`.archon/rules/`](./.archon/rules/) | Detailed policy: review gates, write scope, reasoning quality |
| [`docs/archon-agent-team.md`](./docs/archon-agent-team.md) | Full agent team reference matrix |
| [`docs/global-setup.md`](./docs/global-setup.md) | Installing archon into a consuming project |
| [`.claude/agents/`](./.claude/agents/) | 31 specialist role definitions |
| [`.claude/skills/`](./.claude/skills/) | 46 workflow skill definitions |

---

## Releasing

Releases are triggered by a version tag. After merging to master:

```bash
# 1. Bump the version in package.json (edit manually or use npm version)
npm version patch   # or minor / major

# 2. Push the commit and tag
git push origin master
git push origin --tags
```

The `.github/workflows/release.yml` workflow fires on the tag, asserts the tag matches `package.json` version, builds, and publishes to npm. The `NPM_TOKEN` repo secret must be set to a Granular Access Token with Read+Write on `@witchynibbles/archon`.

To roll back a broken release: `npm deprecate @witchynibbles/archon@<version> "broken release"`. npm does not allow unpublishing after 72 h; use deprecation instead.

---

## Development

To work on archon itself:

```bash
git clone https://github.com/WitchyNibbles/archon.git
cd archon
npm install
cp .env.example .env
# Edit .env — set ARCHON_CORE_DATABASE_URL and ARCHON_POSTGRES_PASSWORD

npm run setup:local   # Start Postgres via Docker (port 5533)
npm run migrate       # Apply DB migrations
npm run doctor        # Verify the full configuration

npm run build:dist    # Compile src/ to dist/
npm run build:types   # Generate .d.ts declarations
npm run lint          # ESLint (zero warnings allowed)
npm test              # Unit test suite
npm run check:quality # typecheck + tests in one pass
```

---

## Lineage

Archon is a port of [devgod](https://github.com/WitchyNibbles/devgod), which brought the same manager-led orchestration discipline to OpenAI Codex. The core IP — workflow contracts, role matrices, reasoning gates, council governance, autonomous execution — is preserved faithfully. Only the integration surface changed: hooks format, agent config format, model names, and directory paths adapted for Claude Code's conventions.

---

## License

[MIT](./LICENSE) © 2026 WitchyNibbles

---

<div align="center">

*Built with intention. Governed by evidence. Delivered by specialists.*

</div>
