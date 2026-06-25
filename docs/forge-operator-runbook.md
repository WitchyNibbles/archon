# Frontend Forge — Operator Runbook

> Audience: an operator installing and running the Archon **Frontend Forge** capability in a
> consuming repository, configuring the secret-manager, and (optionally) enabling the API image
> provider.
>
> Scope: cross-repo install · secret-manager backend + master-key handling · master-key rotation
> (CC-5) · the two-key API image-provider opt-in + spend cap.
>
> All keys and secrets in this document are **placeholders**. Never paste a real key into a file
> that is tracked by git, into shell history, or into a command-line argument.

---

## 1. Cross-repo install

The Forge capability ships as part of the published `archon` package. A consuming repo gets it by
installing the package — there is no separate install step for Forge itself.

### What ships

- **`src/forge/**`** — the Forge runtime (asset contract, providers, anti-generic critic,
  constraints manifest, pipeline builders). Listed in `package.json` `files[]`.
- **The Forge stage skills** — `archon-forge-intent`, `archon-forge-direction`,
  `archon-forge-assets` — ship via their `.claude/skills/archon-forge-*/SKILL.md` entries in
  `package.json` `files[]`.
- **This runbook** — `docs/forge-operator-runbook.md`.

### What does NOT ship

- **`web/**`** — the dogfood dashboard and its Vite/React/Playwright toolchain are **excluded** from
  the package (the R2-C package boundary). The lean core keeps its small dependency surface; a
  consuming repo never inherits the browser toolchain. A CI check (`npm pack --dry-run`) asserts
  `src/forge` is present and `web` is absent on every PR that touches `package.json` or `src/forge/**`.

### Import wall

`src/forge/**` imports only from `src/forge`, `src/domain`, `zod`, and Node built-ins. An ESLint
rule + a CI allowlist scan enforce this, so the Forge surface can be lifted into a consuming repo
without dragging in the rest of the engine.

### Constraints manifest (design tokens / anti-generic rules)

Forge resolves its constraints manifest at runtime:

1. If the consuming repo provides a repo-local `constraints-manifest`, that is used.
2. Otherwise the **shipped default** is used, and Forge emits a loud
   `using-default-constraints-manifest` flag so the operator knows the project has not supplied its
   own design tokens / anti-generic rules.

Treat the `using-default-constraints-manifest` flag as a prompt to author a repo-local manifest
before shipping anything visual — the default encodes Archon's own identity, not the consuming
project's.

### What is gitignored (never commit)

- `.env.archon` (your environment file)
- `<dataRoot>/secrets/` (the encrypted secret store — see §2)
- Generated asset bytes and `web/public/snapshot.live.json`

A CI tripwire keeps the tracked-binary count at zero.

---

## 2. Secret-manager backend + master-key handling

Forge needs a secret only when you opt into the API image provider (§4). Everything else (the
default `placeholder_svg` provider, and `codex_builtin_imagegen` when a local `codex login` exists)
runs with no secret at all. The secret-manager is what lets the API provider read its key without
the key ever touching `.env`, the database, a prompt, a manifest, or durable memory.

### Backend selector

```bash
# .env.archon
ARCHON_SECRETS_BACKEND=encrypted_file   # default; the only backend implemented today
```

`encrypted_file` is the default; you do not have to set it. Any other value throws a clear error at
startup (there is no silent fallback).

### Where the store lives

The store lives under the runtime **data root**, which is **outside the repo by default**:

| Platform | Default data root |
|----------|-------------------|
| Linux    | `~/.local/share/archon/<project-slug>` |
| macOS    | `~/Library/Application Support/archon/<project-slug>` |
| Windows  | `%LOCALAPPDATA%\archon\<project-slug>` |

Override with `ARCHON_RUNTIME_DATA_ROOT` (resolved against the current working directory). The
secret store is then:

```
<dataRoot>/secrets/
  secrets.enc     # the encrypted secrets file   (mode 0600)
  audit.log       # metadata-only audit trail     (JSONL: ref, action, ts, actor; never values)
  .write.lock     # single-writer lock
```

The `secrets/` directory is created with mode `0700` and `secrets.enc` with mode `0600`
(owner-only). If you point `ARCHON_RUNTIME_DATA_ROOT` *inside* the repo, the gitignore entry for
`dataRoot/secrets/` keeps it untracked — but keeping the data root outside the repo is strongly
preferred.

### Encryption at rest

- **AES-256-GCM** authenticated encryption.
- A **random IV per write** and a **per-entry scrypt-derived key** (random per-entry salt).
- The auth tag is verified *before* any plaintext is returned — a tampered file throws rather than
  returning corrupted bytes.

### The master key

The encrypted store is unlocked by a single **master key** supplied via the environment:

