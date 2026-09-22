#!/usr/bin/env python3
"""Driver for the P0 spike book (docs/spikes.md).

Usage::

    uv run python scripts/spikes/run_all.py [--id S1 S3 ...] [--allow-live] [--budget-usd N]

Every spike writes ``docs/evidence/<date>-spike-<id>.json``
(``docs/evidence/<date>-spike-host.json`` for the folded one-liners) with at
least ``{id, date, engine_version, verdict, literal_form, observations,
cost_usd}``. Verdicts are exactly ``PASS``, ``FAIL``, or ``UNRESOLVED``.

Two harness-level guards apply before any spike-specific logic runs:

* **Measure the engine, not the harness** — this script always runs
  ``claude auth status`` first (free, local). When ``--allow-live`` is
  passed it additionally makes one trivial authenticated call. If either
  fails, the *whole* requested book is written as UNRESOLVED and nothing
  else executes.
* **Budget discipline** — cumulative live spend is tracked against
  ``--budget-usd`` (default 2.00); a spike that would exceed the remaining
  headroom is recorded UNRESOLVED with reason "budget exceeded" instead of
  being run.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# This file is invoked directly (`uv run python scripts/spikes/run_all.py`),
# not via `-m`, so it has no parent package at import time and `from . import
# ...` would fail. Bootstrap the repo root onto sys.path and import the
# sibling spike modules as an absolute package instead; the modules
# themselves are only ever reached through this package path, so their own
# internal `from . import common` resolves normally.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from scripts.spikes import (  # noqa: E402
    common,
    host_checks,
    s1_tool_catalog,
    s2_reviewer_hermeticity,
    s3_structured_output,
    s4_sandbox_enforcement,
    s5_bwrap_profile,
    s6_rate_limit,
    s7_stop_hook,
    s8_post_compaction,
    s9_session_identity,
    s10_max_turns_budget,
    s11_plugin_manifest,
    s12_auth_resolution,
)

SPIKES = {
    "S1": s1_tool_catalog.run,
    "S2": s2_reviewer_hermeticity.run,
    "S3": s3_structured_output.run,
    "S4": s4_sandbox_enforcement.run,
    "S5": s5_bwrap_profile.run,
    "S6": s6_rate_limit.run,
    "S7": s7_stop_hook.run,
    "S8": s8_post_compaction.run,
    "S9": s9_session_identity.run,
    "S10": s10_max_turns_budget.run,
    "S11": s11_plugin_manifest.run,
    "S12": s12_auth_resolution.run,
}
ORDER = list(SPIKES.keys())
ALL_IDS = [*ORDER, "host"]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the P0 spike book against the installed Claude Code engine.")
    parser.add_argument(
        "--id",
        nargs="+",
        choices=ALL_IDS,
        default=None,
        help="Run only these spike ids (default: all twelve plus host).",
    )
    parser.add_argument(
        "--allow-live",
        action="store_true",
        help="Authorize live engine calls that spend real cost. Without this, live spikes self-report UNRESOLVED.",
    )
    parser.add_argument(
        "--budget-usd",
        type=float,
        default=2.00,
        help="Total live-spend ceiling for this run (default: 2.00).",
    )
    return parser.parse_args(argv)


def preflight(allow_live: bool) -> tuple[bool, dict, float]:
    """``claude auth status`` (always) and one trivial call (only if live)."""
    obs: dict = {}
    try:
        proc = subprocess.run(
            [common.CLAUDE_BIN, "auth", "status"], capture_output=True, text=True, timeout=20
        )
        auth_ok = proc.returncode == 0
        auth_json = None
        stripped = proc.stdout.strip()
        if stripped.startswith("{"):
            try:
                auth_json = json.loads(stripped)
            except json.JSONDecodeError:
                auth_json = None
        obs["auth_status_returncode"] = proc.returncode
        obs["auth_status_logged_in"] = (auth_json or {}).get("loggedIn")
        obs["auth_status_method"] = (auth_json or {}).get("authMethod")
        obs["auth_status_subscription_type"] = (auth_json or {}).get("subscriptionType")
        auth_ok = auth_ok and bool((auth_json or {}).get("loggedIn"))
    except Exception as exc:  # noqa: BLE001
        auth_ok = False
        obs["auth_status_error"] = f"{type(exc).__name__}: {exc}"

    if not auth_ok:
        obs["reason"] = "claude auth status failed or reports not logged in"
        return False, obs, 0.0

    if not allow_live:
        obs["trivial_call_skipped"] = "not authorized: --allow-live not passed"
        return True, obs, 0.0

    tmp = Path(tempfile.mkdtemp(prefix="archon-spikes-preflight-"))
    try:
        result = common.run_claude(
            [
                "-p",
                "Reply with exactly OK and nothing else.",
                "--output-format",
                "stream-json",
                "--verbose",
                "--model",
                "haiku",
            ],
            cwd=tmp,
            timeout=60,
        )
        res_ev = common.result_event(result)
        call_ok = bool(res_ev) and res_ev.get("is_error") is False
        cost = common.extract_cost(result)
        obs["trivial_call_result_subtype"] = (res_ev or {}).get("subtype")
        obs["trivial_call_is_error"] = (res_ev or {}).get("is_error")
        obs["trivial_call_cost_usd"] = cost
        if not call_ok:
            obs["reason"] = "trivial authenticated call failed"
            obs["trivial_call_stderr_tail"] = result.stderr[-500:]
            return False, obs, cost
        return True, obs, cost
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def run_book(requested_ids: list[str], ctx: common.SpikeContext) -> list[tuple[str, common.EvidenceRecord, Path]]:
    written: list[tuple[str, common.EvidenceRecord, Path]] = []
    for spike_id in requested_ids:
        fn = host_checks.run if spike_id == "host" else SPIKES[spike_id]

        if ctx.allow_live and not ctx.has_headroom():
            record = common.unresolved(
                spike_id,
                ctx,
                f"budget exceeded: remaining ${ctx.remaining_budget():.4f} is below the assumed "
                f"per-call ceiling ${common.ASSUMED_CALL_CEILING_USD:.2f} (--budget-usd {ctx.budget_usd:.2f} "
                f"total, ${ctx.spent_usd:.4f} already spent)",
            )
        else:
            try:
                record = fn(ctx)
            except Exception as exc:  # noqa: BLE001 - a crashing spike is UNRESOLVED, never a silent skip
                record = common.EvidenceRecord(
                    id=spike_id,
                    date=ctx.date,
                    engine_version=ctx.engine_version,
                    verdict="UNRESOLVED",
                    literal_form="not executed",
                    observations={
                        "reason": f"spike module raised an unhandled exception: {type(exc).__name__}: {exc}"
                    },
                )
        ctx.record_spend(record.cost_usd)
        path = common.write_evidence(record)
        written.append((spike_id, record, path))
    return written


def print_report(written: list[tuple[str, common.EvidenceRecord, Path]], preflight_cost: float) -> float:
    total_cost = preflight_cost
    print("\n=== P0 spike book — results ===")
    print(f"{'id':<6} {'verdict':<11} reason / summary")
    for spike_id, record, path in written:
        total_cost += record.cost_usd
        reason = record.observations.get("reason") or record.literal_form
        reason = str(reason).replace("\n", " ")[:140]
        print(f"{spike_id:<6} {record.verdict:<11} {reason}")
        print(f"       -> {path}")
    print(f"\nPreflight cost: ${preflight_cost:.4f}")
    print(f"Total cost this run: ${total_cost:.4f}")
    return total_cost


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    date = dt.date.today().isoformat()
    engine_version = common.engine_version()
    requested_ids = args.id if args.id else ALL_IDS

    preflight_ok, preflight_obs, preflight_cost = preflight(args.allow_live)

    if not preflight_ok:
        written = []
        for spike_id in requested_ids:
            record = common.EvidenceRecord(
                id=spike_id,
                date=date,
                engine_version=engine_version,
                verdict="UNRESOLVED",
                literal_form="claude auth status / trivial authenticated call",
                observations={
                    "reason": "preflight failed (measure-the-engine guard): whole book is UNRESOLVED",
                    **preflight_obs,
                },
            )
            written.append((spike_id, record, common.write_evidence(record)))
        print_report(written, preflight_cost)
        return 1

    ctx = common.SpikeContext(
        date=date,
        engine_version=engine_version,
        allow_live=args.allow_live,
        budget_usd=args.budget_usd,
        spent_usd=preflight_cost,
    )

    written = run_book(requested_ids, ctx)
    ctx.cleanup()
    print_report(written, preflight_cost)

    any_fail = any(r.verdict == "FAIL" for _, r, _ in written)
    return 2 if any_fail else 0


if __name__ == "__main__":
    sys.exit(main())
