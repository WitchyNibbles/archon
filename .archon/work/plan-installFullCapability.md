# Plan — installFullCapability

- task_id: `installFullCapability` (matches `.archon/ACTIVE`, brief, design, council)
- Inputs: brief + design + council (APPROVED_WITH_CONDITIONS, 14 binding) + evidence.
- Reasoning mode: `strict`. Runtime authority = completion; markdown = evidence.
- Blocked assumptions: NONE. Approved assumptions: brief §Operating assumptions 1–4.
- Gates per slice via review-orchestrator (DB records): reviewer + qa_engineer +
  security_reviewer; release-readiness where noted; workflow-proof for each task.
- Manager owns `.archon/ACTIVE`, task-queue.json, product-state.md — OUT of every slice scope.

## Open decisions — RESOLVED (make the call)

- **D-C11 (harness placement) = BOTH.** Primary structural guarantee = a programmatic
  engine unit test in `tests/` (fast, deterministic, stubs externals) that runs the
  registry L0/L1 against a freshly-`init`'d temp dir and asserts `.mcp.json` carries
  `mcpServers.archon` + `playwright` (fails the #140 wrong-file class). ALSO extend the
  existing CI `pack-install` job with `node "$BIN" verify --json` against its temp dir.
  Rationale (1 line): a unit test can pass while dist packaging drops a module — the #140
  lesson is that mechanics-only tests miss the shipped read path, so the pack-install leg
  proves the COMPILED bin exercises the same engine end-to-end.
- **D-S6 (merge into S3?) = STAY SEPARATE.** C13 forbids bundling the HIGH-risk
  `~/.claude` slice with anything lower; the skill-ref codemod writes consumer-authored
  files (different trust boundary + MEDIUM risk). S3 owns the read-only skill-ref *probe*
  (detection needs the identity contract); S6 owns the *codemod* (write). One gate each.
- **D-C2 (verify --json in S1) = CONFIRMED ABSENT today; S1 ADDS it.** Grounded: cli.ts
  parseCliArgs `verify` branch rejects behavior flags, no `--json`; `doctor` already emits
  JSON. S1 adds `verify --json` emitting the engine `{ok, blockers, advisories,
  nextActions, reason}` shape; default text output unchanged (additive).

## Council conditions (verbatim, keyed by id — slices reference by id)

- **C1:** verify whether `everything-claude-code:*` skill refs resolve against a plugin
  installed as `ecc` (and vice versa) — mismatch is REAL in both directions; add L2 probe
  for skill-ref↔installed-plugin-namespace mismatch; S6 codemod is elevated from
  deferrable to done-bar-relevant for consumers on either identity.
- **C2:** S4 (guided UX) + S5 (consumer repair) are done-bar-critical, not a deferrable
  tail; surface the read-only capability report to broken consumers ASAP (verify --json
  ships in S1).
- **C3:** consent defaults must not silently yield a partial install: default-No stays for
  the user-global ECC write; DB/project-local step gets recommended-path framing; declined
  consent reported as "skipped by choice, re-run to complete," never failure.
- **C4:** in S1, audit the capability registry against the brief's full inventory (agents,
  skills, rules, hooks, MCP archon+playwright, ECC, DB+migrations, git guard, playwright,
  doctor, workflow scaffold) so "fullest capabilities" is falsifiable.
- **C5:** `--yes` scopes to consumer-repo writes only; `~/.claude` writes require separate
  explicit `--install-plugin`. Invariant recorded in S3/S4 packets.
- **C6:** record installed ECC version in consumer repo (manifest/lockfile); warn +
  require confirmation on major bump; show version at consent prompt.
- **C7:** all `claude` CLI invocations via spawn array form, `shell: false`; plugin/server
  names hardcoded package constants, never config/targetArg-derived.
- **C8:** `scrubPgCredentials()` applied to all probe `detail`/`remediation` fields;
  documented on the types.
- **C9:** adapter-stub probe remediation text states assurance boundary (stub-gone ≠
  implementation-correct).
