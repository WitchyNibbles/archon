# The spike book — P0 capability proofs

Twelve probes that must run against the installed engine before any P3/P4 code may claim completion, and again before the tested range is widened. Each is a small script under `scripts/spikes/` that writes `docs/evidence/<date>-spike-<id>.json` with `{engine_version, verdict, literal_form, observations}`. Verdicts are **PASS**, **FAIL**, or **UNRESOLVED**. Rules inherited from crabgic's spike discipline:

- **Executed-call guard.** A probe that made zero tool calls, or where the model refused, is UNRESOLVED, never PASS. Blocked arms assert *attempted-and-blocked* with the observed error shape.
- **Measure the engine, not the harness.** Every run starts with `claude auth status` and a trivial authenticated call; if either fails the whole book is UNRESOLVED (crabgic recorded two byte-identical 8-FAIL runs from an expired credential).
- **UNRESOLVED restricts.** Downstream code may only use the literal confirmed form recorded in the evidence file and must not generalize.
- **Never provoke a limit.** S6 uses a fake binary; no spike spends the owner's subscription to reach `rejected`.
- **A negative result needs a positive control.** Added after the second book run, which found two "denials" that were really absences: a masked file that did not exist on this host, and a session that never authenticated. Every blocking arm is paired with an arm that must succeed, and the probe is invalid if the control fails.
- Model for every live spike: `haiku` where the behavior is engine-side, `sonnet` where the model must call a tool (S3).

| ID | Question | Method | PASS means | Blocks |
|---|---|---|---|---|
| **S1** | Live literal name of the subagent tool and deny-as-catalog-removal | `claude -p --output-format stream-json --verbose --setting-sources "" --strict-mcp-config` with default tools; record `system/init.tools`. Then with `--disallowedTools Agent` and again with `--tools Read`. | The literal name is recorded — **`Task`**, observed at 2.1.278 and 2.1.280,, not `Agent`, which is an accepted deny-rule alias — a bare deny removes it from `init.tools`; `--tools` yields exactly the listed set. The probe records the spelling rather than asserting one. | P3 init-catalog check |
| **S2** | Reviewer hermeticity under `--setting-sources ""` | Fixture repo with planted user-tier + project-tier `PreToolUse` hooks that `touch` markers, a `.mcp.json` stub server, a `CLAUDE.md` with a nonce, a project skill. Run the reviewer flag set; task requires ≥ 1 `Read`. | `init.mcp_servers` and `init.skills` both **empty** (they are lists), no marker files, nonce absent from output, ≥ 1 executed `Read`. The fixture config directory must **symlink the live credential file**, or the session never authenticates and no model turn happens. | P3, AC-17 |
| **S3** | Structured output mediation and the null shape | Reviewer flag set with `--json-schema` on `sonnet` with the role prompt naming `StructuredOutput`; second arm on `haiku` without the instruction. | Arm 1: `structured_output` validates; arm 2 records the literal null shape and `subtype`. `error_max_structured_output_retries` presence noted if seen. | P3 result parsing |
| **S4** | Engine sandbox enforcement for shell-issued writes/reads/egress | Reviewer settings with `denyRead ~/.ssh`, `denyWrite <snapshot>`, `allowedDomains: []`, `strictAllowlist`, `failIfUnavailable`; commands `curl`, `cat ~/.ssh/x`, `touch <snapshot>/x`, `touch <scratch>/ok`. | Each blocked arm attempted-and-blocked with its recorded error shape, **paired with a positive control**: the masked read has an identical unmasked twin, because ENOENT alone cannot distinguish a mask from a missing file. `denyRead` presents as **ENOENT**; `denyWrite` as `Read-only file system`; egress as a tool-level refusal and then exit 56 with `<sandbox_violations>`. Permitted arms succeed; `permission_denials` empty. | P3 review settings, AC-16 shapes |
| **S5** | Kernel `bwrap` profile | `render_bwrap()` argv wrapping a script that tries egress, `~/.ssh` read, state-dir write, `/tmp` write, scratch write, `uv sync` in a tiny project. | Egress and masked paths fail; `/tmp` and scratch writes succeed; `uv` cache lands under scratch; receipt written; `--die-with-parent` kills the child when the supervisor is SIGKILLed. | P3, AC-16 |
| **S6** | Rate-limit signals on both channels | Fake `claude` binary replaying (a) `rate_limit_event{status: rejected, resetsAt}` then exit 1; (b) `result{is_error, result: "You've hit your session limit · resets 2:10pm (Europe/Madrid)"}`. Plus one **real** run to record the current `allowed` payload including `unifiedWindows`. | Adapter yields `RateLimited(resume_at)` for both fakes; real payload recorded verbatim. | P3/P4 pause, AC-19 |
| **S7** | Stop-hook continuation and re-entry guard | Interactive-equivalent: `claude -p` with a project `Stop` hook that blocks once using a **marker file** as its own guard and records the `stop_hook_active` field on each call. | Second invocation observed with `stop_hook_active: true`; the sentinel reason appeared in output; no wedge. | P2 hooks, AC-21 |
| **S8** | Post-compaction injection channel | Project hooks on `PreCompact` and `SessionStart[compact]` each emitting a distinct nonce as `additionalContext`; force compaction with `--autocompact 100k`… or, if unreachable headless, record UNRESOLVED and rely on the inherited finding. | The `SessionStart` nonce is visible in the post-compaction turn; the `PreCompact` nonce is not. | P2 hooks |
| **S9** | Session identity and resume | `--session-id U`; kill -9 mid-stream; `--resume U` from the same cwd; `--fork-session`. | `U` echoed in `init` and `result`; the fork gets a different id; and a token planted in the killed session comes back from `--resume`, which is what *resume* has to mean. The verdict deliberately does not key on the transcript file: its path probe proved to be a race. Nor may a PASS here be read as permission to resume a reviewer — the kernel refuses that on independence grounds, and this row records what the engine can do so nobody defends the rule with a capability claim instead. | P3 provenance, interrupted-review recovery |
| **S10** | `--max-turns` and `--max-budget-usd` enforcement | Tiny loop task with `--max-turns 1` and separately `--max-budget-usd 0.01`. | Record whether `error_max_turns`/`error_max_budget_usd` subtypes appear. **Both are enforced**, at 2.1.278 and 2.1.280. A reviewer turn cap must then be generous (≥ 40): a low cap is exhausted exploring and returns a null payload that mimics a refusal. | P3 bounds |
| **S11** | Plugin manifest surface and `enabledPlugins` | `claude plugin validate` on the packaged manifest; `claude plugin install --plugin-dir`; inspect `~/.claude/settings.json` `enabledPlugins` in a temp `CLAUDE_CONFIG_DIR`. | Manifest accepted with `skills`, `agents`, `hooks`, `mcpServers`; plugin hooks fire in a consuming repo; format recorded. | P5 packaging |
| **S12** | Auth resolution for kernel-launched sessions | Reviewer flag set with the user's config dir (no `CLAUDE_CONFIG_DIR`) and with an isolated `CLAUDE_CONFIG_DIR` containing only a copied `.credentials.json` (0600). | Record which works; `--bare` recorded as refusing OAuth. Default adapter path is the one that PASSes with the fewest copied secrets — **the isolated directory**. Note that an isolated directory *without* the credential file does not merely fail to isolate, it de-authenticates the session. | P3 launcher |

