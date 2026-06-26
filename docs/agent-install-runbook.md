# Agent-Followable Archon Consumer Install Runbook

**Audience:** AI agents performing end-to-end consumer repo installation.

**Purpose:** A deterministic, idempotent runbook that installs archon into a consuming project, runs all prerequisite setup steps, verifies a healthy install, and defines clear success signals at every step. Agents MUST NOT ask humans for input; all steps are automated or clearly documented.

---

## Overview

This runbook installs archon from source into a consumer repository without human intervention. Each step includes:
- **Command:** the exact bash/npm invocation
- **Expected output/signal:** success criteria
- **Idempotency note:** safe to re-run
- **On-failure action:** diagnostics and recovery steps

The runbook terminates with a **Definition of Healthy** gate that proves the install is not broken.

---

## Abbreviated Setup Flowchart

```
1. Preflight checks (Node, Docker, everything-claude-code plugin)
   ↓
2. Run installer (init --apply) from archon source
   ↓
3. cd to consumer && npm install (MANDATORY: populates node_modules/archon)
   ↓
4. Configure .env (from .env.archon.example template)
   ↓
5. Bootstrap: setup:local → migrate → bootstrap → verify:setup
   ↓
6. Definition of Healthy gate (verify hooks, postgres reachable, archon health)
   ↓
7. Register first task (pre-unblock for the managed-path guard)
   ↓
8. Success: install is ready for agent work
```

---

## Part 1: Preflight Checks

Each check verifies a prerequisite. If any check fails, stop and repair before continuing.

### 1.1. Node ≥ 22

**Command:**
```bash
node --version
```

**Expected output:** v22.x.x or later (exact version does not matter).

**Success signal:** Exit code 0, version line printed.

**Failure action:** Install Node ≥ 22 (see Node official docs for your OS). Re-run the check after install.

---

### 1.2. PostgreSQL 18+ with pgvector Extension

PostgreSQL must be running and the `pgvector` (vector similarity search) extension must be available.

**Command (Docker mode, recommended):**
```bash
docker --version
docker ps -q --filter "name=archon-postgres" 2>/dev/null | head -1 | wc -l | grep -q "^1$" && echo "postgres running" || echo "postgres not running"
```

**Expected output:** `docker version` prints Docker version; second command prints "postgres running" OR "postgres not running".

**Success signal:** Docker is installed and reachable.

**On-failure (Docker unavailable):** 
- Switch to native or managed runtime mode. See `.env.archon` setup (step 2) for `ARCHON_RUNTIME_MODE` options.
- Or install Docker (see Docker official docs).

**Fallback check (if Docker used):** After installing archon, the bootstrap script will start postgres automatically. If postgres start fails during bootstrap (step 5), re-run:
```bash
cd /path/to/consumer
bash scripts/archon-setup.sh
```

---

### 1.3. PostgreSQL Reachable (if using full runtime)

If `ARCHON_CORE_DATABASE_URL` will be set (the recommended path), confirm postgres is reachable.

**Command:**
```bash
# Requires psql client. If not available, skip and rely on bootstrap (step 5) to surface the error.
psql "postgresql://localhost:5432/postgres" -c "select 1" 2>&1 | grep -E "(1|error|refused)" || echo "psql not available; relying on bootstrap"
```

**Expected output:** Either "1" (connection successful) or "error/connection refused" (will be fixed by bootstrap) or "psql not available".

**Success signal:** One of the above outcomes printed.

**On-failure (connection refused + no Docker):** 
- Set `ARCHON_RUNTIME_MODE=managed` in `.env.archon` (step 2) to skip postgres provisioning; archon will use local `.archon/` state only and forgo runtime-backed proof commands.
- Or provision postgres manually (see `.env.example` for connection string format).

---

### 1.4. Claude Code CLI + everything-claude-code Plugin

The `everything-claude-code` plugin is a **required external dependency**. Skills prefixed `everything-claude-code:*` will not resolve without it.

**Command:**
```bash
claude code --version 2>/dev/null | head -1 || echo "claude code not found"
```

