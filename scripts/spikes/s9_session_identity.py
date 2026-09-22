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
    total_cost = 0.0

    # --- Step 1: launch, then kill -9 mid-stream ---
    launch_args = [
        common.CLAUDE_BIN,
        "-p",
        "Count slowly from one to twenty, one number per line with a short pause of reasoning "
        "between each, then say DONE.",
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
    time.sleep(1.5)
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
        "Just say DONE now, nothing else.",
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

    verdict = "PASS" if (
        killed
        and resume_echoed_U
        and resume_result_echoed_U
        and resume_succeeded
        and fork_session_differs
        and original_byte_identical
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
