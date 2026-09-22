# Verification record

This record separates four kinds of claim. Nothing may be moved up a tier without the
evidence the tier demands.

1. **Automated checks** — ruff, mypy, and the non-live pytest suite, run by
   `bash scripts/check.sh` and by CI on Python 3.12 and 3.13.
2. **Sandbox-marked tests** — real `bubblewrap` confinement. They run on this host and on
   CI (which installs `bubblewrap` and `socat`); they skip cleanly elsewhere and a skip is
   never reported as a pass.
3. **Spike evidence** — capability probes against the installed Claude Code, recorded as
   JSON under `docs/evidence/`. A spike verdict is `PASS`, `FAIL`, or `UNRESOLVED`; an
   `UNRESOLVED` restricts downstream code to the literal confirmed form it recorded.
4. **Live proof** — authenticated runs that spend model quota: the service smoke, the
   native manager run, and the packaged-distribution smoke. These are opt-in, excluded
   from ordinary CI, and reported here separately from simulated fault tests.

Simulated reviewer payloads test gate behaviour. They are never described as live
independent model reviews.

## Automated checks

`bash scripts/check.sh` runs ruff over `src tests scripts`, mypy over the package, and the
non-live suite. CI runs the same three on Python 3.12 and 3.13 with `bubblewrap` and
`socat` installed, so the `sandbox`-marked tests run there rather than skipping.

Observed locally on Python 3.13.5, engine 2.1.278:

| | |
|---|---|
| ruff | clean over `src`, `tests`, `scripts` |
| mypy | clean, 14 source files |
| pytest `-m 'not live'` | 357 passed, 2 failed, ~41 s |
| pytest `-m sandbox` | 15 passed, 344 deselected, ~4 s |

The two failures are both ported Codex-era stubs awaiting the P5 rewrite:
`tests/test_cli.py::test_install_doctor_and_removal_through_cli` still asserts
`runtime["command_protocol"] == "command/exec"`, a protocol Claude Code does not have, and
`tests/test_security.py::test_runtime_receipt_stays_outside_ambient_repo_tmpdir` still
calls the donor's `ClaudeAdapter(client_factory=...)` constructor. Neither is a regression
and neither is reported as passing.

## Sandbox confinement (AC-16)

Captured by `scripts/capture_confinement_evidence.py` against the real
`archon.sandbox` profile under bubblewrap 0.9.0, recorded in
`docs/evidence/2026-09-22-confinement.json`. Nine arms, all as expected, no planted marker
past any mask.

| Boundary | Expected | Observed |
|---|---|---|
| External egress | deny | errno 101, `Network is unreachable` |
| External name resolution | deny | errno -3, `Temporary failure in name resolution` |
| Masked home directory read | deny | errno 2, `No such file or directory` |
| Masked home file read | deny | errno 13, `Permission denied` |
| Private state write | deny | errno 30, `Read-only file system` |
| Unmasked read of the same marker | allow | returns the planted marker |
| Worktree write | allow | succeeds |
| `$TMPDIR` cache write | allow | succeeds |
| Scratch `$HOME` cache write | allow | succeeds |

Three things in that table are load-bearing.

**The directory and file shapes differ, and both must be recognized.** A directory mask is
an empty tmpfs remounted read-only, so a secret behind it reads as *absent*. A file mask is
a read-only bind of `/dev/null`, which denies the read as well as the write. A check that
greps for `No such file or directory` would misread the first as a missing dependency. The
read-only remount is asserted separately by `tests/test_sandbox.py`, because a plain
`--tmpfs` mask is writable and would let a check silently scribble into a masked path.

**The unmasked control is what makes the masking arms mean anything.** It carries the same
planted marker under the same temporary root, inside the worktree bind rather than behind a
mask. Without it an ENOENT proves only that a path is absent, which is how the first S4
masked-read arm passed while proving nothing. The capture is rejected outright if the
control cannot read the marker back.

**The three permissive controls are the donor's fatal bug in test form.** It died eight
minutes into its first real run because its policy excluded `/tmp` and `uv` could not write
a cache. A real `uv` invocation resolving its cache inside the scratch `$HOME` is asserted
by `tests/test_sandbox.py::test_real_uv_places_its_cache_inside_the_scratch_home`.

