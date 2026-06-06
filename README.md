# Archon

Archon is an opt-in overlay for Claude Code that enforces a manager-led workflow control layer. It ships production-oriented package checks that verify agent catalog completeness, manifest hygiene, skill file coverage, and install contract integrity before any release.

Adapted from [devgod](https://github.com/WitchyNibbles/devgod) for Claude Code infrastructure.

Archon enforces:
- Explicit scope and bounded task execution
- Evidence-based completion (not "the model said it was done")
- Review gates with authenticated principals
- Resumable state with checkpoint/resume
- Role-based agent orchestration with retrieval policies
- Reasoning quality discipline (fact/assumption/hypothesis separation)

## Setup

```bash
npm install
cp .env.example .env.archon
# Fill in .env.archon
npm run setup:local   # Start Postgres + Qdrant via Docker
npm run doctor        # Verify configuration
```

## Usage

```bash
npm run status        # Show active run and task state
npm run archon        # Run archon admin CLI
npm run mcp           # Start MCP server
```

## Claude-Native Features

### Skill Invocation

Invoke workflow skills with a slash command from within a Claude Code session:

```
/archon-intake          # Start or clarify a substantive task
/archon-review          # Invoke review gate evidence gathering
/archon-planning        # Structure and scope a task
/archon-git-operator    # Stage, slice, and commit safely
/archon-autopilot       # Run the full delivery loop
/archon-debugging       # Systematic root-cause investigation
/archon-docs-research   # Research docs, evidence, and prior art
```

Skills live in `.claude/skills/`. Each SKILL.md file declares its trigger and output contract.

### Worktree Isolation

For parallel specialist work, use `isolation: "worktree"` in agent delegation:

```
Agent tool → subagent_type: "backend-engineer", isolation: "worktree"
```

This runs independent or risky work in a separate git worktree, keeping the main branch clean. Merge back only after verification.

### Effort Routing

Model and effort are matched to task class:

| Task class | Model | Effort |
|---|---|---|
| Planning, architecture, council | `claude-opus-4-5` | high |
| Implementation, review, QA | `claude-sonnet-4-5` | high |
| Docs, knowledge, memory | `claude-haiku-4-5` | medium |
| Trivial mechanical tasks | `claude-haiku-4-5` | low |

See `CLAUDE.md` §Agent delegation for the full routing table.

### Memory Integration

Archon uses two memory layers:

- **Repo-local durable memory**: `.archon/memory/` — reviewed stable facts about this project. Survives across sessions. Never store secrets here.
- **Claude project memory**: `.claude/projects/*/memory/` — Claude Code's native cross-session memory. Used for personal workflow context, not shared project facts.

The `memory-curator` agent (`/archon-memory`) manages promotion from live work state to durable memory.

## Architecture

See [CLAUDE.md](./CLAUDE.md) for operating rules, workflow contract, and role chain.
See `.archon/rules/` for detailed policy documents.
See `.claude/agents/` for role definitions (25 specialist roles with AGENT.md files).
See `.claude/skills/` for workflow skill definitions (37 skills covering all major work domains).
See `docs/archon-agent-team.md` for the agent team reference matrix.
