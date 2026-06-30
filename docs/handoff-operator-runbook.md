# Context-Handoff — Operator Runbook

> Audience: an operator running Archon in a consuming repository who wants automatic
> **context-handoff** — when an agent session nears its context-window limit, its work is committed
> as a durable handoff so a successor continues without losing state, with no human in the loop.
>
> Scope: the two handoff surfaces (interactive in-session parachute · daemon fresh-process respawn),
> the operator knobs, and running `archon daemon` under an external supervisor (systemd / pm2).

---

## 1. The two surfaces

Archon handles context-handoff differently on each surface, because the two have different process
models:

| Surface | Process model | Handoff mechanism | Operator action |
|---------|---------------|-------------------|-----------------|
| **Interactive** (`claude` REPL) | Native auto-compaction; the process continues | **In-session parachute** — `PreCompact` commits a `precompact_fallback` handoff before compaction; the same session continues with the committed record durable | None beyond install — automatic |
| **Daemon** (`archon daemon`) | Headless `claude -p` turns; the process exits each turn | **Fresh-process respawn** — on `handoff_required` the daemon resets, claims a cross-process lease, and relaunches a fresh turn from the sanitized continuation prompt | Run the daemon under a supervisor; tune/disable via env |

Both ship with the package — no separate install step. The interactive parachute needs nothing
configured. The daemon needs to be run (Part 3) and is **enforce-by-default** (Part 2).

---

## 2. Operator knobs (`.env.archon`)

The installer copies the package's `.env.example` to your repo as `.env.archon.example`. Copy the
relevant lines into your `.env.archon`. All daemon handoff behavior is controlled by these:

| Variable | Default | Effect |
|----------|---------|--------|
| `ARCHON_CONTEXT_MONITOR` | `enforce` (unset = enforce) | **Daemon** mode. `enforce`: reset + respawn on `handoff_required`/`hard_stop`. `observe`: **KILL SWITCH** — sample without resetting; suppresses daemon auto-respawn. Interactive parachute is unaffected by this. |
| `ARCHON_MAX_RESPAWNS_PER_TASK` | `8` | Per-task cap on daemon reset+respawn loops before it blocks (`recovery_required`). Integer `[1, 50]`; any out-of-range / invalid / unset value falls back to `8` (not clamped). |
| `ARCHON_CONTEXT_HANDOFF_PCT` | `70` | Context-window % at which `handoff_required` fires. |
| `ARCHON_CONTEXT_WARNING_PCT` | `60` | Context-window % at which `warning` fires. |
| `ARCHON_CONTEXT_HARD_STOP_PCT` | `80` | Context-window % at which `hard_stop` fires. |

> **Enforce is daemon-only.** The interactive parachute never respawns, so `ARCHON_CONTEXT_MONITOR`
> does not gate it — registration + the `PreCompact` handoff run regardless.

### Disabling daemon auto-respawn (kill switch)

If a daemon is respawning in a way you do not want, set the kill switch and restart it:

```bash
# in .env.archon
ARCHON_CONTEXT_MONITOR=observe
```

In `observe` mode the daemon still samples context usage (and logs it) but never resets or
respawns. The kill switch is honored before **each** relaunch.

### Observability

The daemon emits structured, single-line JSON to **stderr** (tag `archon-context-monitor`) so you
can scrape or alert on respawn activity:

- `enforce_reset` — a reset is proceeding (after the budget + lease guards): includes
  `invocationId`, `runId`, `taskId`, `sampledState`, `respawnCount`.
- `observe_kill_switch_suppressed_reset` — the `observe` kill switch suppressed a would-be reset.
- `respawn_lease_denied` — another supervisor holds the run lease; this daemon skipped the reset.

---

## 3. Running `archon daemon` under a supervisor

`archon daemon` is a **foreground, finite** process: it runs a bounded number of cycles
(`--max-cycles`, default 8) and then exits. To get continuous handling you must run it under an
external supervisor that restarts it. The respawn budget + cross-process lease bound cost within a
single daemon run; the supervisor bounds it across runs.

Invoke it as the wired consumer script:

```bash
npm run archon:daemon
# == node --experimental-strip-types ./node_modules/archon/src/admin/archon.ts daemon --format text
```

### systemd (Linux)

`/etc/systemd/system/archon-daemon.service` (adjust `User`, `WorkingDirectory`, paths):

