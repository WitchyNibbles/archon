---
name: archon-dependency-triage
description: Use on a recurring cadence, or when npm audit / a dependabot-style alert / a major version bump surfaces, to triage archon's dependency advisories and outdated packages into owned, expiring decisions. Owned by infra-engineer (primary) and docs-researcher.
---

# Archon Dependency Triage

Use this routine on a cadence (see Cadence hook below) or whenever a security
advisory, a CVE, or a major-version bump lands on an archon dependency. It is a
review *routine*, not a delivery task: it produces owned, expiring decisions and, when
action is warranted, a queue-ready upgrade proposal — it does not bump versions inline.

Goal: no advisory is ever silently carried. Every one is blocked, scheduled, or
accepted with a named owner and an expiry date (no-buts bar).

## Procedure

1. **Collect the signal.**
   - `npm audit --json` — advisories with severity + affected paths.
   - `npm outdated --json` — current vs wanted vs latest per package.
   - Note any transitive-only advisory (no direct upgrade path) — it triages
     differently from a direct dependency.
2. **Classify each finding** into exactly one disposition, with an owner and expiry:
   - **block** — a `high`/`critical` advisory reachable from shipped/runtime code, or a
     breaking bump that gates other work. Must be fixed before completion; assign the
     owner (usually `infra-engineer`) and the fix task.
   - **schedule** — real but non-urgent (moderate advisory, major bump needing a
     migration). Record a queue-ready upgrade proposal for the `planner` with an
     explicit target window; owner + expiry required.
   - **accept** — genuinely not reachable, false-positive, or a dev-only/test-only
     path with no exposure. Requires a **specific** reason (not "advisory" /
     "low-priority"), a named owner, and an **expiry date** by which it is re-triaged.
     An accept without owner+expiry is not a decision — it is a silent carry.
3. **For a warranted upgrade, propose (do not perform) the PR:** one dependency (or one
   coherent group) per PR; state the advisory/bump it closes, the breaking-change scan,
   and the verification (`npm run build:dist && npm test` green, lockfile updated). Hand
   to `planner`/`infra-engineer` for scoped execution.
4. **Record the disposition set** so the next cadence run starts from the prior
   decisions and can expire stale accepts.

## Cadence hook

This routine is designed to run on a recurring cadence, not only reactively — but
that cadence is currently a **proposed** trigger, not a scheduled one: no
`.github/workflows/` job exists yet to fire it automatically. Until one is added,
trigger it by:

- **Manual / operator:** invoke `/archon-dependency-triage` and run the procedure; land
  the disposition set in the debt notes. This is the only trigger path today.
- **Autonomy loop (opportunistic):** the daemon/autonomy loop may surface the same
  trigger when it observes a new advisory during a run, routing here the same as a
  manual invocation.
- **Future — scheduled (proposed, not yet implemented):** a weekly (or per-release)
  GitHub Actions job running `npm audit` + `npm outdated` and opening a queue item on
  any new `high`/`critical` advisory or expired accept would close the gap between
  "designed for a cadence" and "actually scheduled." Adding that workflow is a
  separate, deliberately small follow-up — not bundled into this skill file.

Whichever fires it, the output is the same: an updated block/schedule/accept set with
owners and expiries.

## Pitfalls

- Bumping a version inline from this routine — it produces proposals + decisions, not
  edits; scoped upgrades go through the planner and a proper PR.
- Accepting an advisory with a generic reason or no expiry — that is a silent carry,
  the exact failure this routine exists to prevent.
- Treating a transitive advisory as unfixable without checking for a direct-dependency
  override or a patched minor.
- Batching unrelated dependency bumps into one PR — one dependency/group per PR keeps
  the breaking-change surface reviewable.
- Letting an expired `accept` sit — an expiry that has passed is a new finding to
  re-triage, not a settled decision.

## Verification

- `npm audit` shows no un-triaged `high`/`critical` advisory (each is block/schedule or
  an unexpired, owner-stamped accept).
- Every carried advisory has a named owner and a future expiry date on the record.
- Any upgrade proposal names its verification command and closes a specific advisory/bump.