Localhost egress is covered by `tests/test_sandbox.py::test_egress_to_a_listening_localhost_port_fails`
rather than by this capture, because it needs a listener process to be meaningful.

## Reviewer hermeticity (AC-17)

_Pending P3/P4. Record here: the `system/init` tool catalog, MCP server list, and skill
count observed for a reviewer session launched against a fixture repository carrying a
planted hook, MCP server, `CLAUDE.md` instruction, and project skill; plus the
executed-call guard showing the reviewer actually read something._

## Spike book

Two runs against engine **2.1.278**, `$0.51` then `$0.24`, evidence under
`docs/evidence/2026-09-22-spike-*.json`. Current standing:

| Verdict | Spikes |
|---|---|
| PASS | S1, S2, S3, S4, S5, S6, S7, S10, S11, S12, host |
| FAIL | S9 |
| UNRESOLVED | S8 |

S9's FAIL is a real capability absence, not a broken probe, and it is left standing rather
than reinterpreted. A kernel-issued `--session-id` round-trips into both `init` and
`result`, which is the entire independence proof and is all the kernel needs. But
`--resume` does **not** recover a SIGKILLed session: the transcript was absent afterwards
and the resumed run reported `subtype: success` with `num_turns: 1`, silently starting
fresh. The adapter therefore uses `--resume` nowhere and treats an interrupted reviewer as
a new attempt with a new session id. S8 stays
UNRESOLVED on purpose. Forcing a ≥100k-token autocompaction inside a single headless run
would consume most of the book's budget, so the post-compaction channel remains an
inherited claim and is labelled as one.

The book's job is to contradict the research note, and it did so eight times. The
corrections are tabulated in §9 and §10 of
`docs/research/2026-09-22-claude-code-platform.md`. The five that changed shipped code:

1. The headless subagent tool is literally `Task`, not `Agent`; `Agent` is an accepted
   deny-rule alias. The headless default catalog also omits `Grep` and `Glob`, though both
   are grantable.
2. `--json-schema` **auto-injects** a `StructuredOutput` tool on top of `--tools`. The
   reviewer hermeticity assertion expects the requested set plus that tool, compares as a
   set because the catalog comes back sorted, and treats its absence as fatal.
3. `--max-turns` and `--max-budget-usd` are both enforced, contradicting the note's
   "unreliable". A reviewer given a low turn cap exhausts it exploring and returns a null
   payload, which is bound exhaustion wearing a refusal's clothes, so the adapter reports
   the two differently.
4. `init` reports `skills` and `mcp_servers` as lists, not counts.
5. Relocating `CLAUDE_CONFIG_DIR` **de-authenticates** a session unless the credential file
   is carried across, because credentials live inside that directory.

Two spikes were repaired rather than believed, and both repairs are findings in their own
right. S2 recorded clean hermeticity signals from a session that had never authenticated;
its executed-call guard refused to certify the PASS, which is exactly what the guard is
for. S4 recorded a `denyRead` "denial" that was really a missing file on a host with no
`id_rsa`. The rule both produced: **a negative result needs a positive control**, now
applied to every masking arm in the book and in the confinement capture.

## Live proof

_Pending P5/P6. Record here, separately: the service smoke (a real failing check, repair,
fresh check, three approving reviewer sessions with distinct session ids, verified gate,
then a source edit returning the run to repair); the native manager run (two dependent
tasks, observed subagent dispatch, zero permission prompts, the five terminal headings in
order, and byte-identical user credentials before and after); and the packaged smoke
(wheel install, byte-idempotent re-`init`, `doctor`, `uninstall` preserving user content)._

## Independent review limits

_Pending P6. Record here what the correctness, QA, and security reviews found and drove,
and state the limits plainly: managed execution requires Linux; hooks can fail open, and
that is deliberate; private state and process provenance protect against accidental or
model-authored evidence forgery, not against an arbitrary process running as the same
user; and passing this gate proves recorded checks and review conditions, not program
correctness._
