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

## Architecture

See [CLAUDE.md](./CLAUDE.md) for operating rules, workflow contract, and role chain.
See `.archon/rules/` for detailed policy documents.
See `.claude/agents/` for role definitions.
See `.claude/skills/` for workflow skill definitions.
