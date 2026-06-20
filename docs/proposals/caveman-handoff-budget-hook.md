# Proposal (DRAFT): Caveman handoff-budget hook

> Status: **draft / not yet integrated.** This is a spec only. Wiring it into the live
> control layer (`scripts/`, `.claude/`, `settings.json`) is an agent-runtime-domain change
> that must route through `archon-agent-runtime` → `agent-runtime-engineer` with
> reviewer/qa/security gates. Do not hand-edit live hooks from this draft.

## Purpose

Turn the existing advisory `caveman` skill into a *measured* one. Today nothing checks
whether internal coordination text actually stays terse — the skill says "hard cap 8 lines"
but there is no enforcement. This hook makes the budget observable and (optionally later)
enforceable, **deterministically, with zero model calls**, matching archon's
`runtime/deterministic` posture.

It is a quality nudge, not a gate. It must never block on user-facing or durable prose.

## Scope (what it measures)

ONLY internal-coordination artifacts that the caveman skill already governs:

- agent-to-agent handoff notes
- review / QA / security **gate notes**
- plan summaries and progress updates inside long tasks

Explicitly **out of scope** (never measured, never warned):

- user-facing manager reports / final answers
- durable operator docs, release notes, migration guides
- code, config, and `CLAUDE.md` / `.archon/rules/` policy prose

## Detection algorithm (deterministic)

A "caveman block" is identified structurally, not semantically:

1. A contiguous run of lines where each non-blank line matches one of the skill's
   schema labels: `role:`, `goal:`, `done:`, `risk:`, `blk:`, `next:`, `need:`,
   `gate:`, `fail:`, `file:`, `test:`.
   - (Optional stronger signal: an explicit `<!-- caveman -->` ... `<!-- /caveman -->`
     marker pair, so authors can opt a block in/out unambiguously.)
2. For each detected block, count non-blank lines and per-value word counts.

No NLP, no tokenizer dependency — line + whitespace-word counting only, so results are
reproducible and CI-safe.

## Budget parameters (config, with skill-aligned defaults)

| Param | Default | Source |
|-------|---------|--------|
| `maxLines` | 8 | caveman SKILL.md "hard cap: 8 lines" |
| `softLines` | 6 | caveman "default target 4-6 lines" |
| `maxWordsPerValue` | 12 | caveman "hard max: 12 words per value" |
| `maxItemsPerLine` | 3 | caveman "list at most 3 items per line" |

Config lives next to other archon hook config (proposed: a `caveman_budget` block in the
repo's hook settings, or a small `scripts/` constant). Values are advisory defaults a task
packet may raise with justification.

## Trigger surface & behavior

Two viable integration points — recommend starting with the first:

1. **PostToolUse on `Write`/`Edit`** targeting in-scope artifact paths
   (e.g. handoff/gate-note files under `.archon/work/**`, review export paths).
   On overage: emit a **warn-only** structured message; non-blocking exit.
2. **Stop hook** scanning artifacts modified during the session as a backstop.

Behavior ladder (adopt incrementally):

- **Phase 1 — warn-only (recommended first):** print `file • block • lines N>max`
  and the offending labels. Never blocks. Pure signal.
- **Phase 2 — soft-block (optional, later):** block only when a block exceeds
  `maxLines` AND the artifact is a gate note, with a one-line override token
  (`caveman_budget=waived` in the task packet). Requires its own gate review before enabling.

## Why warn-only first

Hard-blocking terseness risks the opposite failure: agents dropping real decision signal to
satisfy a line count. The skill itself warns against losing nuance in security/QA notes.
Start by measuring; only escalate if data shows bloat is real.

## Test plan

- Unit: fixtures of valid (≤8-line) and over-budget caveman blocks → assert detection +
  line/word counts; assert non-caveman prose is ignored (zero false positives on
  user-facing reports and policy docs).
- Determinism: same input → identical output across runs (no model, no clock).
- Negative: code blocks, URLs, and tables containing `:` must not be misdetected as
  caveman labels.

## Risks / open questions

- **False positives** on prose that incidentally uses `label:` lines → mitigate with the
  explicit marker-pair option.
- **Gaming** (splitting one bloated block into many small ones) → acceptable for a nudge;
  revisit only if abused.
- **Where do handoff/gate notes actually land on disk?** Confirm the canonical artifact
  paths before choosing PostToolUse vs Stop. This is the main unknown to resolve during
  the real agent-runtime task.

## Governance / routing for live integration

1. `archon-intake` → confirm scope = agent-runtime hook addition.
2. `archon-agent-runtime` skill; implement via `agent-runtime-engineer`.
3. Write scope must cover the new `scripts/` script + hook settings only.
4. Gates: reviewer + qa_engineer + security_reviewer + workflow check.
