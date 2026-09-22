"""S3 — structured output mediation and the null shape.

Method (docs/spikes.md): reviewer flag set with ``--json-schema`` on
``sonnet`` with the role prompt naming ``StructuredOutput``; second arm on
``haiku`` without the instruction.

PASS means: arm 1's ``structured_output`` validates against the schema;
arm 2 records the literal null shape and ``subtype``.
``error_max_structured_output_retries`` presence is noted if seen.
"""

from __future__ import annotations

import json

from . import common

SPIKE_ID = "S3"

SCHEMA = json.dumps(
    {
        "type": "object",
        "properties": {
            "decision": {"type": "string", "enum": ["approve", "request_changes", "blocked"]},
            "summary": {"type": "string"},
        },
        "required": ["decision", "summary"],
        "additionalProperties": False,
    }
)

ISOLATION = ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"]


def run(ctx: common.SpikeContext) -> common.EvidenceRecord:
    if not ctx.allow_live:
        return common.unresolved(SPIKE_ID, ctx, "not authorized: --allow-live not passed")
    if not ctx.has_headroom(0.25):
        return common.unresolved(SPIKE_ID, ctx, "budget exceeded: insufficient remaining --budget-usd headroom")

    workdir = ctx.new_temp_dir("s3")
    total_cost = 0.0

    # Arm 1 — sonnet, instructed to emit via the StructuredOutput tool.
    arm1_args = [
        "-p",
        "You are a code reviewer named StructuredOutput-user. There is nothing to review; "
        "this is a trivial smoke test. Emit your final answer through the StructuredOutput "
        "tool with decision='approve' and summary='ok'. Do not call any other tool.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "sonnet",
        "--json-schema",
        SCHEMA,
        *ISOLATION,
    ]
    arm1 = common.run_claude(arm1_args, cwd=workdir)
    total_cost += common.extract_cost(arm1)
    arm1_result = common.result_event(arm1)
    arm1_tool_calls = common.executed_tool_calls(arm1)

    # Arm 2 — haiku, no instruction naming the tool.
    arm2_args = [
        "-p",
        "Say hello.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
        "--json-schema",
        SCHEMA,
        *ISOLATION,
    ]
    arm2 = common.run_claude(arm2_args, cwd=workdir)
    total_cost += common.extract_cost(arm2)
    arm2_result = common.result_event(arm2)

    ctx.record_spend(total_cost)

    if arm1_result is None or arm2_result is None:
        return common.unresolved(
            SPIKE_ID,
            ctx,
            "one or both arms produced no result event",
            literal_form="claude -p '<prompt>' --json-schema '<schema>' --model sonnet|haiku",
            arm1_returncode=arm1.returncode,
            arm2_returncode=arm2.returncode,
            arm1_stderr_tail=arm1.stderr[-500:],
            arm2_stderr_tail=arm2.stderr[-500:],
            cost_usd=total_cost,
        )

    arm1_structured = arm1_result.get("structured_output")
    arm1_valid = (
        isinstance(arm1_structured, dict)
        and arm1_structured.get("decision") in {"approve", "request_changes", "blocked"}
        and isinstance(arm1_structured.get("summary"), str)
    )
    # Executed-call guard for arm 1: StructuredOutput is itself a tool call,
    # so a valid structured_output with zero tool_use blocks would be
    # suspicious. We require at least one tool_use OR a validated payload
    # tied to a non-error result, and record both signals.
    arm1_had_tool_call = len(arm1_tool_calls) >= 1

    arm2_structured = arm2_result.get("structured_output")
    arm2_is_null = arm2_structured is None
    arm2_subtype = arm2_result.get("subtype")

    error_subtype_seen = arm1_result.get("subtype") == "error_max_structured_output_retries" or (
        arm2_subtype == "error_max_structured_output_retries"
    )

    verdict = "PASS" if (arm1_valid and arm1_had_tool_call) else "UNRESOLVED" if not arm1_had_tool_call else "FAIL"

    observations = {
        "arm1_sonnet_instructed": {
            "structured_output": arm1_structured,
            "valid_against_schema_shape": arm1_valid,
            "subtype": arm1_result.get("subtype"),
            "is_error": arm1_result.get("is_error"),
            "tool_use_blocks_observed": len(arm1_tool_calls),
            "tool_names_observed": [c.get("name") for c in arm1_tool_calls],
        },
        "arm2_haiku_uninstructed": {
            "structured_output": arm2_structured,
            "structured_output_is_null": arm2_is_null,
            "subtype": arm2_subtype,
            "is_error": arm2_result.get("is_error"),
            "model_text": arm2_result.get("result"),
        },
        "error_max_structured_output_retries_observed": error_subtype_seen,
    }

    return common.EvidenceRecord(
        id=SPIKE_ID,
        date=ctx.date,
        engine_version=ctx.engine_version,
        verdict=verdict,
        literal_form=(
            "arm1: claude -p '<StructuredOutput-instructed prompt>' --model sonnet --json-schema '<ReviewPayload>' "
            "--setting-sources ''  |  arm2: claude -p 'Say hello.' --model haiku --json-schema '<ReviewPayload>' "
            "--setting-sources ''"
        ),
        observations=observations,
        cost_usd=total_cost,
    )
