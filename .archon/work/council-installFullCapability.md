# Design & Architecture Council — installFullCapability

- Design under review: `.archon/work/design-installFullCapability.md`
- Panel: product_strategist, infra_engineer (dissent owner), security_reviewer
- Date: 2026-07-02
- **Outcome: APPROVED_WITH_CONDITIONS** (unanimous approve_with_conditions; no rework)

## Dissent record (owner: infra_engineer)

Steelmanned lean alternative: no shared engine — one targeted CI test (init → temp dir →
assert `.mcp.json` has archon+playwright), targeted doctor functions, live-check script,
next-steps fix. Cheaper for S1 in isolation. **Dissent partially overcome:** by S2–S4
(doctor, ECC consent flow, guided UX) the lean path reinvents a partial engine with three
independently drifting truth surfaces; the engine's early contract freeze is structurally
sound. Residual insight adopted as condition C13 (types contract freeze + named change
process).

## Binding conditions (all must be carried into task packets; none waived)

Product (PS):
- **C1 (LOAD-BEARING, resolve before S3 finalizes ECC identity):** verify whether
  `everything-claude-code:*` skill refs resolve against a plugin installed as `ecc` (and
  vice versa). Manager evidence already collected: skill namespace follows installed plugin
  identity (this machine, legacy plugin v1.8.0, exposes `everything-claude-code:*`; package
  agents post-#140 reference `ecc:*` ⇒ mismatch is REAL in both directions). Therefore:
  add L2 probe for skill-ref↔installed-plugin-namespace mismatch; S6 codemod (or equivalent
  managed-file handling) is elevated from deferrable to done-bar-relevant for consumers on
  either identity.
- **C2:** S4 (guided UX) + S5 (consumer repair) are done-bar-critical, not a deferrable tail;
  additionally surface the read-only capability report to broken consumers as early as
  possible (verify --json ships in S1).
- **C3:** consent defaults must not silently yield a partial install: default-No stays for
  the user-global ECC write; DB/project-local step gets a recommended-path framing; declined
  consent reported as "skipped by choice, re-run to complete," never failure.
- **C4:** in S1, audit the capability registry against the brief's full inventory (agents,
  skills, rules, hooks, MCP archon+playwright, ECC, DB+migrations, git guard, playwright,
  doctor, workflow scaffold) so "fullest capabilities" is falsifiable.

Security (SEC):
- **C5 (MEDIUM):** `--yes` scopes to consumer-repo writes only; `~/.claude` writes require
  separate explicit `--install-plugin`. Invariant recorded in S3/S4 packets.
- **C6 (MEDIUM):** record installed ECC version in consumer repo (manifest/lockfile); warn +
  require confirmation on major bump; show version at consent prompt.
- **C7:** all `claude` CLI invocations via spawn array form, `shell: false`; plugin/server
  names hardcoded package constants, never config/targetArg-derived.
- **C8:** `scrubPgCredentials()` applied to all probe `detail`/`remediation` fields; documented
  on the types.
- **C9:** adapter-stub probe remediation text states assurance boundary (stub-gone ≠
  implementation-correct).

Infra (INF):
- **C10:** before S2 ships, either make doctor/live-check part of install completion evidence
  or record "L2/L3 caught only by manual doctor" as a named accepted gap with mitigation
  (live-check in release-readiness evidence).
- **C11:** S1 declares e2e harness placement: unit-tests job (programmatic engine) vs
  pack-install job (`node $BIN verify --json`) vs both. Planner must choose explicitly.
  Note: ci.yml pack-install already runs init into temp dir — scaffolding exists.
- **C12:** S5 destructive operations (strip-stale-settings, mcpServers removal) must route
  through the existing timestamped backup mechanism or add one; no S5 merge without evidence.
- **C13:** S3 risk reclassified MEDIUM → **HIGH** (user-global cross-project blast radius);
  never bundled with a lower-risk slice; security_reviewer owns its gate.
- **C14:** `src/install/capability/types.ts` frozen after S1 ships; post-S2 changes require a
  named migration, not a refactor; constraint recorded in S1 PR description.

## Council notes
- The engine-over-bash rejection was independently endorsed by product + infra seats.
- No conditions waived; each maps to a slice acceptance criterion in planning.