**Expected output:** Claude Code version string OR "claude code not found".

**Success signal:** Version printed.

**On-failure:** Install Claude Code CLI and the plugin (see archon README.md "Prerequisites" section). Retry after install.

---

## Part 2: Run the Installer and npm install

The installer must run from the archon SOURCE repo. After installation, you must run `npm install` in the consumer to populate `node_modules/archon` (archon is a file: devDependency). Without this step, `npm run archon:*` commands will fail with "Cannot find module .../node_modules/archon/...".

### 2.1. Run Installer (from archon source)

The installer requires exactly one of `--apply` or `--dry-run`. A bare `--target` without either flag will error.

**Equivalent forms (both correct):**

**Form 1: Via helper script (simplest)**
```bash
cd /path/to/archon
bash scripts/install-archon.sh /path/to/consumer
```

**Form 2: Direct invocation (explicit)**
```bash
cd /path/to/archon
node --experimental-strip-types src/install/cli.ts init --apply --target /path/to/consumer
```

**With optional flags (e.g., to include Grafana MCP wiring):**
```bash
bash scripts/install-archon.sh /path/to/consumer --with-grafana
```

**To preview changes before applying (dry-run):**
```bash
node --experimental-strip-types src/install/cli.ts init --dry-run --target /path/to/consumer
```

**Expected output (apply mode):** JSON summary showing:
- `mode: "apply"`
- `writesPerformed: true`
- Files listed under `created`, `updated`
- `conflicts: []`
- No errors

**Success signal:** Exit code 0; `writesPerformed: true`.

**On-failure:**
- If conflicts reported: Review `.archon/install-backups/` and resolve before re-running.
- If permission denied: Ensure write access to consumer root.
- If module not found: Archon source may be corrupted. Verify `src/install/cli.ts` exists.
- If error "Mutating installs require 'init --apply'": Your script is outdated. Use `bash scripts/install-archon.sh` (which has been fixed) or add `init --apply` to the direct invocation.

**Idempotency:** Safe to re-run; merge logic is additive. Updated files backed up to `.archon/install-backups/<timestamp>/`.

---

### 2.2. MANDATORY: Install Consumer Dependencies

**Command (cd into the consumer, NOT archon source):**
```bash
cd /path/to/consumer
npm install
```

**Why mandatory:** The installer wires npm scripts that invoke archon from `./node_modules/archon/src/admin/archon.ts`. These scripts (like `npm run archon:migrate`) will NOT work until `npm install` populates `node_modules/archon` with the archon package.

**Expected output:** npm output showing package installations. No errors.

**Success signal:** Exit code 0; `added X packages` or `up to date` printed.

**On-failure:**
- Check `package.json` is valid JSON.
- Check npm can reach registries (network connectivity).
- Check disk space.
- Retry after fixing the issue.

**Idempotency:** Safe to re-run; npm caches skipped packages.

**Critical:** If any `npm run archon:*` command fails with "Cannot find module" after this, `npm install` was skipped. Re-run it.

---

### 2.3. Configure .env (MANDATORY)

The installer copies `.env.archon.example` to the consumer. You MUST configure required variables in `.env` before bootstrap. The consumer's `scripts/archon-setup.sh` now auto-creates `.env` from `.env.archon.example` when `.env` does not already exist, so running `bash scripts/archon-setup.sh` (or the bootstrap path) will handle the copy automatically. Explicitly copying it yourself first is still the recommended deterministic action (belt-and-suspenders), but it is no longer the only way to get `.env`.

**Command:**
```bash
cd /path/to/consumer
cp .env.archon.example .env
```

**Edit `.env` and set these required values:**

```bash
ARCHON_CORE_DATABASE_URL="postgresql://archon:CHOOSE_A_PASSWORD@127.0.0.1:5432/archon"
ARCHON_POSTGRES_PASSWORD="CHOOSE_A_PASSWORD"
ARCHON_WORKSPACE_SLUG="default"
ARCHON_PROJECT_SLUG="<consumer_repo_name>"
ARCHON_PROJECT_NAME="<consumer_repo_name>"
ARCHON_PROJECT_REPO_PATH="/absolute/path/to/consumer"
ARCHON_RUNTIME_MODE="auto"
ARCHON_RUNTIME_PROFILE="local-docker"
```

