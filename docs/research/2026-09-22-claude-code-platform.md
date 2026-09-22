# Claude Code platform research — 2026-09-22

Research date: 2026-09-22. Host engine: **Claude Code 2.1.278** on Linux (WSL2), `bwrap` and `socat` at `/usr/bin`, subscription auth (`claude auth status` → `authMethod: claude.ai`, `apiProvider: firstParty`). This record is the evidence behind [the design](../design.md). It separates three tiers:

- **LIVE (today)** — probed on this host at 2.1.278 during this research session, in a throwaway git fixture under the session scratchpad. Nothing was written to the user's configuration.
- **DOCS** — read from the official documentation at `code.claude.com/docs` and the changelog on this date. Documented, not executed.
- **INHERITED** — measured by the sibling projects `crabgic` (2.1.207–2.1.224) and `project-companion` (2.1.235+, 52 field sessions). Treated as hypotheses until re-probed; each carries its original source.

Anything in the design that rests on a DOCS or INHERITED fact is listed again in [§7](#7-pitfalls-that-must-be-re-verified-before-freezing) as a spike.

## 1. Findings that decide the architecture

### 1.1 Claude Code has no model-free `command/exec`; it has an OS sandbox instead

Codex exposed a JSON-RPC `command/exec` that ran an argv vector inside the app-server sandbox without a model turn. Claude Code exposes no such RPC. What it exposes is the **sandbox settings schema** (`sandbox.enabled`, `filesystem.allowWrite/denyRead/denyWrite`, `network.allowedDomains`, `allowUnsandboxedCommands`, `failIfUnavailable`) backed by bubblewrap + socat on Linux, plus the standalone `@anthropic-ai/sandbox-runtime` (`srt`) package that wraps arbitrary processes with the same primitives ([npm](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime), [repo](https://github.com/anthropic-experimental/sandbox-runtime); research preview).

**LIVE (today), probe 5.** A headless session with `--permission-mode dontAsk`, `--setting-sources ""`, `--strict-mcp-config`, a generated `--settings` file (`sandbox.enabled: true`, `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, `network.allowedDomains: []`, `filesystem.denyRead: ["~/.ssh"]`, `denyWrite: [<protected dir>]`, `allowWrite: ["."]`) and permission **allow** rules for `curl`, `cat`, `touch`:

| Command | Permission layer | OS layer | Observed |
|---|---|---|---|
| `curl -m 5 https://example.com` | allowed by rule | network unshared | blocked; `permission_denials` empty |
| `cat ~/.ssh/id_rsa` | allowed by rule | `denyRead` | blocked (model reported the sandbox denial) |
| `touch protected/x` | allowed by rule | `denyWrite` | blocked; file absent afterwards |
| `touch ok.txt` | allowed by rule | inside `allowWrite` | succeeded; file present |

Design inference: deterministic checks do **not** need a model session at all. The kernel can run a check's argv directly under `bwrap` with the same profile the engine uses (network unshared, writable roots = repository worktree + private scratch, everything else read-only, private `/tmp`), supervised by the existing subreaper launcher. That is simpler than Codex's path, keeps termination receipts, and removes one model round-trip per check. `srt` is the documented way to get the identical profile; direct `bwrap` is the zero-dependency way. The design chooses direct `bwrap` with a fixed, test-pinned profile and treats `srt` as an optional richer driver (see design §5.1).

### 1.2 `dontAsk` + allow rules is real containment; deny prompts never reach a human

**LIVE (today), probe 4b.** `--permission-mode dontAsk` with `deny: ["Bash(rm *)", "Write", "Edit"]`: `rm a.txt` was refused without any prompt and appeared in the result's `permission_denials` array with `tool_name`, `tool_use_id`, `tool_input`. The file survived. The run finished `subtype: success`, `is_error: false`.

**DOCS.** Precedence is deny → ask → allow, first match wins, specificity irrelevant; a deny at any settings level cannot be re-allowed at another. `dontAsk` denies anything that would prompt. Compound commands (`&&`, `||`, `;`, `|`) require each subcommand to match independently; wrappers `timeout`/`nice`/`nohup`/`stdbuf`/`command` are stripped before matching. Bare-name deny (`Bash`, `Write`) removes the tool from the catalog entirely.

**INHERITED (crabgic 2.1.218, `engine-baseline.md:499-531`).** Path-scoped rules were honored as **allow** and inert as **deny**; sensitive-root deny triplets did nothing. Read auto-deny is directory-scoped, and adding bare `Read` to allow removed the only barrier. The sandbox did **not** constrain the engine's own `Write`/`Read` tools, only shell-issued writes.

Design inference: reviewer sessions are contained by **catalog removal** (`--tools Read,Grep,Glob,Bash`, no `Write`/`Edit`/`Agent`/`WebFetch`), `dontAsk`, an allow list scoped to the read-only shell commands they need, and the OS sandbox on top. Never rely on a path-scoped deny.

### 1.3 Structured output is a tool the model must choose to call

**LIVE (today), probes 2a–2c.** `--output-format json --json-schema <ReviewPayload subset>`:

| Model | Instruction | Result |
|---|---|---|
| haiku, `--tools ""` | none | `structured_output: null`, `subtype: success` |
| haiku, default tools | none | `structured_output: null`; the model said it had no `StructuredOutput` tool available |
| sonnet, default tools | "emit your final answer through the StructuredOutput tool" | `structured_output: {"decision":"approve","summary":"ok"}`, `result` = the same JSON |

So the schema is mediated by an internal `StructuredOutput` tool. A success-shaped result with `structured_output: null` is the failure mode; the documented `error_max_structured_output_retries` subtype was **not** observed (matches crabgic's finding at 2.1.210/218). Design inference: the reviewer role prompt names the tool explicitly, the reviewer runs on Opus 5 or Sonnet 5 (never Haiku), and the kernel's pydantic `ReviewPayload.model_validate` stays the authority. A null `structured_output` is a bounded-retry provider fault, never evidence.

### 1.4 Session identity round-trips, and isolated sessions really are isolated

**LIVE (today), probe 6.** `--session-id <uuid>` was echoed unchanged in both `system/init` and the `result` message; the transcript landed at `~/.claude/projects/<munged-cwd>/<uuid>.jsonl`. With `--setting-sources ""` the user's `SessionStart` and `PreToolUse` hooks (headroom, present in `~/.claude/settings.json`) did **not** fire (`hook_started` count 0, versus 3 in probe 3 without the flag). `--strict-mcp-config` gave `mcp_servers: []`; `--disable-slash-commands` gave `skills: 0`; `--tools Read` gave a one-tool catalog. Built-in agents still reported `agents: 5` — those are the bundled `Explore`/`Plan`/etc. definitions, unreachable without the `Agent` tool.

Design inference: the kernel-generated session UUID is the Claude analogue of Codex's `thread_id` and is the review-independence proof in `evaluate_gate`. `--setting-sources ""` + `--strict-mcp-config` + `--disable-slash-commands` + `--tools …` is the reviewer hermeticity profile. `--bare` is **not** usable because it refuses OAuth subscription credentials (`--help`: "OAuth and keychain are never read").

### 1.5 Rate-limit telemetry exists in-stream

**LIVE (today), probe 3.** `--output-format stream-json --verbose` emitted two `rate_limit_event` messages per turn:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1790100000,
 "rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled",
 "isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.12,"resetsAt":1790100000},
 "seven_day":{"utilization":0.03,"resetsAt":1790686800}}}}
```

`unifiedWindows` is new relative to crabgic's 2.1.210 capture. `resetsAt` is epoch seconds. `status ∈ {allowed, allowed_warning, rejected}` per the SDK types; **`rejected` has never been observed in-stream** by any sibling project (crabgic spikes, companion's 2,744 events). The only exhaustion ever seen arrived as the result string `You've hit your session limit · resets <time>` with `is_error: true`. **DOCS:** 2.1.234+ can wait and auto-continue after a reset in interactive sessions (`autoContinueAtUsageLimit`). Design inference: the kernel watches both channels, pauses the verification job with `resets_at`, and exposes `wait` as the deterministic next action. It never provokes a limit deliberately.

### 1.6 Hooks can block, and the Stop hook has a native loop guard

**DOCS (hooks-guide, 2.1.278).** `PreToolUse` can deny (exit 2 or `permissionDecision: deny`), rewrite input (`updatedInput`), and takes precedence over allow rules. `Stop` can force another turn with `decision: block` + `reason`; consecutive blocks are capped at **8** (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`), after which `stop_hook_active: true` is delivered and the hook should exit 0. `SessionStart` receives `source ∈ {startup, resume, clear, compact, fork}` and can inject `additionalContext`. `PreCompact` and `PostCompact` exist but cannot inject context; `SubagentStart`/`SubagentStop` are observational. Hook types: `command`, `http`, `prompt` (single-turn Haiku judge), `agent` (experimental multi-turn). Plugin-shipped `hooks/hooks.json` applies in consuming repositories when the plugin is enabled (2.1.268+). Hooks run for subagent tool calls. Default `command` timeout is 600 s.

**INHERITED (crabgic 2.1.220, `engine-baseline.md:705-733`; companion field runs).** `Stop` `decision: block` delivered the reason as the next instruction; `stop_hook_active` was false on first entry and true on re-entry. `PreCompact` output never reached the post-compaction context; `SessionStart` with matcher `compact|resume` did.

Design inference: devgod's six hook handlers map one-to-one (`SessionStart[startup|resume|compact]`, `PreCompact` checkpoint-only, `SubagentStart/Stop` observation, `Stop` bounded continuation). devgod's `MAX_STOP_CONTINUATIONS = 8` coincides with the engine cap. One Claude-only hook is added: a `PreToolUse` guard that denies a dozen reward-hacking shapes. Every hook fails **open**.

### 1.7 Auto mode, subscription plans, and model aliases

**DOCS.** Permission modes at 2.1.278: `default`, `acceptEdits`, `plan`, `auto` (classifier-backed, 2.1.228+, all plans, default for Pro/Max/Team interactive sessions), `dontAsk`, `bypassPermissions`. Project settings cannot set `defaultMode` to `auto` or `bypassPermissions`. Aliases: `opus` → Opus 5, `sonnet` → Sonnet 5, `haiku` → Haiku 4.5, `fable` → Fable 5.1, `opusplan`, `best`. Effort `low|medium|high|xhigh|max` (`xhigh` on Opus 4.7+, Sonnet 5, Fable). Subagent frontmatter accepts `model`, `effort`, `tools`, `disallowedTools`, `permissionMode`, `maxTurns`, `isolation: worktree`, `memory: user|project|local`, `hooks`, `skills`, `background`, `omitClaudeMd` (2.1.271+). Nesting depth default 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`), concurrency 20. `AGENTS.md` is read natively from 2.1.277 (not on Bedrock/Vertex/Foundry).

Design inference: the manager conversation should run in `auto` or `acceptEdits`; the kernel never sets it. Role agents pin `model` and `effort` in frontmatter. The consuming-repo instruction block goes in `CLAUDE.md` (canonical), not `AGENTS.md`.

## 2. Concept map — Codex → Claude Code

| devgod (Codex) | Archon (Claude Code) | Tier |
|---|---|---|
| `openai-codex` SDK + app-server JSON-RPC | `claude -p` CLI under the subreaper launcher; Agent SDK optional later | LIVE |
| `command/exec` with `sandboxPolicy: workspaceWrite, networkAccess: false` | kernel-owned `bwrap` execution, same profile, no model turn | LIVE (profile via engine), DOCS (`srt`) |
| `thread_start` + `outputSchema` + `sandbox: read-only` + `approvalPolicy: never` + MCP/plugins disabled | `claude -p --session-id U --json-schema S --tools Read,Grep,Glob,Bash --permission-mode dontAsk --setting-sources "" --strict-mcp-config --disable-slash-commands --settings <sandbox ro> --append-system-prompt-file <role> --model M --effort E --max-budget-usd B --output-format stream-json --verbose` | LIVE |
| `thread_id` / `turn_id` provenance | `session_id` (kernel-issued UUID, echoed in `init` and `result`) | LIVE |
| approval handler `deny_approval` | `dontAsk` + `--permission-prompts none`; `permission_denials` array as the audit trail | LIVE / DOCS |
| `AGENTS.md` managed block | `CLAUDE.md` managed block (`<!-- BEGIN ARCHON NATIVE -->`) | DOCS |
| `.agents/skills/devgod-manager/SKILL.md` | `.claude/skills/archon-manager/SKILL.md` (same frontmatter shape) | DOCS |
| `.codex/agents/devgod-*.toml` (Luna/Terra/Sol, `model`, `model_reasoning_effort`, `developer_instructions`) | `.claude/agents/archon-{familiar,warden,oracle}.md` (YAML `model`, `effort`, `tools`, body = instructions) | DOCS |
| `.codex/config.toml` `[mcp_servers.devgod]` + `tools.<name>.approval_mode = "approve"` | `.mcp.json` `archon` stdio entry + `.claude/settings.json` `permissions.allow: ["mcp__archon__*"]` | DOCS |
| `.codex/hooks.json` six events | `.claude/settings.json` `hooks` (or plugin `hooks/hooks.json`): `SessionStart`, `PreCompact`, `SubagentStart`, `SubagentStop`, `Stop`, plus `PreToolUse` guard | DOCS / INHERITED |
| `DEVGOD_MANAGED_REVIEW=1` recursion guard | `ARCHON_MANAGED_REVIEW=1` in the reviewer env, plus catalog removal of `Agent`/MCP | LIVE (catalog) |
| Goal mode | none needed; `Stop` continuation + `auto` mode | DOCS |
| `codex-cli app-server generate-json-schema` protocol pin | `claude --version` tested-range record; capability probes at `doctor` time | LIVE |
| `.codex` relocation inside review snapshots | relocate `.claude/**`, `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`, `AGENTS.md`, `.claude-plugin/**` | design |

## 3. Headless result contract (LIVE today)

`--output-format json` result object fields observed: `type: "result"`, `subtype: "success"`, `is_error`, `result` (text), `structured_output` (object or null), `session_id`, `total_cost_usd`, `num_turns`, `permission_denials[]`, `modelUsage{<model-id>: …}`, `usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, iterations, service_tier, speed, inference_geo, …}`. With `stream-json --verbose` the stream additionally carried `system/init` (`session_id`, `tools[]`, `mcp_servers[]`, `skills`, `agents`, `permissionMode`, `model`), `system/hook_started|hook_response`, `system/thinking_tokens`, `assistant`, `user`, `rate_limit_event`, and the final `result`. Error subtypes (DOCS): `error_max_turns`, `error_max_budget_usd`, `error_during_execution`, `error_max_structured_output_retries`. Exit codes (DOCS): 0 success, 1 failure/usage limit, 2 partial, 130 SIGINT, 143 SIGTERM.

`--max-turns` is **absent from `claude --help` at 2.1.278** (as it was at 2.1.210–2.1.218) although the CLI accepted it without complaint today. Treat it as unreliable; bound reviewers with `--max-budget-usd`, a kernel wall-clock timeout, and the launcher's SIGTERM.

## 4. Sandbox schema (DOCS, 2.1.278) — the subset Archon generates

```jsonc
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,          // settings.json default is false; Archon sets true
    "autoAllowBashIfSandboxed": true,   // reviewers: sandboxed Bash needs no prompt
    "allowUnsandboxedCommands": false,  // strict: never retry outside the sandbox
    "excludedCommands": [],
    "filesystem": { "allowWrite": ["<scratch>"], "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "<state dir>"], "denyWrite": ["<snapshot>"] },
    "network": { "allowedDomains": [], "strictAllowlist": true, "allowLocalBinding": false }
  }
}
```

Path prefixes: `/abs`, `~/`, or project-relative. Protected paths the sandbox always refuses to write (`.claude/settings*`, `.claude/agents`, `.mcp.json`, `.git/hooks`, `~/.claude/**`, …) are listed in the sandboxing doc. Subagents inherit the parent's sandbox. INHERITED (crabgic): egress denial surfaces as the proxy's HTTP 403 with `curl` exit 0 when a proxy is present, and `denyRead` masks as ENOENT — today's strict-allowlist probe showed the model reporting a block rather than a 403 page, so the exact shape must be re-recorded when the check runner is built (§7).

## 5. Statusline payload (INHERITED, binary-sourced at 2.1.220; DOCS at 2.1.278)

`{context_window: {used_percentage | null, context_window_size}, rate_limits: {five_hour: {used_percentage, resets_at}, seven_day: {…}, spend_limit?: {…}}, model: {id, display_name}, workspace: {current_dir, repo}, worktree?: {branch}, effort?: {level}, fast_mode, thinking}`. `used_percentage` is null before the first API response and after `/compact`; `rate_limits` is absent until the first response and only under subscription auth; `resets_at` is epoch seconds. A plugin cannot register a statusline; the installer must write `statusLine` into settings if the sensor is wanted. `$CLAUDE_PROJECT_DIR` is exported to the command. This is the only honest context-occupancy telemetry; Archon records it as a *sensor*, never as a gate (devgod design: no invented 70% rule).

## 6. Claude Code capabilities Codex lacked — adopted or deliberately declined

| Capability | Decision | Why |
|---|---|---|
| Blocking `PreToolUse` hooks | **Adopt, one small guard** | Denies `--no-verify`, `git push --force`, deleting test files, editing Archon-managed files, `rm` of state; ≤ 15 patterns, fail-open (companion H5: 27/27 transcript-scan false positives; archon's 3,572-line parser was theatre) |
| OS sandbox in settings + `srt` | **Adopt** (checks: kernel `bwrap`; reviewers: settings sandbox) | Replaces Codex `command/exec`; enforced at OS level with zero prompts (LIVE) |
| `dontAsk`, `--permission-prompts none`, `permission_denials` | **Adopt** for reviewers | Deny-by-default execution with an audit trail (LIVE) |
| `--json-schema` structured output | **Adopt, with local validation** | Model-mediated, so pydantic stays authoritative (LIVE) |
| `--session-id`/`--resume`/`--fork-session` | **Adopt** `--session-id` as provenance; `--resume` for interrupted reviewer recovery (read-only turns only) | LIVE round-trip; INHERITED crash-resume at 2.1.218 |
| `rate_limit_event` + statusline `rate_limits` | **Adopt** as pause/resume signal and sensor | Subscription reality (LIVE) |
| `auto` permission mode | **Recommend** for the manager session; kernel never sets it | Fewer host prompts; classifier is host-owned (DOCS) |
| Subagent `isolation: worktree` | **Allow** for the Warden's parallel independent tasks; candidate identity stays the delivery worktree | Native, but branches from the default branch, not HEAD (companion H3, $4.58 lesson) — the Warden must pass a base and reset |
| Subagent `memory:` | **Decline in v1** | No run has needed it; Archon's checkpoints are the memory |
| Agent teams | **Decline** | Experimental, no resume, breaking changes (DOCS) |
| `Workflow` tool | **Decline** | Experimental flag; duplicates the kernel |
| Plugin packaging (`.claude-plugin/plugin.json`, namespaced `/archon:…`, plugin hooks/agents/MCP) | **Ship the manifest inside the wheel; `init` overlay is the documented path** | Mirrors devgod's proven idempotent installer; plugin marketplace path is P6-optional |
| `claude plugin eval` | **Adopt in P6** for the manager skill's prompt regression | Real harness-level tests for prose (DOCS 2.1.269+) |
| Agent SDK in-process (Python `claude-agent-sdk`) | **Decline for v1; keep the adapter seam** | CLI + subreaper already gives receipts; SDK bundles its own engine version (crabgic: three engines on one host) |

## 7. Pitfalls that must be re-verified before freezing

Ordered by blast radius. Each becomes a P0 spike with an executed-call guard (zero tool calls ⇒ UNRESOLVED, never PASS; a model refusal ⇒ UNRESOLVED).

1. **`Agent` tool literal name and deny-as-catalog-removal.** At 2.1.218 the live literal was `Task` and `Agent` was an alias; at 2.1.278 the interactive catalog shows `Agent`. Conformance must assert absence from `system/init.tools`, not a `permission_denials` entry.
2. **Path-scoped deny inertness and `Read` directory scoping** (INHERITED n=1). Archon does not depend on them, but the reviewer profile must be probed with an attempted-and-blocked assertion, not a refusal.
3. **Sandbox vs engine `Write`/`Read` tools.** Reviewers remove those tools from the catalog; confirm the snapshot stays byte-identical after a reviewer run (already enforced by `verify_snapshot`).
4. **`stop_hook_active` on re-entry and the 8-block cap.** Probe with an independent marker-file guard. Losing this wedges an interactive session — release-blocking.
5. **`SessionStart` `source: compact` injection reaches the post-compaction context; `PreCompact` output does not.**
6. **`rate_limit_event` `status: rejected` shape** — never observed; detect the error-string channel too. Never trigger deliberately.
7. **`--max-turns` enforcement** — accepted but undocumented; do not rely on it.
8. **`error_max_structured_output_retries`** — documented, never observed; keep the null-`structured_output` handling.
9. **Plugin manifest component set at 2.1.278** (`hooks`, `agents`, `skills`, `mcpServers`, `bin`, `settings` limited to `agent`/`subagentStatusLine`) and `enabledPlugins` format.
10. **Sandbox denial shapes** under strict allowlist (403-page vs connection failure; ENOENT vs EACCES) so the check runner classifies "blocked" correctly instead of as a check failure.
11. **`isolation: worktree` base branch** still defaults to the default branch.
12. **Version-gate discipline.** Record the tested range as `[2.1.278, 2.1.278]` and widen only by re-running the spike suite at the new version. `doctor` reports an untested version as a **warning with a re-probe instruction**, never a hard block (crabgic locked itself at ≤2.1.224 against a 2.1.274 host).

## 8. Broader harness evidence carried forward

The four predecessor post-mortems (devgod, archon-TS, coder-waifu, crabgic; `project-companion/docs/case-studies/`) share eight root causes: never field-proven before hardening; completion authority in something the agent cannot fix; gate-fights-author spirals; prose corpora code never loads; evidence that vouches for itself; whole plan before first run; learning loop never closed; accidental scope. The mechanisms that earned their place — claimed ≠ verified, sealed acceptance criteria, sandboxed execution, `verification[]` as executed argv, deterministic next action from on-disk state, bounded fail-open Stop continuation, honest residuals, the vacuity probe, standing policy at install — are all already present in devgod-recovery's kernel or are one small addition. devgod-recovery itself died eight minutes into its first real run because `Policy` typed the sandbox as `Literal["workspace-write"]` with `/tmp` excluded, so `uv` could not write its cache: the Archon check profile therefore gives every check a private writable scratch **and** a private `TMPDIR` inside it, and the acceptance suite runs a real `uv`/`npm` fixture, not stdlib only.

---

## 9. Spike book results — 2026-09-22, engine 2.1.278

The book in [spikes.md](../spikes.md) was run on this host for $0.51. Verdicts: **7 PASS,
2 FAIL, 3 UNRESOLVED**, plus a PASS on the host checks. Every evidence file is under
`docs/evidence/2026-09-22-spike-*.json`. The two failures and the corrections they force
are the most valuable output of the exercise, so they are recorded first.

### Corrections this book forces on the sections above

| # | Section corrected | What was wrong | What is true at 2.1.278 |
|---|---|---|---|
| 1 | §7 item 1 | Said the catalog "shows `Agent`" at 2.1.278. | That was the *interactive* catalog. The **headless** default catalog uses the literal `Task` and contains no `Agent`, no `Grep` and no `Glob`: `Task, Bash, CronCreate, CronDelete, Edit, ListAgents, PushNotification, ReportFindings, TaskCreate, TaskStop, WebFetch, Workflow, Write`. The rule name `Agent` aliases `Task`, and `--disallowedTools Agent` does remove it. crabgic's 2.1.218 finding still holds. **S1 FAIL** was an expectation error, not an engine change. |
| 2 | §1.3, design §Verification | Implied the reviewer's tool catalog is exactly what `--tools` grants. | Passing `--json-schema` **auto-injects a `StructuredOutput` tool** on top of the allowlist. `--tools Read,Grep,Glob,Bash --json-schema S` yields `['Bash','Glob','Grep','Read','StructuredOutput']`. The hermeticity assertion must expect the requested set **plus** `StructuredOutput`, and must treat its absence as fatal. `Grep` and `Glob` are grantable by `--tools` even though absent from the default headless catalog, so the reviewer profile is unchanged otherwise. |
| 3 | §3 | Called `--max-turns` unreliable because it is absent from `--help`. | It is **enforced**: the result comes back `subtype: error_max_turns`. `--max-budget-usd` is likewise enforced as `error_max_budget_usd`. Both are usable bounds. Set the reviewer turn cap generously (≥ 40): a reviewer given a low cap exhausts it exploring the snapshot and returns a null payload, which is bound exhaustion masquerading as a refusal. |
| 4 | §1.4 | Assumed `skills` and `mcp_servers` are counts. | Both are **lists** in `system/init`; with `--disable-slash-commands` and `--strict-mcp-config` they are `[]`. Assert emptiness, not `== 0`. The granted tool list is returned **sorted**, not in requested order, so compare as a set. |
| 5 | design §Verification, "if a reviewer must be resumed … `--resume`" | Assumed `--resume` recovers an interrupted reviewer. | **S9 FAIL.** After `kill -9` mid-stream the transcript did **not** exist on disk, and `--resume <same id>` returned `subtype: success` with `num_turns: 1` — it silently started fresh rather than recovering. `--session-id` does round-trip reliably into both `init` and `result`, which is all the independence proof needs. Treat an interrupted reviewer as a new attempt with a new session id; do not claim crash recovery for reviewer sessions. |

### Verdicts

| Spike | Verdict | What was established |
|---|---|---|
| S1 tool catalog | **FAIL** | Expectation error, corrected above. Deny-as-catalog-removal works: `--disallowedTools Agent` removed the tool. `--tools` matches exactly. |
| S2 reviewer hermeticity | **UNRESOLVED** | Planted project and user hooks did not fire, `mcp_servers` and `skills` were empty, and the planted nonce did not leak — but the model answered without reading, so the executed-call guard refused to certify a PASS. The probe needs a task that forces a `Read`. The hermeticity signals themselves are all favourable. |
| S3 structured output | **PASS** | Mediation confirmed. Instructed Sonnet called `ToolSearch` then `StructuredOutput` and returned a valid payload; uninstructed Haiku returned `structured_output: null` with `subtype: success` and said it had no such tool. This is why every reviewer prompt names the tool and why Haiku is never a reviewer. |
| S4 engine sandbox | **UNRESOLVED** | The spike module raised `KeyError: 'http_code'`. A script defect, not an engine finding. The equivalent enforcement was measured directly during design (§1.1) and by S5. |
| S5 kernel bwrap profile | **PASS** | Egress blocked, `~/.ssh` masked, private `/tmp` and scratch writable, against the real `archon.sandbox` module. |
| S6 rate-limit signals | **PASS** | Both channels parse: `rate_limit_event{status: rejected}` and the `session limit` error string. Fakes only; no real limit was provoked. |
| S7 Stop hook | **PASS** | Two invocations observed, `stop_hook_active` **false** then **true**, the sentinel reason reached the model, marker-file guard fired. The engine's own re-entry signal is real and is what bounds continuation. |
| S8 post-compaction channel | **UNRESOLVED** | Honestly deferred: forcing a ≥100k-token compaction inside a single `-p` run would consume most of the book's budget. The inherited finding stands unverified at 2.1.278. |
| S9 session identity | **FAIL** | Corrected above. `--session-id` round-trips; `--resume` after SIGKILL does not recover. |
| S10 bounds | **PASS** | `error_max_turns` and `error_max_budget_usd` both observed. |
| S11 plugin manifest | **PASS** | `claude plugin validate` passes with warnings; marketplace add and install work against an isolated `CLAUDE_CONFIG_DIR`. |
| S12 auth | **PASS** | `--bare` refuses OAuth (exit 1). Both the real config dir and an isolated dir holding only a 0600 `.credentials.json` succeed; the isolated one is the recommended default because it exposes the fewest secrets. |
| host | **PASS** | Claude Code 2.1.278, bubblewrap 0.9.0, socat 1.8.0.0, user namespaces permitted, `os.pidfd_open` available. |

### Standing obligations

S2, S4 and S8 are UNRESOLVED and therefore **restrict**: downstream code may use only the
literal confirmed forms recorded in their evidence files and must not generalize. S2 and S4
are probe defects and should be repaired and re-run before release; S8 needs either an
interactive harness or a deliberate budget allocation. The tested engine range is
`[2.1.278, 2.1.278]` and widens only by re-running this book.

## 10. Second book run — 2026-09-22, engine 2.1.278, after probe repair

Three probes were repaired and re-run. All three now resolve **PASS**, and the tested
engine range is unchanged at `[2.1.278, 2.1.278]`. Total spend for the repair run was
`$0.24`. The §9 verdict table above is superseded for S1, S2 and S4 only; every other row
still stands, and S8 remains honestly UNRESOLVED.

| Spike | Was | Now | Why it changed |
|---|---|---|---|
| S1 tool catalog | FAIL | **PASS** | The criterion was wrong, not the engine. It demanded the literal `Agent`; the engine reports `Task`. The spike now records which spelling is live and still requires that `--disallowedTools Agent` remove it. Observed removal set is exactly `['Task']`. |
| S2 reviewer hermeticity | UNRESOLVED | **PASS** | The probe never reached a model turn. See correction 6 below. |
| S4 engine sandbox | UNRESOLVED (then inconclusive) | **PASS** | Two separate defects, corrections 7 and 8 below. |

### Further corrections

| # | Section corrected | What was wrong | What is true at 2.1.278 |
|---|---|---|---|
| 6 | §5, design §Verification | Assumed a reviewer session can be isolated by pointing `CLAUDE_CONFIG_DIR` at an empty directory. | **Subscription credentials live inside that directory.** An empty one de-authenticates the session: the engine answers `Not logged in · Please run /login` with `error: authentication_failed`, `total_cost_usd: 0` and `num_turns: 1`. No model turn happens at all. Relocation is still correct, but the credential file must be carried across — `claude_adapter` copies a 0600 copy into its 0700 control directory and purges it, and falls back to the user's own directory when no credential file exists. Suppression of the user tier comes from `--setting-sources ''`, never from moving the directory. |
| 7 | §1.1 | Recorded `denyRead` as producing "ENOENT vs EACCES" without distinguishing them. | `denyRead` presents as **ENOENT**: the path is made invisible, not unreadable. Proven by planting the same file under two names — one masked, one not — and reading both in one session. The masked read returned `cat: …/planted.txt: No such file or directory`; the control read returned the nonce. A masked path is therefore indistinguishable from an absent one by error shape alone, which is why the original arm against `~/.ssh/id_rsa` proved nothing on a host that has no `id_rsa`. |
| 8 | §1.1 | Recorded only one egress denial shape. | There are **two**, and both must be recognized. A `curl` under `strictAllowlist` first produces a tool-level refusal, `allowed_domains cannot widen network access in this session`, and on the attempt that reaches the network, exit code **56** with a `<sandbox_violations>` block reading `deny network-outbound example.com:443 (host is not on the allow list)`. `denyWrite` is distinct again: exit 1, `Read-only file system`. `permission_denials` stayed `[]` throughout — a sandbox denial is never a permission prompt. |

### What the repair run established about probe design

Two of the three original failures were the probe lying to itself rather than the engine
misbehaving, and both were caught only because the evidence was read rather than the
verdict. S2's executed-call guard did its job: it refused to certify hermeticity from a
session that never authenticated, even though every hermeticity signal looked clean. S4's
masked-read arm did not have such a guard, passed its verdict on other criteria, and
recorded an error shape that was really just a missing file. **A negative result needs a
positive control.** Every masking arm now plants its own target and pairs it with an
identical unmasked control.
