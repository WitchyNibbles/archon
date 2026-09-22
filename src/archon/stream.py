"""The reviewer transcript: one state machine over a recorded ``stream-json`` run.

Every refusal a reviewer session can earn is decided here — the ``system/init``
hermeticity assertion, the rate-limit windows, the tool-use catalog guard, and
the ``result`` parsing that turns a structured payload into evidence or into an
error.  Nothing in this module starts a process or touches the filesystem, so the
whole of it is testable against the recorded fixtures under
``tests/fixtures/claude/`` without an adapter instance, which is what the release
gates scrutinise hardest.

``AdapterError`` is defined here rather than in :mod:`archon.claude_adapter`
because this is the layer that raises it on every path and the adapter sits above
it; the adapter re-exports the name so no caller had to change.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo

from .models import RateLimited, ReviewPayload
from .review_profile import (
    REQUIRED_PERMISSION_MODE,
    REVIEW_TOOLS,
    STRUCTURED_OUTPUT_TOOL,
    reviewer_tool_catalog,
)

MODEL_FAMILIES: tuple[str, ...] = ("opus", "sonnet", "haiku", "fable")
MAX_DENIAL_RECORDS = 256

USAGE_LIMIT_PATTERN = re.compile(r"hit your .{0,64}?limit", re.IGNORECASE)
RESET_EPOCH_PATTERN = re.compile(r"resets\s*(?:at)?\D{0,4}(\d{10,13})", re.IGNORECASE)
RESET_CLOCK_PATTERN = re.compile(
    r"resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?(?:\s*\(([^)]{1,64})\))?", re.IGNORECASE
)
DEFAULT_PAUSE_SECONDS = 3600
#: Both bounds are enforced at 2.1.278 (spike S10).  All three of these end in a
#: null payload, so the diagnostic must say which: an exhausted bound should be
#: raised, a plain refusal should not be retried identically.
BOUND_EXHAUSTED_SUBTYPES: dict[str, str] = {
    "error_max_turns": "turn",
    "error_max_budget_usd": "budget",
    "error_max_structured_output_retries": "structured-output retry",
}

NOT_HERMETIC = "reviewer session not hermetic: "
NO_STRUCTURED_OUTPUT = "no structured output"


class AdapterError(RuntimeError):
    """A diagnosed runtime limitation; never evidence that a check passed."""


def _zone(name: str | None) -> tzinfo | None:
    if not name:
        return datetime.now().astimezone().tzinfo
    try:
        return ZoneInfo(name)
    except (KeyError, ValueError, OSError):
        return datetime.now().astimezone().tzinfo


def parse_reset_time(text: str, *, now: float | None = None) -> int:
    """Resolve a provider reset signal to epoch seconds.

    The only exhaustion message ever observed in the field carries a local clock
    time (``resets 2:10pm (Europe/Madrid)``).  An unparseable message still pauses:
    a pause is never a failure, so a bounded default is safer than refusing one.
    """
    reference = time.time() if now is None else now
    epoch = RESET_EPOCH_PATTERN.search(text)
    if epoch is not None:
        value = int(epoch.group(1))
        return value // 1000 if value > 10_000_000_000 else value
    clock = RESET_CLOCK_PATTERN.search(text)
    if clock is None:
        return int(reference) + DEFAULT_PAUSE_SECONDS
    zone = _zone(clock.group(4))
    hour, meridiem = int(clock.group(1)), (clock.group(3) or "").lower()
    if meridiem:
        hour = hour % 12 + (12 if meridiem == "pm" else 0)
    if not 0 <= hour <= 23:
        return int(reference) + DEFAULT_PAUSE_SECONDS
    current = datetime.fromtimestamp(reference, tz=zone)
    target = current.replace(hour=hour, minute=int(clock.group(2) or 0), second=0, microsecond=0)
    if target <= current:
        target += timedelta(days=1)
    return int(target.timestamp())


def _resume_at(resets_at: Any, *, now: float | None = None) -> int:
    """Resolve a rejected ``rate_limit_event`` to a reset the kernel can wait on.

    CORR-M1: a rejection with no integer ``resetsAt`` fell back to ``time.time()``,
    so the job was requeued immediately against a window that is still closed, and
    because a pause deliberately costs no attempt nothing bounded the cycle.  The
    sibling path :func:`parse_reset_time` already floors an unparseable signal at
    ``now + DEFAULT_PAUSE_SECONDS``; this is the same floor.
    """
    reference = time.time() if now is None else now
    if isinstance(resets_at, int) and not isinstance(resets_at, bool):
        return int(resets_at)
    return int(reference) + DEFAULT_PAUSE_SECONDS


def _model_matches(requested: str, reported: str) -> bool:
    """A reported model id must name the family the kernel routed to."""
    wanted, actual = requested.strip().lower(), reported.strip().lower()
    if not wanted or not actual:
        return False
    if wanted in MODEL_FAMILIES:
        return wanted in actual
    return actual.startswith(wanted) or wanted.startswith(actual)

def _event_method(event: Mapping[str, Any]) -> str:
    kind = str(event.get("type", "unknown"))
    subtype = event.get("subtype")
    return f"{kind}/{subtype}" if isinstance(subtype, str) else kind

@dataclass
class _ReviewSession:
    """Validates one reviewer stream.  Every mismatch is a refusal, not a warning."""

    session_id: str
    model: str
    tools: tuple[str, ...] = REVIEW_TOOLS
    init_seen: bool = False
    reported_model: str = ""
    tool_uses: int = 0
    payload: ReviewPayload | None = None
    result_uuid: str = ""
    cost_usd: float | None = None
    num_turns: int = 0
    denials: list[Any] = field(default_factory=list)
    windows: dict[str, Any] = field(default_factory=dict)
    limit_hint: int | None = None

    def handle(self, event: Mapping[str, Any]) -> None:
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            self._init(event)
        elif kind == "rate_limit_event":
            self._rate_limit(event)
        elif kind == "assistant":
            self._assistant(event)
        elif kind == "result":
            self._result(event)

    def _init(self, event: Mapping[str, Any]) -> None:
        """Assert the session the engine actually built, not the one we asked for.

        Measured at 2.1.278: ``tools`` comes back sorted rather than in the order
        ``--tools`` listed, so the catalog is compared as a set; ``skills`` and
        ``mcp_servers`` are lists (``[]`` when hermetic), so emptiness is the
        assertion, never equality with ``0``; and ``--json-schema`` adds exactly
        one member the kernel did not ask for, ``StructuredOutput``.
        """
        if event.get("session_id") != self.session_id:
            raise AdapterError(f"{NOT_HERMETIC}the session identity was not echoed back")
        catalog = set(map(str, event.get("tools") or ()))
        if STRUCTURED_OUTPUT_TOOL not in catalog:
            raise AdapterError(
                f"{NOT_HERMETIC}the {STRUCTURED_OUTPUT_TOOL} tool is absent, so the session "
                "cannot produce a structured review"
            )
        if catalog != reviewer_tool_catalog(self.tools):
            raise AdapterError(
                f"{NOT_HERMETIC}tool catalog is {sorted(catalog)}, not "
                f"{sorted(reviewer_tool_catalog(self.tools))}"
            )
        if event.get("mcp_servers"):
            raise AdapterError(f"{NOT_HERMETIC}MCP servers are attached to the session")
        if event.get("skills"):
            raise AdapterError(f"{NOT_HERMETIC}skills are attached to the session")
        if event.get("permissionMode") != REQUIRED_PERMISSION_MODE:
            raise AdapterError(f"{NOT_HERMETIC}permission mode is {event.get('permissionMode')!r}")
        reported = str(event.get("model") or "")
        if not _model_matches(self.model, reported):
            raise AdapterError(f"{NOT_HERMETIC}model {reported!r} is not the routed family")
        self.init_seen = True
        self.reported_model = reported

    def _rate_limit(self, event: Mapping[str, Any]) -> None:
        info = event.get("rate_limit_info")
        if not isinstance(info, Mapping):
            return
        windows = info.get("unifiedWindows")
        if isinstance(windows, Mapping):
            self.windows = dict(windows)
        resets_at = info.get("resetsAt")
        window = str(info.get("rateLimitType") or "unknown")
        status = str(info.get("status") or "")
        if status and status != "allowed" and isinstance(resets_at, int):
            self.limit_hint = int(resets_at)
        if status == "rejected":
            raise RateLimited(
                _resume_at(resets_at),
                window=window,
                detail="the provider rejected the reviewer request",
            )

    def _assistant(self, event: Mapping[str, Any]) -> None:
        self._require_init("an assistant message")
        message = event.get("message")
        blocks = message.get("content") if isinstance(message, Mapping) else None
        for block in blocks or ():
            if not isinstance(block, Mapping) or block.get("type") != "tool_use":
                continue
            name = str(block.get("name") or "")
            if name not in (*self.tools, STRUCTURED_OUTPUT_TOOL):
                raise AdapterError(f"reviewer used a tool outside its catalog: {name!r}")
            self.tool_uses += 1

    def _result(self, event: Mapping[str, Any]) -> None:
        text = str(event.get("result") or "")
        if event.get("is_error") and USAGE_LIMIT_PATTERN.search(text):
            raise RateLimited(
                parse_reset_time(text), window="usage_limit_message", detail=text[:200]
            )
        if event.get("session_id") != self.session_id:
            raise AdapterError("reviewer result did not carry its requested session identity")
        self._require_init("the result message")
        subtype = str(event.get("subtype") or "unknown")
        if subtype in BOUND_EXHAUSTED_SUBTYPES:
            raise AdapterError(
                f"{NO_STRUCTURED_OUTPUT}: the reviewer exhausted its "
                f"{BOUND_EXHAUSTED_SUBTYPES[subtype]} bound ({subtype}). Raise the bound for the "
                "next attempt rather than retrying the same one."
            )
        if event.get("is_error"):
            raise AdapterError(f"reviewer session failed: {subtype}")
        self._record(event)
        self.payload = _validate_payload(event.get("structured_output"))

    def _record(self, event: Mapping[str, Any]) -> None:
        self.result_uuid = str(event.get("uuid") or "")
        if not self.result_uuid:
            raise AdapterError("reviewer result carried no message identity")
        cost = event.get("total_cost_usd")
        self.cost_usd = float(cost) if isinstance(cost, (int, float)) else None
        turns = event.get("num_turns")
        self.num_turns = int(turns) if isinstance(turns, int) else 0
        denials = event.get("permission_denials")
        self.denials = list(denials)[:MAX_DENIAL_RECORDS] if isinstance(denials, list) else []

    def _require_init(self, stage: str) -> None:
        if not self.init_seen:
            raise AdapterError(f"{NOT_HERMETIC}{stage} arrived before a verified init event")


def _validate_payload(raw: Any) -> ReviewPayload:
    """The engine mediates ``--json-schema`` through a tool the model must call.

    A success-shaped result with ``structured_output: null`` is therefore a
    bounded provider fault.  It is never a decision, and never an approval.
    """
    if raw is None:
        raise AdapterError(NO_STRUCTURED_OUTPUT)
    if not isinstance(raw, dict):
        raise AdapterError("reviewer structured output was not an object")
    try:
        return ReviewPayload.model_validate(raw)
    except Exception as exc:  # pydantic ValidationError and any coercion failure
        raise AdapterError(f"reviewer payload failed local validation: {type(exc).__name__}") from exc

def _decode_event(line: bytes) -> dict[str, Any]:
    try:
        event = json.loads(line)
    except json.JSONDecodeError as exc:
        raise AdapterError("reviewer stream carried malformed JSON") from exc
    if not isinstance(event, dict):
        raise AdapterError("reviewer stream carried a non-object event")
    return event
