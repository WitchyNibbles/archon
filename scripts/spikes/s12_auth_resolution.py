"""S12 — auth resolution for kernel-launched sessions.

Method (docs/spikes.md): reviewer flag set with the user's config dir (no
``CLAUDE_CONFIG_DIR``) and with an isolated ``CLAUDE_CONFIG_DIR`` containing
only a copied ``.credentials.json`` (0600).

PASS means: which arm works is recorded; ``--bare`` is recorded as
refusing OAuth. The default adapter path is the one that PASSes with the
fewest copied secrets.

Security note: this spike copies the user's real OAuth credentials file
into a 0600 temp directory to answer the literal question the spike asks,
then deletes that copy immediately after use in a ``finally`` block. The
token value itself is never read into memory beyond what ``claude`` itself
needs, never logged, and never written into the evidence file — only
booleans and redacted key names are recorded, matching the existing
redaction precedent in docs/evidence/2026-09-22-live-probes.json
(``"auth": "claude.ai subscription (email omitted)"``).
"""

from __future__ import annotations

import os
import shutil
import stat
from pathlib import Path

from . import common

SPIKE_ID = "S12"

REVIEWER_FLAGS = ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"]
REAL_CREDENTIALS = Path.home() / ".claude" / ".credentials.json"


def _arm_summary(result: common.CLIResult, cost_accum: list[float]) -> dict:
    cost_accum[0] += common.extract_cost(result)
    res_ev = common.result_event(result)
    return {
        "returncode": result.returncode,
        "result_is_error": (res_ev or {}).get("is_error"),
        "result_subtype": (res_ev or {}).get("subtype"),
        "stderr_tail": result.stderr[-400:] if result.returncode != 0 else "",
        "succeeded": bool(res_ev) and res_ev.get("is_error") is False,
    }


def run(ctx: common.SpikeContext) -> common.EvidenceRecord:
    if not ctx.allow_live:
        return common.unresolved(SPIKE_ID, ctx, "not authorized: --allow-live not passed")
    if not ctx.has_headroom(0.20):
        return common.unresolved(SPIKE_ID, ctx, "budget exceeded: insufficient remaining --budget-usd headroom")

    workdir = ctx.new_temp_dir("s12")
    cost_accum = [0.0]

    # --- Arm A: user's real config dir (no CLAUDE_CONFIG_DIR override) ---
    args_a = [
        "-p",
        "Reply with exactly OK and nothing else.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
        *REVIEWER_FLAGS,
    ]
    result_a = common.run_claude(args_a, cwd=workdir)
    arm_a = _arm_summary(result_a, cost_accum)

    # --- Arm B: isolated CLAUDE_CONFIG_DIR with only a copied 0600 .credentials.json ---
    arm_b: dict
    if not REAL_CREDENTIALS.exists():
        arm_b = {"skipped": True, "reason": "no real ~/.claude/.credentials.json present on this host"}
    else:
        isolated_cfg = ctx.new_temp_dir("s12-isolated-cfg")
        copied_creds = isolated_cfg / ".credentials.json"
        try:
            shutil.copyfile(REAL_CREDENTIALS, copied_creds)
            copied_creds.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0600
            args_b = [
                "-p",
                "Reply with exactly OK and nothing else.",
                "--output-format",
                "stream-json",
                "--verbose",
                "--model",
                "haiku",
                *REVIEWER_FLAGS,
            ]
            env_b = {"CLAUDE_CONFIG_DIR": str(isolated_cfg)}
            result_b = common.run_claude(args_b, cwd=workdir, env=env_b)
            arm_b = _arm_summary(result_b, cost_accum)
            arm_b["copied_file_mode_octal"] = oct(copied_creds.stat().st_mode & 0o777)
        finally:
            # Delete the copied credential immediately; never left on disk
            # beyond this arm's execution.
            if copied_creds.exists():
                copied_creds.unlink()
            shutil.rmtree(isolated_cfg, ignore_errors=True)

    # --- Arm C: --bare (documented to refuse OAuth keychain reads) ---
    args_c = [
        "--bare",
        "-p",
        "Reply with exactly OK and nothing else.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
    ]
    env_c = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    result_c = common.run_claude(args_c, cwd=workdir, env=env_c)
    arm_c = _arm_summary(result_c, cost_accum)

    total_cost = cost_accum[0]
    ctx.record_spend(total_cost)

    if arm_a.get("result_subtype") is None and result_a.stdout.strip() == "":
        return common.unresolved(
            SPIKE_ID,
            ctx,
            "executed-call guard: baseline arm A (real config dir) produced no result event at all",
            literal_form="claude -p 'OK' --setting-sources '' --strict-mcp-config",
            arm_a=arm_a,
            cost_usd=total_cost,
        )

    bare_refuses_oauth = not arm_c.get("succeeded", False)
    isolated_creds_work = bool(arm_b.get("succeeded", False)) if not arm_b.get("skipped") else None

    fewest_secrets_arm = "arm_b_isolated_credentials_only" if isolated_creds_work else (
        "arm_a_real_config_dir" if arm_a.get("succeeded") else "none"
    )

    verdict = "PASS" if arm_a.get("succeeded") else "FAIL"

    return common.EvidenceRecord(
        id=SPIKE_ID,
        date=ctx.date,
        engine_version=ctx.engine_version,
        verdict=verdict,
        literal_form=(
            "arm A: claude -p 'OK' --setting-sources '' --strict-mcp-config (real ~/.claude)  |  "
            "arm B: CLAUDE_CONFIG_DIR=<isolated, only .credentials.json 0600> claude -p 'OK' --setting-sources ''  |  "
            "arm C: claude --bare -p 'OK'"
        ),
        observations={
            "arm_a_real_config_dir": arm_a,
            "arm_b_isolated_credentials_only": arm_b,
            "arm_c_bare": arm_c,
            "bare_refuses_oauth": bare_refuses_oauth,
            "isolated_credentials_only_sufficient": isolated_creds_work,
            "recommended_default_adapter_path_fewest_secrets": fewest_secrets_arm,
        },
        cost_usd=total_cost,
    )