```bash
# .env.archon — PLACEHOLDER, generate your own (see below)
ARCHON_SECRETS_MASTER_KEY=0000000000000000000000000000000000000000000000000000000000000000
```

Requirements and behavior:

- It must be a **64-character hex string** (32 bytes / 256 bits). An invalid value throws.
- Generate one with:

  ```bash
  openssl rand -hex 32
  ```

- The backend reads `ARCHON_SECRETS_MASTER_KEY` **lazily on first use** and then **scrubs it from
  the process environment** (`delete process.env[...]`), so it does not linger in `/proc/<pid>/environ`
  for the life of the process.
- If the master key is **absent**, the backend still constructs (so a no-secret run does not crash);
  any operation that actually needs to decrypt or encrypt (`get`/`set`/`rotate`) then fails with a
  clear "master key is not configured" message.
- The master key is **never** written to the repo, the database, the audit log, or any error message.
  Store it in your secret manager of choice (a password manager, your OS keychain, or your CI secret
  store) — not in a tracked file.

> **Threat model.** A stolen `secrets.enc` is useless without the master key. A stolen master key
> plus the file is a full compromise → rotate the master key (§3) and rotate the underlying secret
> values. Master-key custody is operator-owned; the runbook is the control.

### Managing secret values — `archon secret`

```
archon secret set <ref>    [--from-file <path> | --from-env <VAR>]
archon secret rotate <ref> [--from-file <path> | --from-env <VAR>]
archon secret list
archon secret delete <ref>
```

- **`set`** stores (or overwrites) a secret. **`rotate`** replaces an **existing** secret value and
  fails if the ref does not exist (so a typo cannot silently create a new secret — use `set` to
  create). **`list`** prints stored refs only — never values. **`delete`** removes a secret.

- **Secret refs** must match the allowlist `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` — lowercase,
  dot-segmented, no spaces / quotes / path separators. The API provider uses the ref
  **`forge.openai_api_key`**.

- **Value input — never on the command line.** There is **no positional value and no `--value`
  flag** (both are rejected loudly); passing a secret that way would leak it into shell history and
  process listings. Choose one of:

  1. **`--from-file <path>`** — the file is opened with `O_NOFOLLOW` (symlinks rejected), `fstat`-ed
     on the open descriptor, and **rejected if it is group- or world-readable** (must be `0600` or
     `0400`). The file is read, never copied. Delete the file afterward.
     ```bash
     printf '%s' 'sk-REPLACE_ME' > /run/user/$UID/forge-key && chmod 0600 /run/user/$UID/forge-key
     archon secret set forge.openai_api_key --from-file /run/user/$UID/forge-key
     rm -f /run/user/$UID/forge-key
     ```
  2. **`--from-env <VAR>`** — read once, then **deleted from the process env**; the command prints
     instructions to remove the var from `.env.archon` and clear your shell history.
  3. **Masked stdin (default)** — run `archon secret set forge.openai_api_key` with no input flag and
     type the value at the hidden prompt (echo disabled). Best for interactive use.

---

## 3. Rotating the master key (CC-5)

Rotate the master key when it may have been exposed, on a schedule, or when an operator leaves.

> **Important — there is no automated `rotate-master-key` verb yet.** By design the store exposes no
> `get`/decrypt-all command on the CLI (plaintext never leaves the store through tooling), so there
> is no one-shot "decrypt-all → re-encrypt-all" command. Rotation is the operator procedure below.
> An automated re-encrypt-all verb is a tracked future enhancement.

> **Why you must re-provision *every* secret.** `archon secret set` re-encrypts only the entry it
> writes (under the current master key) and copies every other entry's ciphertext **verbatim**. So
> if you switch the master key and re-set only one ref, the *other* entries stay encrypted under the
> old key and become undecryptable (a mixed-key file). You must re-set **all** refs under the new
> key. You therefore need the plaintext of every secret from your own secure source (the store will
> not reveal them).

### Procedure

1. **Inventory.** With the **current** master key still set:
   ```bash
   archon secret list
   ```
   Make sure you hold the plaintext value of every listed ref from your secure source. For a typical
   Forge setup this is just `forge.openai_api_key`.

2. **Generate the new master key:**
   ```bash
   openssl rand -hex 32      # copy the output
   ```

3. **Remove the old encrypted file** so no stale old-key entry can survive the rotation:
   ```bash
   rm -f "<dataRoot>/secrets/secrets.enc"
   ```
   (Resolve `<dataRoot>` per §2. The `audit.log` may be kept for history.)

4. **Switch the master key** in your environment / secret store:
   ```bash
   # .env.archon
   ARCHON_SECRETS_MASTER_KEY=<the new 64-char hex value>
   ```

