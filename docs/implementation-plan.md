# Archon implementation plan

Date: 2026-09-22. Scope: implementation sequencing and shared contracts for the design in [design.md](design.md). The user has supplied the product decisions; implementation proceeds without further product questions. This document is a plan, not evidence that the product exists. Platform facts it relies on are tiered in [the research record](research/2026-09-22-claude-code-platform.md); anything tiered DOCS or INHERITED is re-proved in [the spike book](spikes.md) before the code that depends on it may claim completion.

## Delivery contract

The user keeps working in an existing Claude Code session. An intentionally enabled consuming repository routes substantive engineering work through Archon. Delivery ends on an implemented, verified local branch ready for human review. No PR, merge, deployment, or global settings change follows.

The selected direction: Python package `archon`, local SQLite kernel, Claude Code CLI as the only model runtime, native manager and implementation subagents, a small repository overlay. Kernel-owned evidence decides verified completion. Claude Code owns the conversation and the continuation loop. Checks run under a kernel-owned `bwrap` profile with no model turn; reviewers are kernel-launched hermetic `claude -p` sessions.

Dependency contract: Python ≥ 3.12, `mcp==2.2.0` (`MCPServer`, not `FastMCP`), `pydantic>=2,<3`, `bubblewrap` and `socat` on the host, Claude Code CLI on `PATH` with an authenticated login. No Anthropic SDK dependency: the kernel never calls the API directly. The tested engine range is **derived from the evidence on record and never typed here**, which is why this sentence names no version. A version counts only once every spike in the book has a verdict for it; a partial book widens nothing. At the time of writing two versions qualify, and `doctor` warns — never blocks — on anything outside the range.

## Starting point — what is ported and what is written

`../devgod-recovery` is the donor. Its kernel is ~2,900 lines and 86 kernel-only tests that port with mechanical renames; its Codex edge is ~1,900 lines and 81 tests that are rewritten. The coupling map:

| Donor module | Lines | Action |
|---|---|---|
| `models.py` | 372 | **Port.** Rename `Policy` fields (§Shared contracts), add `paused` job state and `wait` action, rename `thread_id`→`session_id`, `turn_id`→`result_uuid`. |
| `store.py` | 587 | **Port verbatim** plus the `paused`/`resume_at` columns and `pause_job`/`unpause_due_jobs`. |
| `workspace.py` | 699 | **Port.** Replace the `.codex` relocation predicate (`:573-578`) with the Claude predicate. |
| `verification.py` | 826 | **Port.** `thread_id`→`session_id` in `_review` and `evaluate_gate`; `process_identity` field filter widened; rate-limit pause handling in `_review` and `_pipeline`. |
| `service.py` | 425 | **Port.** Add `wait` next action and `paused` run reason. |
| `mcp_server.py` | 278 | **Port.** Server name `Archon`; tool names unchanged. |
| `cli.py` | 278 | **Port.** Command spelling unchanged; `hook` gains `--event` passthrough for tests. |
| `launcher.py` | 202 | **Port lines 1–176 verbatim.** Rewrite `main()` to exec either the check argv under `bwrap` or `claude -p …`. |
| `hooks.py` | 192 | **Rewrite** for Claude event names and payloads; add the `PreToolUse` guard. |
| `codex_adapter.py` | 910 | **Replace** with `claude_adapter.py` + `sandbox.py`. |
| `install.py` | 648 | **Port the primitives** (`_safe`, `_write`, `_backup`, `_block`, `_json_members`/`_set_json`/`_merge_hooks`); **rewrite** `init`/`uninstall`/`doctor`/`--migrate` targets. |
| `assets/**` | — | **Rewrite** as Claude assets ([assets.md](assets.md)). |
| tests (kernel) | 86 | **Port.** |
| tests (Codex) | 81 | **Rewrite** as `test_claude_adapter.py`, `test_sandbox.py`, `test_install.py`, `test_hooks.py`, `test_smoke_config.py`. |
| `scripts/live_smoke.py`, `native_smoke.py`, `package_smoke.py` | 929 | **Rewrite** the runtime half; keep the fixture and validators. |

The integrator copies the donor tree into `src/archon/` at P0 with `git subtree`-free plain copy and a recorded donor commit hash (`2973b2d`), so `git log` shows a single "port baseline" commit before any edit.

## Component ownership and package order

