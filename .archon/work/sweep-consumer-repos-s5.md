# U3 Consumer Repo Blast-Radius Sweep — S5

Date: 2026-07-03  
Task: installFullCapability / S5 consumer repair  
Performed: read-only, no modifications to any repo

## Candidate repos scanned

All directories in `/home/eimi/projects/` checked for `.archon/` presence or archon refs in `package.json`.

| Repo | .archon/ | archon pkg.json ref | Archon consumer? |
|------|----------|---------------------|------------------|
| adonay-project | no | no | no |
| ai-btc-predictor | no | no (devgod ref) | not archon |
| algorithms-practice | no | no | no |
| crucible | no | no | no |
| devgod | no | devgod only | not archon |
| devgod-docs-refresh | no | devgod only | not archon |
| devgod-frontend-beauty | no | devgod only | not archon |
| everything-claude-code | no | no | no |
| **hexchange** | **YES** | **YES (file:../archon + file:../devgod)** | **YES — calibration case** |
| insta-donwload | no | no | no |
| pastel-princess | no | no | no |
| workstuff | no | no | no |

## Consumer repo detail: hexchange (only confirmed archon consumer)

| Marker | State | Detail |
|--------|-------|--------|
| `.mcp.json` | **MISSING** | MCP broken since forever |
| `.claude/settings.json mcpServers` | **5 STALE** | archon (old src path), grafana (old src path), obsidian (@latest), playwright (--yes + @latest), playwright_vision (--yes + @latest). gitnexus is user-managed (not stale). |
| `.archon/install-manifest.json` | EXISTS | Created by a previous upgrade run |
| `.archon/runtime/migration-report.json` | **STUCK "planned"** | Written by upgrade; status never advanced |
| `scripts/check-archon-workflow.sh` | **OLD .sh EXISTS** | Pre-P1 legacy script; .ts form absent |
| ECC plugin | absent (external, not in repo scope) | |
| AGENT.md ECC skill refs | 20+ files with `everything-claude-code:*` (external scope) | |

## Stale settings.json entries (verbatim)

```json
{
  "archon": {
    "command": "node",
    "args": ["--env-file=.env.archon", "--experimental-strip-types", "./node_modules/archon/src/mcp/server.ts"]
  },
  "grafana": {
    "command": "node",
    "args": ["--experimental-strip-types", "./node_modules/archon/src/grafana/mcp-server.ts"]
  },
  "obsidian": {
    "command": "npx",
    "args": ["@bitbonsai/mcpvault@latest", "${ARCHON_OBSIDIAN_VAULT_PATH}"],
    "env": {}
  },
  "playwright": {
    "command": "npx",
    "args": ["--yes", "@playwright/mcp@latest", "--config", ".archon/playwright/mcp.json"]
  },
  "playwright_vision": {
    "command": "npx",
    "args": ["--yes", "@playwright/mcp@latest", "--config", ".archon/playwright/mcp.vision.json"]
  }
}
```

Not stale (user-managed, preserved): `gitnexus`

## S5 repair blast radius

Mutations consumer-repair.ts will apply to hexchange:
- `.claude/settings.json` → strip 5 stale archon-managed mcpServers entries; gitnexus preserved
- `.archon/runtime/migration-report.json` → advance status "planned" → "upgrade-applied"

Non-mutating (handled by upgrade managed-file pass):
- `.mcp.json` → created by upgrade managed-file pass (avoiding manifest-hash conflict)

Not auto-repaired (human action):
- `scripts/check-archon-workflow.sh` → migrate to TypeScript form manually

C12 backups created before every mutation:
- `.archon/install-backups/<timestamp>/.claude/settings.json`
- `.archon/install-backups/<timestamp>/.archon/runtime/migration-report.json`

## Conclusion

**Blast radius: 1 consumer repo (hexchange).** No other active archon consumer repos found on this machine. devgod/devgod-docs-refresh/devgod-frontend-beauty reference the pre-rename `devgod` package, not `archon`, and have no `.archon/` directory.

S5 repairs are limited to hexchange and are idempotent: re-running upgrade after initial repair produces zero writes.
