# Proposal (DRAFT): Ponytail-derived minimalism for archon-execution / archon-planning

> Status: **draft / not yet integrated.** This is proposed skill text only. Editing the live
> `.claude/skills/archon-execution/SKILL.md` and `.claude/skills/archon-planning/SKILL.md`
> is control-layer work that must route through `archon-intake` → planning with an explicit
> write scope and reviewer/qa/security gates. Nothing here changes live behavior yet.

## Intent

Port the *ideas* from ponytail (github.com/DietrichGebert/ponytail) — a "lazy senior dev"
code-generation discipline — **not** the plugin. We take the decision ladder and the
explicit-debt convention as advisory guidance, and rename its `ponytail:` marker to an
archon-native `archon-debt:` to avoid foreign vocabulary (per memory-vocabulary policy).

Critical reconciliation: **archon's gates stay authoritative.** Minimalism never overrides
TDD-first, the 80% coverage expectation, or the reviewer/qa/security gates. When minimalism
and a gate conflict, the gate wins.

---

## Draft section for `archon-execution` (advisory)

> ### Minimalism and explicit debt (advisory)
>
> Before writing code, stop at the first rung that applies:
>
> 1. **YAGNI** — does this need to be built at all? If not, don't.
> 2. **Stdlib** — does the standard library already do it? Use it.
> 3. **Platform** — does a native platform/runtime feature cover it? Use it.
> 4. **Installed deps** — does an already-present dependency solve it? Use it; add no new
>    dependency that can be avoided.
> 5. **One line** — can it be one clear line? Prefer it (clarity over golfing).
> 6. **Minimal** — only then write the minimum working implementation.
>
> Prefer deletion over addition, boring over clever. No abstractions, boilerplate, or
> config nobody asked for. Question over-scoped requests; propose the simpler path.
>
> **Never on the chopping block** (these are not "extra"):
> trust-boundary input validation, error handling that prevents data loss, security,
> accessibility, and any explicitly requested feature. Minimalism reduces *gratuitous*
> code, never *safety* code.
>
> **Archon gates remain authoritative.** This guidance does not relax test-first delivery,
> the coverage expectation, or the reviewer/qa_engineer/security_reviewer gates. The
> ponytail-style "no test needed for trivial one-liners" does NOT apply where a quality
> gate requires coverage — the gate wins.
>
> **Mark intentional shortcuts** with an inline `archon-debt:` comment naming (a) the known
> ceiling (e.g. `global lock`, `O(n^2) scan`, `naive heuristic`) and (b) the upgrade path
> when it matters. Example:
> `// archon-debt: in-memory cache, no eviction — swap for LRU when entries > ~10k`
> Surface each `archon-debt:` marker into the task's follow-up items so debt stays traceable.

---

## Draft pointer for `archon-planning` (one line)

> When decomposing tasks, budget for minimal-viable scope (see archon-execution
> "Minimalism and explicit debt") and capture any deferred `archon-debt:` shortcuts as
> explicit follow-up entries in `task-queue.json` / `product-state.md`.

---

## Why this is low-risk (vs the other two tools evaluated)

- Pure advisory text in a skill — no proxy, no lossy compression, no MITM, no new runtime.
- Worst case it nudges code smaller; the manager kernel (confirm acceptance criteria) and
  qa/reviewer gates catch any under-build.
- The `archon-debt:` convention is a net gain: it makes deferred shortcuts explicit and
  feedable into existing state files, complementing archon's evidence culture.

## Open reconciliation points to settle during the real task

- Exact wording alignment with existing `archon-tdd` / coverage expectations so the
  "trivial one-liner" carve-out can't be read as a coverage-gate loophole.
- Whether `archon-debt:` markers should be auto-harvested (a small scan) or captured
  manually at task close. Manual first; automate only if it proves noisy.

## Governance / routing for live integration

1. `archon-intake` → scope = advisory skill-text addition to two `archon-*` skills.
2. `archon-planning` to produce the task packet; write scope limited to those two SKILL.md
   files.
3. Gates: reviewer + qa_engineer + security_reviewer + workflow check.
