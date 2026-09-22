# Archon

A Python kernel that gives Claude Code a persistent, evidence-backed engineering
workflow. Read `docs/design.md` before changing anything; `docs/implementation-plan.md`
is the build contract and `docs/spikes.md` says which platform facts are proven.

## Iron rules

- **A model's say-so never changes state.** `claimed -> verified` happens only when the
  kernel itself ran the check's argv and the gate found current evidence. No public API
  accepts a passing check record, a review receipt, or a force-verified flag.
- **Evidence binds to a candidate.** Every result carries the candidate and checks digests
  it was produced against. A source, plan, or snapshot change invalidates it.
- **Fail open, never lock.** A hook or kernel error degrades to "tell the human", never to
  an unwritable repository. The predecessor that failed closed on an unreachable database
  froze itself and is a case study in `docs/research/`.
- **No mechanism without a run that needed it.** Every guard row, gate, and role cites the
  real failure it prevents. If you cannot name one, do not add it.
- **Label the ceiling.** Reports say what was not verified and why.
- **Confinement is fixed.** A check found in repository configuration is a proposal to run
  under the profile, never authority to widen it.

## Layout

`src/archon/` — `models.py` contracts · `store.py` the only SQL writer · `workspace.py`
repository identity, candidates, snapshots · `sandbox.py` the bwrap check profile ·
`launcher.py` child-subreaper supervision · `claude_adapter.py` checks and reviewer
sessions · `verification.py` job orchestration and the gate · `service.py` public API ·
`mcp_server.py` + `cli.py` interfaces · `install.py` + `hooks.py` the consuming-repo
overlay · `assets/` what `init` writes.

`docs/` design, plan, spikes, assets spec, operations, research, evidence.
`scripts/spikes/` capability probes. `tests/` pytest.

## Working here

- Tests first. `bash scripts/check.sh` is the blocking gate: ruff, mypy, and the non-live
  suite. Tests marked `live` need an authenticated Claude Code; `sandbox` needs bubblewrap.
- **Engine facts are cited from observed behaviour, never memory.** If you need a new fact
  about Claude Code, add a spike to `docs/spikes.md`, run it, and commit the evidence JSON.
  A fact tiered DOCS or INHERITED in `docs/research/` is a hypothesis until a spike passes
  at the installed version.
- The tested engine range is derived from the evidence files on record, never typed by hand.
  `doctor` warns on an untested version; it must never block.
- Write scopes are disjoint by package (see the plan's ownership table). Propose a change to
  a shared contract to the integrator rather than editing another package's files.
- Python: PEP 8, type annotations on every signature, frozen dataclasses or pydantic models,
  no mutation of inputs, functions under 50 lines, files under 800.

## Provenance

The kernel is ported from `../devgod-recovery` at commit `2973b2d` (Codex harness, 233
tests, one live field failure). The name and documentation voice come from `../archon`
(TypeScript, frozen 2026-08-01, self-locked). Neither is a dependency.