Replace:
- `CHOOSE_A_PASSWORD`: Any strong local-development password (NOT default "archon").
- `<consumer_repo_name>`: Consumer repo directory name (e.g. "my-awesome-project").
- `/absolute/path/to/consumer`: Full absolute path to consumer root.

**Success signal:** File exists with all ARCHON_* variables set to non-empty values.

**Failure action:** If any variable is missing or set to placeholder, bootstrap (Part 3) will error at the postgres password guard with "ARCHON_POSTGRES_PASSWORD must be set to a non-default local password". Fix and retry.

---

### 2.4. Verify Installer Output

Confirm the installer created/merged key files:

**Command:**
```bash
cd /path/to/consumer
test -f CLAUDE.md && echo "CLAUDE.md: OK" || echo "CLAUDE.md: MISSING"
test -f .claude/settings.json && echo "settings.json: OK" || echo "settings.json: MISSING"
test -d .archon/work && echo ".archon/work: OK" || echo ".archon/work: MISSING"
test -f .env.archon.example && echo ".env.archon.example: OK" || echo ".env.archon.example: MISSING"
```

**Expected output:**
```
CLAUDE.md: OK
settings.json: OK
.archon/work: OK
.env.archon.example: OK
```

**Success signal:** All four lines print "OK".

**On-failure:** Re-run the installer (step 2.1) or manually verify the files exist.

---

## Part 3: Bootstrap Archon Runtime

Initialize archon's database, workflow state, and retrieval indices. Run these commands in order in the consumer repo.

### 3.1. Provision PostgreSQL (if Docker mode)

This step sets up postgres (Docker), creates roles/databases, and installs the pgvector extension.

**Command:**
```bash
cd /path/to/consumer
npm run archon:setup:local
```

**Expected output:** Docker and postgres setup logs. Final line: `archon local setup complete`.

**Success signal:** Exit code 0; final success message printed.

**On-failure:**
- **"docker not running":** Start Docker daemon and retry.
- **"postgres did not become healthy":** Check `docker logs archon-postgres-<slug>` for startup errors. Fix and retry.
- **"ARCHON_POSTGRES_PASSWORD is required":** Ensure `.env` has `ARCHON_POSTGRES_PASSWORD` set to non-default value.
- **"ARCHON_RUNTIME_MODE=managed":** This is expected for managed mode; archon falls back to local state (skip postgres setup).

**Idempotency:** Safe to re-run; postgres container idempotency handled by docker compose. Existing database not re-initialized.

---

### 3.2. Run Database Migrations

**Command:**
```bash
cd /path/to/consumer
npm run archon:migrate
```

**Expected output:** Migration log showing schema applied. Final line: `migrations complete` or similar.

**Success signal:** Exit code 0; no errors.

**On-failure:**
- **"Cannot find module .../node_modules/archon/...":** `npm install` was skipped. Go back to Part 2.2 and run it.
- **"postgres is configured but unreachable":** Confirm postgres is running and `ARCHON_CORE_DATABASE_URL` is correct. Check `docker ps` for archon-postgres container.
- **"ARCHON_CORE_DATABASE_URL not set":** Set it in `.env` and retry.
- **"role does not exist":** Postgres role/db not created. Re-run step 3.1.

**Idempotency:** Safe to re-run; migrations are idempotent (already-applied skipped).

---

### 3.3. Bootstrap Workflow State

**Command:**
```bash
cd /path/to/consumer
npm run archon:bootstrap
```

**Expected output:** JSON showing bootstrapped run and task records. No errors.

**Success signal:** Exit code 0; run/task IDs printed.

**On-failure:**
- **"postgres offline":** Confirm postgres is running. Re-run step 3.1 if needed.