5. **Re-provision every secret** under the new key, using a no-command-line input mode (§2):
   ```bash
   archon secret set forge.openai_api_key      # masked stdin
   # ...repeat for every other ref you inventoried in step 1
   ```
   Each `set` writes `secrets.enc` atomically (temp file + `rename`), so the swap to the
   new-key file is atomic per write.

6. **Verify:**
   ```bash
   archon secret list        # every expected ref is present
   ```
   Check `audit.log` shows a `set` for each ref, and confirm the API provider still functions
   (or that selection reports `no_key` only when you intend it to).

7. **Destroy the old master key** everywhere it was stored, and clear shell history if any value
   passed through it.

> **Rotating a secret *value* (not the master key)** is the simpler `archon secret rotate <ref>`
> (e.g. when an API key itself is compromised) — it replaces one value in place under the current
> master key.

---

## 4. Enabling the API image provider (two-key opt-in + spend cap)

The OpenAI API image provider (`openai_api_later_optional`, `gpt-image-1`) is **off by default and
fails safe to placeholder**. It turns on only when **two independent switches** are both set, a key
is present in the secret-manager, and a positive spend cap exists. Any missing condition →
deterministic placeholder fallback with a **structured reason** (never a silent downgrade).

### The two keys

```bash
# .env.archon
ARCHON_FORGE_API_PROVIDER_ENABLED=true   # switch 1: explicit opt-in (default off)
ARCHON_FORGE_API_SPEND_CAP=25            # switch 2: positive integer cap (deny-by-default)
```

- **`ARCHON_FORGE_API_PROVIDER_ENABLED`** must equal exactly `true`. Anything else → placeholder
  (reason `provider_disabled`).
- **`ARCHON_FORGE_API_SPEND_CAP`** is a **run-level token bucket** — the maximum number of API image
  generations allowed per process run. **Deny-by-default is hardcoded:** absent, empty, zero,
  negative, or non-integer → the cap is unconfigured and **every** API call is denied (reason
  `no_spend_cap`). Only a **positive integer** allows spending, and only up to that many generations;
  once the bucket is exhausted, further requests fall back to placeholder (reason `cap_exceeded`).
  The cap is debited *before* each network call.

### The key

Store the OpenAI key in the secret-manager (§2) under the ref `forge.openai_api_key` — **not** in
`.env.archon`:

```bash
archon secret set forge.openai_api_key      # masked stdin; or --from-file / --from-env
```

The provider reads the key via the secret-manager **at the moment of the call** and discards it when
the request completes. The key is never placed in provider config, the manifest, an error message,
or a log. On an HTTP failure only the status code + asset id are reported; the `Authorization`
header value is never logged or surfaced.

### Selection order and fallback reasons

For a request whose provider is `openai_api_later_optional`, selection evaluates, in order:

| Condition | Result | Reason |
|-----------|--------|--------|
| `CI=true` | placeholder | `ci` |
| `ARCHON_FORGE_API_PROVIDER_ENABLED != true` | placeholder | `provider_disabled` |
| key absent in secret-manager | placeholder | `no_key` |
| spend cap absent / zero / negative / non-integer | placeholder | `no_spend_cap` |
| spend cap exhausted | placeholder | `cap_exceeded` |
| all satisfied | **API provider** | `api_available` |

**CI always falls back to placeholder**, regardless of the other switches — the API provider never
runs in CI. This makes pipelines deterministic and zero-cost by default.

### Minimal enable checklist

1. `openssl rand -hex 32` → set `ARCHON_SECRETS_MASTER_KEY` (§2). _(Only if you have not already set up the secret store.)_
2. `archon secret set forge.openai_api_key` (masked stdin).
3. `ARCHON_FORGE_API_PROVIDER_ENABLED=true` in `.env.archon`.
4. `ARCHON_FORGE_API_SPEND_CAP=<positive integer>` in `.env.archon`.
5. Run outside CI. Confirm selection reports `api_available` (not a fallback reason).

To disable again, unset `ARCHON_FORGE_API_PROVIDER_ENABLED` (or set the cap to `0`) — the provider
falls back to placeholder immediately.

---

## Appendix — environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `ARCHON_SECRETS_BACKEND` | Secret backend selector | `encrypted_file` |
| `ARCHON_SECRETS_MASTER_KEY` | 64-char hex master key (32 bytes) | _(none — required to use secrets)_ |
| `ARCHON_RUNTIME_DATA_ROOT` | Override the runtime data root | platform default (§2) |
| `ARCHON_FORGE_API_PROVIDER_ENABLED` | API provider opt-in (switch 1) | unset (off) |
| `ARCHON_FORGE_API_SPEND_CAP` | Run-level generation cap (switch 2) | unset (deny) |

See `.env.example` for the same variables with placeholder values.