- **C10:** before S2 ships, either make doctor/live-check part of install completion
  evidence or record "L2/L3 caught only by manual doctor" as a named accepted gap with
  mitigation (live-check in release-readiness evidence).
- **C11:** S1 declares e2e harness placement (unit-tests vs pack-install vs both) — see
  D-C11.
- **C12:** S5 destructive operations (strip-stale-settings, mcpServers removal) must route
  through the existing timestamped backup mechanism or add one; no S5 merge without evidence.
- **C13:** S3 risk = HIGH (user-global cross-project blast radius); never bundled with a
  lower-risk slice; security_reviewer owns its gate.
- **C14:** `src/install/capability/types.ts` frozen after S1 ships; post-S2 changes require
  a named migration, not a refactor; constraint recorded in S1 PR description.

Coverage map (all 14, none dropped): S1={C4,C8,C11,C14,C2} · S2={C9,C10} ·
S3={C1,C5,C6,C7,C13} · S4={C3,C5} · S5={C12} · S6={C1}.

---

## S1 — Capability engine + L0/L1 probes + verify upgrade + CI e2e harness  [SIZE: L]

- branch: `feature/install-capability-engine`
- goal: land the shared capability engine (frozen contract) + L0/L1 probes + `verify`
  as thin caller + `verify --json` + CI structural harness; fold next-steps DB fix.
- risk: LOW-MEDIUM (behavior change: falsely-`ok` repos now report config gaps — keep
  L2/L3 advisory in verify so no consumer CI hard-breaks).
- gates: reviewer + qa + security + **release-readiness** + workflow-proof.
- write scope (NEW): `src/install/capability/{types,registry,probes-file,probes-config,
  report}.ts`, `src/install/next-steps.ts`. EDIT: `src/install/cli.ts`
  (verify→thin caller of engine ~L1510-1562; add `--json` in parseCliArgs verify branch
  ~L1124; move `buildNextSteps` L173-242 → next-steps.ts + add `.env.archon`/`archon
  migrate`/`bootstrap-project` lines, evidence B). EDIT: `tests/install.test.ts` + NEW
  `tests/install/capability-engine.test.ts`, `tests/install/verify-json.test.ts`. EDIT:
  `.github/workflows/ci.yml` (pack-install leg) + NEW `scripts/ci/assert-verify-json.mjs`.
- out of scope: any L2/L3 probe body, ECC, doctor, prompts, consumer repair, `.claude/`,
  `CLAUDE.md`.
- acceptance criteria:
  - engine = pure functions; each probe takes injected effects (fs read) mirroring
    db-preflight.ts `DbQueryFn`; probe result = `{capability, layer, status∈
    ok|degraded|blocked|skipped, code, detail, remediation}`; report assembler emits
    `{ok, blockers[], advisories[], nextActions[], reason}` byte-compatible with doctor.
  - L0 reuses existing managed-file diff; L1 asserts `.mcp.json` parses + has
    `mcpServers.archon` + `mcpServers.playwright`, project `settings.json` hook keys,
    `package.json` `archon:*` scripts, `.env.archon` resolvable DB URL.
  - L0/L1 blocking in verify; L2/L3 advisory placeholder in verify (never crash/hard-fail).
  - `archon verify --json` prints the report; default text path unchanged.
  - **C4:** registry enumerates every brief-inventory capability (agents, skills, rules,
    hooks, MCP archon+playwright, ECC, DB+migrations, git guard, playwright, doctor,
    workflow scaffold); a test asserts registry ⊇ inventory (falsifiable "fullest").
  - **C8:** `scrubPgCredentials()` applied to every probe `detail`/`remediation`; the
    obligation is documented as a doc-comment on the `types.ts` result type.
  - **C11:** harness placed per D-C11 (BOTH); PR description names the choice.
  - **C14:** `types.ts` marked FROZEN in a header comment + PR description; downstream
    changes require a named migration, not a refactor.
  - **C2:** `verify --json` ships here (read-only report for broken consumers).
  - each touched/new file <800 lines; cli.ts net LOWER than 2475.
