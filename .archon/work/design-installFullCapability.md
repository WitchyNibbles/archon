# Design — installFullCapability

- **Brief:** `.archon/work/brief-installFullCapability.md`
- **Evidence:** `.archon/work/evidence-installFullCapability.md`
- **Role:** solution_architect. Status: design ready for planner + Design & Architecture Council.
- **Release-sensitive:** installer changes → `release_readiness_required` gate applies.

## Problem in one line

No layer proves CAPABILITY. `verify` = byte-diff of managed files; `doctor` = DB-only.
Both pass while MCP is unusable, ECC absent, hooks dead, adapter stub throwing. #140 (MCP
routed to the wrong file since the installer's first commit) lived undetected because tests
assert merge mechanics, not "a consumer ends up able to do the thing."

## Source-of-truth / trust boundaries (3 distinct authorities)

1. **Package (this repo)** — owns managed file content, the *capability contract* (what
   capabilities exist and how each is probed), expected external identities (ECC marketplace
   + plugin name set, playwright pin), and next-steps derivation. One writer.
2. **Consumer repo** — owns live project state: `.mcp.json`, `.env.archon`, `node_modules`,
   project `.claude/settings.json` hooks, seeded `review-identity-adapter.ts`, DB. Installer
   writes managed/seed files here per existing managed/seed semantics.
3. **User-global `~/.claude`** — owns plugin/marketplace/`enabledPlugins` state. Cross-project,
   NOT the installed repo. Any installer write here (marketplace add, plugin install) is a
   side effect on a shared authority → **requires explicit consent** every time (interactive
   prompt or an explicit flag). Never silent.

External contract surface = the `claude` CLI (`mcp list/get`, `plugin list`, marketplace).
It is the ONLY way to prove MCP/plugin runtime capability, and it may be absent (CI, headless).
Probes must treat its absence as `skipped`, never crash.

## Core architectural move: one Capability engine, layered probes, three callers

Today truth is scattered (verify=file, doctor=DB, docs=a third). The durable fix is a single
**capability registry**: a declarative list of capabilities, each carrying probes at up to
four layers. All install/verify/doctor surfaces and CI/live-check consume the SAME engine.

### The four layers (cheap → expensive, each provable independently)

- **L0 FILES** — managed file present + unmodified. (existing `verify` logic, reused.)
- **L1 CONFIG-PARSE** — the config file parses and contains the expected shape:
  `.mcp.json` parses and has `mcpServers.archon` + `playwright`; project `settings.json`
  has the hook keys; `package.json` has `archon:*` scripts; `.env.archon` has a resolvable
  DB URL. **This layer alone catches the entire #140 class** — a probe asserting "archon MCP
  server is present in `.mcp.json`" fails the instant the fragment lands in the wrong file.
- **L2 EXTERNAL CONTRACT** — external identity/prereq resolves: `claude` CLI present;
  `node_modules` installed; ECC marketplace registered + plugin identity in the accepted set;
  playwright browsers present; **adapter-stub detection** (seeded `review-identity-adapter.ts`
  still throws / is the shipped stub, not a real impl).
- **L3 RUNTIME CAPABILITY** — the thing actually works: `claude mcp list` shows archon
  Connected (not Pending); hook exec dry-run exits 0; DB preflight (existing db-preflight.ts);
  bootstrap/registration present.

### Probe result contract (immutable, machine + human)

Each probe returns `{ capability, layer, status, code, detail, remediation }` where
`status ∈ ok | degraded | blocked | skipped`. `remediation` is an exact operator action
(e.g. the precise `claude plugin install` line, or "open the IDE and approve the MCP server").
`skipped` carries a reason (tool absent). Severity (does a `degraded`/`skipped` block?) is
decided at **report assembly**, not in the probe — probes stay pure and context-free.

### Severity policy (data-driven, reversible)

- L0/L1 failures → **blocking** everywhere (managed files + config are fully controllable).
- L2/L3 failures → **advisory (degraded)** in `verify` and in CI (external deps may be absent),
  **blocking** in operator `doctor` on a machine that has `claude` + DB.
- MCP first-use approval (Pending state) → **always advisory** with the approve remediation
  (the click is not automatable — evidence A.2).
