# Global Setup — Installing Archon into a Project

This guide covers installing archon into a consuming repository. The archon repo itself is a development dependency; consuming projects receive the overlay files (agents, skills, hooks, scripts, templates) via the installer.

## Prerequisites

- Node.js ≥ 22
- Docker (for PostgreSQL + Qdrant)
- Claude Code CLI

## 1. Clone and build archon

```bash
git clone https://github.com/WitchyNibbles/archon.git
cd archon
npm install
```

## 2. Configure the environment

```bash
cp .env.example .env
# Edit .env and fill in the ARCHON_* variables
```

Key variables:

```bash
ARCHON_CORE_DATABASE_URL=postgresql://archon:password@127.0.0.1:5432/archon
ARCHON_QDRANT_URL=http://127.0.0.1:6333
ARCHON_RUNTIME_MODE=auto
ARCHON_RUNTIME_PROFILE=local-docker
```

## 3. Start backing stores

```bash
npm run setup:local   # Spins up PostgreSQL + Qdrant via Docker
npm run migrate       # Runs database migrations
npm run doctor        # Verifies the full configuration
```

## 4. Install archon into a target project

```bash
# From the archon repo root:
bash scripts/install-archon.sh /path/to/your/project

# Or using npm:
npm run install:project -- --target /path/to/your/project
```

The installer merges archon's `.claude/` overlay (agents, skills, hooks, settings) into the target project, sets up `.archon/` work directories, and writes the `CLAUDE.md` operating rules entrypoint.

## 5. Bootstrap workflow state

In the target project:

```bash
npm run bootstrap     # Initialises the active run and task queue
npm run status        # Confirms workflow state is live
```

## 6. Start the MCP server (optional)

```bash
npm run mcp           # Exposes archon tools to Claude Code
```

Add the MCP server to your Claude Code config so `archon_status`, `archon_ops`, and related tools are available in every session.

## 7. Verify the install

```bash
npm run check:workflow    # Verifies the workflow contract is intact
npm run check:happy-path  # Runs the install smoke test
```

## Updating archon

Pull the latest archon source, then re-run the installer against your project. The merge logic is additive and safe to re-apply.

```bash
cd /path/to/archon
git pull
npm run install:project -- --target /path/to/your/project
```

## Troubleshooting

- **`npm run doctor` fails** — check that Docker is running and `.env` has correct `ARCHON_CORE_DATABASE_URL`.
- **Hook errors on session start** — confirm `.claude/hooks/` scripts are executable (`chmod +x .claude/hooks/*.mjs`).
- **Workflow state missing** — run `npm run bootstrap` in the consuming project.