### Host capability recorded alongside the book

**`bwrap --json-status-fd`** — how a confinement fault is told apart from a failed
check. The adapter originally decided this by testing whether the first stderr line
began `bwrap:`, but the child's stderr and bubblewrap's own are the same stream and the
exit code does not separate them, so a check that printed that prefix had its own
failure filed as a runtime fault. That is the repository classifying its own evidence,
which is exactly what the first iron rule exists to prevent.

Measured locally at bubblewrap 0.9.0, free, no model call, recorded in the `host`
evidence file under `bwrap_json_status_fd`:

| Arm | Status pipe | Recorded as |
|---|---|---|
| clean run, child prints `bwrap: forged diagnostic` and exits 3 | `{child-pid}` then `{exit-code: 3}` | failed check, code 3 |
| bind setup failure | `{child-pid}` only | confinement fault |
| exec failure | `{child-pid}` only | confinement fault |

**An `exit-code` document is emitted only when the sandbox was established and the child
actually ran.** Its absence is the discriminator; the `bwrap:` prefix is now quoted as
diagnosis text and decides nothing. The host arm fails if this stops holding.

Additional one-line checks folded into `run_all.py`: `claude --version` (record), `bwrap --version`, `socat -V`, `/proc/sys/kernel/unprivileged_userns_clone` or AppArmor status, Python `os.pidfd_open` availability, and `isolation: worktree` base-branch behavior (companion H3) via a subagent that prints `git log -1` in its worktree.

Evidence files are committed. The tested range in `capabilities()` is derived from the set of engine versions with a complete PASS/UNRESOLVED book on record, never typed by hand.