- `skipped` (tool absent) → advisory, never a crash.

### Reuse of existing shape

`doctor` already emits `{ok, blockers, advisories, nextActions, reason}` (runtime.ts
`doctorCommand`). The engine's report assembler produces exactly this shape so doctor is a
thin adapter and the JSON contract is unchanged. db-preflight.ts's injectable-fn pattern
(`DbQueryFn`) is the model: every probe takes injected effects (fs read, `spawn`, query) so
CI runs the engine with stubbed externals.

## Module layout (cli.ts is 2475 lines — must split; <800-line rule)

New pure engine, feature-organized:
- `src/install/capability/types.ts` — probe result + report types (the contract).
- `src/install/capability/registry.ts` — the declarative capability list + which layers apply.
- `src/install/capability/probes-file.ts` — L0 (extracted from current verify).
- `src/install/capability/probes-config.ts` — L1 parse/shape assertions.
- `src/install/capability/probes-external.ts` — L2 (claude-present, node_modules, ECC identity,
  adapter-stub, playwright), all via injected `spawn`/fs.
- `src/install/capability/report.ts` — assembles probe results → severity → `{ok, blockers,
  advisories, nextActions}`.
- `src/admin/capability-probes-runtime.ts` — L3 runtime probes (claude mcp list, hook dry-run),
  reusing db-preflight.ts for the DB probe; consumed by `doctor`.
- `src/install/ecc-plugin.ts` — expected ECC identity set + drift contract + consented install.
- `src/install/guided-init.ts` — interactive prompt orchestration + non-interactive flags.
- `src/install/next-steps.ts` — extract + fix `buildNextSteps`.

`init`/`upgrade`/`verify` in cli.ts become thin callers of these modules → cli.ts shrinks.

## 1. Target end-state UX

