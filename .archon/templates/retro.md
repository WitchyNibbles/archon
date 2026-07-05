# Retro — <task-id>

Driven by the `archon-retro` skill at task/initiative closure (gates passed, before
next-task selection). Keep it short; the promotion decision is the required output.

## Source evidence

- gate records (reviewer / qa_engineer / security_reviewer outcomes + findings):
- mistake-ledger / repair rounds (`.archon/work/qa-findings-<task-id>*.json`, round count):
- acceptance criteria vs. what shipped:

## Candidate lessons

List each lesson in one sentence, then classify: `repo-fact` | `process-lesson` | `one-off`.

- lesson: … — class: …

## Promotion decision (required)

Choose one:

- **Promoted** — per entry: `<memory-file>` ← `<one-line reason>` (with `role:`/`domain:` labels applied)
- **Nothing to promote** — reason: …

## Process lessons routed

- `/archon-skill-evolution`: `<skill patched or proposed>` — or `none`

## Postmortem

Required only for substantive initiatives (multi-round gate failure, security finding,
or user-visible incident). Fill `.archon/templates/postmortem.md` and link it here, else
`not substantive`.