```ini
[Unit]
Description=Archon daemon (context-handoff + respawn)
After=network-online.target

[Service]
Type=simple
User=archon
WorkingDirectory=/srv/your-consumer-repo
# .env.archon is loaded by the archon CLI wrapper when present in WorkingDirectory.
ExecStart=/usr/bin/npm run archon:daemon
# The daemon exits after its cycle budget; restart it to keep handling turns.
Restart=always
RestartSec=5
# Bound runaway restarts (defense in depth on top of ARCHON_MAX_RESPAWNS_PER_TASK).
StartLimitIntervalSec=300
StartLimitBurst=20
# Hardening (recommended — run as a non-root User above, then add):
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/srv/your-consumer-repo
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now archon-daemon
journalctl -u archon-daemon -f   # watch the archon-context-monitor events
```

### pm2 (cross-platform)

`ecosystem.config.cjs`:

```js
module.exports = {
  apps: [
    {
      name: "archon-daemon",
      script: "npm",
      args: "run archon:daemon",
      cwd: "/srv/your-consumer-repo",
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,     // window-bounded; pairs with ARCHON_MAX_RESPAWNS_PER_TASK
      min_uptime: 5000
    }
  ]
};
```

```bash
# Run pm2 as a dedicated non-root user (not root) — the daemon spawns `claude` turns.
pm2 start ecosystem.config.cjs
pm2 logs archon-daemon       # watch the archon-context-monitor events
pm2 save                     # persist across reboots
```

> **Kill switch under a supervisor:** set `ARCHON_CONTEXT_MONITOR=observe` in `.env.archon` and
> restart the service (`systemctl restart archon-daemon` / `pm2 restart archon-daemon`). The next
> relaunch reads it and stops respawning.

---

## 4. Verifying handoff works

### Interactive parachute

1. **Replayable install check (do this first).** `PreCompact` only fires when a session actually
   nears its limit, so you cannot trigger the full handoff on demand — but you *can* verify the
   wiring deterministically. In a repo with an active archon task, start a plain `claude` session,
   then confirm the registration ran:
   ```bash
   ls .archon/work/context-guard.json    # written by SessionStart for an archon-managed session
   ```
   If the file exists, `SessionStart` is wired and `PreCompact` will have a registered invocation to
   attach the handoff to. (No file → see Troubleshooting: the session is not archon-managed, or the
   hooks were not installed.)
2. When the session later nears its limit, Claude Code fires `PreCompact`; the hook commits a
   `precompact_fallback` handoff and updates the guard to `handoff_written`. The session continues in
   place — no respawn, no wrapper.
3. Inspect the durable record. Obtain `<run-id>`/`<task-id>` from `npm run archon -- status` (or
   `.archon/work/product-state.md`), then:
   ```bash
   npm run archon -- status                 # shows the active run id + task id
   npm run archon -- handoffs <run-id> <task-id>
   ```
   The latest unconsumed handoff has `reason: "precompact_fallback"`.

### Daemon respawn

1. Ensure `ARCHON_CONTEXT_MONITOR` is unset or `enforce` (the default).
2. Run `npm run archon:daemon`. On a `handoff_required` sample it logs an `enforce_reset` event and
   relaunches a fresh turn from the sanitized continuation prompt.
3. Confirm the budget bound: after `ARCHON_MAX_RESPAWNS_PER_TASK` respawns for one task, the daemon
   blocks with `recovery_required` rather than looping.

---

## 5. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Daemon never respawns | `ARCHON_CONTEXT_MONITOR=observe` (kill switch on) | Set it to `enforce` (or unset) and restart. |
| Daemon blocks with `recovery_required` | Respawn budget exhausted for the task | Investigate why the task keeps respawning (stagnation / broken packet); raise `ARCHON_MAX_RESPAWNS_PER_TASK` only if genuinely needed; restart to reset the counter. |
| `respawn_lease_denied` in logs | Another daemon/supervisor owns this run's lease | Expected mutual-exclusion — only one supervisor should drive a given run. |
| Interactive session loses context with no handoff record | Hooks not installed in the consumer repo (most common silent failure) | `ls .claude/hooks/archon-session-start.mjs .claude/hooks/archon-pre-compact.mjs` — if missing, re-run the installer. |
| Interactive session loses context, hooks present | `SessionStart` did not register (no active archon task) or the guard file was removed | Confirm an archon task is active (`npm run archon -- status`); the parachute only registers for genuinely archon-managed sessions. Confirm `.archon/work/context-guard.json` appears after the session starts. |
| Daemon exits immediately and never restarts | No external supervisor | `archon daemon` is finite by design — run it under systemd/pm2 (Part 3). |

---

## 6. Consume-on-next-start (interactive handoff loop — A1)

> Added in `handoffConsumeOnStart`. Closes the interactive handoff consume loop:
> the write side (PreCompact hook) was already wired; this section documents the
> new read side that fires at SessionStart.