### (a) Fresh consumer install
```
npx @witchynibbles/archon init            # or `archon init` after global add
```
Guided flow:
1. Copy managed/seed files (as today).
2. **Prompt (consent):** "Install the ECC plugin now? (writes ~/.claude, runs `claude plugin
   marketplace add affaan-m/ECC && claude plugin install ecc@ecc`) [y/N]". If yes and `claude`
   present → run it. If no or `claude` absent → record as a documented-manual step.
3. **Prompt (consent):** "Run `npm install`, DB migrate, and bootstrap-project now? [y/N]".
   If yes → run them. If no → emit as next-steps.
4. **Post-install capability check (always):** run the engine (L0–L2, + L3 when `claude`/DB
   present). Print the capability report inline: what's OK, what's degraded (+ approve-in-IDE
   note for MCP), what's blocked (+ exact remediation).
5. Next-steps text is derived from the *actual* report, and finally includes the DB essentials
   (`.env.archon`, `archon migrate`, `bootstrap-project`) that are omitted today (evidence B).

Automated: file copy, plugin install (consented), npm/migrate/bootstrap (consented), all probes.
Consented (user-global side effect): ECC marketplace/plugin. Documented-manual (not automatable):
the one-time MCP approval click in the IDE.

Non-interactive parity for agents/CI: `--yes` (accept all consents), `--install-plugin`,
`--run-db-setup`, `--no-plugin`, `--json` (machine report). Interactive prompts only when TTY
and no explicit flag.

### (b) Existing consumer upgrade/repair
```
archon upgrade            # idempotent; converges
```
Adds to today's managed/seed upgrade: (i) run the capability report and print the gap list with
remediation; (ii) heal the hexchange class (§5); (iii) offer the same consented ECC + DB steps
if the report shows them missing. `archon verify --json` gives the same report read-only for
scripts/CI without writing.

## 2. Capability verification architecture

- **Where checks live:** engine is shared; `verify` runs L0+L1 blocking, L2+L3 advisory (fast,
  no hard external dep). `doctor` runs L2+L3 blocking on an equipped machine (owns the runtime
  probes + DB). `init` post-check runs whatever the environment supports and reports honestly.
- **Exact probes:** `claude mcp list` / `claude mcp get archon` (Connected vs Pending);
  `claude plugin list` (ECC identity in accepted set); hook exec dry-run (spawn the hook with a
  no-op/`--dry-run` and assert exit 0 + executable bit); DB preflight (existing checkPgvector /
  checkMigrationsCurrent / tables+columns); adapter-stub detection (parse seeded
  `review-identity-adapter.ts` — matches shipped throwing stub → degraded "implement before
  trusting reviews").
- **Output:** machine-readable `{ok, blockers[], advisories[], nextActions[], reason}` (unchanged
  doctor contract) + a human table. Every entry carries capability + remediation.

## 3. ECC plugin management

- **Capability `ecc-plugin`.** Probes: marketplace registered? plugin installed? identity in
  accepted set?
- **Dual-identity acceptance:** accepted set = { `ecc@ecc` (canonical, v2.x), `everything-
  claude-code@*` (legacy, redirects upstream) }. Either counts as "present" for capability;
  legacy additionally raises a **migration advisory** ("legacy ECC identity; canonical is
  `ecc@ecc` — reinstall to migrate").
- **Consented automation:** `claude plugin marketplace add affaan-m/ECC` then
  `claude plugin install ecc@ecc` — scriptable & non-interactive once marketplace is registered
  (evidence A.3). Runs only under consent (prompt or `--install-plugin`). Idempotent.
- **Drift contract check:** `src/install/ecc-plugin.ts` holds the expected marketplace source +
  plugin-name set as package-owned truth; the L2 probe resolves actual via `claude plugin list`
  and compares → drift becomes a visible advisory, not a silent stale ref.

## 4. E2E install regression harness

- **CI layer (no claude IDE, no DB):** a test that runs real `init` into a temp repo (reuse the
  existing pack smoke path), then runs engine L0+L1 (+L2 probes that don't need `claude`) against
  it. Because L1 asserts "archon server present in `.mcp.json`", the #140 wrong-file class fails
  here structurally — through the product's own read model, not a bespoke bash assertion. This is
  the structural guarantee the brief demands.
- **Local live-check script:** `scripts/check-archon-install-live.sh` runs L3 (claude mcp list,
  plugin list, hook dry-run, DB) on an operator machine that has `claude` + DB. Documents what CI
  cannot cover. Mirrors the existing `check-archon-workflow-live.sh` convention.
- **Contract test on external output:** a small fixture-based parser test for `claude mcp list` /
  `plugin list` output shape so upstream format drift surfaces as a failing test, not a crash.

## 5. Consumer repair path (hexchange class)

Upgrade must additionally detect + heal (all idempotent, converge on re-run):
- **No `.mcp.json` / pre-P1 (no manifest):** backfill manifest (existing
  `loadInstallManifestOrBackfill`) + write `.mcp.json` (existing `mergeMcpJson`).
- **Stale `mcpServers` in settings.json** (old unscoped `node_modules/archon/src/...`,
  `@latest`/`--yes`): strip (existing `stripArchonFromMcpJson`) + migrate to `.mcp.json`.
- **Legacy ECC identity / absent ECC:** report + consented migrate (§3).
- **`migration-report.json` stuck "planned":** upgrade already writes runtime migration
  artifacts — advance/flag its status so it reflects reality.
- **Stale `everything-claude-code:*` skill refs in consumer-authored AGENT.md (20+ files):**
  these are NOT managed files → do NOT auto-rewrite in the first slices. Report as an advisory
  with guidance; a `--migrate-skill-refs` codemod is a **named later investment** (§6, S6), not a
  silent patch.
- **Idempotency:** probes are read-only; every repair action (plugin install, `.mcp.json` write,
  migrate, manifest backfill) is idempotent → repeated `upgrade` is safe and convergent.

## 6. Sequencing (independently shippable PRs)

- **S1 — LOAD-BEARING, FIRST. Capability engine + L0/L1 probes + `verify` upgrade + CI e2e
  harness.** Root-cause fix; needs no external deps. Catches #140 class structurally. Also folds
  the trivial next-steps DB text fix. Gate: reviewer+qa+security+release-readiness. Risk: LOW
  (internal, additive to verify — but note behavior change: repos that were falsely `ok` now
  report config gaps; keep L2/L3 advisory in verify so no consumer CI hard-breaks).
- **S2 — doctor gains L2/L3 Claude-surface + external probes + live-check script.** Reuses engine.
  Risk: MEDIUM (shells out to `claude`; defensive parse). Gate: full + release-readiness.
- **S3 — ECC plugin capability: drift contract + dual-identity + consented automation.**
  Risk: MEDIUM (writes user-global `~/.claude` under consent). Gate: full; security_reviewer owns
  the consent/side-effect review.
- **S4 — Guided init UX: interactive prompts + non-interactive flags + inline post-install
  capability check.** Risk: LOW-MEDIUM (TTY detection, agent/CI non-interactive parity). Gate: full.
- **S5 — Consumer repair hardening (hexchange class §5, minus codemod).** Risk: MEDIUM
  (mutating existing consumer state; idempotency + backups). Gate: full + release-readiness.
- **S6 — (named investment, may defer) `--migrate-skill-refs` codemod for consumer AGENT.md.**
  Risk: MEDIUM (rewrites consumer-authored files). Explicitly separable; not required for the
  done-bar but named so it isn't a silent gap.

Council should review at S1 plan (architecture-significant: new shared engine + severity policy +
user-global consent contract).

## Reversible vs expensive decisions

- **EXPENSIVE (get right in S1):** the probe-result + report *contract* (types), the four-layer
  model, and the severity-policy shape — everything downstream depends on them. Internal, so
  refactorable within the repo, but churn is costly once 4 surfaces consume it.
- **EXPENSIVE-ish:** the `~/.claude` consent contract (S3) — a shared-authority side effect;
  design the consent gate once, apply uniformly.
- **REVERSIBLE:** individual probe additions (additive), severity thresholds (data-driven),
  interactive prompts (flag-gated), the live-check script, the S6 codemod.

## 7. Non-goals, risks, rejected alternative

**Non-goals:** automating the MCP first-use approval click (impossible — A.2); auto-rewriting
consumer AGENT.md skill refs in the core slices (S6, deferred); managing `~/.claude` beyond
consented ECC marketplace/plugin; pinning the `claude` CLI version.

**Risks + mitigations:** (a) `claude` output-format drift → defensive parse, treat parse-fail as
`skipped` advisory, contract fixture test. (b) `~/.claude` writes → consent + idempotent + never
without prompt/flag; security_reviewer owns S3. (c) probes shelling out slow `verify` → verify
defaults to fast L0/L1, L2/L3 opt-in. (d) verify severity change breaking consumer CI → L2/L3
advisory in verify, blocking only in operator doctor. (e) temp-repo e2e provisioning → reuse
existing pack smoke.

**Rejected alternative (dissent seed):** *"No engine — just add more assertions to the existing
file-diff `verify` plus a standalone bash smoke script."* Rejected: it re-scatters truth across
three unsynced surfaces (verify file-side, doctor DB-side, script a third), can't express
degraded/advisory uniformly, and — decisively — an external bash script tests bash, not the
product's own read model. #140 survived precisely because tests asserted mechanics outside the
product read path. A shared engine makes the capability contract the single source of truth that
CI, verify, doctor, and the live-check all exercise; the bash-only shortcut re-creates the exact
gap that caused this initiative. Cost of the engine is moderate and internal; it is the durable
fit, not a shortcut dressed as minimalism.

**Second rejected option (ECC):** vendoring/bundling ECC into the package instead of automating
its install. Rejected: ECC is user-global by Claude Code's plugin design, upstream-owned
(affaan-m/ECC), and versioned independently; bundling fights the plugin model and freezes drift.

## Remaining uncertainty → evidence to retire it

- **U1:** exact `claude mcp list` / `plugin list` stdout format across versions. Retire in S2 by
  capturing real output on this machine into the parser fixture before writing the probe.
- **U2:** whether hook exec supports a true no-op dry-run or needs a sandbox arg. Retire in S2 by
  inspecting the shipped hook entrypoints before finalizing the L3 hook probe.
- **U3:** how many live consumers beyond hexchange are pre-P1 (upgrade blast radius). Retire in S5
  by a read-only sweep of the known consumer repos before enabling auto-heal writes.
