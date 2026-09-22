"""S1 — live literal name of the subagent tool and deny-as-catalog-removal.

Method (docs/spikes.md): run with default tools under the reviewer
isolation flags and record ``system/init.tools``; then again with
``--disallowedTools Agent``; then again with ``--tools Read``.

PASS means: a subagent-dispatch tool is present in the default catalog and
its literal name is recorded; ``--disallowedTools Agent`` removes that
entry from ``init.tools``; ``--tools Read`` yields exactly ``["Read"]``.

The first run of this book (2026-09-22, engine 2.1.278) required the
criterion to be corrected. It demanded the literal string ``Agent`` in the
default catalog, which ``docs/research/2026-09-22-claude-code-platform.md``
had inherited rather than observed. The engine reports the literal
``Task``; the spelling ``Agent`` is accepted by ``--disallowedTools`` as an
alias and does remove ``Task``. The load-bearing fact for the kernel is
that the deny removes subagent dispatch, not how the entry is spelled, so
the spike now records the spelling instead of asserting one.
"""

from __future__ import annotations

from . import common

SPIKE_ID = "S1"
PROMPT = "Reply with the single word OK and do not use any tools."
# Every spelling the engine has been seen to use for subagent dispatch. The
# spike records which one is live rather than asserting a single literal.
SUBAGENT_ALIASES = ("Task", "Agent")
ISOLATION = ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"]


def run(ctx: common.SpikeContext) -> common.EvidenceRecord:
    if not ctx.allow_live:
        return common.unresolved(SPIKE_ID, ctx, "not authorized: --allow-live not passed")
    if not ctx.has_headroom():
        return common.unresolved(SPIKE_ID, ctx, "budget exceeded: insufficient remaining --budget-usd headroom")

    workdir = ctx.new_temp_dir("s1")
    total_cost = 0.0

    def do_run(extra_args: list[str]) -> common.CLIResult:
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

    arm_default = do_run([])
    init_default = common.init_event(arm_default)

    arm_deny = do_run(["--disallowedTools", "Agent"])
    init_deny = common.init_event(arm_deny)

    arm_tools = do_run(["--tools", "Read"])
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

    dispatch_names = [name for name in SUBAGENT_ALIASES if name in default_tools]
    dispatch_present = bool(dispatch_names)
    dispatch_absent_after_deny = dispatch_present and not any(n in deny_tools for n in dispatch_names)
    tools_exact_match = tools_tools == ["Read"]

    verdict = "PASS" if (dispatch_present and dispatch_absent_after_deny and tools_exact_match) else "FAIL"

    observations = {
        "default_tools": default_tools,
        "subagent_dispatch_literal_names": dispatch_names,
        "subagent_dispatch_present_by_default": dispatch_present,
        "deny_agent_tools": deny_tools,
        "subagent_dispatch_removed_by_disallowedTools_Agent": dispatch_absent_after_deny,
        "removed_by_deny": sorted(set(default_tools) - set(deny_tools)),
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
