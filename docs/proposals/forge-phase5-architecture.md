# Frontend Forge — Phase 5 Architecture Proposal

**Status:** DRAFT — INPUT to Design and Architecture Council pre-implementation gate
**Phase:** 5 (final roadmap phase) — cross-repo capability, secret-manager subsystem, opt-in API image provider
**Author role:** `solution_architect`
**Task:** `forgePhase5Council` (run `8f2ed5fa-5b09-40be-a39f-f78b7582b452`)
**Parent decision:** Forge initiative council `APPROVED_WITH_CONDITIONS` (12 conditions); Phase-1 council `approved_with_conditions` (C1–C10). This packet carries forward U1 (the deferred "API provider + secrets model"), now activated by the user choosing **full secret-manager integration**.
**Reasoning mode:** strict

---

## 0. Overview + problem statement

Phases 0–4 shipped a working, archon-native frontend-generation capability: a 15-stage gated pipeline (`src/forge/forge-pipeline.ts`) materialized as ordinary tasks on the core graph; three stage skills; a three-provider asset layer (`codex_builtin_imagegen`, `manual_upload`, `placeholder_svg`) with a hard D2 security contract (argv array, no shell, timeout + process-group kill, source-path bounding, CI→placeholder gate); and an isolated `web/` dashboard behind the R2-C package boundary (root has exactly 3 runtime deps: `@modelcontextprotocol/sdk`, `pg`, `zod`; `src/**` must never import `web/**`).

Phase 5 closes the roadmap with three pillars. Each is gated independently; they are sequenced so the highest-risk piece (secrets) lands and is hard-gated **before** the thing that consumes it (the API provider).

- **Pillar A — Cross-repo capability.** Today `src/forge/**` and the three `archon-forge-*` skills are **NOT** in `package.json` `files[]` and **NOT** in the installer manifest (`src/install/cli.ts buildManifest`). The forge therefore does not ship; it only runs in this repo. Pillar A makes a consuming repo able to install the archon package and run the forge pipeline/skills against **its own** `outputDir`, **its own** design tokens, and **its own** gates — without breaching R2-C.
- **Pillar B — Secret-manager subsystem.** archon stores no secrets today; it reads plain env vars from `.env.archon` into `process.env`. The user chose **full secret-manager integration**. Pillar B adds a pluggable secret-manager interface + at least one backend, with read/write/rotate, a storage location that is NOT the DB workflow tables, NOT durable memory, and NOT prompts/manifests (roadmap §31.1), plus a trust/threat model. **This is the dominant-risk pillar.**
- **Pillar C — Opt-in API image provider** (`openai_api_later_optional`, gpt-image, `requires_api_key: true`, `enabled_by_default: false`). A new `AssetProvider` impl that reads its key **via the secret-manager**, disabled by default, with the same bounded/timeout/no-shell discipline as the codex provider, and CI/no-secret → placeholder fallback.

### Additive-safety pre-check (load-bearing for Pillar C)

`assetProviderValues` (asset-contract.ts) is a `const` tuple consumed as a Zod `.enum(...)` inside `.strict()` schemas, and `selectAssetProvider` branches with `if` chains, **not** an exhaustive `switch`/`never`. Therefore **adding `"openai_api_later_optional"` to the tuple is additive-safe**: existing manifests/requests with old values still validate; no compile-time exhaustiveness check breaks; the only required code change is a new `if` branch in `selectAssetProvider` plus the new provider class. Verdict: **additive, safe.** (One nuance, see C-DEC-3: the new value must default to disabled regardless of schema membership.)

### Source-of-truth map (the spine every Phase-5 decision must respect)

| Layer | Authority | Phase-5 rule |
| --- | --- | --- |
| Postgres (`project_runtime_state`, `workflow_documents`, review/approval records) | canonical, runtime-authoritative | single core writer; forge stages write the SAME path as every task. **Secrets NEVER stored here.** |
| Secret store (Pillar B backend) | canonical **for secret material only** | a separate, non-DB, non-memory store; read at point-of-use, never logged, never persisted into DB/manifest/prompt |
| `src/forge` Zod contracts + manifests | canonical (derived from repo markdown skills) | one direction only: into `web`. **Manifests carry no secret material — only provider name + path + hash.** |
| `.env.archon` / `process.env` | bootstrap config | may hold a *pointer/handle* to the secret store (backend selector, store path) but is downgraded as a place to hold the actual API key once the secret-manager is authoritative |
| graphify / retrieval | advisory | discovery only; re-anchor before handoff |