### How it works

When a new `claude` session starts while an archon task is active, the
`archon-session-start.mjs` hook now runs a consume step AFTER the parachute
registration:

1. Reads `run_id` and `task_id` from `.archon/ACTIVE`.
2. Reads the new session's `invocationId` from the just-written `context-guard.json`
   (the parachute registration wrote it above).
3. Calls `consumeInteractiveHandoff` which:
   - Validates `runId`/`taskId` (`^[A-Za-z0-9_-]+$`) — C3.
   - Normalizes the `role` field in the guard — C1.
   - If a daemon lease (`owner=daemon`) is held for the run, skips — A3.
   - Queries `getLatestUnconsumedHandoff(runId, taskId)`.
   - If found: builds a continuation prompt via
     `HandoffController.buildContinuationPrompt`, calls `markHandoffConsumed`,
     returns the continuation text.
4. The hook merges the continuation text with the normal task-context line and
   writes one `{"additionalContext":"..."}` response to stdout. Claude Code
   injects it at the start of the new session — the agent sees the full handoff
   context without any manual step.

### SessionStart stderr diagnostics

```
[archon-session-start] interactive parachute registered: inv_interactive_<uuid> (task: <id>)
[archon-session-start] handoff ho_<id> consumed — continuation injected
```

When no handoff is pending:
```
[archon-session-start] consume-on-start: no_handoff
```

Other `skipped` reasons:
| Reason | Meaning |
|--------|---------|
| `no_handoff` | No unconsumed handoff for this run+task (normal for a fresh start) |
| `daemon_lease_held` | The daemon supervisor holds the lease; it owns this cycle |
| `invalid_ids` | `run_id`/`task_id` in `.archon/ACTIVE` failed safe-charset check |

### Idempotency

If the new session starts and the handoff has already been consumed (e.g. the
hook ran twice), `getLatestUnconsumedHandoff` returns nothing and the result is
`skipped: no_handoff`. No double-consume occurs.

---

## 7. Manual continuation: `npx archon continue-session` (A2)

> Added in `handoffConsumeOnStart`. The `continue-session` verb is now a
> registered admin command dispatched by `npx archon continue-session`.

For cases where automatic consume-on-start did not fire (DB offline at session
start, or you want to manually resume in a separate terminal):

```bash
npx archon continue-session
```

This fetches the latest unconsumed handoff for the active task and prints a
ready-to-run `claude --print '...'` command.

### Options

```
npx archon continue-session [--run-id <id>] [--task-id <id>] [--exec]
```

| Flag | Description |
|------|-------------|
| `--run-id <id>` | Override run ID (default: read from `.archon/ACTIVE`) |
| `--task-id <id>` | Override task ID (default: read from `.archon/ACTIVE`) |
| `--exec` | Spawn `claude` directly instead of printing the invocation |

### Typical workflow

1. The current session's PreCompact hook commits a `precompact_fallback` handoff.
2. You start a new terminal (or notice the session lost context).
3. Run `npx archon continue-session` to print the successor invocation.
4. Run (or copy-paste) the printed `claude --print '...'` command to start the
   successor session with the continuation prompt injected.

### Fallback when DB is unavailable

If the database is offline, the command prints manual instructions and exits 1:

```
continue-session: could not connect to the archon runtime DB.
Manual continuation path:
  1. Ensure the current session called archon_handoff_commit before stopping.
  2. Start a new claude session and paste the continuation prompt from:
       .archon/work/daemon/continuation-context.txt
```

---

## 8. Enabling autonomous execution (`archon autonomous-enable`)

The daemon's turn dispatch is gated on `autonomousExecution.enabled` in the runtime state. By
default this flag is `false`, so the daemon returns `blocked: no executable next step` on every
turn. Use `archon autonomous-enable` to flip it on.

### Prerequisites

- Review-identity adapter is live (`archon verify-review-identity` returns `liveTrustReady: true`).
- A run is active (`archon status --run-id latest`).
- `archon daemon` will be (or is) running under a supervisor (Part 3).

### Enable

```sh
npx archon autonomous-enable --run-id latest
# or with explicit profile and starting phase:
npx archon autonomous-enable --run-id <run-id> --profile standard_delivery --phase discovery
```

Prints the resulting state as JSON (or `--format text`). Then start (or restart) the daemon:

```sh
npx archon daemon --run-id <run-id>
```

### Disable

```sh
npx archon autonomous-enable --disable --run-id <run-id>
```

This flips `enabled=false` without clearing coverage items, gaps, checkpoints, or any other
accumulated analysis state. The daemon will fall back to `blocked` directives until you re-enable.

### Safety rails (all active by default)

