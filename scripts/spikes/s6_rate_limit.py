"""S6 — rate-limit signals on both channels.

Method (docs/spikes.md): a fake ``claude`` binary replaying (a)
``rate_limit_event{status: rejected, resetsAt}`` then exit 1; (b)
``result{is_error, result: "You've hit your session limit ..."}``. Plus one
**real** run to record the current ``allowed`` payload including
``unifiedWindows``.

PASS means: a parser derives ``RateLimited(resume_at)`` (models.RateLimited,
which already exists in src/archon/models.py) from both fakes; the real
payload is recorded verbatim.

Note: src/archon/claude_adapter.py is still an unimplemented P3 placeholder
(``AdapterError("... not implemented yet (P3)")``), so there is no
production adapter to call yet. This spike therefore exercises a small,
spike-local reference parser against the two fake channels and against the
real payload, and says so explicitly in the observations — it is evidence
about the raw signal shapes, not a claim that P3's adapter is done.

The fake arms spend nothing (no real ``claude`` invocation). Only the third,
real-payload arm is live and requires --allow-live; per docs/spikes.md this
spike never deliberately provokes ``rejected`` against the real subscription.
"""

from __future__ import annotations

import json
import re
import stat
from pathlib import Path
from typing import Any

from . import common

SPIKE_ID = "S6"

FAKE_REJECTED_SCRIPT = """#!/usr/bin/env python3
import json, sys
print(json.dumps({
    "type": "rate_limit_event",
    "rate_limit_info": {
        "status": "rejected",
        "resetsAt": 1790200000,
        "rateLimitType": "five_hour",
    },
}))
sys.exit(1)
"""

FAKE_ERROR_STRING_SCRIPT = """#!/usr/bin/env python3
import json, sys
print(json.dumps({
    "type": "result",
    "subtype": "success",
    "is_error": True,
    "result": "You've hit your session limit \\u00b7 resets 2:10pm (Europe/Madrid)",
    "session_id": "00000000-0000-0000-0000-000000000000",
    "total_cost_usd": 0.0,
}))
sys.exit(0)
"""

_RESUME_PHRASE_RE = re.compile(r"resets\s+(.+)$", re.IGNORECASE)


def reference_parse_rate_limit(events: list[dict[str, Any]]):
    """Spike-local reference parser: two channels -> archon.models.RateLimited.

    Not the production adapter (P3 pending) — see module docstring.
    """
    from archon.models import RateLimited

    for ev in events:
        if ev.get("type") == "rate_limit_event":
            info = ev.get("rate_limit_info", {})
            if info.get("status") == "rejected":
                return RateLimited(
                    resume_at=int(info.get("resetsAt", 0)),
                    window=info.get("rateLimitType", "unknown"),
                    detail="rate_limit_event status=rejected",
                )
        if ev.get("type") == "result" and ev.get("is_error"):
            text = ev.get("result", "") or ""
            if "session limit" in text.lower() or "usage limit" in text.lower():
                m = _RESUME_PHRASE_RE.search(text)
                detail = m.group(1) if m else text
                # No epoch in the string channel; resume_at=0 is a sentinel
                # meaning "reported, but not machine-parseable from this
                # channel alone" — recorded explicitly in observations.
                return RateLimited(resume_at=0, window="unknown", detail=detail)
    return None


