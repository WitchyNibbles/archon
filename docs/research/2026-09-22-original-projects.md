# The two haunted houses — devgod-recovery and TypeScript Archon

Research date: 2026-09-22. Read-only inspection of `/home/eimi/projects/devgod-recovery` (commit `2973b2d`) and `/home/eimi/projects/archon` (frozen at `b5ba775`, 2026-08-01), plus the post-mortems in `/home/eimi/projects/project-companion/docs/case-studies/`. This record says what is carried into the new Archon, what is left in the old houses, and why.

## devgod-recovery — the donor

DevGod is a Python 3.12 harness for OpenAI Codex: a local stdio MCP kernel over SQLite that records runs, tasks, checkpoints, and evidence; executes checks through the Codex app-server's model-free `command/exec`; launches three independent reviewer threads with a strict output schema; and evaluates a gate that requires current checks, three approvals with distinct thread IDs, and an unchanged candidate. Its native side is one manager skill, an `AGENTS.md` block, three TOML agents (Luna/Terra/Sol), a `config.toml` MCP section with per-tool approval, and six lifecycle hooks. It passed 233 non-live tests on 2026-09-12, a live service smoke, and a native manager run with 17 MCP calls and zero approval callbacks ([verification record](../../../devgod-recovery/docs/verification.md)).

Its first real run died after eight minutes: `Policy` typed the sandbox as `Literal["workspace-write"]` with `/tmp` excluded, `uv` could not write a cache, every check failed, and the manager could diagnose but not act (`project-companion/docs/case-studies/devgod.md`). The 2026-09-20 modernization roadmap then pointed the product at legacy-monolith analysis; that direction is out of scope here — Archon ports the delivery kernel, not the analysis roadmap.

**Carried in (ported, ~2,900 lines + 86 tests):** `models.py`, `store.py`, `workspace.py`, `verification.py`, `service.py`, `mcp_server.py`, `cli.py`, `launcher.py` lines 1–176, the kernel-only test files, the acceptance fixture, the manager skill text, the three role instruction texts, the terminal-report headings, and the installer's span-preserving JSON and backup primitives. The exact coupling map is in [the implementation plan](../implementation-plan.md#starting-point--what-is-ported-and-what-is-written).

**Left behind:** `codex_adapter.py` (app-server JSON-RPC, `command/exec`, thread/turn identity, Codex config overlays), the Codex asset containers (TOML, `config.toml`, `hooks.json` with Codex events, `AGENTS.md` block), `DEVGOD_MANAGED_REVIEW`, the single shared reviewer prompt (three roles get their own), and the `/tmp`-excluded policy.

## TypeScript Archon — the namesake

Archon (Node 22, TypeScript, Postgres + pgvector) was the first Claude Code port of DevGod's discipline: 31 agent roles, 46 skills, nine `.mjs` hooks totalling 5,728 lines, a Postgres-backed workflow proof, HMAC-signed review identity, a design council, and a context-handoff guard at 70% context. It froze itself on 2026-08-01 (`STATUS.md`): Postgres was unreachable on the development machine, the Stop hook failed closed on the offline runtime, the PreToolUse hook blocked substantive writes with no active task, and "the repository locks itself". The tip commit is labelled UNGATED; `dist/` is stale; the gate-trust document records that the v2 identity claim was false because the signing key fell back to a cwd-relative path the daemon could read.

**Carried in (as rules, not code):** the witchy documentation voice and emoji section markers; the honest-residual doctrine ("write down the ceiling instead of claiming a wall"); the Stop-hook structure "prose can release a soft hold, never a hard gate; a repeated stop still falls through to the hard gates"; the statusline-as-sensor idea (mirrored to a file, never a gate); the review-independence sentence "'I reviewed my own work and found it flawless' is a diary entry"; the name.

**Left behind:** Postgres, HMAC review identity, the 31-role catalog and 46 skills (audited inert), the 3,572-line shell parser, the fail-closed hooks, the 70% context handoff, the forge sub-product, the ecc plugin dependency, the npm overlay installer.

## project-companion and crabgic — the neighbours

Neither is ported, but both paid for facts Archon uses. project-companion (1.3k lines, 13 field runs on `../magic-tower`, ≈$443) proved that one-task-per-fresh-session with an external manager-run `done-when` command works, and documented the per-run defects (H1–H11) that shaped Archon's guard table, scratch rules, worktree base handling, and "textual exception". crabgic's engine baseline (2.1.207–2.1.224) supplied the permission, sandbox, structured-output, session, and rate-limit findings that the spike book re-verifies at 2.1.278; its own version gate, which now blocks its host, is the reason `doctor` warns instead of locking.

## What is different this time

1. The kernel is inherited, not invented; the edge is rewritten against facts probed on the day of design.
2. Checks need no model turn; the OS sandbox is the kernel's, not the provider's.
3. Reviewers are hermetic by flags the kernel can verify from the session's own `init` event.
4. Usage windows are a first-class paused state, not a crash.
5. No mechanism beyond DevGod's kernel enters without a citing run; the guard table cites one per row.
6. The first acceptance fixture runs `uv sync`, because that is what killed the donor.