| Rail | Env var | Default |
|------|---------|---------|
| Respawn budget per task | `ARCHON_MAX_RESPAWNS_PER_TASK` | 8 (valid range 1–50) |
| Context monitor mode | `ARCHON_CONTEXT_MONITOR` | `enforce` |
| Cross-process file-lock lease | — | Automatic, prevents concurrent daemon runs |

Out-of-range `ARCHON_MAX_RESPAWNS_PER_TASK` values resolve to the default `8` (not clamped).

---

## 9. What ships (reference) <!-- was §8 -->

- `archon autonomous-enable` — operator command to enable/disable the daemon's autonomous execution
  loop for a run (`src/admin/autonomous-enable.ts`). See §8 above.
- `archon sweep-orphans` — operator command to mark-close historical twinless orphan tasks/runs
  (`src/admin/sweep-orphans.ts`). See §10 below.
- `archon:daemon` npm script — the wired consumer entrypoint (`src/admin/archon.ts daemon`).
- The interactive parachute hooks — `.claude/hooks/archon-session-start.mjs` (registration) and
  `.claude/hooks/archon-pre-compact.mjs` (handoff commit).
- `.env.archon.example` — documents every knob in Part 2.
- The respawn budget bound `[1, 50]` (reject-to-default on invalid — an out-of-range value resolves
  to `8`, it is **not** clamped to the nearest bound) and the cross-process file-lock lease — the
  safety guards that bound a single daemon run.

## 10. Historical orphan sweep (`archon sweep-orphans`, closureLoop W4)

Over time, manager control-writes and aborted cycles leave runtime tasks (and their runs) stuck in
`in_progress`/`ready` even though their work merged long ago. These orphans are *twinless* —
`prune-orphans` deletes only duplicates that have a sealed twin, so it excludes them by design.
`sweep-orphans` MARKS such orphans **closed** (`status → done` + a `sweptOrphan` payload stamp)
instead of deleting them, so the action is fully reversible from the backup.

### Safety model

- **Dry-run by default.** No mutation happens without `--confirm`.
- **Backup-first.** `--confirm` writes a pre-mutation JSON backup (original statuses captured) and
  refuses if the backup path is not inside `dataRoot`/`repoRoot`.
- **Mandatory operator review.** Always inspect the dry-run candidate list and cross-check it against
  the known-merged initiatives before `--confirm`. The predicate is a heuristic, not a guarantee.
- **Hard rails (never overridable, even by `--allow-list`):** the active run is never swept; an
  `approved`/`done`/`blocked` task is never swept; a task with a recorded approval is never swept.
- **Heuristic rails (overridable by `--allow-list`):** passed reviews, run newer than the age cutoff,
  or an active scope lock. (`claimed_by` is intentionally NOT a rail — manager control-write tasks are
  permanently `claimed_by="manager"`; the active scope lock is the real in-use signal.)

### Flags

```bash
# 1) Review the candidate list (read-only). Default age cutoff is 14 days.
npx archon sweep-orphans                       # or: npx tsx ./src/admin.ts sweep-orphans
npx archon sweep-orphans --older-than-days 2   # widen the window for recent orphans

# 2) After reviewing, mutate:
npx archon sweep-orphans --older-than-days 2 --confirm
# narrow to specific task_keys past the heuristic (still subject to the hard rails):
npx archon sweep-orphans --allow-list taskA,taskB --confirm
```

- `--older-than-days <N>` run-age cutoff for the heuristic (default `14`).
- `--allow-list <a,b,c>` task_keys/ids allowed past the heuristic rails.
- `--max-scan <N>` cap on the initial task scan (default `1000`); the command refuses to proceed past
  the cap rather than silently truncating. Narrow the field (run `prune-orphans` first) or raise it
  deliberately.
- `--backup <abs.json>` override the backup path (must be absolute, end in `.json`, inside
  `dataRoot`/`repoRoot`). Default: `<dataRoot>/sweep-backups/orphans-<ISO>.json`.

### Rollback

The backup JSON records each swept task's and sealed run's **original status**. To reverse a sweep,
restore those statuses from the backup file (`candidateTasks[].status`, `affectedRuns[].status`):

```sql
-- For each entry in backup.candidateTasks:
update tasks set status = '<original_status>', payload = payload - 'sweptOrphan' - 'sweptAt'
  where id = '<task uuid>';
-- For each entry in backup.affectedRuns (runs that were sealed):
update runs set status = '<original_status>' where id = '<run uuid>';
```

(Original statuses are almost always `in_progress`. The `sweptOrphan`/`sweptAt` payload keys are the
audit marker for swept rows.)
