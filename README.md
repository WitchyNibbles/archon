<!-- A little witchcraft in the README. Evidence in the workflow. -->

<div align="center">

<h1>Archon</h1>

<p><em>Hold the thread. Keep the receipts.</em></p>

<p>Autonomous engineering for your existing Claude Code session.</p>

<p><strong>Status: the kernel is built and its deterministic suite is green, 2026-09-22.</strong> Checks, gate, installer, adapter, CLI and MCP surface all run. What has <em>not</em> happened yet is the paid proof: the live verification smoke and the native manager run are written and opt-in, and no recorded pass exists. Until they do, nothing here claims to have delivered real work.</p>

[The grimoire](docs/design.md) · [The plan](docs/implementation-plan.md) · [The spike book](docs/spikes.md) · [Field notes](docs/operations.md) · [Platform research](docs/research/2026-09-22-claude-code-platform.md)

</div>

---

## 🖤 What Archon is

Archon gives Claude Code a persistent engineering workflow inside the conversation you already use. Describe the work, settle the design, let the manager delegate implementation to native specialists, run checks, dispatch independent reviews, repair failures. The finish line is an **implemented, verified local branch ready for your review**.

It is a re-imagining of the [TypeScript Archon](../archon) on the bones of [DevGod](../devgod-recovery), the Codex harness that proved the kernel: a local SQLite state and evidence store, sandboxed checks, three independent reviewer sessions bound to a frozen candidate, and a gate that no model can talk its way through. The Codex edge is replaced with what Claude Code actually offers — an OS sandbox, blocking hooks, hermetic headless sessions, structured output, session identity, and rate-limit telemetry — each fact probed on the day of design rather than remembered.

## 🌙 The ritual

| Step | What happens |
|---|---|
| **Set intention** | You and the manager agree on design, acceptance criteria, scope. |
| **Summon the coven** | The Warden plans; Familiars implement bounded packets; the Oracle is called only for evidence-backed hard blockers. |
| **Test the spell** | The kernel runs your configured checks under `bwrap` with no model in the loop, then launches three Witnesses — reviewer, QA, security — as hermetic sessions against a frozen snapshot. Findings return to the manager for repair. |
| **Bring it into the light** | Fresh evidence supports the current candidate; the local branch is ready for you. |

A worker saying "done" cannot mark a run verified. A reviewer approving the wrong snapshot cannot either. A usage window closing mid-verification pauses the job; it does not fail it.

## 🕯️ What you will need

- Linux or WSL2, Python 3.12+, [`uv`](https://docs.astral.sh/uv/).
- `bubblewrap` and `socat` (`sudo apt install bubblewrap socat`).
- The Claude Code CLI (tested at **2.1.278**), logged in with your subscription.
- A consuming Git repository with an initial commit.

Installation:

```sh
uv tool install --python 3.12 .
archon --repo /absolute/path/to/your-project init
archon --repo /absolute/path/to/your-project doctor
```

`doctor` reports bubblewrap, socat, kernel PID handles, the installed overlay, and whether your engine version is inside the range the [spike book](docs/spikes.md) was last proven against. An untested version is a **warning** naming `archon spikes` as the remedy — it never blocks your repository.

`init` adds a marked block to `CLAUDE.md`, one manager skill, three agent files, an `.mcp.json` entry, and two managed members of `.claude/settings.json`. It never touches your model, your permission mode, or anything under `~/.claude`. `uninstall` removes only what it owns.

## 🗝️ Your everyday spellbook

Keep talking to Claude Code as usual:

> Use Archon to fix the invoice rounding. Clarify the design with me, implement it, and verify the complete change on a local branch ready for review.

Or invoke `/archon-manager` explicitly. Pick up an interrupted thread with **"Resume the Archon run."**

Administration lives in one command; `archon --help` lists all of it, and [the field notes](docs/operations.md) explain each one.

```sh
archon --repo PATH status            # run, tasks, jobs, and the one next action
archon --repo PATH verify            # real checks and the three Witnesses; waits for the gate
archon --repo PATH wait JOB          # observe a job, including one parked on a usage window
archon --repo PATH spikes --id S5    # re-prove a platform fact against your installed engine
```

## 🔮 Inside the grimoire

- [Design](docs/design.md) — architecture, roles, trust, dissent.
- [Implementation plan](docs/implementation-plan.md) — what is ported from DevGod line-for-line, what is written new, package ownership P0–P6, contracts, acceptance matrix.
- [Spike book](docs/spikes.md) — twelve capability proofs that must pass at the installed engine version before P3/P4 may claim completion.
- [Assets](docs/assets.md) — the manager skill, agent files, reviewer prompts, hook guard table, plugin manifest.
- [Operations](docs/operations.md) — paths, commands, recovery, execution boundaries.
- [Platform research](docs/research/2026-09-22-claude-code-platform.md) — LIVE / DOCS / INHERITED evidence behind every design choice.
- [The two haunted houses](docs/research/2026-09-22-original-projects.md) — what was taken from devgod-recovery and the old Archon, and what was left.
- [Verification record](docs/verification.md) — what has actually been observed, and what is still unproven.

Three opt-in scripts carry the proofs a test suite cannot: `scripts/package_smoke.py` (free — wheel, install, idempotent `init`, `doctor`, `uninstall`), `scripts/live_smoke.py --allow-live` (real checks and three real Witnesses), and `scripts/native_smoke.py --allow-live` (one real manager turn delivering two dependent tasks). Each writes a JSON report with a `PASS` / `FAIL` / `UNRESOLVED` verdict and spends nothing unless it says so.

## 📜 License

MIT · Copyright (c) 2026 Eimi (WitchyNibbles).

---

<div align="center">🕯️ <em>The code may be haunted. The checks should pass.</em> 🕯️</div>
