# Verification record

This record separates four kinds of claim. Nothing may be moved up a tier without the
evidence the tier demands.

1. **Automated checks** — ruff, mypy, and the non-live pytest suite, run by
   `bash scripts/check.sh` and by CI on Python 3.12 and 3.13.
2. **Sandbox-marked tests** — real `bubblewrap` confinement. They run on this host. Whether
   they run on CI is an open question: the first CI run showed a GitHub runner refusing the
   profile's own network-namespace flag (see below). They skip cleanly where the capability
   is absent, and a skip is never reported as a pass.
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
non-live suite. CI runs the same three on Python 3.12 and 3.13. It installs `bubblewrap`
and `socat`, which is necessary for the `sandbox`-marked tests but — as the first run
showed — not sufficient; see below.

Observed locally on Python 3.12.3, engine 2.1.280:

| | |
|---|---|
| ruff | clean over `src`, `tests`, `scripts` |
| mypy | clean, 24 source files |
| pytest `-m 'not live'` | 470 passed, 0 failed, ~67 s |
| pytest `-m sandbox` | 27 passed, 443 deselected, ~15 s |
| pytest `-m live` | **0 tests exist** |

Three things a reader should not infer from that table.

**CI has now run once, and it failed — on the workflow, not the code.** The repository was
published on 2026-09-23 and the first run failed both matrix jobs before a single test
executed. The cause was a capability probe written as a gate: the "report sandbox
availability" step ran under `set -e`, so when the runner refused `bwrap --unshare-net`
the whole job died. A probe that can fail the build is not a probe, and that step is now
diagnostic only.

The refusal itself is a real platform fact and is recorded verbatim:

```
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

**This puts AC-16 on CI in doubt, and the doubt is not yet resolved.** The check profile
unshares the network namespace, and a GitHub runner appears unable to bring up loopback
inside one. If that holds, the `sandbox`-marked tests will *skip* on CI rather than run,
which means confinement is proven on a developer host and nowhere else. The workflow now
reports which of those tests actually executed, so the answer appears in the run log
instead of being assumed. **Until that report has been read, do not claim CI proves
AC-16.** The tier list at the top of this document has been corrected accordingly.

**The `live` marker names an empty tier.** `scripts/check.sh` and the repository rules both
describe tests that need an authenticated engine, and there are none. The live proofs are
the three smoke scripts, which are not pytest tests.

**A green suite is a narrower claim than it looks.** See the last section.

## Sandbox confinement (AC-16)

Captured by `scripts/capture_confinement_evidence.py` against the real `archon.sandbox`
profile under bubblewrap 0.9.0, recorded in `docs/evidence/2026-09-22-confinement.json`:
**17 arms, 11 deny and 6 allow, all as expected, no planted marker past any mask.**

| Boundary | Expected | Observed |
|---|---|---|
| External egress | deny | errno 101, `Network is unreachable` |
| External name resolution | deny | errno -3, `Temporary failure in name resolution` |
| Masked home directory read (one arm per masked entry) | deny | errno 2, `No such file or directory` |
| Masked home file read | deny | errno 13, `Permission denied` |
| Private state write | deny | errno 30, `Read-only file system` |
| Unix socket in the host runtime directory | deny | errno 2 |
| Unmasked read of the same marker | allow | returns the planted marker |
| Unmasked read inside the fake home | allow | returns the planted marker |
| Unix socket inside the worktree | allow | round-trips |
| Worktree, `$TMPDIR` and scratch-`$HOME` writes | allow | succeed |

Four things here are load-bearing.

**Unsharing the network namespace does not contain unix-domain sockets.** The read-only
root bind left every host socket connectable, and a confined child was demonstrated talking
to an unconfined peer through one. On an ordinary host that set includes the session bus,
which reaches a service manager and therefore a fully unconfined process. `/run`, `/var/run`
and `$XDG_RUNTIME_DIR` are now masked. The escape is closed for those roots only: a socket
elsewhere under the read-only bind remains reachable, and that is the ceiling.

**Masking the runtime directory has a real cost.** Version managers publish shims there —
on this host `node` and `npm` resolve through it — so a check invoking such a tool now fails
with "no such file or directory" even though the tool is installed. It fails closed, which
is correct, but it is indistinguishable from a missing dependency, so `doctor` warns when
any `PATH` entry resolves inside a masked root. That warning never blocks.

**The directory and file denial shapes differ and both must be recognized.** A directory
mask is an empty tmpfs remounted read-only, so a secret behind it reads as *absent*. A file
mask is a read-only bind of `/dev/null`, which denies the read. A check grepping for "no
such file or directory" would misread the first as a missing dependency.

**Every masking arm has a positive control, and this was learned the hard way three times.**
A denial that looks identical to an absence proves nothing. The first version of this
capture read through `$HOME`, which inside the sandbox is the empty scratch home, so every
arm reported ENOENT and none of them tested a mask. The second built its fake home under
`/tmp`, which the profile replaces with an empty tmpfs, so the layout was invisible whether
masked or not — deleting a mask entirely left the suite green. Layouts now live on ordinary
disk and each masking arm carries an unmasked twin that must be readable, or the capture is
rejected. The mask list itself is pinned as a literal in the tests, because a check deriving
its expectations from the constant it is testing moves with it.

## Reviewer hermeticity (AC-17)

**Partially proven, and the halves are not equal.**

Proven from fixtures: the adapter *refuses* a non-hermetic session. It asserts the
`system/init` event reports the requested tool catalog plus `StructuredOutput`, compared as
a set, with `mcp_servers` and `skills` both empty and the session id echoed; any mismatch,
including a missing `StructuredOutput`, cancels the session and accepts no result. Recorded
transcripts drive the foreign-tool, missing-schema-tool and wrong-model-family cases.

Proven live, once: spike S2 against a fixture repository carrying a planted project hook, a
planted user-tier hook, a stub MCP server, a `CLAUDE.md` nonce and a project skill. Neither
marker fired, `mcp_servers` and `skills` came back empty, the nonce did not leak, and the
executed-call guard saw a real `Read`.

**Not proven: that a reviewer cannot reach what it is denied.** The reviewer deny-read list
now derives from the check profile's mask set rather than restating it — they had drifted,
leaving the user's credential file outside the reviewer's deny list while the reviewer holds
a read-only shell, which the security gate filed as its one CRITICAL finding. The fix is
verified by a test asserting the lists cannot drift again. But only the `~/.ssh` entry has
ever been confirmed denied against a *live* reviewer. The rest, including the credential
paths and the evidence database, are unexercised by any authenticated session.

The spike that would settle it: one reviewer session against a fixture with a planted marker
in the credential file, a second in the evidence database, and a third in an environment
variable, each paired with an unmasked control under the same root. Until that runs, this
criterion is PARTIAL and must not be described otherwise.

## Spike book

Three runs, evidence under `docs/evidence/2026-09-22-spike-<id>-<version>.json`. Two engine
versions have a complete book because the engine updated partway through the build:

| Engine | Result | Cost |
|---|---|---|
| 2.1.278 | 11 PASS, 1 UNRESOLVED (S8), 1 FAIL (S9) | `$0.51` then `$0.24` |
| 2.1.280 | 11 PASS, 1 UNRESOLVED (S8), 0 FAIL | `$0.55` |

S8 is UNRESOLVED at both versions on purpose: forcing a compaction inside a single headless
run would consume most of the book's budget, so the post-compaction channel stays an
inherited claim and is labelled as one.

**The tested range is derived, never typed, and a partial book widens nothing.** A version
counts only once every spike has a verdict for it; a FAIL counts, because the range says
the book was *executed* there, not that everything passed. This mattered immediately: after
the engine update, re-running the host one-liners alone wrote one record at the new version
and the range promptly claimed it was tested while eleven of twelve spikes had never run
there. Evidence filenames now carry the engine version too, because without it a same-day
re-run after an update overwrites the previous version's records — which it did, taking the
whole 2.1.278 book with it until it was restored.

### The corrections, and one retraction

The book's job is to contradict the research note, and it did so ten times across three
runs. They are tabulated in §9, §10 and §11 of
`docs/research/2026-09-22-claude-code-platform.md`. The ones that changed shipping code:

1. The headless subagent tool is literally `Task`; `Agent` is an accepted deny-rule alias.
2. `--json-schema` **injects** a `StructuredOutput` tool on top of `--tools`, so the
   hermeticity assertion expects the requested set plus that tool, compared as a set.
3. `--max-turns` and `--max-budget-usd` are both enforced. A reviewer given a low turn cap
   exhausts it exploring and returns a null payload, which is bound exhaustion wearing a
   refusal's clothes, so the two are reported differently.
4. `init` reports `skills` and `mcp_servers` as lists, not counts.
5. Relocating `CLAUDE_CONFIG_DIR` **de-authenticates** a session unless the credential file
   is carried across, because credentials live inside that directory.
6. `denyRead` presents as ENOENT, and egress has two distinct denial shapes.

**One earlier conclusion in this document was wrong and is retracted.** It said `--resume`
cannot recover an interrupted session. The spike never tested recovery: it observed an
absent transcript and `num_turns: 1` and inferred a silent fresh start, but that turn count
is just the resumed run's own and the transcript probe is a race. Re-run with a token
planted in the killed session and demanded back afterwards, `--resume` returned the token
verbatim in every run. Context is recovered.

Archon still never resumes a reviewer, on the reason that was always the real one: a
resumed reviewer is a new review wearing the previous one's identity, and three approvals
with three distinct session ids is what the gate rests on. Defending a correct rule with a
false capability claim is how the rule dies the day someone checks it.

### Two probes that lied to themselves, and the rule that came out of it

S2 recorded clean hermeticity signals from a session that had never authenticated; its
executed-call guard refused to certify the pass, which is exactly what the guard is for.
S4 recorded a `denyRead` "denial" that was really a missing file on a host with no such
file. Getting S9 deterministic took three attempts, each of which measured the probe's own
timing rather than the engine's behaviour.

The rule: **a negative result needs a positive control, and an inference is not an
observation.** Both are now repository rules, applied to every masking arm in the book and
in the confinement capture.

## Live proof

**One of three has run.**

`scripts/package_smoke.py` — **PASS**, online and offline, spending nothing. It exercised:
wheel and sdist build; all eleven packaged assets present in both; the plugin manifest
declaring agents, hooks, MCP servers and skills; install into a clean virtual environment
importing from site-packages rather than the checkout; `init` byte-idempotent on a second
run; `doctor` reporting no problems with both evidence locators agreeing; and `uninstall`
restoring the consumer's original bytes including a hand-written comment in their settings.

Its earlier reported pass is worth recording accurately: it was true when made, and was
then invalidated by a later installer change that moved the interpreter into the argument
vector. The script now fails loudly on that shape instead of passing silently, and the
check was strengthened rather than narrowed.

`scripts/live_smoke.py` and `scripts/native_smoke.py` — **never run.** They are written,
import-clean, type-clean, and verified to self-report UNRESOLVED without authorization.
Nothing about reviewer behaviour, manager delegation, permission-prompt counts or terminal
report structure has been observed against a real authenticated session. AC-12 is ABSENT
and AC-13 is PARTIAL for that reason.

## Independent review limits

Three independent gates reviewed the tree: correctness, QA, and security. **All three
returned `request_changes`**, and between them they filed one CRITICAL each plus fourteen
HIGH or MEDIUM findings. Every finding was remediated by four parallel packages, and the
suite went from 361 tests to 470.

What they drove, in the order of how much it mattered:

**The kernel could tell a manager to repair forever.** After any completed verification,
the next-action channel — the manager's only instruction — could return `repair` in
perpetuity and never re-verify, in the most common state the system enters. The findings it
handed over were absence-of-evidence statements, not repairable ones. The product contract
was only met because the manager skill's prose independently said to request fresh
verification: the kernel was being saved by documentation. The regression test now drives a
whole delivery through the next-action channel alone and fails before the fix.

**A shipped agent card told workers to destroy uncommitted work.** It instructed
`git reset --hard` on a base mismatch, shipped into other people's repositories, evaluated
by a mid-tier model, and fired precisely in the window the guard table leaves open. A
sibling harness lost a run to exactly this. All eleven assets are now checked by a test that
rejects instruction-shaped repository mutation.

**A reviewer could read the credentials it was launched with.** The reviewer deny list and
the check profile mask list had drifted apart; the deny list is now derived from the mask
set and a test prevents the drift recurring.

**The network namespace did not contain unix-domain sockets**, and a confined child was
demonstrated talking to an unconfined peer. See AC-16 above.

**A check could relabel its own failure as a confinement fault** by printing a line starting
`bwrap:`. The discriminator is now a kernel-held status pipe, recorded in the host evidence.

**Three separate things passed while proving nothing**: the mask set was unpinned so
deleting entries left the suite green; a confinement regression reported as a SKIP in the
very test this document cites as proof against the donor's fatal bug; and an advertised
policy bound had no mechanism anywhere in the tree and was deleted rather than documented.

### The limits, stated plainly

- **Managed execution requires Linux** with bubblewrap and user namespaces.
- **Hooks fail open, deliberately.** A hook or kernel error degrades to telling the human,
  never to an unwritable repository. The flip side is real: corrupting the state database
  disables the guard. That is the accepted trade, and it also destroys the run, so it buys
  an attacker nothing.
- **Private state and process provenance protect against accidental and model-authored
  evidence forgery, not against an arbitrary process running as the same user.**
- **Confinement is closed for the roots it masks, not universally.** A socket elsewhere
  under the read-only root bind remains reachable.
- **Two guard-table rows cite no observed run.** The iron rule says a mechanism without a
  run that needed it should not exist. Both are inherited, both are cheap, and removing
  shipped protection against history rewriting and hook injection on the grounds of missing
  paperwork would be worse engineering than keeping them. They are labelled in code as
  lacking a citation rather than given an invented one. This is a known, deliberate
  deviation from the iron rule.
- **Passing this gate proves recorded checks and review conditions, not program
  correctness.**

### What a green suite here does and does not entitle you to conclude

It entitles you to conclude that the kernel's state machine behaves as recorded against
simulated adapters and recorded engine transcripts: the gate cannot be talked into
`verified`, stale or forged evidence is rejected, three approvals must carry three distinct
kernel-issued session ids, a usage window pauses rather than fails, the installer owns named
spans reversibly, hooks fail open, and — on a host with bubblewrap — the rendered profile
really denies what this document says it denies.

It does **not** entitle you to conclude that a real reviewer session is hermetic beyond the
one spike and the one confirmed denied path; that Archon has ever completed an authenticated
model call through the production adapter; that CI has ever executed; or that the manager
workflow behaves as designed in a live session. Those are the two unrun smoke scripts and
the spike named in AC-17, and until they run this record says so.