- test plan: capability-engine.test.ts (probe purity, severity assembly, skipped-never-
  crash, C4 inventory ⊇, C8 scrub); verify-json.test.ts (init→temp dir→L0/L1, #140
  wrong-file case fails); ci.yml pack-install adds `node "$BIN" verify --json` +
  assert-verify-json.mjs on the SHIPPED bin.
- rollback: revert PR; verify text path and doctor untouched → no consumer regression.

## S2 — doctor L2/L3 + external probes + live-check script  [SIZE: M]

- branch: `feature/install-doctor-capability-probes`
- goal: doctor consumes the engine for L2/L3 (claude present, node_modules, playwright,
  adapter-stub, mcp/hook runtime) + ship the operator live-check script.
- risk: MEDIUM (shells to `claude`; defensive parse; treat parse-fail/tool-absent as
  `skipped`).
- gates: reviewer + qa + security + **release-readiness** + workflow-proof.
- write scope (NEW): `src/install/capability/probes-external.ts` (L2: claude-present,
  node_modules, playwright-browsers, adapter-stub; STUB `ecc-present` probe filled in S3),
  `src/admin/capability-probes-runtime.ts` (L3: `claude mcp list/get`, hook exec dry-run;
  reuse db-preflight.ts for DB probe), `scripts/check-archon-install-live.sh`,
  `tests/install/probes-external.test.ts`, `tests/install/mcp-output-fixture.test.ts` +
  captured fixture. EDIT: `src/runtime.ts` `doctorCommand` (~L1744) → thin adapter over the
  report assembler; JSON contract unchanged.
- out of scope: ECC identity/drift/consent (S3), cli.ts init/upgrade, prompts, repair.
- acceptance criteria:
  - all `claude` calls via injected spawn; tool-absent ⇒ `skipped` (never crash);
    parse-fail ⇒ `skipped` advisory + fixture test guards output-shape drift (retires U1).
  - hook exec dry-run confirmed against shipped hook entrypoints before finalizing
    (retires U2); asserts exit 0 + executable bit.
  - doctor unchanged JSON shape; L2/L3 blocking in doctor on equipped machine, advisory in
    verify/CI.
  - **C9:** adapter-stub probe remediation states assurance boundary (stub-gone ≠
    implementation-correct).
  - **C10:** live-check (L3) named as install completion evidence in release-readiness;
    the "L2/L3 only via manual doctor" residue recorded as a named, mitigated gap.
- test plan: probes-external.test.ts (stubbed spawn: present/absent/degraded/skipped);
  mcp-output-fixture.test.ts (real captured `claude mcp list`/`plugin list` stdout →
  parser). Live-check runs only on operator machine, documented.
- rollback: revert PR; doctor reverts to DB-only; verify (S1) unaffected.

## S3 — ECC plugin capability: drift contract + dual-identity + consented automation  [SIZE: M-L]  RISK: HIGH (C13)

- branch: `feature/install-ecc-plugin-capability`
- goal: package-owned ECC identity set + drift check + dual-identity acceptance +
  consented `~/.claude` install + version record + read-only skill-ref mismatch probe.
- risk: **HIGH** (C13 — user-global cross-project blast radius). NEVER bundled.
- gates: reviewer + qa + **security_reviewer OWNS the gate** + release-readiness +
  workflow-proof.
- write scope (NEW): `src/install/ecc-plugin.ts` (expected marketplace source +
  plugin-name accepted set `{ecc@ecc, everything-claude-code@*}`, drift contract,
  consented install, version record), `tests/install/ecc-plugin.test.ts`. EDIT (sequential
  after S2, single writer): `src/install/capability/probes-external.ts` (fill `ecc-present`
  drift/dual-identity probe + NEW read-only `skill-ref-namespace` probe comparing installed
  identity to consumer AGENT.md refs). EDIT `src/admin/capability-probes-runtime.ts` if
  runtime ECC state probe needed. Manifest/lockfile version field lives in
  `.archon/install-manifest.json` write path (cli.ts region owned here for the version
  record only).
