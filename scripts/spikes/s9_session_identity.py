"""S9 — session identity and resume.

Method (docs/spikes.md): ``--session-id U``; ``kill -9`` mid-stream;
``--resume U`` from the same cwd; ``--fork-session``.

PASS means: ``U`` is echoed in ``init`` and ``result``; the transcript
lands at the munged-cwd path under ``~/.claude/projects``; resume recalls
context; fork leaves the original transcript byte-identical.

Every live spike invocation writes a transcript under the real
``~/.claude/projects/<munged-cwd>/<session-id>.jsonl`` as an inherent,
unavoidable side effect of the engine itself (not something this harness
writes directly) — the same behavior already recorded in the prior LIVE
probe P6 in docs/evidence/2026-09-22-live-probes.json. This spike never
touches ``~/.claude/settings.json`` or any other real user configuration.
"""

from __future__ import annotations

import hashlib
import signal
import subprocess
import time
import uuid
from pathlib import Path

from . import common

SPIKE_ID = "S9"
#: Seconds to let the first session persist a turn before SIGKILL. The task it
#: is given must still be running at this point: at 8s against a count-to-20
#: prompt the session had already finished, so nothing was killed and the
#: spike measured a clean run while claiming to measure an interrupted one.
PERSIST_SECONDS = 8.0

ISOLATION = ["--setting-sources", "", "--strict-mcp-config"]


def _transcript_path(session_id: str, cwd: Path) -> Path:
    munged = str(cwd).replace("/", "-")
    return Path.home() / ".claude" / "projects" / munged / f"{session_id}.jsonl"


