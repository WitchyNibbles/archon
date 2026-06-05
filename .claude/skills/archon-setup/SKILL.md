---
name: archon-setup
description: Configure local and shared archon prerequisites.
---

# Archon Setup

Use when archon is present but not fully configured.

Goal: leave the repo in a state where Claude Code can actually use archon.

Working means:
- repo-local control files exist
- Postgres with `pgvector` is reachable
- migrations are applied
- workspace/project is registered
- health checks pass
- Claude Code has a clear next prompt

1. Verify the repo contains the archon runtime and local-control files.
2. Ensure `.env.archon` exists. If missing, create it from `.env.example`.
3. Ensure `ARCHON_PROJECT_REPO_PATH`, `ARCHON_PROJECT_SLUG`, and `ARCHON_WORKSPACE_SLUG` are set.
4. Start the local backend with Docker Compose: `npm run setup:local`.
5. Run `npm run doctor` and report the result.
6. Record any durable setup choices in repo memory only after successful verification.

## Rules

- prefer the shared core service as the only writer to orchestration state
- do not invent secrets; use `.env.archon` and ask the user only if a real secret or external backend is required
- if Docker is unavailable, switch to a managed Postgres path and document the exact env vars
- if setup fails, report the exact blocking step and command output summary