**Load-bearing invariant:** Phase 5 adds **no new authority over runtime state** and **no new place that durably holds a secret except the dedicated secret store**. The secret store is a new canonical layer, but only for secret material, and it is deliberately *outside* every existing authority (DB, memory, manifests, prompts).

---

## Decision A — Cross-repo capability (export + invocation + scoping)

### State of the world (evidence-anchored)
- `package.json` `files[]` lists individual skills and agents by name; **no `src/forge/**` entry and no `archon-forge-*` skill entry.** The forge ships to nobody today.
- `src/install/cli.ts buildManifest` copies `.archon/{playwright,rules,templates}`, `.githooks`, named hooks, agents, and **repo-local skills via `repoLocalSkillIdPrefixes`**. Whether `archon-forge-*` is in that prefix set determines whether the skills install — must be verified (A-INVEST below).
- The forge already loads `.env.archon` from `process.cwd()` first, so a consuming repo's config wins over the bundled fallback. The forge path guard `resolveWithinRepo` defaults to `process.cwd()`. **The consuming-repo machinery for outputDir/config already exists at the primitive level.**

### Option A — Library export + skill-install, invoked through the existing admin/skill surface (RECOMMENDED)
Add `src/forge/` to `files[]`, and ship the three stage skills by ensuring `archon-forge-*` is in `repoLocalSkillIdPrefixes`. A consuming repo then `npm install archon` → gets `src/forge/**` + the `archon-forge-*` skills, and runs the forge through the existing `forge` admin sub-verb + stage skills against its own repo. `ForgeBuildRequest.outputDir` is already validated repo-relative; `resolveWithinRepo` already bounds it to `process.cwd()`.
- **Trust boundary:** none new for runtime. The forge runs as ordinary gated tasks in the consuming repo's own run.
- **R2-C:** preserved trivially — `src/forge/**` already obeys the import wall; shipping it does NOT ship `web/`.
- **Reversible:** YES (cheap) — `files[]` + skill-prefix config.

### Option B — Publish a separate `@archon/forge` package
Standalone npm package. **Risk (HIGH for now):** second published artifact, versioning/skew surface (forge imports `src/domain/types.ts`), premature given "compose-on-core, no parallel module." **Reversible:** NO.

### Option C — Git-submodule / vendored copy
Drift; defeats "install the archon package." Rejected.

### Recommendation: Option A — smallest change matching how every other capability ships; preserves R2-C by construction.

### Cross-repo scoping model
- **outputDir:** consuming repo passes its own validated, cwd-bound `outputDir`. No change.
- **Design tokens / constraints:** the consuming repo owns its own constraints manifest / design-system contract; skills reference it by path (mirrors Phase-1 C9 "reference, never copy"). Missing → shipped default manifest, but the fallback is **visible in gate output**, never silent.
- **Gates:** the consuming repo's own reviewer/qa/security gates run (15 stages are ordinary tasks). No second gate path.

### Risks
- **A-INVEST (dominant, blocker):** unverified whether `archon-forge-*` is in `repoLocalSkillIdPrefixes` and whether `src/forge`'s transitive imports (`src/domain/types.ts`) are all within `files[]`. A missing import = broken consuming-repo install. Evidence required before A-SLICE-1.
- **Default-constraints-manifest leak:** silent inheritance → archon-flavored UIs. Mitigation: explicit `using-default-constraints-manifest` flag.
- **`web/` accidentally shipped:** keep `web/**` out of `files[]`; add `npm pack --dry-run` test asserting `web/` absent.

---

## Decision B — Secret-manager subsystem (dominant-risk pillar; own hard security gate)

### B.1 — Interface (the stable seam)
A minimal pluggable interface in a new module `src/secrets/secret-manager.ts`, modeled on the repository/provider pattern:

```
interface SecretManager {
  get(ref: SecretRef): Promise<SecretValue | undefined>;   // read at point-of-use
  set(ref: SecretRef, value: SecretValue): Promise<void>;  // operator action
  rotate(ref: SecretRef, next: SecretValue): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
  list(): Promise<SecretRef[]>;   // refs only — NEVER values
}
```
- `SecretRef` = a typed, regex-allowlisted name (e.g. `forge.openai_api_key`), never free-form. `SecretValue` = a branded type whose `toString`/`toJSON` return `"[REDACTED]"` so it cannot be accidentally logged or serialized (defense-in-depth vs §31.1).
- **Read-at-point-of-use:** the API provider calls `secretManager.get(...)` inside `generate()` and discards the value when the request completes. The secret never enters `ProviderDeps`, the manifest, or the prompt.

### B.2 — Backend choice (a genuine USER decision; recommendation given)

| Option | Storage | Pros | Cons / threat |
| --- | --- | --- | --- |
| **B-A: Encrypted file** (sealed file under runtime data root) | local FS, outside repo + DB | no external dep (built-in `crypto`); cross-platform; matches `dataRoot` convention; rotatable | needs a master key; stolen file + stolen key = compromise; homegrown-crypto risk |
| **B-B: OS keychain** (Keychain / libsecret / Cred Manager) | OS secure store | best at-rest; OS handles crypto + access control | 3 platform impls; awkward in headless CI/WSL2 (forge's primary env); harder rotation |
| **B-C: External manager** (Vault / cloud) | remote service | enterprise rotation/audit | heavy; network dep (pressures 3-dep posture); overkill single-operator; new attack surface |

**Recommendation: B-A (encrypted file) as default, interface designed so B-B/B-C can be added later without touching callers.** Rationale: zero new runtime deps with node built-in `crypto` (preserves 3-dep posture/R2-C), lives outside repo + DB (satisfies §31.1), works in headless WSL2/CI where keychains are awkward, master key from env (`ARCHON_SECRETS_MASTER_KEY`) or later keychain-derived. **Flag for user (U1):** genuinely your security/convenience call. **If B-A is chosen, the dissent's homegrown-crypto concern is binding → mandate AEAD (e.g. XChaCha20-Poly1305/AES-GCM) + a vetted KDF (scrypt/argon2 via built-ins where available) + an extra crypto review.**

### B.3 — Storage location invariants (non-negotiable)
- NOT in any DB table / `workflow_documents` (survives backups, replicas, dashboard projections).
- NOT in `.archon/memory/` (reviewed/shared; "never store secrets").
- NOT in any manifest, prompt, asset request, or `web/` projection (§31.1).
- NOT committed: encrypted file under runtime `dataRoot` (outside repo); gitignore belt-and-suspenders.
- `.env.archon` may hold the **backend selector** + master-key ref, but the **actual API key is NOT a plain `.env.archon` var** once the secret-manager is authoritative (C-DEC-3).

### B.4 — Threat model
| Threat | Mitigation |
| --- | --- |
| Secret logged | redacting brand; security gate greps logs/test output for a fixture secret, fails on any leak |
| Secret persisted to DB | no DB writer in secret module; review asserts no `pg`/store import |
| Secret in manifest/prompt | read-at-point-of-use; `.strict()` schema rejects a stray `apiKey`; gate asserts manifest = name/path/hash only |
| Secret on disk in clear | encrypted file; mode `0600`; outside repo |
| Master-key compromise | rotation (B.5); key never in repo; from env or keychain |
| Prompt-injection exfiltration | secret never enters prompt context; request body built in code, not agent free-text |
| Stolen encrypted file | useless without master key; rotation invalidates |

### B.5 — Rotation + audit
- **Rotation:** `rotate(ref, next)` atomic (temp + rename) + `onRotate` hook; no long-lived in-memory cache beyond one request → effective on next `get`.
- **Audit:** every `set`/`rotate`/`delete` writes a **metadata-only** record (ref, action, ts, actor — never the value) to an append-only audit log under `dataRoot` (not DB, not memory).

### Reversible vs expensive
Interface = cheap/reversible. **Backend file format = expensive** → version the header (`version: 1`) from day one; a format change is a migration.

---

## Decision C — Opt-in API image provider wiring

### C.1 — Schema + selection (additive)
Add `"openai_api_later_optional"` to `assetProviderValues` (additive-safe). Add `OpenAiApiImagegenProvider implements AssetProvider` mirroring the codex provider: request built **in code** (no shell, no agent free-text); configurable timeout via `AbortController`; output path guarded by `resolveWithinRepo` before I/O; validate returned image (size > 0, extension allowlist); structured result, never uncaught throw. Extend `selectAssetProvider` with a new `if` branch.

### C.2 — Key sourcing (DECISION: Option B, via secret-manager)
The provider calls `secretManager.get("forge.openai_api_key")` inside `generate()`. The key is never in `ProviderDeps`, the manifest, or `.env.archon` live-read. No key ref → provider unavailable → placeholder. (Env var downgraded to at most a `set --from-env` migration import path, never the live read.)

### C.3 — Disabled-by-default + CI/no-secret → placeholder (two layers)
1. **Selection gate:** even when `request.provider === "openai_api_later_optional"`: `CI === "true"` → placeholder; `ARCHON_FORGE_API_PROVIDER_ENABLED !== "true"` → placeholder; `secretManager.get(...)` undefined → placeholder; only CI-false AND opt-in AND key present → API provider.
2. **Cost/usage controls (§31.2):** `max_assets_per_run`, regenerate-at-most-once, approval-before-generation; plus a per-run spend cap, **deny by default**.

### C.4 — Same bounded/no-shell discipline
No subprocess (pure HTTP via built-in `fetch` — zero new deps); timeout → `AbortController`; output-path bounding; no secret in logs/headers; CI gate per C.3.

### Risks
- New network egress (small attack surface) — opt-in, key-gated, CI-disabled, spend-capped, request body code-built (no injection→tamper path).
- Dependency pressure → use node built-in `fetch`; do NOT pull an SDK.

---

## Binding CONDITIONS the council should attach

**Secret-manager (own hard gate):**
- **SC-1 (non-waivable, `security_reviewer`):** Pillar B requires a dedicated `security_reviewer` hard gate as its slice done-bar.
- **SC-2:** a secret value is never logged/printed/serialized — redacting brand + a fixture-secret leak grep test over all stdout/stderr/written-files.
- **SC-3:** no secret in any DB table, `workflow_documents`, `.archon/memory/`, manifest, asset request, prompt, or `web/` projection — review assertion (no `pg`/store/manifest-writer import) + `.strict()` stray-field rejection test.
- **SC-4:** encrypted-file backend mode `0600`, under `dataRoot` (outside repo), versioned header, atomic write; rotation invalidates prior + fires `onRotate`. **If B-A: AEAD + vetted KDF + extra crypto review.**
- **SC-5:** `set`/`rotate`/`delete` produce metadata-only audit records (never the value).

**API provider:**
- **C-DEC-1 (non-waivable):** `enabled_by_default: false`; CI → placeholder always; missing key → placeholder. Test proves both.
- **C-DEC-2:** key read only via secret-manager at point-of-use; never in deps/`.env.archon` live-read/manifest/prompt. Test proves provider never gets the key via deps.
- **C-DEC-3:** adding the enum value changes no existing default; existing manifests/requests still validate (round-trip test); new value defaults to disabled at selection.

**Cross-repo:**
- **X-1:** shipping `src/forge/**` must not breach R2-C — `web/**` stays out of `files[]`; `npm pack --dry-run` test asserts `web/` absent + `src/forge/` present; transitive-import audit confirms every `src/forge` import resolves within the shipped tree.
- **X-2:** consuming repo using the shipped default constraints manifest emits an explicit `using-default-constraints-manifest` flag — never silent.

---

## Residual RISKS + dominant risk per pillar

| Pillar | Dominant risk | Residual after mitigation |
| --- | --- | --- |
| A (cross-repo) | consuming-repo install breaks at import time (missing `files[]`/skill-prefix) | low once transitive-import audit + `npm pack` test land; blocker before A-SLICE-1 |
| B (secrets) | a secret leaks (log/DB/manifest/prompt) | low with SC-2/SC-3 + redacting brand + fixture grep; residual = master-key mgmt (operator-owned, documented) |
| C (API provider) | provider runs in CI or without opt-in (cost/egress) | very low with two-layer disable + CI gate + key gate; residual = spend overrun, capped deny-by-default |

**Single most expensive / least-reversible item:** the secret-store on-disk **format** (B). Version from v1.

---

## Slice breakdown (ordered; secrets land + hard-gated before the API provider)

- **P5-S0 — Cross-repo ship audit (BLOCKER for A; investigation).** Owner `solution_architect`(read)→`infra_engineer`(fix). Read the skill-surface module; audit `src/forge/**` transitive imports vs `files[]`. Done: a recorded finding of every missing `files[]` entry + confirmation of the `archon-forge-*` skill prefix. No code. Cheap. Precedes P5-S1.
- **P5-S1 — Cross-repo capability ship (Decision A; X-1, X-2; CC-14/15/16/17).** Scope: `package.json` `files[]`, gitignore/install merge. (The `archon-` skill prefix already ships the `archon-forge-*` skills — confirmed, see Council Outcome A-INVEST resolution; no skill-surface change needed.) Done: `src/forge/**` added to `files[]`; **CC-14** `npm pack --dry-run` CI test (forge present / `web` absent) runs on PRs touching `package.json` or `src/forge/**`; **CC-15** forge import-wall CI/eslint check (forge imports only `src/forge`/`src/domain`/`zod`/node built-ins); **CC-16** gitignore test asserts `.env.archon` + `dataRoot/secrets/` ignored; **CC-17** default-constraints-manifest fallback emits the `using-default-constraints-manifest` flag. Self-contained releasable increment (CC-18). Reversible.
- **P5-S2 — Secret-manager interface + redacting `SecretValue` (B.1; SC-2 partial).** Scope: new `src/secrets/`. Done: interface + branded redacting value + fixture-grep leak test + in-memory fake backend (tests only). Reversible.
- **P5-S3 — Encrypted-file backend + audit + rotation (B.2-A, B.5; SC-1 NON-WAIVABLE, SC-4, SC-5; CC-2/3/4/6/7).** Scope: `src/secrets/`. Done: built-in-`crypto` AEAD encrypted file under `dataRoot/secrets/`, mode `0600` set immediately after a same-dir atomic temp+rename, versioned header, per-entry random nonce + per-entry scrypt salt, full CRUD + rotate, metadata-only audit with regex-allowlisted `SecretRef` validated before write, serialized writes (advisory lock / single-process). **Named tests (all required to pass the SC-1 hard `security_reviewer` gate):** (a) **CC-2** unique-nonce regression (two writes → different nonces) + auth-tag-rejection (tampered tag/ciphertext throws before returning bytes); (b) **CC-4** master-key scrub (`process.env["ARCHON_SECRETS_MASTER_KEY"]` is `undefined` after first backend read) + lazy-init (absent key → no crash, degrades) ; (c) **CC-3** file mode is `0600` after creation; (d) **CC-6** `SecretRef` allowlist rejects names with spaces/quotes/path-seps; (e) **CC-7** concurrent `set` does not corrupt/reuse nonce. **Hard `security_reviewer` gate incl. the dedicated crypto review.** Backend format is the expensive edge — gate hardest. Partially expensive.
- **P5-S4 — Secret-manager config integration (B.3).** Scope: `src/secrets/`, env loading, an `archon secret` admin sub-verb (`set --from-env` migration, `rotate`, `list`). Done: operator can store/rotate; `.env.archon` holds only selector + master-key ref. The `--from-env` path must refuse-and-instruct or scrub (dissent #3). Reversible.
- **P5-S5 — API image provider (Decision C; C-DEC-1/2/3, SC-3; CC-8/9/10/11/12).** Depends on P5-S3/S4 gated (CC-19). Scope: `asset-contract.ts` (enum), `asset-provider.ts` (class + selection + `sanitizeErrorMessage`). Done: provider reads key via secret-manager at point-of-use; disabled-by-default; built-in `fetch`, AbortController timeout, output-path bounding; enum round-trip schema test (existing manifests still validate). **Named tests (all required):** (a) **CC-12** CI=true → placeholder (exact codex-guard parity) + no-key → placeholder; (b) **CC-8** fake `fetch`→401 → `AssetGenerationResult.message` contains no fixture key (Authorization header never leaks); (c) **CC-10** spend-cap boundary — cap absent / cap zero / cap unparseable (each with key + opt-in) → placeholder, positive cap → allow then deny once the run-level bucket is exhausted; (d) **CC-11** the no-cap path emits the structured reason `no_spend_cap` alongside the placeholder asset (attributable fallback, never silent); (e) **CC-9** an injected API error with a credential-bearing body is sanitized out of `message`/manifest. Reversible (additive).
- **P5-S6 — Docs + operator runbook (technical-writing).** Scope: docs. Done: cross-repo install, secret-manager backend + master-key handling, API opt-in + spend cap. Placeholders only in examples. Reversible.

Every code slice: `reviewer` + `qa_engineer` + `security_reviewer` + workflow proof. **P5-S3 additionally requires the dedicated SC-1 security gate before any later slice consumes the secret-manager.**

---

## USER decisions — RESOLVED (2026-06-25)

- **U1 → B-A encrypted file WITH vetted crypto (DECIDED).** Backend = sealed file under the runtime
  data root via node built-in `crypto`, but the dissent's homegrown-crypto concern is **binding**:
  mandatory **AEAD** (AES-256-GCM or XChaCha20-Poly1305) + a **vetted KDF** (scrypt) + a dedicated
  **extra crypto-focused security review** as part of the P5-S3 SC-1 gate. No loose hand-rolled crypto.
- **U2 → API provider BUILT, deny-by-default until a cap is set (DECIDED).** Build the provider fully,
  but it stays OFF until the operator BOTH opts in (`ARCHON_FORGE_API_PROVIDER_ENABLED=true`) AND sets
  an explicit per-run/per-day spend cap. **No default cap** — absence of a cap = deny. CI always uses
  placeholder regardless. No spend can occur by accident.
- **U3 → env passphrase master key (DEFAULT).** Master key sourced from `ARCHON_SECRETS_MASTER_KEY`;
  OS-keychain-derived is a documented later enhancement. The setup runbook (P5-S6) covers handling.

---

## Recommended council seats + dissent

Security-heavy → seat `security_reviewer` + `infra_engineer`. 5-seat panel:
- `solution_architect` (architecture/boundaries)
- `security_reviewer` (Pillar B threat model — owns SC-1…SC-5)
- `infra_engineer` (**dissent owner**; cross-repo ship, dep posture, backend ops)
- `product_strategist` (cost/opt-in policy for Pillar C)
- `frontend_designer` (cross-repo design-token scoping, default-manifest flag)

**Dissent owner (`infra_engineer`) must argue:**
1. **Against B-A:** a self-rolled `crypto` encrypted file is a homegrown secret store — the classic place teams get crypto subtly wrong (IV reuse, no auth tag, weak KDF). Prefer OS keychain (B-B) or external (B-C). If B-A wins, mandate AEAD + vetted KDF + extra crypto review.
2. **Against shipping `src/forge` in `files[]`:** widening the published surface couples consumers to forge internals and risks dragging core/web-adjacent modules in; a separate `@archon/forge` keeps blast radius small at a versioning cost. (Answer: `npm pack` test + transitive audit.)
3. **Against the `set --from-env` migration path:** leaves a plaintext key in shell history + `.env.archon`; operator forgets to delete → secret-manager is theater. (Answer: refuse-and-instruct or scrub.)

---

## Council Outcome — APPROVED_WITH_CONDITIONS (2026-06-25)

4-seat panel (security-heavy), unanimous **`approved_with_conditions`**. Seats: `solution_architect`
(author), `security_reviewer`, `infra_engineer` (**dissent owner**), `product_strategist`.
Dissent did NOT flip: infra verified the forge transitive-import surface is clean (`src/forge`
imports only `src/domain/types.ts`, already in `files[]`) and accepted B-A given the WSL2/daemon
model + the AEAD/scrypt/extra-review mandate. **A-INVEST fully resolved:** both sub-questions are
confirmed — (1) `src/forge/**` transitive imports stay within the shipped surface (`src/domain`),
and (2) `repoLocalSkillIdPrefixes` (`src/archon/repo-local-skill-surface.ts`) includes `"archon-"`,
so `buildManifest` already installs the three `archon-forge-*` skills. P5-S0's only remaining job is
to add `src/forge/**` to `files[]` and lock both facts behind the CC-14/CC-15 CI tests. The
conditions below are BINDING; the planner turns each into slice acceptance criteria. Grouped +
de-duplicated across seats.

_(Every condition below is self-contained and binding; the parenthetical provenance labels from the
seat reviews have been inlined. Each names its owning slice.)_

### Secret-manager crypto + leakage (P5-S2/S3 — SC-1 hard gate)
- **CC-1 (redaction completeness; P5-S2):** `SecretValue` stores the raw string in a
  **non-enumerable, non-configurable** property; implements `[util.inspect.custom]()` →
  `"[REDACTED]"`; overrides `toString`/`toJSON`. The P5-S2 leak test must cover `util.inspect`,
  `JSON.stringify({v})`, `{...v}` spread, `Object.values`, **template-literal interpolation
  (`` `${v}` ``)**, and a structured logger — each must yield no fixture secret.
- **CC-2 (AEAD correctness; P5-S3):** per-write **random** nonce via `crypto.randomBytes(12)`
  (AES-256-GCM) or 24 (XChaCha20) — never derived/sequential; **auth-tag verified before any
  plaintext is returned**; **per-entry scrypt salt** stored in the versioned file header; scrypt
  params (min N=131072, r=8, p=1) as named constants. P5-S3 must include a unique-nonce regression
  test (two writes → different nonces) AND an auth-tag-rejection test (a tampered ciphertext/tag
  throws before returning any bytes).
- **CC-3 (file at rest; P5-S3):** `chmod 0600` immediately after the atomic temp+rename (no
  create→chmod race); the temp file is created in the **same directory** as the target so the
  rename is atomic on one filesystem; file under a dedicated `dataRoot/secrets/` subdir; versioned
  header from v1.
- **CC-4 (master key handling; P5-S3):** the backend reads `ARCHON_SECRETS_MASTER_KEY` **lazily on
  first use** (the daemon must NOT crash or refuse to start when the key is absent — it degrades to
  placeholder); **immediately after that first read, delete the var from `process.env`**; never
  cache the decrypted secret value beyond a single operation. B.4 names the `/proc/environ`, swap,
  and core-dump residual as an accepted residual (Node has no secure-erase for strings). P5-S3 must
  include a test asserting `process.env["ARCHON_SECRETS_MASTER_KEY"]` is `undefined` after the
  backend's first read. The first read is guarded by an **init-once** latch so concurrent async
  callers cannot double-read after the var is deleted (the latch resolves the captured key/handle).
- **CC-5 (master-key rotation runbook; P5-S6):** documents decrypt-all → re-encrypt-all → atomic
  env swap → verify.
- **CC-6 (audit log; P5-S3):** metadata-only (ref, action, ts, actor — never value); `SecretRef`
  is regex-allowlisted (no spaces/quotes/path-separators/value-fragments) and validated BEFORE any
  audit write or store operation.
- **CC-7 (concurrency; P5-S3):** serialize secret writes so a concurrent `set` cannot race
  nonce/file state. The single-process CLI serializes naturally; for any multi-process path an
  **advisory lock via an `O_EXCL` lockfile** (acquire-before-read/encrypt/write, release in
  `finally`) is REQUIRED — not merely "or". Covered by the P5-S3 done-bar.

### API provider leakage + spend (P5-S5)
- **CC-8 (Authorization header containment; P5-S5):** the `Authorization: Bearer <key>` header is
  NEVER logged, stringified, spread, included in a thrown Error, or placed in
  `AssetGenerationResult.message`. On `fetch` failure log only HTTP status + asset id + `SecretRef`
  name. P5-S5 test: fake `fetch` → 401, assert the result message contains no fixture key.
- **CC-9 (message sanitization; P5-S5, owner `backend_engineer`):** a `sanitizeErrorMessage(err)`
  util (lives beside the provider in `src/forge/asset-provider.ts`) strips any header/credential
  from every API-provider error message before it reaches `AssetGenerationResult.message`, the
  manifest, or `web/`.
- **CC-10 (spend cap = hardcoded deny-by-default; P5-S5):** absent cap → deny; unparseable → deny;
  zero or negative → deny; only a positive integer → allow. "Absent = deny" is code, not a config
  default. Cap is a **run-level token bucket** debited atomically BEFORE each API call (not a
  per-request threshold). P5-S5 tests cover EACH boundary: cap absent / cap zero / cap unparseable
  (each with key present + opt-in set) → placeholder; positive cap → allow then deny once exhausted.
- **CC-11 (attributable fallback — non-waivable; P5-S5):** every API→placeholder fallback emits a
  structured reason (`ci` | `provider_disabled` | `no_key` | `no_spend_cap` | `cap_exceeded`) into
  the manifest + gate output — NEVER a silent downgrade. P5-S5 test: the no-cap path yields
  `no_spend_cap` + a placeholder asset.
- **CC-12 (CI gate parity; P5-S5):** the new provider replicates the EXACT existing codex
  `if (env["CI"] === "true") → placeholder` guard, plus the opt-in flag + key + cap gates (C.3).

### Secret input UX (P5-S4)
- **CC-13 (no-plaintext-residue input; P5-S4):** `archon secret set` accepts the value ONLY via a
  masked stdin prompt or `--from-file <path>`; NO positional arg, NO `--value`. `--from-file` must
  open with `O_NOFOLLOW` and `fstat` the open descriptor (TOCTOU-safe), reject world/group-readable
  files, and not copy the file elsewhere. The `--from-env` path reads
  silently then **deletes** the env var from `process.env` and prints a "now remove it from
  .env.archon / rotate shell history" instruction. P5-S4 test: after `set --from-env`, the var is
  `undefined` in `process.env`.

### Cross-repo ship (P5-S0/S1)
- **CC-14 (packaged surface CI-enforced; P5-S1):** an `npm pack --dry-run` content assertion runs
  in CI on every PR touching `package.json` or `src/forge/**` — asserts `src/forge/**` present,
  `web/**` absent. Not a one-time audit.
- **CC-15 (forge import wall; P5-S1):** a CI check / ESLint rule asserts `src/forge/**` imports only
  from `src/forge/**`, `src/domain/**`, `zod`, and node built-ins — prevents new transitive deps
  silently entering the shipped surface.
- **CC-16 (gitignore verified; P5-S1/S3):** `.env.archon` and `dataRoot/secrets/` confirmed
  git-ignored by a CI test, not prose.
- **CC-17 (default-manifest loud; P5-S1):** a consuming repo on the shipped default constraints
  manifest emits an explicit `using-default-constraints-manifest` flag in gate output.

### Sequencing + done-bar
- **CC-18 (cross-repo ships independently; P5-S1):** P5-S1 (cross-repo) is a self-contained
  releasable increment with zero dependency on Pillars B/C — Phase-5 value does not wait on the
  secret-manager.
- **CC-19 (SC-1 fences consumers):** no consumer of the secret-manager (P5-S4, P5-S5) may proceed
  until the dedicated non-waivable `security_reviewer` crypto gate on P5-S3 is cleared.

### Measurable Phase-5 done-bar (product)
Phase 5 is complete only when ALL are independently demonstrable: (1) a separate repo `npm install`s
archon and runs the forge pipeline + `archon-forge-*` skills against its own outputDir + manifest;
`npm pack` shows forge present/`web` absent; default-manifest flag fires. (2) operator can
set/get(point-of-use)/rotate/delete a secret; SC-1 crypto gate passes; fixture-secret leak grep = 0
across stdout/stderr/files/DB/manifest/prompt. (3) with CI=false + opt-in + key + cap → API
generates; removing ANY one → placeholder with an attributable reason; CI always placeholder.
(4) operator runbook covers cross-repo install, master-key handling + rotation, two-key API opt-in.

---

## Reversible vs expensive — summary

| Item | Reversible? | Note |
| --- | --- | --- |
| A cross-repo `files[]` + skill ship | Reversible | config entries |
| B secret-manager interface | Reversible | a seam |
| B encrypted-file **format** | **Expensive** | versioned header from v1; format change = migration |
| B backend choice | Semi | interface lets B-B/B-C be added later without touching callers |
| C enum add + provider class | Reversible | additive; no exhaustiveness break |
| C key-via-secret-manager wiring | Reversible | a read call at point-of-use |