- out of scope: guided prompts (S4), the codemod write (S6), consumer settings repair (S5).
- acceptance criteria:
  - dual-identity: either accepted identity ⇒ "present"; legacy raises migration advisory.
  - drift check: package-owned expected set vs actual `claude plugin list` → visible
    advisory, not silent stale ref.
  - **C1:** L2 skill-ref↔installed-plugin-namespace mismatch probe present (read-only,
    reports both directions); does NOT rewrite files here.
  - **C5:** `~/.claude` install runs ONLY under `--install-plugin` (or interactive
    consent); NOT under `--yes`; invariant asserted by a test.
  - **C6:** installed ECC version recorded in consumer manifest; major bump warns +
    requires confirmation; version shown at consent prompt.
  - **C7:** every `claude` invocation = spawn array form, `shell: false`; plugin/server
    names = hardcoded package constants, never targetArg/config-derived (test asserts).
  - **C13:** slice shipped alone; security_reviewer gate recorded; idempotent (repeat safe).
- test plan: ecc-plugin.test.ts (dual-identity accept, drift advisory, C5 --yes-excludes-
  global, C6 version+major-bump gate, C7 spawn-array/hardcoded-name, idempotency); skill-ref
  probe test (mismatch both directions, read-only).
- rollback: revert PR; no `~/.claude` writes occur without consent; probes-external ecc
  probe reverts to S2 stub.

## S4 — Guided init UX: prompts + non-interactive flags + inline post-install check  [SIZE: M]

- branch: `feature/install-guided-init`
- goal: real guided flow — consent prompts (ECC, DB/bootstrap), non-interactive parity
  flags, inline capability report after install.
- risk: LOW-MEDIUM (TTY detection; agent/CI non-interactive parity).
- gates: reviewer + qa + security + workflow-proof.
- write scope (NEW): `src/install/guided-init.ts` (prompt orchestration + flag resolution),
  `tests/install/guided-init.test.ts`. EDIT: `src/install/cli.ts` (init/upgrade → callers;
  parseCliArgs adds `--yes`, `--install-plugin`, `--run-db-setup`, `--no-plugin`, `--json`;
  post-install runs engine + prints report). Reuses S1 engine, S2 probes, S3 ecc consent.
- out of scope: `~/.claude` install mechanics (S3-owned), consumer repair (S5), codemod (S6).
- acceptance criteria:
  - interactive prompts ONLY when TTY and no explicit flag; full non-interactive parity.
  - post-install runs L0–L2 (+L3 when claude/DB present) and prints OK/degraded(+MCP
    approve note)/blocked(+exact remediation); next-steps derived from ACTUAL report.
  - **C3:** default-No for user-global ECC; DB/project step framed recommended-path;
    declined consent → "skipped by choice, re-run to complete," never failure/nonzero.
  - **C5:** `--yes` accepts consumer-repo consents only; ECC `~/.claude` still requires
    `--install-plugin` even under `--yes` (test asserts).
  - cli.ts stays <800 via extraction to guided-init.ts + next-steps.ts.
- test plan: guided-init.test.ts (TTY vs non-TTY, each flag, C3 decline-not-failure, C5
  --yes-scope, report-driven next-steps).
- rollback: revert PR; init reverts to non-interactive file-copy (S1 behavior preserved).

## S5 — Consumer repair hardening (hexchange class §5, minus codemod)  [SIZE: M]

- branch: `fix/install-consumer-repair`
- goal: `upgrade` detects + heals the pre-P1/stale class idempotently with backups.
- risk: MEDIUM (mutates existing consumer state).
- gates: reviewer + qa + security + **release-readiness** + workflow-proof.
- write scope: EDIT `src/install/cli.ts` upgrade path — backfill manifest
  (`loadInstallManifestOrBackfill`), write `.mcp.json` (`mergeMcpJson`), strip stale
  `mcpServers` from settings.json (`stripArchonFromMcpJson`), advance stuck
  `.archon/runtime/migration-report.json` status, report+consent for ECC via S3. NEW
  `tests/install/consumer-repair.test.ts`. Add/route timestamped backup if missing.
