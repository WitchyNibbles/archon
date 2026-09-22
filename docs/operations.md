# Operating Archon — field notes

## Daily workflow

Use your existing Claude Code session. The manager performs planning, delegation, bookkeeping, checks, review dispatch, repair, waiting out usage windows, and resumption. Product questions belong before design completion; routine implementation choices and internal recovery belong to the manager afterwards.

Archon follows repository instructions, applicable skills, project agents, and quality gates. Native specialists receive bounded scopes. Independent code, QA, and security verification runs in separate kernel-launched Claude Code sessions whose session IDs are recorded as provenance.

## Model routes

Run the host conversation on whatever model you already use; Archon never rewrites it. `auto` or `acceptEdits` permission mode keeps prompts to a minimum; Archon never sets the mode.

| Route | Installed agent | Model / effort | When the manager dispatches it |
|---|---|---|---|
| Worker | `archon-familiar` | sonnet / medium | Clear, bounded coding tasks with acceptance criteria, path ownership, checks; focused tests; mechanical refactors; known-path repairs. |
| Lead | `archon-warden` | opus / high | Planning, decomposition, integration, ordinary multi-file debugging, API/schema decisions, Familiar escalations. |
| Expert | `archon-oracle` | fable / xhigh (or opus / max) | Evidence-backed hard blockers, material design disagreement, difficult root cause, high-risk security or data-integrity decisions. |
| Witnesses | kernel sessions | opus / high each (policy-overridable; never haiku) | Reviewer, QA, security assessment of the frozen candidate. |

Fable is installed only with `init --fable`; otherwise the Oracle file pins `opus`/`max`. A passing test alone cannot grant verification.

## Installation and ownership

Install the Python distribution in a stable environment outside the consuming repository (`uv tool install --python 3.12 .`), then `archon --repo PATH init`. Generated MCP and hook commands refer to that interpreter. Rerun `init` if the environment moves. Managed checks cannot rewrite the controller: the kernel runtime is masked inside the check sandbox.

| Location | Purpose |
|---|---|
| `CLAUDE.md` managed block | Route substantive work to the manager. |
| `.claude/skills/archon-manager/` | Manager instructions; numbered on collision. |
| `.claude/agents/archon-{familiar,warden,oracle}.md` | Project-scoped role routes; an existing or edited file stays active rather than being overwritten. |
| `.mcp.json` `archon` entry | Local stdio kernel. |
| `.claude/settings.json` managed members | `permissions.allow: mcp__archon__*`; six hook groups. |
| `.archon/native-install.json` | Ownership, content hashes, runtime paths. |

User instructions and unrelated configuration remain intact, including comments and key order in `settings.json`. Repeating unchanged setup is byte-idempotent. Edited managed files are preserved and the installer reports backup locations under the private state root.

Claude Code owns project trust and the first-use hook approval prompt; `init` cannot grant either. After `init`, start a new session so the skill, agents, MCP server, and hooks load.

Prerequisites: Linux or WSL2, Python 3.12+, `bubblewrap` and `socat` (`sudo apt install bubblewrap socat`; Ubuntu 24.04+ may need the AppArmor profile for user namespaces), the Claude Code CLI logged in. `doctor` checks each and reports an engine version outside the tested range as a warning with the spike-book command, never as a block.

## State and workspace safety

Private root: `$XDG_STATE_HOME/archon/repos/` (fallback `~/.local/state/archon/repos/`), one SQLite database, artifacts, snapshots, and receipts per canonical repository. `--state-home PATH` selects an external root; repository-local state is rejected. Do not edit or force transitions. The public service accepts plans, implementation claims, checkpoints, and recovery actions; it never accepts passing check records or review receipts.

A run creates a delivery branch at the current commit with no checkout, stash, reset, or clean. Staged, unstaged, and untracked work stays in place and is part of the candidate. Task scopes describe changes made after the baseline.

Checks execute in the active worktree under a kernel-owned `bwrap` profile: no network, writes only inside the worktree and a private scratch (which also holds `TMPDIR` and a private `HOME` for tool caches), `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.claude`, and Archon's state masked. Reviews inspect frozen, read-only copies from which `.claude/`, `CLAUDE.md`, `.mcp.json`, and `AGENTS.md` have been relocated into inert review data. Source, branch, plan, snapshot, or artifact changes prevent stale approval from being reused.

This protects against ordinary worker writes and stale results. It is not a security boundary against an unrestricted process running as the same user, nor proof that a model review catches every defect.

## Execution and recovery

Reviewer sessions run `claude -p` with a kernel-issued session ID, no settings sources, no MCP servers, no skills, a four-tool read-only catalog, `dontAsk`, and a generated read-only sandbox. The kernel verifies the session's own `init` report before accepting anything from it. Approval prompts never reach you: anything a reviewer could not do is recorded as a denial, not asked.

`verify` returns a job ID and continues in the service's event loop between tool calls; the CLI `verify` waits because there is no resident loop after exit. Duplicate requests reuse the existing job.

**Usage windows.** If the subscription's five-hour or seven-day window closes mid-verification, the affected job pauses with the reset time, `status` reports `next_action: wait`, and the manager calls `wait` until it reopens. No attempt is consumed; evidence gathered before the pause is reused. A weekly window can be days; closing the session is safe, and `resume` after reopening continues from the paused job.

Interruption preserves state. Leases and attempt tokens reject late results. Each kernel-launched process runs under a child-subreaper supervisor that writes a termination receipt only after every descendant is reaped; a check passes only with that receipt. After a service crash, recovery reconciles recorded supervisors and requires inspection of completed effects before a replay. Hooks restore recorded checkpoints and request bounded continuation; they fail open and never lock the repository.

## Migrating an older overlay

```sh
archon --repo /absolute/path/to/your-project init --migrate
```

Recognizes the TypeScript Archon overlay (`.archon/work`, `.archon/rules`, `.claude/hooks/archon-*.mjs`, the 31 `AGENT.md` roles, `archon-*` skills, the npm `archon:*` scripts) and the DevGod overlay (`AGENTS.md` block, `.agents/skills/devgod-manager`, `.codex/**`). Unchanged files are archived by hash; modified files stay and are reported. Historical `.archon/memory` and old plans are retained as reference, never imported as evidence.

## Administrative commands

Options `--repo`, `--state-home`, `--json` precede the subcommand; every command has `--help`.

| Command | Behavior |
|---|---|
| `init [--migrate] [--fable] [--gitignore]`, `doctor`, `uninstall` | Install, inspect local capabilities, remove owned integration. |
| `status [RUN]`, `next [RUN]`, `resume [RUN]` | Inspect or reconcile the current run. |
| `start --goal TEXT --acceptance ID:DESCRIPTION… [--branch] [--tasks FILE] [--checks FILE]` | Record an accepted goal and create the delivery branch. |
| `task add\|update\|list`, `checkpoint save\|show` | Record scopes, claims, continuation context. |
| `verify [RUN]` | Run actual checks and the three Witnesses; wait for the gate. |
| `wait JOB --timeout SECONDS` | Observe a job for up to 60 seconds, including a paused one. |
| `recover JOB --attempt N --candidate-digest HASH --checks-digest HASH --observations TEXT` | Record manager inspection and retry a stopped attempt. |
| `cancel [RUN]` | Cancel owned jobs, preserving work and history. |
| `mcp`, `hook` | Generated native host entry points. |
| `spikes [--id S1…]` | Run the capability spike book and record evidence. |

Errors explain the failing operation and the next recovery action. Diagnostic output never replaces MCP protocol messages on stdout. `doctor` reports installed capabilities without claiming a live authenticated invocation.
