---
name: archon-retro
description: Post-task learning loop that compounds knowledge before the next task starts. Use at task or initiative closure — after the reviewer/qa_engineer/security_reviewer gates pass and before the next task is selected — or on an explicit operator retro ask. Turns what the gates, mistake-ledger, and repair rounds recorded into an explicit promotion decision: repo facts into .archon/memory/, process lessons into skill patches via archon-skill-evolution, one-offs discarded on the record. Drives the postmortem template for substantive initiatives. "Nothing to promote" is a valid recorded outcome.
---

# Archon Retro

Use to close the learning loop so each task makes the next one cheaper. This is the
step that stops `.archon/memory/` and `.archon/skills/` from staying empty (audit F5).

Goal: extract durable signal from a just-closed task into reviewed durable context,
and record the promotion decision — even when the decision is "nothing to promote."

## When to run

- **Task/initiative closure** — after the `reviewer`, `qa_engineer`, and
  `security_reviewer` gates pass and the workflow check is green, before the next
  task is selected (autopilot step; execution completion step).
- **Explicit operator ask** — `/archon-retro`.

Do NOT run mid-task or before gates pass: a retro on unverified work promotes noise.

## Retro pass

1. **Gather what actually happened.** Read, for the closed task, only recorded
   evidence — not memory of the session:
   - the gate records (review/qa/security outcomes and findings)
   - the mistake-ledger and repair-round artifacts (`.archon/work/qa-findings-<task>*.json`,
     repair-loop notes) — what failed, how many rounds, what fixed it
   - the task packet acceptance criteria vs. what shipped
2. **Extract candidate lessons.** For each finding, repair, or correction, state one
   concrete lesson in a sentence. Skip nothing yet — filtering is step 3.
3. **Classify each candidate** into exactly one bucket:

   | Bucket | Signal | Destination |
   |---|---|---|
   | Repo fact | Stable truth about this codebase/stack/decision, reusable beyond one thread | `.archon/memory/` promotion (rules below) |
   | Process lesson | A workflow/build/debug pattern or "stop doing X in this repo" correction | Skill patch proposal via `/archon-skill-evolution` |
   | One-off | Environment-specific, task-narrative, or already recorded | Discard — but record that it was considered and dropped |

4. **Apply the memory-promotion rubric** (`.archon/rules/memory-promotion.md`) to every
   repo-fact candidate. Promote only if it is stable, cited to this run/task, reviewed,
   reusable, non-secret, and non-speculative. If any test fails, it drops to one-off.
5. **Write to the right memory file** (`.archon/rules/memory-vocabulary.md` labels are
   mandatory — see below):
   - `project-profile.md` — stable product purpose, users, stack, non-negotiable constraints
   - `decision-log.md` — a choice, when it won, the tradeoff accepted, what it superseded
   - `patterns.md` — an approach that worked repeatedly, or an anti-pattern to avoid
   - `lessons-learned.md` — failure → cause → fix → prevention rule
   Prefer editing an existing entry over appending noise; mark superseded/contradicted
   entries instead of silently flattening them.
6. **Route process lessons** to `/archon-skill-evolution` (patch a loaded skill first;
   new skill is last resort). Do not write durable skill knowledge inline here.
7. **Postmortem for substantive initiatives** — drive `.archon/templates/postmortem.md`
   when the initiative hit any of: multi-round gate failure, a security finding, or a
   user-visible incident. Store the filled postmortem under `.archon/work/` and promote
   only its `## Prevention rule` and `## Durable memory update` into memory.

## Memory vocabulary (required on every entry)

Bind every promoted entry to `.archon/rules/memory-vocabulary.md`: at minimum a
`role:` and `domain:` label (domain ∈ workflow, frontend, infra, retrieval, review,
security, testing, planning, runtime, install), plus `scope:` and one of
`decision:` / `constraint:` / `pattern:` / `status:`. Use the canonical terms
(`workflow`, `postgres`, `pgvector`, `review-gate`, `durable-memory`, …) — never
synonyms. A prose-only entry is not searchable and is rejected.

## Recording the decision (always)

End every retro with an explicit promotion decision, one of:

- **Promoted** — list each file touched and the one-line reason per entry.
- **Nothing to promote** — state it plainly and why (e.g. "trivial fix, no reusable
  fact; no process correction"). This is a valid, complete outcome — silence is not.

Record the decision in the runtime, not just in prose: run

```
npx tsx ./src/admin.ts record-retro --task-id <id> \
  --outcome <memory_promoted|skill_patched|discarded|postmortem_filed|nothing_to_promote> \
  --source orchestrator
```

This is the real, auditable recording primitive (auditP3RetroLoop fix #1) — it
writes `packet.retroOutcome` + `packet.retroDecidedAt` on the task record, which
`close-run`'s seal gate reads before it will seal a run. A retro pass that only
writes prose and never runs `record-retro` has not actually recorded anything the
runtime can verify.

Never leave a closed task with no recorded retro decision. That silent gap is the
exact failure (F5) this skill exists to close.

## Rules

- promote reviewed, cited, reusable facts only — retrieval hints are not durable memory
- do not let an implementation agent write durable memory without this decision step
- do not restate what the repo or git history already records
- never store secrets, tokens, or artifact payloads (screenshots/traces) in memory
- keep promotion decisions tighter than retrieval decisions

## Verification

- every promoted `.archon/memory/` entry carries `role:` + `domain:` labels and a
  provenance reference (run or task id)
- the retro decision is recorded (promoted list OR explicit "nothing to promote")
- process lessons were routed to `/archon-skill-evolution`, not written inline
- substantive initiatives have a filled `postmortem.md`

## Output

Return the classification decision for each candidate lesson (repo fact / process
lesson / one-off and its destination), the outcome token recorded (one of
`memory_promoted`, `skill_patched`, `discarded`, `postmortem_filed`,
`nothing_to_promote`), and confirmation that `record-retro --task-id <id> --outcome
<token> --source orchestrator` was actually run — not just described.
