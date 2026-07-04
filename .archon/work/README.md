# `.archon/work/`

This directory holds Archon's **live workflow state**: the task queue, briefs,
plans, task packets, review records, council notes, daemon coordination files,
and every other artifact the runtime, hooks, and agents produce while a
project is in flight.

## Ownership

`.archon/work/` is **owned by the repo it lives in, never by the shared
Archon package**. In this package repo (`archon` itself), the tree exists only
to support dogfooding and local development — none of its contents are a
package asset. In a consuming repo, this is where that repo's own live task
state accumulates.

Because of that split:

- Every file under `.archon/work/` **except this README** is git-ignored (see
  the repo's `.gitignore` — `.archon/work/*` with `!.archon/work/README.md`
  re-including this file). The installer applies the same two entries
  (`.archon/work/` and `.archon/ACTIVE`) to consumer repos on install/repair —
  see `src/install/merge.ts` `mergeGitignore`.
- This README **is** tracked and shipped as a package asset (listed in
  `package.json` `files[]`) purely to document the directory's layout and
  ownership for anyone who opens it — it carries no runtime meaning and is
  never read by Archon itself.
- Nothing else in this directory should ever be committed. If `git status`
  shows other files under `.archon/work/` as staged or trackable, that is a
  bug in the ignore rules, not evidence they should be committed.

## Single writer

Every TypeScript write to `.archon/work/**` (and the sibling `.archon/ACTIVE`
pointer) routes through `src/runtime/export-writer.ts` — one atomic
(temp-file + rename) writer with a rooted path guard and symlink-escape check.
A short, explicit list of exceptions (dependency-free hook `.mjs` scripts,
lock files needing O_EXCL exclusivity, and configurable external
interchange directories) is documented in that module's header. See
`architecture-runtime-debt.md` §3.6 (F8) for the audit finding this closes.

## Typical contents

| Path | What it is |
|---|---|
| `task-queue.json` | The exported task queue snapshot |
| `briefs/`, `plans/`, `tasks/`, `reviews/`, `council/`, `proofs/` | Per-task workflow artifacts |
| `daemon/` | Daemon coordination state (continuation status, automation envelopes, scheduler requests, operator handoffs, supervisor status/history, review-queue archives) |

None of these are read by anything outside the current run — they are
regenerated from the authoritative runtime (Postgres) state, not the other way
around. If this directory is deleted entirely, the next reconcile/init-task
invocation recreates whatever it needs.
