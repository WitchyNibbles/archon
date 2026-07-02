# Intake brief — installFullCapability

## Goal
Make `archon` installation into consuming repos straightforward, complete, and reliable:
one guided flow that leaves any consuming project configured to archon's **fullest
capabilities**, with verification that proves capability (not just file placement).

## Requestor intent
- Install is "still flaky" on real consuming repos despite install-hardening P1–P5 (#135–#139).
- Latest incident (#140): ECC plugin left uninstalled; MCP servers broken — MCP fragment
  routing to `.claude/settings.json` instead of `.mcp.json` was broken **since the installer's
  first commit**; no consumer ever had working MCP registration.
- User mandate: deep analysis → plan → execute as archon orchestrator. End-to-end completion
  expected, NOT planning-only.

## Operating assumptions (stated, no blocking questions)
1. "Fullest capabilities" = everything the package offers a consumer: agents, skills, rules,
   hooks, MCP servers (archon, playwright; optional grafana/obsidian), ECC plugin dependency,
   DB config + migrations, git guard, Playwright setup, doctor/verify checks, workflow scaffold.
2. Installer UX/CLI may change if existing-consumer migration (upgrade path) is preserved.
3. Real consuming repos exist locally (per #140: "verified live against 3 real consuming
   repos") and may be used read-only as evidence.
4. External dependency drift (ECC plugin rename, Claude Code config-surface changes) is in
   scope: install must either automate or hard-verify external prerequisites.

## First-pass facts (2 shallow inspections)
- `src/install/` = cli.ts (~2.4k lines), merge.ts, setup-local.ts, setup-playwright.ts,
  git-guard, maintainer-boundary; commands: init | upgrade | verify | scaffold-workflow | ...
- #140 root causes: (a) MCP fragments merged into wrong file for the product's read path;
  (b) external plugin renamed (everything-claude-code → ecc, repo affaan-m/ECC) and refs went
  stale; ECC install remains a manual documented prerequisite, not automated/verified.
- tests/install.test.ts exists but the MCP break lived for the installer's whole life ⇒ tests
  assert file placement/merge mechanics, not consumer-side capability.

## Hypotheses (competing)
- H1 (primary): no end-to-end capability acceptance — nothing asserts "a fresh consuming repo
  ends up with working MCP, plugin, hooks, DB, agents/skills." Bugs are invisible until a human
  uses a consumer repo.
- H2: external contract drift (Claude Code config surfaces, ECC plugin identity) is unmonitored;
  installer encodes assumptions with no contract checks.
- H3: too much of "full capability" is manual prerequisite (ECC install, DB provisioning,
  plugin marketplace) — flakiness is partly "steps humans skip."
- H4: verify/doctor check the wrong layer (files/DB) and can pass while capability is broken.

## Evidence gaps → bounded investigation
- P1: Full capability inventory: every surface `init`/`upgrade` writes, every check
  `verify`/`doctor` performs, mapped against what a consumer actually needs at runtime;
  identify unchecked/unautomated gaps. (owner: agent-runtime-engineer, read-only)
- P2: External contract mechanics: how Claude Code discovers project MCP servers, plugins,
  marketplaces; can ECC plugin be installed/verified programmatically; what surfaces are
  stable vs drift-prone. (owner: docs-researcher)
- P3: Live consumer evidence: state of the 3 real consuming repos — what's present, missing,
  broken after latest installs. (folded into P1, read-only)

Budget: 2 parallel packets, evidence-only, no writes outside `.archon/work/`.

## Success criteria (done bar)
1. Fresh consuming repo: one guided command → full capability, zero silent gaps; every
   external prerequisite either automated or fail-fast verified with a clear remedy.
2. `verify`/`doctor` prove capability (MCP resolvable, plugin present, hooks executable,
   DB reachable) — not just file existence.
3. Regression harness: e2e install test against a simulated consuming repo runs in CI;
   a #140-class bug cannot ship silently again.
4. Existing consumers upgrade cleanly.
5. Gates: reviewer + qa_engineer + security_reviewer + release-readiness (installer =
   release-sensitive) + workflow check.

## Risk triage
- Main risk: external surfaces (Claude Code behavior, ECC plugin) can't be fully pinned —
  mitigation: contract checks + fail-fast doctor, not silent assumptions.
- Council: substantive architecture-significant work → Design & Architecture Council review
  required at plan stage.

## Stop/go
GO — direction is unambiguous; execution mandated by user.