The root session integrates shared contracts, packaging, and cross-component changes. Each specialist owns the listed modules and their tests. A specialist proposes shared-contract changes to the integrator before touching another owner's files. Familiars take P1–P5 packets; the Warden owns P0 and integration; the Witnesses own P6.

| Package | Sole write scope | Depends on | Exit evidence |
|---|---|---|---|
| **P0 Contracts, baseline, spikes** — Warden | `pyproject.toml`, `src/archon/models.py`, `src/archon/__init__.py`, `.github/workflows/ci.yml`, `docs/evidence/2026-09-*-spike-*.json`, `scripts/spikes/*.py` | — | Donor copied and renamed; `uv sync --locked`; `bash scripts/check.sh` green on the ported kernel tests with the adapter stubbed; **all twelve spikes in [spikes.md](spikes.md) run with recorded JSON evidence**, each PASS or UNRESOLVED with its literal confirmed form. |
| **P1 Durable kernel** — Familiar (domain) | `store.py`, `service.py`, `tests/test_store.py`, `tests/test_service.py` | P0 | `paused` job state, `resume_at`, `pause_job`, `unpause_due_jobs`, `wait` next action; all ported store/service tests pass; new tests: paused job is not reclaimable before `resume_at`, `status` reports `wait` with the reset time, `resume` after the window re-queues exactly once. |
| **P2 Workspace and consumer installation** — Familiar (workspace) | `workspace.py`, `install.py`, `hooks.py`, `src/archon/assets/**`, `tests/test_workspace.py`, `tests/test_install.py`, `tests/test_hooks.py`, `tests/test_manager_assets.py` | P0; consults P1 state paths | Claude relocation predicate; `init`/`doctor`/`uninstall`/`--migrate` against clean, pre-configured, TS-Archon, and DevGod fixtures; byte-idempotent re-init; comments and key order in `.claude/settings.json` preserved; hook handlers for every event in §Hooks with fail-open tests; `PreToolUse` guard table tests. |
| **P3 Claude adapter and sandbox** — Familiar (runtime), Warden reviews | `claude_adapter.py`, `sandbox.py`, `launcher.py`, `tests/test_claude_adapter.py`, `tests/test_sandbox.py`, `tests/fixtures/claude/*.jsonl` | P0 and spikes S1–S8 | `run_command` under real `bwrap` with recorded fixtures; `run_review` against a **fake `claude` binary** that replays recorded `stream-json`; init-catalog verification; null-`structured_output` handling; rate-limit signal on both channels; cancellation; termination receipts; `capabilities()`; the five pidfd tests ported verbatim. |
| **P4 Verification execution** — Familiar (verification) | `verification.py`, `tests/test_verification.py`, `tests/test_acceptance.py` | Stable P0 contracts; consumes P1–P3 | Session-ID independence in `evaluate_gate`; pause/resume through the pipeline; all ported verification and acceptance tests pass with the simulated adapter; a real-`bwrap` acceptance fixture with a `uv` project whose check writes a cache. |
| **P5 Interface, packaging, integration** — Warden | `cli.py`, `mcp_server.py`, `README.md`, `docs/operations.md`, `scripts/check.sh`, `scripts/*_smoke.py`, distribution metadata | P1–P4 | CLI and MCP share service methods; every documented command works; wheel ships the plugin manifest and assets; clean install completes a real local-branch workflow in `package_smoke.py`. |
| **P6 Independent release gates** — the Witnesses (reviewer, QA, security) | findings and evidence artifacts only | begins during P1–P5; final after P5 | Acceptance matrix verified; fault injection; install/removal on configured repos; **live smoke** and **native manager run** recorded separately; `claude plugin eval` suite for the manager skill; security review of the sandbox profile and reviewer hermeticity. |

Steps P1–P3 run in parallel after P0. P4 starts when P1's store API and P3's adapter signatures are frozen (the integrator publishes a one-page "frozen" note in `docs/evidence/`). P5 integrates continuously.

## Shared Python contracts

Typed, validated domain records with JSON serialization at public boundaries. Pydantic `Model` with `extra="forbid"` as in the donor. Identifier, Digest, PathText constraints unchanged.

### `models.py` deltas

