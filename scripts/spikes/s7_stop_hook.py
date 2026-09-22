"""S7 — Stop-hook continuation and re-entry guard.

Method (docs/spikes.md): interactive-equivalent ``claude -p`` with a
project ``Stop`` hook that blocks once using a **marker file as its own
guard** (not the engine's ``stop_hook_active`` field), and records the
``stop_hook_active`` field the engine actually sent on each invocation.

PASS means: the second invocation is observed with ``stop_hook_active:
true``; the sentinel reason appears in output; no wedge (the process
terminates normally, never relying on the engine's internal continuation
cap to break a loop we could have avoided ourselves).
"""

from __future__ import annotations

import json
import textwrap
import uuid

from . import common

SPIKE_ID = "S7"


def _hook_script(marker_path, log_path, reason: str) -> str:
    return textwrap.dedent(
        f"""\
        #!/usr/bin/env python3
        import json, sys, pathlib

        marker = pathlib.Path({str(marker_path)!r})
        log = pathlib.Path({str(log_path)!r})

        try:
            data = json.loads(sys.stdin.read() or "{{}}")
        except json.JSONDecodeError:
            data = {{}}

        with log.open("a", encoding="utf-8") as f:
            f.write(json.dumps(data) + "\\n")

        # Own guard: a marker file on disk, not the engine's stop_hook_active
        # field, decides whether to block again. stop_hook_active is only
        # ever *recorded* here for later assertion, never trusted as the
        # loop-prevention mechanism.
        if not marker.exists():
            marker.write_text("fired\\n", encoding="utf-8")
            print(json.dumps({{"decision": "block", "reason": {reason!r}}}))
            sys.exit(0)
        sys.exit(0)
        """
    )


def run(ctx: common.SpikeContext) -> common.EvidenceRecord:
    if not ctx.allow_live:
        return common.unresolved(SPIKE_ID, ctx, "not authorized: --allow-live not passed")
    if not ctx.has_headroom():
        return common.unresolved(SPIKE_ID, ctx, "budget exceeded: insufficient remaining --budget-usd headroom")

    repo = ctx.new_temp_dir("s7-repo")
    common.init_git_repo(repo)

    marker = repo / "s7_stop_guard.marker"
    log_path = repo / "s7_stop_hook.log.jsonl"
    reason = f"S7-CONTINUE-ONCE-{uuid.uuid4().hex[:8]}"

    hook_script_path = repo / "stop_hook.py"
    hook_script_path.write_text(_hook_script(marker, log_path, reason), encoding="utf-8")
    hook_script_path.chmod(0o755)

    settings = {
        "hooks": {
            "Stop": [
                {
                    "hooks": [
                        {"type": "command", "command": f"python3 {hook_script_path}", "timeout": 15}
                    ]
                }
            ]
        }
    }
    claude_dir = repo / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    (claude_dir / "settings.json").write_text(json.dumps(settings, indent=2), encoding="utf-8")

    args = [
        "-p",
        "Say done.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-hook-events",
        "--model",
        "haiku",
        "--setting-sources",
        "project",
        "--strict-mcp-config",
    ]
    result = common.run_claude(args, cwd=repo, timeout=90)
    cost = common.extract_cost(result)
    ctx.record_spend(cost)

    res_ev = common.result_event(result)
    hook_events = common.find_events(result, "system")

    log_entries = []
    if log_path.exists():
        for line in log_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    log_entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

    if res_ev is None or not log_entries:
        return common.unresolved(
            SPIKE_ID,
            ctx,
            "no result event and/or the Stop hook's own log file is empty "
            "(executed-call guard: the marker-file probe itself never ran)",
            literal_form="claude -p 'Say done.' --setting-sources project (project .claude/settings.json Stop hook)",
            hook_log_entries=len(log_entries),
            result_present=res_ev is not None,
            stderr_tail=result.stderr[-500:],
            cost_usd=cost,
        )

    two_invocations = len(log_entries) >= 2
    first_stop_hook_active = log_entries[0].get("stop_hook_active") if log_entries else None
    second_stop_hook_active = log_entries[1].get("stop_hook_active") if two_invocations else None
    marker_fired = marker.exists()
    reason_in_output = reason in result.stdout

    verdict = "PASS" if (
        two_invocations
        and first_stop_hook_active is not True
        and second_stop_hook_active is True
        and marker_fired
        and reason_in_output
        and res_ev.get("subtype") == "success"
    ) else "FAIL"

    return common.EvidenceRecord(
        id=SPIKE_ID,
        date=ctx.date,
        engine_version=ctx.engine_version,
        verdict=verdict,
        literal_form=(
            "claude -p 'Say done.' --output-format stream-json --verbose --include-hook-events "
            "--setting-sources project (project .claude/settings.json Stop hook, own marker-file guard)"
        ),
        observations={
            "hook_invocation_count_observed": len(log_entries),
            "first_invocation_stop_hook_active": first_stop_hook_active,
            "second_invocation_stop_hook_active": second_stop_hook_active,
            "marker_file_fired": marker_fired,
            "sentinel_reason_in_output": reason_in_output,
            "result_subtype": res_ev.get("subtype"),
            "result_num_turns": res_ev.get("num_turns"),
            "raw_hook_log": log_entries,
        },
        cost_usd=cost,
    )
