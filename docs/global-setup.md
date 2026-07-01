# Global Setup — Installing Archon into a Project

This guide covers installing archon into a consuming repository. The archon repo itself is a development dependency; consuming projects receive the overlay files (agents, skills, hooks, scripts, templates) via the installer.

**For agents:** See [`docs/agent-install-runbook.md`](agent-install-runbook.md) for a deterministic, idempotent runbook that agents can follow end-to-end without human intervention.

## Prerequisites

- Node.js ≥ 22
- Docker (for PostgreSQL)
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
# Docker mode (default) — port 5533 is the host-side port docker-compose maps to
# the container's Postgres port 5432.  Use 5533 unless you have a port conflict.
ARCHON_CORE_DATABASE_URL=postgresql://archon:CHANGEME_SET_A_STRONG_PASSWORD@127.0.0.1:5533/archon
ARCHON_RUNTIME_MODE=auto
ARCHON_RUNTIME_PROFILE=local-docker
```

If the password contains special characters (`@`, `/`, `?`, `#`, etc.), **percent-encode**
them in the URL (e.g. `@` → `%40`, `#` → `%23`, `/` → `%2F`).

### Migrating from `ARCHON_POSTGRES_*` variables

Earlier versions of archon accepted individual `ARCHON_POSTGRES_USER`, `ARCHON_POSTGRES_PASSWORD`,
`ARCHON_POSTGRES_HOST`, `ARCHON_POSTGRES_PORT`, and `ARCHON_POSTGRES_DB` variables and composed
the URL internally.  The current version uses **`ARCHON_CORE_DATABASE_URL` only** as the
single source of truth.

To migrate, compose the URL manually:

```bash
# Old variables
ARCHON_POSTGRES_USER=archon
ARCHON_POSTGRES_PASSWORD=mypassword
ARCHON_POSTGRES_PORT=5533
ARCHON_POSTGRES_DB=archon

# New single variable (replace values accordingly)
ARCHON_CORE_DATABASE_URL=postgres://archon:mypassword@127.0.0.1:5533/archon
```

The `ARCHON_POSTGRES_*` variables are still used by the Docker Compose convenience script
(`scripts/setup-archon.sh`) to compose `ARCHON_CORE_DATABASE_URL` when the URL is not
already set.  They have no other effect on the runtime.

## 3. Start backing stores

```bash
npm run setup:local   # Spins up PostgreSQL via Docker (port 5533 by default)
npm run migrate       # Runs database migrations
npm run doctor        # Verifies the full configuration
```

## 4. Stopping and tearing down Postgres

```bash
# Stop the container, keep data volume intact:
docker compose down

# Full teardown — removes the archon-postgres-data volume (DATA LOSS):
docker compose down -v
```

Use `down -v` only when you want a clean slate (e.g. resetting a corrupted schema).
After a full teardown, re-run `npm run setup:local && npm run migrate && npm run bootstrap`.

## 5. Install archon into a target project

```bash
# From the archon repo root:
bash scripts/install-archon.sh /path/to/your/project

# Or using npm:
npm run install:project -- --target /path/to/your/project
```

The installer merges archon's `.claude/` overlay (agents, skills, hooks, settings) into the target project, sets up `.archon/` work directories, and writes the `CLAUDE.md` operating rules entrypoint.

## 6. Bootstrap workflow state

In the target project:

```bash
npm run bootstrap     # Initialises the active run and task queue
npm run status        # Confirms workflow state is live
```

## 7. Start the MCP server (optional)

```bash
npm run mcp           # Exposes archon tools to Claude Code
```

Add the MCP server to your Claude Code config so `archon_status`, `archon_ops`, and related tools are available in every session.

## 8. Verify the install

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

## Migration notes

### Schema migrations

Migrations are applied by `npm run migrate` (`src/runtime.ts: migrate()`).  Each migration
is an SQL file in `src/sql/migrations/` named `NNN_description.sql`.  Migrations are
idempotent by design — each file uses `IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`,
`DO $$ … IF NOT EXISTS $$`, or similar guards so that re-running them does not error.

**Numbering gaps** — the migration sequence has deliberate gaps at 005–007 and 015 (those
numbers were reserved for work that was ultimately merged into adjacent migrations).  The
migration runner does not validate sequence continuity; gaps are silently skipped and are
not an error.  Operators should not be alarmed by these gaps.

**Rollback** — there are no down-migrations. The recommended rollback for a bad schema
change is:
1. Restore from a Postgres dump taken before the migration (`pg_dump` / `pg_restore`).
2. Or, for development environments, `docker compose down -v && npm run setup:local &&
   npm run migrate` to rebuild from scratch.

Production operators should take a database snapshot before running `npm run migrate`.

## Troubleshooting

- **`npm run doctor` outputs `SSL connection error`** — append `?sslmode=require` or
  `?sslmode=disable` to `ARCHON_CORE_DATABASE_URL` depending on whether your server
  requires TLS.  See the doctor output for specific guidance.
- **`npm run doctor` outputs `pgvector is installed but not enabled`** — connect as a
  superuser and run `CREATE EXTENSION vector;` in the target database.
- **`npm run doctor` outputs `pgvector is not installed`** — install the pgvector package
  on your server (`apt install postgresql-16-pgvector`) or use a pgvector-capable Docker
  image (`pgvector/pgvector:0.8.2-pg18`).
- **`ARCHON_CORE_DATABASE_URL` is not a valid URL** — ensure special characters in the
  password are percent-encoded (`@` → `%40`, `#` → `%23`, `/` → `%2F`).
- **`npm run doctor` fails** — check that Docker is running and `.env` has the correct
  `ARCHON_CORE_DATABASE_URL` (default port for Docker is **5533**, not 5432).
- **Hook errors on session start** — confirm `.claude/hooks/` scripts are executable
  (`chmod +x .claude/hooks/*.mjs`).
- **Workflow state missing** — run `npm run bootstrap` in the consuming project.