```python
class JobStatus(StrEnum):
    QUEUED = "queued"; RUNNING = "running"; PAUSED = "paused"
    SUCCEEDED = "succeeded"; FAILED = "failed"; INTERRUPTED = "interrupted"; CANCELLED = "cancelled"

Role = Literal["reviewer", "qa_engineer", "security_reviewer"]
ModelAlias = Literal["opus", "sonnet", "haiku", "fable"]

class ModelRoute(Model):
    model: ShortText                      # alias or full ID; validated nonblank
    effort: Literal["low", "medium", "high", "xhigh", "max"] = "high"

class Policy(Model):
    review_routes: dict[Role, ModelRoute] = {}      # default: opus/high for every role
    review_model: ShortText | None = None            # shorthand for all three
    fable_allowed: StrictBool = False                # Oracle may use fable; else opus/max
    max_parallel_reviews: int = Field(default=3, ge=1, le=3)
    max_attempts: int = Field(default=3, ge=1, le=5)
    command_timeout_seconds: int = Field(default=600, ge=1, le=3600)
    review_timeout_seconds: int = Field(default=900, ge=1, le=3600)
    review_budget_usd: float = Field(default=3.0, gt=0, le=50)
    max_output_bytes: int = Field(default=1_048_576, ge=1024, le=16_777_216)
    network_access: Literal[False] = False           # kept Literal on purpose; widened only by a run that needs it
    def review_route(self, role: Role) -> ModelRoute: ...   # explicit > review_model@high > ModelRoute("opus","high")

class ReviewResult(Model):
    role: Role; invocation_id: Identifier
    session_id: Annotated[str, StringConstraints(strict=True, max_length=96)]   # kernel-issued UUID echoed by init+result
    result_uuid: ShortText | None = None                                         # the result message uuid, if present
    payload: ReviewPayload | None = None
    error: Text | None = None
    rate_limited_until: int | None = None    # epoch seconds when the provider paused the session
    duration_seconds: float = 0
    cost_usd: float | None = None
```

`CheckSpec`, `TaskSpec`, `RunSpec`, `Candidate`, `JobLease`, `NextAction`, `CommandResult`, `GateResult`, `VerificationResult`, `ReviewPayload`, `Finding` are unchanged. `CommandResult` gains `sandbox_profile_digest: Digest` (sha256 of the rendered `bwrap` argv minus paths) so evidence binds to the exact confinement. **Binding means comparison, not presence.** The field was originally recorded and never read, so a result carrying `None` passed the gate while this sentence claimed otherwise; the gate now refuses a check with no digest, refuses a candidate whose checks name two different profiles, and compares the recorded digest against the one the kernel itself renders through `ClaudeAdapter.check_profile_digest`.

`Policy.scratch_bytes` was removed. It was an advertised bound with no mechanism — nothing in the tree ever sized the scratch, and `render_bwrap` emits `--tmpfs` with no size — which is the inverse of "no mechanism without a run that needed it" and worse than no field at all. Removing it required store schema v3, which strips the key from older records on open.

`NextAction.action` gains `"wait"` with `inputs={"job_id", "resume_at"}`.

### `ExecutionAdapter` (unchanged protocol, new implementation)

```python
class ExecutionAdapter(Protocol):
    async def run_command(self, spec: CheckSpec, candidate: Candidate, policy: Policy,
                          on_event: EventCallback | None = None, *, invocation_id: str | None = None) -> CommandResult: ...
    async def run_review(self, role: Role, candidate: Candidate, packet: dict[str, Any], policy: Policy,
                         on_event: EventCallback | None = None, *, invocation_id: str | None = None) -> ReviewResult: ...
    async def cancel(self, invocation_id: str) -> None: ...
    def termination_confirmed(self, invocation_id: str) -> bool: ...
    async def recover_termination(self, identity: dict[str, Any]) -> bool: ...
    async def capabilities(self) -> dict[str, Any]: ...
    async def close(self) -> None: ...
```

### `sandbox.py` — the check profile (P3)