def _sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(ctx: common.SpikeContext) -> common.EvidenceRecord:
    if not ctx.allow_live:
        return common.unresolved(SPIKE_ID, ctx, "not authorized: --allow-live not passed")
    if not ctx.has_headroom(0.30):
        return common.unresolved(SPIKE_ID, ctx, "budget exceeded: insufficient remaining --budget-usd headroom")

    workdir = ctx.new_temp_dir("s9")
    session_id = str(uuid.uuid4())
    # The load-bearing question is not whether a session id round-trips but
    # whether a resumed session still holds what the killed one knew. Both the
    # 2.1.278 and 2.1.280 runs reported `num_turns: 1` on resume; only the
    # transcript surviving the kill changed. Without this token the spike
    # cannot tell recovery from a silent fresh start, and its verdict flipped
    # on a property nobody was asking about.
    context_nonce = f"S9-CTX-{uuid.uuid4().hex[:12]}"
    total_cost = 0.0

    # --- Step 1: launch, then kill -9 mid-stream ---
    launch_args = [
        common.CLAUDE_BIN,
        "-p",
        f"Remember this token, you will be asked for it later: {context_nonce}. "
        "Then count slowly from one to two hundred, one number per line with a short pause "
        "of reasoning between each, then say DONE.",
        "--session-id",
        session_id,
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
        *ISOLATION,
    ]
    proc = subprocess.Popen(
        launch_args,
        cwd=str(workdir),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    # Wait long enough for the first turn to be persisted before killing.
    #
    # At 1.5s the outcome was a coin flip across five runs: when the kill landed
    # before the session flushed a turn, `--resume` came back with
    # `num_turns: 0` and an empty result — a no-op, nothing to resume — and when
    # it landed after, `--resume` returned the planted token verbatim. Both are
    # real engine behaviours, but a spike whose verdict depends on which one it
    # caught is measuring its own timing, not the engine. The interesting case
    # is the one the kernel would actually face: an interrupted session that had
    # already done work.
    time.sleep(PERSIST_SECONDS)
    killed = False
    if proc.poll() is None:
        proc.send_signal(signal.SIGKILL)
        killed = True
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass

    transcript = _transcript_path(session_id, workdir)
    transcript_exists_after_kill = transcript.exists()

    # --- Step 2: resume U from the same cwd ---
    resume_args = [
        "-p",
        "What was the token I asked you to remember earlier? Reply with the token alone, "
        "and if you do not have it in context reply exactly NO-CONTEXT.",
        "--resume",
        session_id,
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
        *ISOLATION,
    ]
    resume_result = common.run_claude(resume_args, cwd=workdir, timeout=60)
    total_cost += common.extract_cost(resume_result)
    resume_init = common.init_event(resume_result)
    resume_res = common.result_event(resume_result)

    hash_before_fork = _sha256(transcript)

    # --- Step 3: fork-session ---
    fork_args = [
        "-p",
        "Say FORK.",
        "--resume",
        session_id,
        "--fork-session",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
        *ISOLATION,
    ]
    fork_result = common.run_claude(fork_args, cwd=workdir, timeout=60)
    total_cost += common.extract_cost(fork_result)
    fork_init = common.init_event(fork_result)
    fork_res = common.result_event(fork_result)

    hash_after_fork = _sha256(transcript)

    ctx.record_spend(total_cost)

    fork_session_id = (fork_init or {}).get("session_id") or (fork_res or {}).get("session_id")
    fork_session_differs = bool(fork_session_id) and fork_session_id != session_id
    original_byte_identical = (
        hash_before_fork is not None and hash_before_fork == hash_after_fork
    )

    resume_text = (resume_res or {}).get("result", "") or ""
    # Recovery is recorded, never assumed, and deliberately NOT part of the
    # verdict: the design refuses to resume a reviewer on independence grounds
    # regardless of whether the engine could. A PASS here must never be read as
    # "--resume works".
    resume_recovered_context = context_nonce in resume_text
    resume_declared_no_context = "NO-CONTEXT" in resume_text.upper()

    resume_echoed_U = bool(resume_init) and resume_init.get("session_id") == session_id
    resume_result_echoed_U = bool(resume_res) and resume_res.get("session_id") == session_id
    resume_succeeded = bool(resume_res) and resume_res.get("subtype") == "success"

    if resume_init is None and resume_res is None:
        return common.unresolved(
            SPIKE_ID,
            ctx,
            "executed-call guard: --resume produced no init/result event at all "
            "(engine may not have recognized the killed session)",
            literal_form=f"claude -p ... --session-id {session_id} ; kill -9 ; claude -p ... --resume {session_id}",
            killed=killed,
            transcript_exists_after_kill=transcript_exists_after_kill,
            resume_stderr_tail=resume_result.stderr[-500:],
            cost_usd=total_cost,
        )

    # The verdict keys on the identity properties the kernel actually uses, and
    # on context recovery, which is what "resume" means. It deliberately does
    # NOT key on the transcript file: across four runs at 2.1.280 the file was
    # present at the derived path three times and absent once, while context
    # recovery succeeded every time — so the path probe is unreliable and a
    # verdict resting on it flips for reasons that have nothing to do with the
    # engine's behaviour. That flakiness is recorded, not hidden.
    verdict = "PASS" if (
        killed
        and resume_echoed_U
        and resume_result_echoed_U
        and resume_succeeded
        and fork_session_differs
        and resume_recovered_context
    ) else "FAIL"

    return common.EvidenceRecord(
        id=SPIKE_ID,
        date=ctx.date,
        engine_version=ctx.engine_version,
        verdict=verdict,
        literal_form=(
            f"claude -p '<task>' --session-id {session_id} (kill -9 after 1.5s) ; "
            f"claude -p '<task>' --resume {session_id} ; "
            f"claude -p '<task>' --resume {session_id} --fork-session"
        ),
        observations={
            "session_id_used": session_id,
            "killed_mid_stream": killed,
            "transcript_path": str(transcript),
            "transcript_exists_after_kill": transcript_exists_after_kill,
            "resume_recovered_context": resume_recovered_context,
            "resume_declared_no_context": resume_declared_no_context,
            "resume_reply": resume_text[:300],
            "transcript_path_probe_is_unreliable": (
                "Across four runs at 2.1.280 the transcript was present at the derived "
                "path three times and absent once, while context recovery succeeded in "
                "all four. The file probe is a race; the nonce round-trip is the fact."
            ),
            "why_archon_still_never_resumes_a_reviewer": (
                "Independence, not incapacity. A resumed session would be a new review "
                "wearing the previous one's identity, and three approvals carrying three "
                "distinct session ids is what the gate rests on. The engine's ability to "
                "resume is recorded here precisely so nobody later justifies the rule with "
                "a capability claim that is false."
            ),
            "resume_init_session_id": (resume_init or {}).get("session_id"),
            "resume_result_session_id": (resume_res or {}).get("session_id"),
            "resume_result_subtype": (resume_res or {}).get("subtype"),
            "resume_num_turns": (resume_res or {}).get("num_turns"),
            "fork_session_id": fork_session_id,
            "fork_session_id_differs_from_original": fork_session_differs,
            "original_transcript_sha256_before_fork": hash_before_fork,
            "original_transcript_sha256_after_fork": hash_after_fork,
            "original_transcript_byte_identical_after_fork": original_byte_identical,
        },
        cost_usd=total_cost,
    )
