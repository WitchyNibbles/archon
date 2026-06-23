# Forge Phase-0 Dashboard Spec

**Status:** Draft — Phase-0 foundation (S1 deliverable)
**Task:** forgePhase0Skeleton
**Scope:** Layout hierarchy, primary information order, done-bar definition

---

## Purpose

This spec defines the primary layout hierarchy for the Archon Forge operator dashboard. It is a hard requirement enforced at the spec stage — S3 (dashboard implementation) may not override the hierarchy without a new council decision.

The dashboard serves one primary operator job: **identify a blocked run and its blocking gate faster than reading task-queue.json or running the CLI.**

---

## Primary Layout Hierarchy (required, non-negotiable)

The layout is ordered strictly by operator urgency:

```
1. HERO — Blocker Panel
2. Run Header + Authority Badge
3. Task-Queue Table
4. Review-Gate State
5. Live Pulse Indicator
```

Each tier is described below with its data source from `src/forge/dashboard-contract.ts`.

---

### 1. HERO: Blocker Panel

**This is the layout hero. It must be the most visually dominant element on screen when blockers exist.**

- Source: `DashboardViewModel.blockers` (array of `BlockerViewModel`)
- Placement: top of the main content area, full width
- Visual treatment: `--status-error` (#EF4444) for blocked kind; `--surface-raised` background; border-left accent stripe in `--status-error` or `--status-warning` depending on `BlockerViewModel.kind`
- When empty (no blockers): display a compact idle/done state — do not hide the region entirely (disappearing UI is disorienting)
- Blocked state rule (AG-015): must be visually dominant — subtle badges are a hard-fail

**Blocker card anatomy (per item):**
- `reason` in `--text-primary` at body size
- `kind` badge in Geist Mono at `--text-label` scale (AG-007 mono use case)
- `taskId` in Geist Mono at `--text-muted` if scoped to a task
- `nextActions` as a tight bulleted list in `--text-secondary`

**Operator done-bar:** An operator identifies a blocked run and its blocking gate via the blocker panel alone — without needing to scan the task table or read task-queue.json or run CLI commands. The `nextActions` field surfaces recovery steps inline.

---

### 2. Run Header + Authority Badge

- Source: `DashboardViewModel.header` (`RunHeaderViewModel`)
- Placement: below the blocker panel, above the task table
- Layout: one row — run title (text-h2, tight tracking), run status badge, authority label badge, updatedAt timestamp
- `runId` in Geist Mono at `--text-muted` (inline, after title)
- `authorityLabel`:
  - `"runtime_authoritative"` → solid `--accent` (#6366F1) pill badge, label "RUNTIME"
  - `"derived_only"` → `--surface-elevated` background, `--text-secondary` text, label "ADVISORY"
- `status` uses `--status-*` semantic tokens:
  - `in_progress` → `--status-running`
  - `review_blocked` → `--status-error`
  - `done` / `approved` / `memorized` → `--status-success`
  - `ready` / `planned` / `decomposed` / `intake` → `--status-pending`

---

### 3. Task-Queue Table

- Source: `DashboardViewModel.taskQueue` (array of `TaskQueueEntryViewModel`)
- Placement: below run header, main content area
- Layout: compact data table (not card grid — AG-012 forbids 3-card layouts)
- Columns: Status dot | Task ID (Geist Mono) | Title | Owner Role | Routing | Updated
- Row ordering: blocked/review_blocked first, then in_progress, then ready, then done
- Status dot uses `--status-*` tokens mapped from `TaskStatus`
- `routingRecommendation` column: `review_dispatch` → "Review" badge in `--status-error`; `owner_dispatch` → "Dispatch" in `--status-pending`; `wait` → muted; undefined → empty
- Inline blocker messages: when a task has blockers, show them inline below the row as a tight sub-row in `--text-muted`, indented

---

### 4. Review-Gate State

- Source: `DashboardViewModel.reviewGates` (array of `ReviewGateViewModel`)
- Placement: below task table, or collapsible panel attached to a blocked task row
- Layout: grouped by taskId — one section per task that has pending/blocked gates
- Gate row: role label (Geist Mono, --text-label scale) | state badge | severity | actor + reviewedAt (Geist Mono, --text-muted)
- Gate state badge colours:
  - `pending` → `--status-pending`
  - `passed` → `--status-success`
  - `blocked` → `--status-error`
  - `waived` → `--status-muted`
- Only show tasks with at least one non-passed, non-waived gate in the default view; "passed" gates accessible on expand

---

### 5. Live Pulse Indicator

- Source: `DashboardViewModel.pulse` (`RunPulseViewModel`)
- Placement: top-right of the run header row (does not interrupt content flow)
- Layout: small dot + label
- `running` → `--status-running` (#06B6D4) dot with `status-pulse` animation (opacity + scale, 2s ease-in-out); label "LIVE"
- `blocked` → `--status-error` dot, static; label "BLOCKED"
- `complete` → `--status-success` dot, static; label "DONE"
- `idle` → `--status-muted` dot, static; label "IDLE"
- `activeLockCount` shown in Geist Mono if > 0: "2 locks"
- Animation rule (AG-010): status-pulse only — no other looping animation
- **Layout binding (must hold in S3):** the Live Pulse Indicator is a *composed element within the Run Header row* (section 2), NOT a standalone layout block rendered below the Review-Gate State section. The numbered hierarchy (1–5) above reflects **data priority / urgency order, not five separate layout blocks** — pulse occupies the header row's top-right, co-located with section 2.

---

## Visual System Requirements

All of the following apply verbatim from `src/forge/constraints-manifest.ts`:

- Dark base: `#0A0A0A` (`--surface-base`)
- Single accent: indigo `#6366F1` (`--accent`)
- Typefaces: Geist Sans + Geist Mono — IDs/timestamps/counts always in Geist Mono
- 8px spacing grid — no arbitrary values
- Border radius cap: 6px for data surfaces, 8px absolute maximum
- Motion: 150–200ms max, `cubic-bezier(0.16, 1, 0.3, 1)` for enter
- Elevation via luminance (background steps), never `box-shadow` on dark surfaces

Anti-generic constraints AG-001 through AG-015 are enforced. S3 implementation must pass the S4 critic before review gate.

---

## Operator Done-Bar Definition

An operator can:
1. Load the dashboard URL for a run
2. See immediately (without scrolling) whether the run is blocked and what the blocking gate or issue is
3. Read the recovery action inline (no CLI command, no file read)
4. Identify which task is blocked and which review role is missing

This is the **minimum viable operator value** of the Forge dashboard. The blocker panel HERO placement is the mechanical enforcement of this done-bar — it is not a stylistic preference.

---

## Data Contract Dependency

This spec assumes `src/forge/dashboard-contract.ts` is the single source of truth for all view model shapes. S3 must import from that module only — no raw MCP/tool JSON in web/.