```python
@dataclass(frozen=True)
class CheckProfile:
    worktree: Path; scratch: Path; state_dir: Path; home: Path
    masked: tuple[Path, ...] = ("~/.ssh", "~/.aws", "~/.gnupg", "~/.claude", "~/.config/gh", "~/.netrc")
    def argv(self, command: Sequence[str], cwd: Path, env: Mapping[str, str]) -> list[str]: ...
    def digest(self) -> str: ...

def render_bwrap(profile: CheckProfile, command, cwd, env) -> list[str]:
    # bwrap --unshare-net --unshare-pid --unshare-uts --unshare-ipc --die-with-parent --new-session
    #   --ro-bind / /  --dev /dev --proc /proc --tmpfs /tmp
    #   --bind <worktree> <worktree>  --bind <scratch> <scratch>
    #   --tmpfs <masked>… (each masked path that exists)  --tmpfs <state_dir>
    #   --setenv TMPDIR <scratch>/tmp --setenv TMP … --setenv TEMP … --setenv HOME <scratch>/home
    #   --clearenv + explicit allowlist: PATH, LANG, LC_ALL, TERM, plus repo-declared passthrough names
    #   --chdir <cwd> -- <command…>
```

Rules: the profile is a frozen tuple; `CheckSpec` cannot add binds; `network_access` stays `False`; the worktree bind is read-write because checks run in the active worktree (DevGod design) and source is hashed before and after; a `.venv`, `node_modules`, `.uv-cache` inside the worktree therefore work. The scratch directory holds `tmp/` and `home/` so `uv`, `npm`, `pip`, `cargo` caches (which default under `$HOME` or `$TMPDIR`) land in a writable, private place. `probe_bwrap()` runs `bwrap --ro-bind / / --unshare-net -- true` at `doctor` time and before every dispatch; unavailability stops execution before the child starts (mirrors the pidfd probe).

Reviewer sandbox is **not** `bwrap` from the kernel; it is the engine's own settings sandbox rendered as JSON:

```python
def review_settings(snapshot: Path, scratch: Path, state_dir: Path) -> dict:
    return {
      "permissions": {
        "defaultMode": "dontAsk",
        "allow": ["Read", "Grep", "Glob",
                  "Bash(cat *)", "Bash(ls *)", "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)",
                  "Bash(grep *)", "Bash(rg *)", "Bash(find *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)",
                  "Bash(sed -n *)", "Bash(python3 -c *)", "Bash(python -c *)", "Bash(node -e *)"],
        "deny": ["Write", "Edit", "NotebookEdit", "Agent", "WebFetch", "WebSearch", "Skill",
                 "EnterWorktree", "ExitWorktree", "Monitor", "SendMessage", "CronCreate", "RemoteTrigger",
                 "Bash(git commit *)", "Bash(git push *)", "Bash(git checkout *)", "Bash(git reset *)",
                 "Bash(rm *)", "Bash(mv *)", "Bash(cp *)", "Bash(curl *)", "Bash(wget *)", "Bash(ssh *)",
                 "Bash(sudo *)", "Bash(tee *)", "Bash(> *)"]
      },
      "sandbox": {"enabled": True, "failIfUnavailable": True, "autoAllowBashIfSandboxed": True,
                  "allowUnsandboxedCommands": False,
                  "filesystem": {"allowWrite": [str(scratch)], "denyWrite": [str(snapshot)],
                                 "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", str(state_dir)]},
                  "network": {"allowedDomains": [], "strictAllowlist": True, "allowLocalBinding": False}},
      "attribution": {"commit": "", "pr": "", "sessionUrl": False},
      "env": {"ARCHON_MANAGED_REVIEW": "1"}
    }
```

Deny rules by bare name remove the tool from the catalog; the `--tools Read,Grep,Glob,Bash` flag does the same from the other side. Path-scoped denies are **not** relied on (inherited finding). The snapshot is already mode `0555`/`0444`, so a write attempt fails at the filesystem even if a layer is bypassed.

### `claude_adapter.py` (P3)

```python
class ClaudeAdapter:
    def __init__(self, *, receipt_root: Path, claude_bin: str = "claude", config_dir: Path | None = None): ...
    async def capabilities(self) -> dict   # claude --version, tested_range, bwrap probe, pidfd probe, auth status via `claude auth status --json`? (spike S12) ; no live model call
    async def run_command(...)             # sandbox.render_bwrap → launcher.supervise → CommandResult with receipt
    async def run_review(...)              # build packet file (0600) + settings file + role prompt file in a private job dir;
                                           # launcher.supervise(["claude","-p",…]) ; parse stream-json ; verify init ; validate result
    async def cancel(invocation_id)        # SIGTERM via pidfd, 5 s, then receipt wait
    ...
```

