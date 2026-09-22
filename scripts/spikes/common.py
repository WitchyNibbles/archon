"""Shared harness for the P0 spike probes (docs/spikes.md).

Every spike module exposes ``run(ctx: SpikeContext) -> EvidenceRecord``.
``run_all.py`` drives them in order, tracks cumulative spend against
``--budget-usd``, and writes ``docs/evidence/<date>-spike-<id>.json``.

Design rules carried over verbatim from docs/spikes.md:

* Executed-call guard — a probe that made zero tool calls, or where the
  model refused the task, is UNRESOLVED, never PASS. Assertions must be on
  observed evidence of execution (a ``tool_use`` block in the stream, a
  marker file on disk, a nonzero byte count) — never on the mere absence of
  an error.
* Measure the engine, not the harness — every run starts with
  ``claude auth status`` and one trivial authenticated call; if either
  fails, the whole book is UNRESOLVED.
* Live spikes require ``--allow-live``; without it they self-report
  UNRESOLVED with reason "not authorized".
* All fixtures live under a temp directory; nothing here ever writes to the
  user's real ``~/.claude`` or to any repository outside this one.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
EVIDENCE_DIR = REPO_ROOT / "docs" / "evidence"
VALID_VERDICTS = {"PASS", "FAIL", "UNRESOLVED"}

CLAUDE_BIN = shutil.which("claude") or "claude"

# Rough per-call ceiling used only to decide whether a *further* live call is
# worth attempting against the remaining --budget-usd headroom. Real spend is
# always taken from the engine's own total_cost_usd, never estimated after
# the fact.
ASSUMED_CALL_CEILING_USD = 0.15


@dataclass
class SpikeContext:
    """A stateful run ledger, not a data/value object — deliberately mutable.

    Like ``store.py``/``launcher.py`` elsewhere in this repo, this tracks a
    real resource (cumulative live spend, a scratch directory) across a
    sequence of side-effecting calls; ``EvidenceRecord`` and ``CLIResult``
    are the immutable value objects this harness produces and never mutates
    after construction.
    """

    date: str
    engine_version: str
    allow_live: bool
    budget_usd: float
    spent_usd: float = 0.0
    scratch_root: Path = field(default_factory=lambda: Path(tempfile.mkdtemp(prefix="archon-spikes-")))

    def remaining_budget(self) -> float:
        return self.budget_usd - self.spent_usd

    def has_headroom(self, ceiling: float = ASSUMED_CALL_CEILING_USD) -> bool:
        return self.remaining_budget() >= ceiling

    def record_spend(self, amount: float) -> None:
        if amount > 0:
            self.spent_usd += amount

    def new_temp_dir(self, prefix: str) -> Path:
        d = Path(tempfile.mkdtemp(prefix=f"{prefix}-", dir=self.scratch_root))
        return d

    def cleanup(self) -> None:
        shutil.rmtree(self.scratch_root, ignore_errors=True)


@dataclass(frozen=True)
class EvidenceRecord:
    id: str
    date: str
    engine_version: str
    verdict: str
    literal_form: str
    observations: dict[str, Any]
    cost_usd: float = 0.0

    def __post_init__(self) -> None:
        if self.verdict not in VALID_VERDICTS:
            raise ValueError(f"invalid verdict {self.verdict!r} for spike {self.id}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "date": self.date,
            "engine_version": self.engine_version,
            "verdict": self.verdict,
            "literal_form": self.literal_form,
            "observations": self.observations,
            "cost_usd": round(self.cost_usd, 6),
        }


def unresolved(
    spike_id: str,
    ctx: SpikeContext,
    reason: str,
    literal_form: str = "not executed",
    **extra: Any,
) -> EvidenceRecord:
    obs: dict[str, Any] = {"reason": reason}
    obs.update(extra)
    return EvidenceRecord(
        id=spike_id,
        date=ctx.date,
        engine_version=ctx.engine_version,
        verdict="UNRESOLVED",
        literal_form=literal_form,
        observations=obs,
    )


def write_evidence(record: EvidenceRecord) -> Path:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    path = EVIDENCE_DIR / f"{record.date}-spike-{record.id}.json"
    path.write_text(json.dumps(record.to_dict(), indent=2, sort_keys=False) + "\n", encoding="utf-8")
    return path


@dataclass(frozen=True)
class CLIResult:
    args: list[str]
    returncode: int
    stdout: str
    stderr: str
    duration_s: float
    events: list[dict[str, Any]] = field(default_factory=list)
    timed_out: bool = False


def _decode(chunk: bytes | str | None) -> str:
    if chunk is None:
        return ""
    if isinstance(chunk, str):
        return chunk
    return chunk.decode("utf-8", "replace")


def run_claude(
    args: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
    input_text: str | None = None,
    timeout: float = 180.0,
) -> CLIResult:
    """Invoke the real ``claude`` binary and parse any stream-json lines."""
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    start = time.monotonic()
    try:
        proc = subprocess.run(
            [CLAUDE_BIN, *args],
            cwd=str(cwd),
            env=full_env,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        timed_out = False
        returncode = proc.returncode
        stdout, stderr = proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        returncode = -1
        stdout = _decode(exc.stdout)
        stderr = _decode(exc.stderr)
    duration = time.monotonic() - start

    events: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    return CLIResult(
        args=args,
        returncode=returncode,
        stdout=stdout,
        stderr=stderr,
        duration_s=duration,
        events=events,
        timed_out=timed_out,
    )


def extract_cost(result: CLIResult) -> float:
    for ev in result.events:
        if ev.get("type") == "result":
            cost = ev.get("total_cost_usd")
            if isinstance(cost, int | float):
                return float(cost)
    # --output-format json (non-stream) prints one JSON object on stdout.
    stripped = result.stdout.strip()
    if stripped.startswith("{"):
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError:
            return 0.0
        cost = obj.get("total_cost_usd")
        if isinstance(cost, int | float):
            return float(cost)
    return 0.0


def find_events(result: CLIResult, event_type: str) -> list[dict[str, Any]]:
    return [e for e in result.events if e.get("type") == event_type]


def init_event(result: CLIResult) -> dict[str, Any] | None:
    for e in result.events:
        if e.get("type") == "system" and e.get("subtype") == "init":
            return e
    return None


def result_event(result: CLIResult) -> dict[str, Any] | None:
    for e in result.events:
        if e.get("type") == "result":
            return e
    if result.stdout.strip().startswith("{"):
        try:
            obj = json.loads(result.stdout.strip())
        except json.JSONDecodeError:
            return None
        if obj.get("type") == "result":
            return obj
    return None


def executed_tool_calls(result: CLIResult, tool_name: str | None = None) -> list[dict[str, Any]]:
    """Return assistant ``tool_use`` blocks observed in the stream.

    This is the executed-call guard's positive evidence: a tool_use block
    here means the model actually issued the call, as opposed to merely
    describing what it would do.
    """
    calls: list[dict[str, Any]] = []
    for ev in result.events:
        if ev.get("type") != "assistant":
            continue
        message = ev.get("message", {})
        for block in message.get("content", []) or []:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                if tool_name is None or block.get("name") == tool_name:
                    calls.append(block)
    return calls


def tool_results_for(result: CLIResult, tool_use_ids: set[str]) -> list[dict[str, Any]]:
    """Return ``tool_result`` blocks (from user-role echo events) matching ids."""
    hits: list[dict[str, Any]] = []
    for ev in result.events:
        if ev.get("type") != "user":
            continue
        message = ev.get("message", {})
        for block in message.get("content", []) or []:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                if block.get("tool_use_id") in tool_use_ids:
                    hits.append(block)
    return hits


def tool_result_text(block: dict[str, Any]) -> str:
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                parts.append(c.get("text", ""))
        return "\n".join(parts)
    return ""


def init_git_repo(path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=str(path), check=True)
    subprocess.run(["git", "config", "user.email", "spike@example.invalid"], cwd=str(path), check=True)
    subprocess.run(["git", "config", "user.name", "archon spike"], cwd=str(path), check=True)


def engine_version() -> str:
    proc = subprocess.run([CLAUDE_BIN, "--version"], capture_output=True, text=True, timeout=15)
    out = (proc.stdout or proc.stderr or "").strip()
    return out.split()[0] if out else "unknown"