**Idempotency:** Safe to re-run; existing run state detected and reused.

---

### 3.4. Repair Task Queue (if it exists)

**Command:**
```bash
cd /path/to/consumer
if [[ -f .archon/work/task-queue.json ]]; then
  npm run archon:repair-task-queue
fi
```

**Expected output:** Task queue repair log. If no queue exists, no output.

**Success signal:** Exit code 0.

**Idempotency:** Safe to re-run.

---

### 3.5. Refresh Repository Context

**Command:**
```bash
cd /path/to/consumer
npm run archon:refresh-repo-context
```

**Expected output:** Logs showing file discovery and context refresh. No errors.

**Success signal:** Exit code 0.

**On-failure:**
- **"working directory is not a git repo":** Ensure consumer is a git repository (`git init` if needed).

**Idempotency:** Safe to re-run.

---

### 3.6. Refresh Retrieval Index

**Command:**
```bash
cd /path/to/consumer
npm run archon:refresh-retrieval:fast
```

**Expected output:** Logs showing embedding job status. No errors.

**Success signal:** Exit code 0.

**Idempotency:** Safe to re-run.

---

### 3.7. Verify Setup

**Command:**
```bash
cd /path/to/consumer
npm run archon:verify:setup
```

**Expected output:** Verification checklist showing all items passed. Final line: `archon setup verification passed` or similar.

**Success signal:** Exit code 0; no FAILED items in output.

**On-failure:**
- **"verification failed: [reason]":** Read the reason and fix. Re-run after fix.

**Idempotency:** Safe to re-run.

---

## Part 4: Definition of Healthy — Verification Gate

An install is proven healthy when ALL of the following checks pass. If ANY check fails, the install is broken and must be repaired before use.

### 4.1. All .claude/hooks/*.mjs Files Exist

All 11 hook modules must exist or Claude Code will error at session start.

**Command:**
```bash
cd /path/to/consumer
HOOKS=(
  "archon-post-tool.mjs"
  "archon-pre-compact.mjs"
  "archon-stop.mjs"
  "archon-session-start.mjs"
  "archon-prompt-submit.mjs"
  "archon-subagent-stop.mjs"
  "archon-permission-request.mjs"
  "hook-utils.mjs"
  "hook-policy.mjs"
  "archon-statusline.mjs"
  "archon-pre-tool.mjs"
)
for h in "${HOOKS[@]}"; do
  test -f ".claude/hooks/$h" || echo "MISSING: $h"
done
```

**Expected output:** No lines printed (all hooks exist).

**Success signal:** Exit code 0; no "MISSING" lines.

**On-failure:**
- **"MISSING: hook-name.mjs":** The installer did not copy all hooks. Re-run the installer from updated archon source, or manually copy the missing hook.

---

### 4.2. Archon Health Check

**Command:**
```bash
cd /path/to/consumer
npm run archon:health
```

**Expected output:** JSON showing health status:
```json
{
  "status": "healthy",
  "runtime": { "connected": true, "mode": "docker" },
  "store": { "initialized": true }
}
```

**Success signal:** Exit code 0; `"status": "healthy"`.

**On-failure:**
- **`"status": "unhealthy"`:** Read the detailed error (runtime/store sections). Common causes:
  - **"postgres is configured but unreachable":** Start postgres and retry (step 3.1).
  - **"store not initialized":** Re-run bootstrap (step 3.3).

---

### 4.3. Archon Verify Setup

**Command:**
```bash
cd /path/to/consumer
npm run archon:verify:setup
```

**Expected output:** Verification checklist. Final line: `archon setup verification passed`.

**Success signal:** Exit code 0; no FAILED items.

**On-failure:** Fix the reported issue and retry.

---

### 4.4. Happy Path Smoke Test

**Command:**
```bash
cd /path/to/consumer
npm run archon:check:happy-path
```

**Expected output:** Happy path test output showing all checks passed.

**Success signal:** Exit code 0; final success message.

**On-failure:** Read the error and fix the issue. Retry after fixing.