`run_review` event handling, in order:

1. `system/init`: assert `session_id == requested`; `tools` **as a set** equals `{"Read","Grep","Glob","Bash"} | {"StructuredOutput"}`, because `--json-schema` injects that tool on top of `--tools` and the engine returns the catalog sorted rather than in requested order (S1, second book run); `mcp_servers` and `skills` both **empty** — they are lists, not counts, so assert emptiness and never `== 0`; `permissionMode == "dontAsk"`; `model` starts with the requested family. Any mismatch, including a *missing* `StructuredOutput`, → `AdapterError("reviewer session not hermetic")`; the session is cancelled and **no result is accepted**.
2. `rate_limit_event`: record `unifiedWindows`; on `status == "rejected"` set `rate_limited_until = resetsAt` and cancel the session.
3. `assistant` with `tool_use`: count; a `tool_use` whose name is not in the allowed catalog aborts the review (defence in depth; the engine already removed them).
4. `result`: assert `session_id`; if `is_error` and the text matches `hit your .* limit`, parse the reset time and raise a rate-limit pause; if the subtype is `error_max_turns` or `error_max_budget_usd`, report **bound exhaustion**, distinctly from refusal — both bounds are enforced (S10) and an exhausted reviewer returns `structured_output: null`, which is indistinguishable from a refusal by payload alone, so the turn cap must be generous (≥ 40) or reviewers exhaust themselves exploring the snapshot; if `structured_output is None` → `AdapterError("no structured output")` (bounded retry, never evidence); else `ReviewPayload.model_validate`. Record `total_cost_usd`, `permission_denials`, `num_turns`, `result.uuid`.
5. Pass requires `termination_confirmed()` after close, as for commands.

Stdout of `claude` is the only channel parsed; stderr is captured to an artifact, capped. Output caps come from `policy.max_output_bytes`. The role prompt and packet are never passed on the command line (argv is visible to other processes); the prompt goes on stdin and the role text through `--append-system-prompt-file` in the 0700 job directory.

`launcher.main()` becomes:

```
archon-launch <control_dir> <nonce> check   -- <bwrap argv…>
archon-launch <control_dir> <nonce> review  -- claude -p …
```

Both branches call `supervise(command, receipt_dir, nonce)` unchanged; `review` additionally sets `CLAUDE_CONFIG_DIR`.

S12 and the S2 repair settled the open question, and the answer inverted the placeholder default. **The default is an isolated config directory** under the 0700 control directory, holding a 0600 copy of the credential file and purged in a `finally`; it exposes the fewest secrets to the reviewer. It is not optional hardening but a correctness requirement in one direction: an isolated directory *without* the credential file de-authenticates the session outright, which the engine reports as `Not logged in` with `error: authentication_failed`, zero cost and one turn, and which looks like a silent refusal. When the host has no credential file — keychain or API-key auth — the adapter falls back to the user's own directory rather than handing the reviewer an empty one.

### Persistence (P1)

`jobs` gains `resume_at INTEGER NULL`. `claim_job` skips `paused` rows and rows with `resume_at > now`. `pause_job(job_id, attempt, token, resume_at)` is lease-fenced like `finish_job`. `reconcile_jobs` moves `paused` rows whose `resume_at` has passed back to `queued` with the same attempt (a pause is not a failure and consumes no attempt). `list_jobs` exposes `resume_at`. Everything else is the donor schema at `user_version=2` with a migration from 1.

### Verification (P4)

`_review` catches `RateLimited(resume_at)` from the adapter, calls `store.pause_job` for the review child **and** the coordinator, and returns; `_pipeline` treats a paused child as "not finished" and exits without failing the coordinator. `evaluate_gate` requires distinct `invocation_id` **and** distinct `session_id` across the three approving reviews. `_invoke` stores `process_identity` from the receipt plus `session_id`, `model`, `cost_usd`.

### Service and MCP (P1/P5)

`status()` reports `next_action: wait` with `resume_at` while any owned job is paused; `wait(job_id, timeout≤60)` returns early when the job leaves `paused`. `resume()` calls `reconcile_jobs` which requeues due jobs. MCP tools: `run_start, plan, task_update, checkpoint, status, next, verify, verification_status, wait, resume, recover, cancel` — identical names to DevGod so the manager skill text ports.

## Consumer surface and distribution