def _write_fake_binary(path: Path, script: str) -> None:
    path.write_text(script, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def run(ctx: common.SpikeContext) -> common.EvidenceRecord:
    fixture = ctx.new_temp_dir("s6")

    # --- Fake arm (a): in-stream rejected event ---
    fake_a = fixture / "fake_claude_rejected.py"
    _write_fake_binary(fake_a, FAKE_REJECTED_SCRIPT)
    import subprocess

    proc_a = subprocess.run([str(fake_a)], capture_output=True, text=True, timeout=10)
    events_a = [json.loads(line) for line in proc_a.stdout.splitlines() if line.strip().startswith("{")]
    rl_a = reference_parse_rate_limit(events_a)

    # --- Fake arm (b): error-string result ---
    fake_b = fixture / "fake_claude_error_string.py"
    _write_fake_binary(fake_b, FAKE_ERROR_STRING_SCRIPT)
    proc_b = subprocess.run([str(fake_b)], capture_output=True, text=True, timeout=10)
    events_b = [json.loads(line) for line in proc_b.stdout.splitlines() if line.strip().startswith("{")]
    rl_b = reference_parse_rate_limit(events_b)

    fake_a_pass = rl_a is not None and rl_a.resume_at == 1790200000
    fake_b_pass = rl_b is not None  # string channel carries no epoch; detail text is what matters

    observations: dict[str, Any] = {
        "fake_arm_a_rejected_in_stream": {
            "raw_event": events_a[0] if events_a else None,
            "parsed_resume_at": rl_a.resume_at if rl_a else None,
            "parsed_detail": str(rl_a) if rl_a else None,
        },
        "fake_arm_b_error_string": {
            "raw_event": events_b[0] if events_b else None,
            "parsed_detail": str(rl_b) if rl_b else None,
            "note": "string channel carries no machine epoch; resume_at recorded as sentinel 0",
        },
        "production_adapter_status": (
            "src/archon/claude_adapter.py is an unimplemented P3 placeholder "
            "(AdapterError); this spike used a spike-local reference parser against "
            "archon.models.RateLimited, not the production adapter."
        ),
    }

    if not ctx.allow_live:
        obs = dict(observations)
        obs["reason"] = "not authorized: --allow-live not passed (real allowed-payload arm skipped)"
        obs["fake_arm_a_pass"] = fake_a_pass
        obs["fake_arm_b_pass"] = fake_b_pass
        return common.EvidenceRecord(
            id=SPIKE_ID,
            date=ctx.date,
            engine_version=ctx.engine_version,
            verdict="UNRESOLVED",
            literal_form="fake claude replays executed; real allowed-payload capture skipped",
            observations=obs,
        )

    if not ctx.has_headroom():
        obs = dict(observations)
        obs["reason"] = "budget exceeded: insufficient remaining --budget-usd headroom for real arm"
        obs["fake_arm_a_pass"] = fake_a_pass
        obs["fake_arm_b_pass"] = fake_b_pass
        return common.EvidenceRecord(
            id=SPIKE_ID,
            date=ctx.date,
            engine_version=ctx.engine_version,
            verdict="UNRESOLVED",
            literal_form="fake claude replays executed; real allowed-payload capture skipped",
            observations=obs,
        )

    workdir = ctx.new_temp_dir("s6-real")
    args = [
        "-p",
        "Reply with exactly OK and nothing else.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
        "--setting-sources",
        "",
        "--strict-mcp-config",
    ]
    result = common.run_claude(args, cwd=workdir)
    cost = common.extract_cost(result)
    ctx.record_spend(cost)

    real_rl_events = common.find_events(result, "rate_limit_event")
    real_payload = real_rl_events[0] if real_rl_events else None

    observations["real_arm_allowed_payload"] = real_payload
    observations["fake_arm_a_pass"] = fake_a_pass
    observations["fake_arm_b_pass"] = fake_b_pass

    if real_payload is None:
        # Not fatal to the fake-arm findings, but the real-payload PASS
        # criterion needs the event; record honestly.
        verdict = "UNRESOLVED" if (fake_a_pass and fake_b_pass) else "FAIL"
        observations["reason"] = "no rate_limit_event observed in-stream for the trivial real call"
    else:
        verdict = "PASS" if (fake_a_pass and fake_b_pass) else "FAIL"

    return common.EvidenceRecord(
        id=SPIKE_ID,
        date=ctx.date,
        engine_version=ctx.engine_version,
        verdict=verdict,
        literal_form=(
            "fake claude emitting rate_limit_event{status:rejected} and result{is_error,'session limit'} "
            "parsed via a reference RateLimited() constructor; real arm: "
            "claude -p 'OK' --model haiku --output-format stream-json --verbose"
        ),
        observations=observations,
        cost_usd=cost,
    )