---

### 4.5. Postgres Reachable (if configured)

**Command:**
```bash
cd /path/to/consumer
if [[ -z "${ARCHON_CORE_DATABASE_URL:-}" ]]; then
  echo "ARCHON_CORE_DATABASE_URL not set; postgres check skipped"
else
  npm run archon:health 2>&1 | grep -q '"connected": true' && echo "postgres: OK" || echo "postgres: UNREACHABLE"
fi
```

**Expected output:** "postgres: OK" or "postgres: UNREACHABLE" or "postgres check skipped".

**Success signal:** "postgres: OK" OR "postgres check skipped".

**On-failure:** "postgres: UNREACHABLE" means postgres configured but not running.
  - **Fix:** Re-run step 3.1 to restart postgres.

---

### 4.6. Starting a Claude Session Does NOT Error (Manual Check)

**Manual verification:**
1. Open Claude Code in the consumer repo.
2. Type any simple query (e.g., "list files").
3. Confirm the session starts WITHOUT errors like:
   - "Cannot find module .../.claude/hooks/archon-pre-tool.mjs"
   - "SyntaxError in .claude/hooks/..."

**Success signal:** Claude Code session starts normally; no hook errors.

---

## Part 5: Register First Task (Post-Install Unblock)

After the Definition of Healthy gate passes, register an active task. The managed-path guard blocks substantive writes until a task is active. Without this step, agents will see errors like "write to X blocked — no active archon task".

### 5.1. Register the Task

**Command:**
```bash
cd /path/to/consumer
npm run archon -- init-task \
  --id "bootstrap-init" \
  --title "Post-install bootstrap configuration" \
  --goal "Complete post-install setup and verification" \
  --owner-role "planner" \
  --scope "src/,docs/,.env.local,.archon/work/" \
  --allow-managed-scope
```

**Why `--allow-managed-scope`:** This flag explicitly allows the task to write to `.archon/work/`. Without it, the task registration would reject control-layer scope paths.

**Expected output:** JSON showing created task and run records. No errors.

**Success signal:** Exit code 0; task ID and run ID printed.

**On-failure:**
- **"ARCHON_PROJECT_SLUG is required":** Set it in `.env` and retry, or export: `export ARCHON_PROJECT_SLUG="$(basename "$(pwd)")"`; retry.
- **"--id must match ^[A-Za-z0-9][A-Za-z0-9_-]*$":** Choose a valid task ID (alphanumeric, dashes, underscores only).
- **"refusing to grant control-layer scope":** Ensure `--allow-managed-scope` flag is present.
- **"postgres is offline":** Start postgres and retry (step 3.1).

**Idempotency:** Safe to re-run; existing task is reused if IDs match.

---

### 5.2. Verify Task is Active

**Command:**
```bash
cd /path/to/consumer
npm run archon:status
```

**Expected output:** JSON showing active run and task:
```json
{
  "activeRunId": "run-xxx",
  "activeTaskId": "bootstrap-init",
  "taskState": "pending",
  ...
}
```

**Success signal:** Exit code 0; `"activeTaskId": "bootstrap-init"` (or your chosen ID).

**On-failure:** Task not registered. Re-run step 5.1.

---

## Part 6: Installation Complete

At this point, the consumer repo has a healthy archon install with an active task. Agents can now:
- Use archon runtime commands: `npm run archon:*` for wired commands, or `npm run archon -- <cmd>` for others.
- Invoke `/archon-*` workflow skills without "no active archon task" blocks.
- Run the MCP server: `npm run archon:mcp` to expose archon tools to Claude Code.

---