### What `init` writes (P2)

| Path | Format | Rule |
|---|---|---|
| `.claude/skills/archon-manager/SKILL.md` | Markdown + YAML frontmatter | Numbered on collision; `name:` rewritten to the directory name. |
| `.claude/agents/archon-familiar.md`, `archon-warden.md`, `archon-oracle.md` | YAML frontmatter + body | An existing or user-edited file stays active; the packaged version goes to private backups as `.new`. |
| `CLAUDE.md` | marker block `<!-- BEGIN ARCHON NATIVE -->` … `<!-- END ARCHON NATIVE -->` | Created if absent; appended otherwise; exactly one block. |
| `.mcp.json` | span-preserving JSON edit of `mcpServers.archon` | Name collision → `archon_workflow`, `archon_workflow_N`. `command` is the absolute Python from the tool environment, `args = ["-I", "-m", "archon", "--repo", <root>, ("--state-home", …)?, "mcp"]`, `env = {"PYTHONNOUSERSITE": "1"}`. |
| `.claude/settings.json` | span-preserving JSON edit | `permissions.allow` gains `"mcp__<server>__*"`; `hooks.<Event>[]` gains Archon's groups (see §Hooks). Existing entries, comments, and order untouched. Adds `statusLine` (the `archon statusline` sensor) only when the file has none. **Never** writes `defaultMode`, `model`, or `sandbox`. |
| `.archon/native-install.json` | manifest v1, mode 0600 | Ownership, content hashes, runtime paths, created-flags. |
| `.gitignore` | append `.archon/`, `.claude/worktrees/` if absent | Only if the file exists or `--gitignore` is passed. |

Hook command: `/usr/bin/env -u PYTHONPATH -u PYTHONHOME PYTHONNOUSERSITE=1 <abs python> -I -m archon --repo <root> hook` with `timeout: 5`. Hook groups:

| Event | Matcher | Purpose |
|---|---|---|
| `SessionStart` | `startup\|resume\|compact` | Inject bounded run summary + next action as `additionalContext`. |
| `PreCompact` | — | Checkpoint only; emits nothing. |
| `SubagentStart` | — | Inject "execute only the assigned scope; do not start another Archon run" as `additionalContext`. |
| `SubagentStop` | — | Record observation + checkpoint. |
| `Stop` | — | Bounded continuation (`decision: block`, reason = next action) when actionable work remains; always yields on `stop_hook_active`. |
| `PreToolUse` | `Bash\|Edit\|Write\|NotebookEdit` | Guard table (assets.md §Guard); `permissionDecision: deny` with reason; otherwise `{}`. |

Every handler returns `{}` when no Archon run exists in the worktree, when `ARCHON_MANAGED_REVIEW=1`, or on any internal error (fail open with a `systemMessage`).

### `doctor` (P2 + P5)

Reports: manifest loads; managed files' digests; `.mcp.json` entry present and pointing at the installed runtime; `permissions.allow` contains the server glob; every hook group present verbatim; `claude --version` inside/outside the tested range (**warning**, with `scripts/spikes/run_all.py` as the remedy); `bwrap`/`socat` present and `probe_bwrap()` passes; pidfd probe; login state via `claude auth status` (`loggedIn`, `subscriptionType`, without printing the email); `permissions.defaultMode` if set to `bypassPermissions` → note. It cannot observe the model selected in the UI, hook trust prompts, or whether a subagent actually spawned, and says so.

### `--migrate`

Recognizes and archives: the TypeScript Archon overlay (`.archon/ACTIVE`, `.archon/work/**`, `.archon/rules/**`, `.claude/hooks/archon-*.mjs`, `.claude/agents/<31 names>/AGENT.md`, `.claude/skills/archon-*`, the `archon:` npm scripts block, `ARCHON_CORE_DATABASE_URL` env template) and the DevGod overlay (`AGENTS.md` block, `.agents/skills/devgod-manager`, `.codex/agents/devgod-*.toml`, `.codex/config.toml` section, `.codex/hooks.json` entries). Unchanged files are archived by hash; modified files are left in place and reported. Old `.archon/memory/**` is retained as reference, never imported as evidence.

### Distribution