- out of scope: AGENT.md skill-ref rewrite (S6); new `~/.claude` mechanics (S3).
- acceptance criteria:
  - read-only sweep of known consumer repos before enabling auto-heal writes (retires U3);
    blast radius documented in PR.
  - every repair idempotent — repeated `upgrade` converges, no double-write.
  - stale skill refs REPORTED as advisory with guidance (not rewritten here — S6).
  - **C12:** every destructive op (strip-stale-settings, mcpServers removal) routes through
    the existing timestamped backup mechanism (or one is added); PR carries backup evidence;
    NO merge without it.
- test plan: consumer-repair.test.ts (pre-P1 no-manifest backfill, stale-6-entries strip,
  migration-report advance, idempotency re-run, C12 backup created before mutate).
- rollback: revert PR; upgrade reverts to managed/seed-only; backups guarantee recoverable
  consumer state.

## S6 — `--migrate-skill-refs` codemod for consumer AGENT.md  [SIZE: S-M]

- branch: `feature/install-skill-ref-codemod`
- goal: consented codemod rewriting stale `everything-claude-code:*`↔`ecc:*` skill refs to
  match installed identity (elevated to done-bar-relevant by C1).
- risk: MEDIUM (rewrites consumer-authored files).
- gates: reviewer + qa + security + workflow-proof.
- write scope: NEW `src/install/skill-ref-codemod.ts`, `tests/install/skill-ref-codemod.
  test.ts`. EDIT `src/install/cli.ts` parseCliArgs (add `--migrate-skill-refs`).
- out of scope: the read-only detection probe (S3-owned).
- acceptance criteria:
  - **C1:** codemod migrates refs in BOTH directions to the installed-plugin namespace;
    runs only under explicit `--migrate-skill-refs` (consumer-authored files, never silent);
    idempotent; timestamped backup before rewrite; dry-run preview default.
  - rewrites ONLY skill-ref tokens (no other AGENT.md content); count reported.
- test plan: skill-ref-codemod.test.ts (both-direction rewrite, idempotency, backup-before-
  write, dry-run preview, non-skill content untouched).
- rollback: revert PR; detection advisory (S3) still informs operators; backups recover.

---

## Dependency edges & parallelism

- Chain: **S1 → S2 → S3 → S4 → S5**; **S6 after S3** (needs identity set).
- S1 is the hard gate: types-freeze (C14) blocks all downstream; ship + freeze first.
- Genuine worktree-parallelism is LIMITED: S1/S4/S5/S6 all edit `src/install/cli.ts` and
  downstream depends on the frozen contract, so slices are inherently sequential PRs.
  Only S2 (touches `runtime.ts` + new `admin/` + `probes-external.ts`, NOT cli.ts) could
  overlap a cli.ts-only slice — but S3 edits probes-external.ts after S2, so keep S2→S3
  ordered. Recommend SEQUENTIAL execution; do not force parallel worktrees against the
  shared cli.ts write scope.
- One-writer-per-scope: `probes-external.ts` written by S2 then S3 sequentially (never
  concurrent); `cli.ts` by S1→S4→S5→S6 sequentially.

## Anti-patterns to avoid (all slices)

- Bash-script-tests-bash instead of the product read model (rejected alternative — re-
  creates the #140 gap). Assertions must flow through the engine.
- Probes carrying severity — severity is decided at report assembly only.
- Silent `~/.claude` writes; unscrubbed credentials in probe output; config-derived
  plugin/server names; swallowed spawn errors.
- Fuzzy "done" — every finding resolved or carries a recorded, defensible reason.

## Rollback (initiative-level)

Each slice is an independent revertible PR off updated `origin/master`; reverting any slice
leaves prior slices functional. S1 keeps verify/doctor backward-compatible so no consumer CI
hard-breaks mid-rollout. Consumer-mutating slices (S5, S6) mandate timestamped backups so
every write is recoverable.
