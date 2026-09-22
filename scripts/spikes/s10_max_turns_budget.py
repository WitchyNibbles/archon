"""S10 — ``--max-turns`` and ``--max-budget-usd`` enforcement.

Method (docs/spikes.md): a tiny loop task with ``--max-turns 1`` and
separately with ``--max-budget-usd 0.01``.

PASS/record means: whether ``error_max_turns`` / ``error_max_budget_usd``
subtypes appear is recorded; per docs/research, ``--max-turns`` is absent
from ``claude --help`` at 2.1.278 though accepted without error, so it is
treated as unreliable unless this spike's own evidence shows it enforced.
"""

from __future__ import annotations

from . import common

SPIKE_ID = "S10"

LOOP_TASK = (
    "You must use the Bash tool at least five separate times, as five separate tool calls in "
    "five separate turns (never combine them into one command): run `echo 1`, wait for the "
    "result, then run `echo 2`, wait, then `echo 3`, wait, then `echo 4`, wait, then `echo 5`. "
    "After the fifth call succeeds, say DONE and stop."
)

ISOLATION = ["--setting-sources", "", "--strict-mcp-config", "--tools", "Bash"]


def run(ctx: common.SpikeContext) -> common.EvidenceRecord:
    if not ctx.allow_live:
        return common.unresolved(SPIKE_ID, ctx, "not authorized: --allow-live not passed")
    if not ctx.has_headroom(0.25):
        return common.unresolved(SPIKE_ID, ctx, "budget exceeded: insufficient remaining --budget-usd headroom")

    total_cost = 0.0

    workdir_turns = ctx.new_temp_dir("s10-turns")
    turns_args = [
        "-p",
        LOOP_TASK,
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
        "--max-turns",
        "1",
        *ISOLATION,
    ]
    turns_result = common.run_claude(turns_args, cwd=workdir_turns, timeout=90)
    total_cost += common.extract_cost(turns_result)
    turns_res_ev = common.result_event(turns_result)
    turns_bash_calls = common.executed_tool_calls(turns_result, tool_name="Bash")

    workdir_budget = ctx.new_temp_dir("s10-budget")
    budget_args = [
        "-p",
        LOOP_TASK,
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
        "--max-budget-usd",
        "0.01",
        *ISOLATION,
    ]
    budget_result = common.run_claude(budget_args, cwd=workdir_budget, timeout=90)
    total_cost += common.extract_cost(budget_result)
    budget_res_ev = common.result_event(budget_result)
    budget_bash_calls = common.executed_tool_calls(budget_result, tool_name="Bash")

    ctx.record_spend(total_cost)

    if turns_res_ev is None and budget_res_ev is None:
        return common.unresolved(
            SPIKE_ID,
            ctx,
            "executed-call guard: neither arm produced a result event",
            literal_form="claude -p '<5-step loop task>' --max-turns 1 | --max-budget-usd 0.01",
            turns_stderr_tail=turns_result.stderr[-500:],
            budget_stderr_tail=budget_result.stderr[-500:],
            cost_usd=total_cost,
        )

    turns_subtype = turns_res_ev.get("subtype") if turns_res_ev else None
    turns_num_turns = turns_res_ev.get("num_turns") if turns_res_ev else None
    turns_enforced = (turns_subtype == "error_max_turns") or (
        isinstance(turns_num_turns, int) and turns_num_turns <= 1 and len(turns_bash_calls) <= 1
    )

    budget_subtype = budget_res_ev.get("subtype") if budget_res_ev else None
    budget_cost = budget_res_ev.get("total_cost_usd") if budget_res_ev else None
    budget_enforced = (budget_subtype == "error_max_budget_usd") or (
        isinstance(budget_cost, int | float) and budget_cost <= 0.015
    )

    no_tool_calls_at_all = len(turns_bash_calls) == 0 and len(budget_bash_calls) == 0
    if no_tool_calls_at_all and turns_num_turns != 1:
        # Neither arm ever issued a Bash call and turns weren't even
        # capped at exactly 1 — most likely the model refused the task
        # rather than the flags doing anything observable.
        verdict = "UNRESOLVED"
    else:
        verdict = "PASS" if (turns_enforced and budget_enforced) else "FAIL"

    return common.EvidenceRecord(
        id=SPIKE_ID,
        date=ctx.date,
        engine_version=ctx.engine_version,
        verdict=verdict,
        literal_form="claude -p '<5-step Bash loop>' --tools Bash --max-turns 1 | --max-budget-usd 0.01",
        observations={
            "max_turns_arm": {
                "subtype": turns_subtype,
                "num_turns": turns_num_turns,
                "bash_calls_observed": len(turns_bash_calls),
                "enforced": turns_enforced,
                "is_error": turns_res_ev.get("is_error") if turns_res_ev else None,
            },
            "max_budget_usd_arm": {
                "subtype": budget_subtype,
                "total_cost_usd": budget_cost,
                "bash_calls_observed": len(budget_bash_calls),
                "enforced": budget_enforced,
                "is_error": budget_res_ev.get("is_error") if budget_res_ev else None,
            },
            "note": (
                "--max-turns is documented-absent from `claude --help` at 2.1.278 though "
                "accepted without CLI error (see docs/research). Treat as unreliable unless "
                "this evidence's max_turns_arm.enforced is true."
            ),
        },
        cost_usd=total_cost,
    )