`uv tool install .` gives an isolated environment; `init` records that interpreter. The wheel also carries `.claude-plugin/plugin.json` (`name: archon`, `skills`, `agents`, `hooks`, `mcpServers`) so `claude plugin install --plugin-dir` works for evaluation and `claude plugin eval` can run the manager suite; the documented consumer path remains `init`.

## Acceptance matrix

AC-01 … AC-15 are carried over from DevGod's matrix ([`../devgod-recovery/docs/implementation-plan.md`](../../devgod-recovery/docs/implementation-plan.md)) with "Codex" read as "Claude Code". Claude-specific additions:

| ID | Required behavior | Verification |
|---|---|---|
| AC-16 | Checks are OS-confined. | Under the real profile: egress to a listening local port and to an external host fails; a write to `$HOME/.ssh/marker` and to the state directory fails; `uv sync` and `npm ci` fixtures succeed writing caches under the scratch; source digests are unchanged after a check that tries to edit a tracked file outside its worktree bind. |
| AC-17 | Reviewers are hermetic. | A fixture consuming repo with a planted `.claude/settings.json` hook, `.mcp.json` server, `CLAUDE.md` instruction, and project skill: none appear in the reviewer's `system/init`; the planted hook's marker file is absent; the review output contains no planted token. Executed-call guard: the reviewer made ≥ 1 `Read` call. |
| AC-18 | Null structured output is not evidence. | A fake `claude` replaying `subtype: success` with `structured_output: null` yields a failed review child, bounded retries, and a `repair`/`inspect` next action, never `verified`. |
| AC-19 | Rate-limit pause is resumable and free. | Fake `claude` emits `rate_limit_event{status: rejected, resetsAt: T}` (and separately the error-string result): job → `paused`, `status.next_action == wait`, attempt count unchanged, job requeued exactly once at `T`, evidence from before the pause reused. |
| AC-20 | Independence is proven by session identity. | Two approving reviews sharing a `session_id` do not satisfy the gate. |
| AC-21 | Hooks fail open and never lock. | With the state directory unreadable, every hook returns `{}`/`systemMessage`, no `decision: block`, no `permissionDecision: deny`. The Stop hook yields on `stop_hook_active: true` and after eight continuations. |
| AC-22 | Version drift is a warning. | `doctor` with a spoofed `claude --version` outside the tested range exits 0 with a warning naming the spike runner. |
| AC-23 | Installer preserves Claude Code configuration byte-for-byte outside owned spans. | Fixture `.claude/settings.json` with comments, trailing commas removed only inside the owned member, and unusual key order; diff after `init` touches only the owned spans; `uninstall` restores the original bytes when nothing else changed. |

The deterministic suite must cover, in addition to DevGod's list: init-catalog mismatch, unexpected `tool_use` name in a review stream, `claude` exiting 1 with a usage-limit message, `claude` missing from `PATH`, `bwrap` missing, `bwrap` present but user namespaces disabled, a check whose command reads `~/.ssh`, a check that spawns a detached child, the guard table's allow and deny rows, and `--migrate` from each of the two legacy overlays.

## Live proof

Three scripts, all opt-in, all recording engine version, source hashes, and cost:

- `scripts/live_smoke.py --allow-live`: DevGod's calculator fixture; first `verify` must fail on the real check, repair, re-verify with three real Witnesses (three distinct `session_id`s, `structured_output` present in each), gate `verified`, then an edit flips it back to `repair`. Also asserts `bwrap` blocked a planted `curl`.
- `scripts/native_smoke.py`: installs the wheel in a clean venv, runs `init` in a fixture repo, starts `claude -p` as the **manager** with the project's settings (this is the one place the manager runs headless) using `--permission-mode acceptEdits`, and asserts: two dependent tasks reached `verified`, both Familiars and the Warden appear in the `SubagentStart` events, 17-ish MCP calls, zero permission prompts, the five terminal headings in order, and that `~/.claude/settings.json` and credentials are byte-identical before and after.
- `scripts/package_smoke.py [--online]`: wheel install, `init` twice (byte-idempotent), `doctor`, `uninstall` preserving user content, plugin manifest present.

Before freezing integration: authentication and model access, `bwrap` on the CI runner (GitHub Ubuntu images need `sudo apt install bubblewrap socat` and may need the AppArmor profile), and the reviewer hermeticity assertion must each be exercised for real, never satisfied by synthetic passing records. Independent correctness, QA, and security reviews remain blocking release gates.
