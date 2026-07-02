# Evidence — installFullCapability (combined investigation results)

Sources: agent-runtime-engineer install audit + docs-researcher external-contract research +
manager upstream verification. Date: 2026-07-02.

## A. External contracts (Claude Code v2.1.198, verified live)

1. **Project MCP = `.mcp.json` only.** Claude Code reads project-scope MCP exclusively from
   `.mcp.json` (`{"mcpServers": {...}}`). Verifiable: `claude mcp list` (shows project entries +
   Connected/Pending state), `claude mcp get <name>`. #140's routing fix is correct. STABLE.
2. **First-use approval gate is NOT automatable.** New `.mcp.json` servers need a one-time IDE
   click-through (state internal; reset via `claude mcp reset-project-choices`). Must be a
   documented fail-fast/doctor advisory, not automated.
3. **Plugin install IS scriptable.** `claude plugin install <name>@<marketplace>` is
   non-interactive once the marketplace is registered (`claude plugin marketplace add`, or
   `extraKnownMarketplaces` in ~/.claude/settings.json). Enable-state lives in user
   settings.json `enabledPlugins`. Verify via `claude plugin list`.
4. **ECC identity drift confirmed live (upstream check via gh):**
   - Upstream `affaan-m/everything-claude-code` REDIRECTS to `affaan-m/ECC`.
   - Canonical marketplace/plugin is now `ecc` v2.0.0 (marketplace.json name "ecc").
   - This very machine still runs stale cache `everything-claude-code@everything-claude-code`
     v1.8.0 under the old ID. Installed consumers keep old identity silently.
   - ⇒ installer/doctor must accept BOTH identities and migrate old→new. DRIFT-PRONE:
     needs a contract check (marketplace resolves, plugin name matches expected set).
5. **Hooks/plugins/marketplaces are user-scope**; project scope has no equivalent override.
   Project-side hook config goes through project `.claude/settings.json` hooks keys (as
   installer already writes) — but no layer verifies hooks are executable.

## B. What `archon init` does / does not do (src/install/cli.ts:1426)

Does (all file-level, non-interactive despite "guided" label): managed copies (.archon/rules,
templates, playwright, .githooks, plugins/archon, .claude/{skills,agents,hooks}, scripts),
merges (.claude/settings.json, .mcp.json [post-#140], CLAUDE.md, .claude.md, package.json,
.gitignore), seeds (review-identity-adapter.ts [throwing stub], .graphifyignore, memory/skills
READMEs).

Does NOT: install ECC plugin; create/configure DB or .env.archon; run npm install; run
migrate/bootstrap-project; run git-guard setup; verify any capability; prompt interactively.
Next-steps text omits .env.archon + migrate + bootstrap-project entirely (cli.ts:229-241).

## C. verify/doctor layer analysis

- `archon verify` (cli.ts:1510) = byte-diff of managed files. Passes while: MCP unusable,
  hooks dead, DB absent, ECC missing, review-identity stub throwing.
- `archon doctor` (db-preflight.ts) = DB checks (URL, connect, pgvector, 14 tables, 12 columns,
  bootstrap, registration, review-identity file presence). Zero Claude-Code-surface checks:
  no ECC, no MCP registration, no hook executability, no node_modules presence, no stub
  detection.

## D. Test coverage gap (calibrated on #140)

tests/install.test.ts asserts merge shapes + .mcp.json content in temp dir + pack smoke +
catalogs + doctor stubs. Cannot catch: wrong-file placement class (#140), ECC absence,
hooks that don't execute, real migrate+bootstrap flow, stub-left-in-place, stale paths after
package rename. No e2e "init into temp repo → capability probes" test exists.

## E. Live consumer state (hexchange — worst case, pre-P1 install)

- NO `.mcp.json` at all → MCP entirely broken since forever.
- settings.json mcpServers: 6 stale entries → old unscoped pkg `node_modules/archon/src/...`,
  `@latest` + `--yes` forms now disallowed.
- ECC plugin absent; 20+ AGENT.md files reference `everything-claude-code:*` → silent skill
  resolution failure.
- Old `.sh` workflow check; migration-report.json stuck at status "planned".
- `archon verify` output would say "Missing: .mcp.json" with zero capability framing/remedy.

## F. Ranked gaps (agreed by both investigations)

1. STRUCTURAL: verify is file-diff, doctor is DB-only → no layer proves capability. (root cause)
2. STRUCTURAL: ECC plugin unmanaged: not installed, not verified, identity drift unhandled.
3. STRUCTURAL: no e2e install regression harness (init → temp repo → capability probes) in CI.
4. UX: "guided" init isn't guided — no prompts, next-steps omit DB essentials (env, migrate,
   bootstrap); essential steps live only in runbook docs.
5. SEED: review-identity-adapter stub throws at runtime, never re-checked after seeding.
6. CONSUMER DEBT: existing consumers (hexchange) stuck pre-P1 broken; upgrade exists but
   nothing tells the operator what/why; migration-report left "planned".
7. DRIFT: external contracts (ECC identity, marketplace source, playwright pin) unmonitored.

## G. Constraints for architecture

- MCP approval click cannot be automated — fail-fast + instructions only.
- Plugin/marketplace state is user-global (~/.claude), not project — installer touching user
  scope needs explicit consent in flow.
- Existing consumers must upgrade cleanly (managed/seed semantics preserved).
- Installer = release-sensitive ⇒ release_readiness gate.
