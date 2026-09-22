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

_Pending P5 integration. Record here: the exact command, the Python versions, the test
count and duration, and the module count under mypy._

## Sandbox confinement (AC-16)

_Pending P3. Record here: the observed denial shape for external egress, localhost egress,
a masked read, and a masked write; and the positive controls proving a worktree write, a
`$TMPDIR` write, and a scratch-`$HOME` write succeed. The last three exist because the
donor harness died eight minutes into its first real run when its policy excluded `/tmp`
and `uv` could not write a cache._

## Reviewer hermeticity (AC-17)

_Pending P3/P4. Record here: the `system/init` tool catalog, MCP server list, and skill
count observed for a reviewer session launched against a fixture repository carrying a
planted hook, MCP server, `CLAUDE.md` instruction, and project skill; plus the
executed-call guard showing the reviewer actually read something._

## Spike book

_Pending P0 run. Record here: the engine version, the twelve verdicts, the total cost, and
any observation that contradicts `docs/research/2026-09-22-claude-code-platform.md`. A
contradiction is the most valuable output the book can produce._

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