## Troubleshooting — Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Cannot find module .../node_modules/archon/..." | `npm install` was skipped in the consumer. Archon is a file: devDependency; node_modules/archon must exist. | Run `npm install` in the consumer (Part 2.2). |
| "Cannot find module .../.claude/hooks/archon-pre-tool.mjs" at session start | Installer did not copy all 11 hook modules. | Re-run installer from updated archon source; or manually copy missing hooks from archon source `.claude/hooks/`. |
| "write to X blocked — no active archon task" on every write attempt | No task registered yet. | Complete Part 5 (register task). |
| "write to X is outside active task write scope" | Task scope too narrow for the write. | Edit `.archon/ACTIVE` (TASK.md) and expand the `## Allowed write scope` to include the path; or register a new task with broader scope (Part 5). |
| "archon runtime is offline: postgres is configured but unreachable" | Postgres configured but not running. | Run `npm run archon:setup:local` (Part 3.1). Wait 10–30 seconds. Retry archon commands. |
| "ARCHON_PROJECT_SLUG is required" when running init-task or runtime commands | Environment variable not set. | Set: `export ARCHON_PROJECT_SLUG="$(basename "$(pwd)")"`; retry. Or add to `.env`. |
| "everything-claude-code:*" skills not found in Claude Code | Plugin not installed. | Install the everything-claude-code plugin. Restart Claude Code. Retry. |
| "role does not exist" during migrations | Postgres role/database not created. | Postgres container not fully initialized. Re-run `npm run archon:setup:local` (Part 3.1). Wait 30 seconds. Retry migrations. |
| `npm run archon:*` script not found | Consumer package.json does not have archon scripts merged. | Re-run installer (Part 2.1). Then re-run `npm install` (Part 2.2). |
| `scripts/archon-setup.sh` not found | Installer did not copy scripts. | Re-run installer (Part 2.1). |

---

## Updating Archon

To upgrade archon in a consumer repo after a new version is released:

**Command (from archon source):**
```bash
cd /path/to/archon
git pull origin main
npm install

cd /path/to/consumer
node --experimental-strip-types /path/to/archon/src/install/cli.ts upgrade --apply --target .
```

**Expected output:** JSON summary showing updated managed files. No conflicts.

**Success signal:** Exit code 0; `"writesPerformed": true`.

**Post-upgrade (in the consumer):**
```bash
npm install
npm run archon:migrate
npm run archon:verify:setup
```

**Idempotency:** Safe to re-run. Existing files backed up before update.

---

## Remaining Documentation Gaps

The following items could not be fully verified and are marked for future review:

1. **Playwright optional setup:** The bootstrap script attempts to install and verify playwright (`npm run archon:setup:playwright`, `npm run archon:verify:playwright`). These are optional; if they fail, archon continues without them.

2. **Graphify integration:** The bootstrap script attempts to install the graphify tool (Python-based dependency graph builder). This is optional and non-fatal if it fails.

3. **Secrets backend (forge feature):** The `.env` mentions `ARCHON_SECRETS_BACKEND` and `ARCHON_SECRETS_MASTER_KEY` for forge (image generation). This is optional. See `docs/forge-operator-runbook.md` if secrets are needed.

4. **Grafana/Obsidian optional MCP servers:** The installer supports `--with-grafana` and `--with-obsidian` flags for additional MCP configurations. This runbook uses the default.

5. **Review identity adapter:** The installer creates a placeholder `archon/review-identity-adapter.ts` that agents must implement for review actions. This is project-specific.

6. **MCP server startup:** The server (`npm run archon:mcp`) is optional for local testing but required for Claude Code tool integration.

---

## Summary

An agent following this runbook end-to-end will produce a healthy archon install in a consumer repo with:
- All files and overlays copied and merged by the installer.
- `node_modules/archon` populated (mandatory `npm install` completed).
- PostgreSQL provisioned and reachable (if using full runtime).
- Database schema migrated and workflow state bootstrapped.
- All 11 hook modules in place and functional.
- An active task registered to unblock the managed-path guard.
- No "Cannot find module .../node_modules/archon/...", "Cannot find module .../.claude/hooks/...", or "no active archon task" errors blocking further work.

The Definition of Healthy gate (Part 4) provides clear evidence that the install is not broken. Agents can then proceed to invoke archon workflow skills and runtime commands with confidence using `npm run archon:*` (for wired commands) or `npm run archon -- <cmd>` (for others).
