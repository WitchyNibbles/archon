"""S1 — live literal name of the subagent tool and deny-as-catalog-removal.

Method (docs/spikes.md): run with default tools under the reviewer
isolation flags and record ``system/init.tools``; then again with
``--disallowedTools Agent``; then again with ``--tools Read``.

PASS means: the literal subagent-tool name is recorded (``Agent`` at
2.1.278 per docs/research); the bare deny removes it from ``init.tools``;
``--tools Read`` yields exactly ``["Read"]``.
"""

from __future__ import annotations

from pathlib import Path

from . import common

SPIKE_ID = "S1"
PROMPT = "Reply with the single word OK and do not use any tools."
ISOLATION = ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"]


def run(ctx: common.SpikeContext) -> common.EvidenceRecord:
    if not ctx.allow_live:
        return common.unresolved(SPIKE_ID, ctx, "not authorized: --allow-live not passed")
    if not ctx.has_headroom():
        return common.unresolved(SPIKE_ID, ctx, "budget exceeded: insufficient remaining --budget-usd headroom")

    workdir = ctx.new_temp_dir("s1")
    total_cost = 0.0
    arms: dict[str, dict] = {}

    def do_run(name: str, extra_args: list[str]) -> common.CLIResult:
        nonlocal total_cost
        args = [
            "-p",
            PROMPT,
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            "haiku",
            *ISOLATION,
            *extra_args,
        ]
        res = common.run_claude(args, cwd=workdir)
        total_cost += common.extract_cost(res)
        return res

    arm_default = do_run("default", [])
    init_default = common.init_event(arm_default)

    arm_deny = do_run("deny_agent", ["--disallowedTools", "Agent"])
    init_deny = common.init_event(arm_deny)

    arm_tools = do_run("tools_read_only", ["--tools", "Read"])
    init_tools = common.init_event(arm_tools)

    ctx.record_spend(total_cost)

    if init_default is None or init_deny is None or init_tools is None:
        return common.unresolved(
            SPIKE_ID,
            ctx,
            "one or more runs produced no system/init event in the stream",
            literal_form="claude -p --output-format stream-json --verbose --setting-sources ''",
            arms={
                "default_returncode": arm_default.returncode,
                "deny_returncode": arm_deny.returncode,
                "tools_returncode": arm_tools.returncode,
                "default_stderr_tail": arm_default.stderr[-500:],
            },
            cost_usd=total_cost,
        )

    default_tools = list(init_default.get("tools", []))
    deny_tools = list(init_deny.get("tools", []))
    tools_tools = list(init_tools.get("tools", []))

    agent_present_default = "Agent" in default_tools
    agent_absent_after_deny = "Agent" not in deny_tools
    tools_exact_match = tools_tools == ["Read"]

    verdict = "PASS" if (agent_present_default and agent_absent_after_deny and tools_exact_match) else "FAIL"

    observations = {
        "default_tools": default_tools,
        "agent_literal_name_present_by_default": agent_present_default,
        "deny_agent_tools": deny_tools,
        "agent_removed_by_disallowedTools": agent_absent_after_deny,
        "tools_read_only_tools": tools_tools,
        "tools_flag_exact_match": tools_exact_match,
        "engine_reported_model": init_default.get("model"),
        "permission_mode_default": init_default.get("permissionMode"),
    }

    return common.EvidenceRecord(
        id=SPIKE_ID,
        date=ctx.date,
        engine_version=ctx.engine_version,
        verdict=verdict,
        literal_form=(
            "claude -p '<prompt>' --output-format stream-json --verbose --model haiku "
            "--setting-sources '' --strict-mcp-config --disable-slash-commands "
            "[--disallowedTools Agent | --tools Read]"
        ),
        observations=observations,
        cost_usd=total_cost,
    )
