# Global Setup — Installing Archon into a Project

This guide covers installing archon into a consuming repository from the published npm package.

**For agents:** See [`docs/agent-install-runbook.md`](agent-install-runbook.md) for a deterministic, idempotent runbook that agents can follow end-to-end without human intervention.

## Prerequisites

- Node.js >= 22
- A pgvector-capable PostgreSQL instance (Docker convenience image or BYO; see step 3)
- Claude Code CLI
- [ecc](https://github.com/affaan-m/ECC) plugin (formerly `everything-claude-code`) — required for skills prefixed `ecc:*`

## 1. Install the package

Add archon as a dev dependency in the consuming repository:

```bash
npm install -D @witchynibbles/archon
```

Pin to the exact version in `package.json` to avoid unexpected overlay changes on `npm update`:

```json
"devDependencies": {
  "@witchynibbles/archon": "0.1.0"
}
```

## 2. Run the guided installer

From inside the consuming repository root:

```bash
npx archon init --apply --target .
```

This merges archon's `.claude/` overlay (agents, skills, hooks, settings), writes `CLAUDE.md`, creates the `.archon/work/` state directories, and copies `.env.archon.example` as the env template. The merge is additive and idempotent — safe to re-run after upgrading the package.

To preview what will change without writing anything:

```bash
npx archon init --dry-run --target .
```

After init, install dependencies so the newly merged npm scripts resolve:

```bash
npm install
```

### Verifying installer output

Confirm the key overlay files are present:

```bash
test -f CLAUDE.md && echo "CLAUDE.md: OK" || echo "CLAUDE.md: MISSING"
test -f .claude/settings.json && echo "settings.json: OK" || echo "settings.json: MISSING"
test -d .archon/work && echo ".archon/work: OK" || echo ".archon/work: MISSING"
test -f .env.archon.example && echo ".env.archon.example: OK" || echo ".env.archon.example: MISSING"
```

All four should print `OK`.

## 3. Configure the environment

Copy the env template and set the required variables:

```bash
cp .env.archon.example .env.archon
```

Edit `.env.archon`. The minimum required variables are:

```bash
# PostgreSQL connection string (see DB Setup below)
ARCHON_CORE_DATABASE_URL=postgresql://archon:CHOOSE_A_PASSWORD@127.0.0.1:5533/archon

# Workspace and project identifiers
ARCHON_WORKSPACE_SLUG=default
ARCHON_PROJECT_SLUG=<your-repo-slug>
ARCHON_PROJECT_NAME=<Your Project Name>
ARCHON_PROJECT_REPO_PATH=/absolute/path/to/your/project

# Runtime mode
ARCHON_RUNTIME_MODE=auto
ARCHON_RUNTIME_PROFILE=local-docker
```

The runtime loader checks `.env.archon` first, then `.env`. In consuming projects, use `.env.archon` so archon-specific variables do not collide with the project's own `.env`.

If the DB password contains special characters (`@`, `/`, `?`, `#`, etc.), percent-encode them in the URL (e.g. `@` → `%40`, `#` → `%23`, `/` → `%2F`).

### Runtime mode note

| Mode | When | Behavior |
|---|---|---|
| **Full runtime** | `ARCHON_CORE_DATABASE_URL` set and Postgres reachable | Postgres is the workflow completion authority. `workflow-proof`, runtime review gates, and run history are available. |
| **Local-only** | `ARCHON_CORE_DATABASE_URL` unset (commented out) | Agent workflow runs from local `.archon/` state. Postgres-backed runtime proof is unavailable; everything else works. |

## 4. Set up PostgreSQL

Archon requires a PostgreSQL instance with the `vector` (pgvector) extension.

### Option A — Docker convenience (recommended for local dev)

The package ships `docker-compose.yml`. The wired npm script starts Postgres:

```bash
npm run archon:setup:local
```

This starts a `pgvector/pgvector:0.8.2-pg18` container on port `5533` (host) → `5432` (container). The `ARCHON_POSTGRES_PASSWORD` variable in `.env.archon` must be set to a non-default value before the container will start.

To stop the container without losing data:

```bash
docker compose -f node_modules/@witchynibbles/archon/docker-compose.yml down
```

Full teardown (removes the data volume — DATA LOSS):

```bash
docker compose -f node_modules/@witchynibbles/archon/docker-compose.yml down -v
```

After a full teardown, re-run `npm run archon:setup:local && npm run archon:migrate && npm run archon:bootstrap`.

### Option B — Bring your own Postgres

Set `ARCHON_CORE_DATABASE_URL` to any pgvector-capable Postgres. The DB must have the `vector` extension enabled:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Managed providers that support pgvector: Supabase, Neon, Railway, Google AlloyDB, Amazon Aurora. For SSL-required managed providers, append `?sslmode=require` to the URL.

### Migrating from `ARCHON_POSTGRES_*` variables

Earlier versions accepted individual `ARCHON_POSTGRES_USER`, `ARCHON_POSTGRES_PASSWORD`, `ARCHON_POSTGRES_HOST`, `ARCHON_POSTGRES_PORT`, and `ARCHON_POSTGRES_DB` variables. The current version uses `ARCHON_CORE_DATABASE_URL` as the single source of truth.

To migrate, compose the URL:

```bash
# Old variables
ARCHON_POSTGRES_USER=archon
ARCHON_POSTGRES_PASSWORD=mypassword
ARCHON_POSTGRES_PORT=5533
ARCHON_POSTGRES_DB=archon

# New single variable
ARCHON_CORE_DATABASE_URL=postgres://archon:mypassword@127.0.0.1:5533/archon
```

The `ARCHON_POSTGRES_*` variables are still consumed by the Docker Compose file (which uses them to configure the container). They have no other effect on the runtime.

## 5. Run migrations and verify

Apply the database schema and run the doctor check:

```bash
npm run archon:migrate    # Applies all pending migrations
npx archon doctor         # Verifies: reachable, pgvector enabled, migrations current
```

Pass `--repair` to apply pending migrations automatically if the doctor reports them missing:

```bash
npx archon doctor --repair
```

The doctor check validates:
- Postgres is reachable at `ARCHON_CORE_DATABASE_URL`
- The `vector` extension is enabled in the target database
- All required migrations are applied

A fully passing doctor output looks like:

```json
{
  "ok": true,
  "checks": {
    "pgvector": { "ok": true, "summary": "pgvector is enabled" },
    "migrations": { "ok": true, "summary": "all required migrations are applied" }
  },
  "blockers": []
}
```

## 6. Bootstrap workflow state

Initialize archon's task queue and run state in the database:

```bash
npm run archon:bootstrap    # Creates or reuses the active run
npm run archon:status       # Confirms workflow state is live
```

Bootstrap is idempotent — safe to re-run. Existing run state is detected and reused.

## 7. Register the first task

The managed-path guard blocks control-layer writes until a task is active. Register an initial task to unblock:

```bash
npm run archon -- init-task \
  --id "bootstrap-init" \
  --title "Post-install bootstrap configuration" \
  --goal "Complete post-install setup and verification" \
  --owner-role "planner" \
  --scope "src/,docs/,.env.local,.archon/work/" \
  --allow-managed-scope
```

Verify it is active:

```bash
npm run archon:status
```

## 8. Start the MCP server (optional)

Expose archon tools to Claude Code:

```bash
npm run archon:mcp
```

Add the MCP server to your Claude Code config so `archon_status`, `archon_ops`, and related tools are available in every session.

## 9. Verify the install

```bash
npm run archon:verify:setup    # Full install verification
npm run archon:check:happy-path    # Smoke test
```

## Updating archon

After upgrading the package version in `package.json`:

```bash
npm install
npx archon init --apply --target .    # Merge updated overlay assets
npm install                            # Re-install to pick up new scripts
npm run archon:migrate                 # Apply any new migrations
npx archon doctor                      # Confirm healthy
```

The `init --apply` merge is additive — updated managed files are backed up to `.archon/install-backups/<timestamp>/` before being replaced.

## Schema migrations

Migrations are applied by `npm run archon:migrate`. Each migration is an SQL file in the package's `dist/sql/migrations/` directory, named `NNN_description.sql`. Migrations are idempotent — each uses `IF NOT EXISTS` or similar guards so re-running them does not error.

**Rollback** — there are no down-migrations. The recommended rollback for a bad schema change is:

1. Restore from a Postgres dump taken before the migration (`pg_dump` / `pg_restore`).
2. For dev environments: `docker compose down -v && npm run archon:setup:local && npm run archon:migrate` to rebuild from scratch.

Production operators should take a database snapshot before running `npm run archon:migrate`.

## Troubleshooting

- **`archon doctor` reports `SSL connection error`** — append `?sslmode=require` or `?sslmode=disable` to `ARCHON_CORE_DATABASE_URL` depending on your server's TLS requirements.
- **`archon doctor` reports `pgvector is not enabled`** — connect as a superuser and run `CREATE EXTENSION vector;` in the target database.
- **`archon doctor` reports `pgvector is not installed`** — install pgvector on your server (`apt install postgresql-16-pgvector`) or switch to a pgvector-capable image (`pgvector/pgvector:0.8.2-pg18`).
- **`ARCHON_CORE_DATABASE_URL` is not a valid URL** — ensure special characters in the password are percent-encoded (`@` → `%40`, `#` → `%23`, `/` → `%2F`).
- **`archon doctor` fails** — check Docker is running and `.env.archon` has the correct `ARCHON_CORE_DATABASE_URL`. Default port for the Docker convenience image is `5533`.
- **Hook errors on session start** — confirm `.claude/hooks/` scripts are executable (`chmod +x .claude/hooks/*.mjs`).
- **Workflow state missing** — run `npm run archon:bootstrap` in the consuming project.
- **`npm run archon:*` script not found** — re-run `npx archon init --apply --target .` then `npm install`.
