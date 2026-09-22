"""Claude Code execution adapter: confined checks and hermetic reviewer sessions.

Two paths, one discipline.  ``run_command`` renders the kernel's fixed ``bwrap``
profile and supervises the argv itself, with no model turn anywhere in it.
``run_review`` launches one ``claude -p`` session whose hermeticity is *proved*
by its own ``system/init`` event rather than assumed from the flags that asked
for it.

Nothing here may turn an adapter-level failure into evidence.  A malformed
stream, a null ``structured_output``, an unconfirmed termination, a broken
confinement, a truncated capture: each produces an error, never a passing check
and never an approved review.  The transport changed from DevGod's Codex SDK to
a supervised CLI.  An interrupted reviewer is relaunched as a new attempt with a
new session id, never resumed: at 2.1.278 ``--resume`` after a mid-stream kill
silently started a fresh turn instead of recovering context (spike S9).  The
invocation-identity checks, bounded output, artifact caps,
cancellation budget, nonce-bound termination receipts, sanitized operator
messages and the self-hosting guard did not.
"""

from __future__ import annotations

import asyncio
import codecs
import contextlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, tzinfo
from pathlib import Path
from tempfile import mkdtemp
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from .launcher import pidfd_open, pidfd_send_signal, pidfd_supported
from .models import (
    Candidate,
    CheckSpec,
    CommandResult,
    EventCallback,
    Policy,
    RateLimited,
    ReviewPayload,
    ReviewResult,
    Role,
)
from .sandbox import (
    BwrapProbe,
    CheckProfile,
    SandboxError,
    prepare_scratch,
    probe_bwrap,
    render_bwrap,
)

ENGINE_BINARY = "claude"
LAUNCHER_SCRIPT = "launcher.py"
CHECK_KIND = "check"
REVIEW_KIND = "review"
ARGV_SEPARATOR = "--"

CLEANUP_SECONDS = 5.0
IDENTITY_TIMEOUT_SECONDS = 5.0
IDENTITY_POLL_SECONDS = 0.01
STDERR_DRAIN_SECONDS = 2.0
ENGINE_PROBE_TIMEOUT_SECONDS = 15.0
READ_CHUNK_BYTES = 65_536
MAX_STREAM_LINE_BYTES = 8_388_608
MAX_DENIAL_RECORDS = 256
RECEIPT_NAME = "stopped.json"
PRIVATE_DIR_MODE = 0o700
PRIVATE_FILE_MODE = 0o600

#: The reviewer catalog asked for with ``--tools`` and asserted on ``system/init``.
REVIEW_TOOLS: tuple[str, ...] = ("Read", "Grep", "Glob", "Bash")
#: The engine auto-injects this tool whenever ``--json-schema`` is passed, even
#: under an explicit ``--tools`` allowlist (measured at 2.1.278).  It is the only
#: catalog member the kernel did not name, and it is required: without it the
#: session cannot produce a structured review at all.
STRUCTURED_OUTPUT_TOOL = "StructuredOutput"
REQUIRED_PERMISSION_MODE = "dontAsk"
PERMISSION_PROMPT_TARGET = "none"
STREAM_FORMAT = "stream-json"
SETTING_SOURCES = ""
MANAGED_REVIEW_ENV = "ARCHON_MANAGED_REVIEW"
CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR"
CLAUDE_HOME = ".claude"
CREDENTIALS_FILE = ".credentials.json"
CONFIG_DIRNAME = "config"
REVIEWER_ASSETS = ("assets", "archon", "reviewers")
REVIEWER_ROLES: tuple[str, ...] = ("reviewer", "qa_engineer", "security_reviewer")
MODEL_FAMILIES: tuple[str, ...] = ("opus", "sonnet", "haiku", "fable")

REVIEW_ALLOW: tuple[str, ...] = (
    "Read", "Grep", "Glob",
    "Bash(cat *)", "Bash(ls *)", "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)",
    "Bash(grep *)", "Bash(rg *)", "Bash(find *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)",
    "Bash(sed -n *)", "Bash(python3 -c *)", "Bash(python -c *)", "Bash(node -e *)",
)  # fmt: skip
#: ``Agent`` is the permission-rule name; ``Task`` is the live literal catalog name
#: of the subagent tool in a headless session at 2.1.278.  Both are denied, though
#: the explicit ``--tools`` allowlist is what structurally excludes them.
REVIEW_DENY: tuple[str, ...] = (
    "Write", "Edit", "NotebookEdit", "Agent", "Task", "WebFetch", "WebSearch", "Skill",
    "EnterWorktree", "ExitWorktree", "Monitor", "SendMessage", "CronCreate", "RemoteTrigger",
    "Bash(git commit *)", "Bash(git push *)", "Bash(git checkout *)", "Bash(git reset *)",
    "Bash(rm *)", "Bash(mv *)", "Bash(cp *)", "Bash(curl *)", "Bash(wget *)", "Bash(ssh *)",
    "Bash(sudo *)", "Bash(tee *)", "Bash(> *)",
)  # fmt: skip
REVIEW_DENY_READ: tuple[str, ...] = ("~/.ssh", "~/.aws", "~/.gnupg")

#: Keywords a provider's strict structured-output subset may reject.  They stay
#: in the local ``ReviewPayload`` validation, which is the only authority.
SCHEMA_UNSUPPORTED_KEYWORDS: frozenset[str] = frozenset(
    {
        "title", "description", "default", "minLength", "maxLength", "pattern", "format",
        "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
        "minItems", "maxItems", "patternProperties",
    }
)  # fmt: skip

EVIDENCE_DIRECTORY = ("docs", "evidence")
EVIDENCE_PATTERN = "*-spike-*.json"
FAILED_VERDICT = "FAIL"
VERSION_PATTERN = re.compile(r"(\d+(?:\.\d+){1,3})")
USAGE_LIMIT_PATTERN = re.compile(r"hit your .{0,64}?limit", re.IGNORECASE)
RESET_EPOCH_PATTERN = re.compile(r"resets\s*(?:at)?\D{0,4}(\d{10,13})", re.IGNORECASE)
RESET_CLOCK_PATTERN = re.compile(
    r"resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?(?:\s*\(([^)]{1,64})\))?", re.IGNORECASE
)
#: Both bounds are enforced at 2.1.278 (spike S10).  All three of these end in a
#: null payload, so the diagnostic must say which: an exhausted bound should be
#: raised, a plain refusal should not be retried identically.
BOUND_EXHAUSTED_SUBTYPES: dict[str, str] = {
    "error_max_turns": "turn",
    "error_max_budget_usd": "budget",
    "error_max_structured_output_retries": "structured-output retry",
}
DEFAULT_PAUSE_SECONDS = 3600
BWRAP_DIAGNOSTIC_PREFIX = "bwrap:"
DENIAL_ARTIFACT = "permission-denials.json"
STREAM_ARTIFACT = "stream.jsonl"

NOT_HERMETIC = "reviewer session not hermetic: "
NO_STRUCTURED_OUTPUT = "no structured output"
CONFINEMENT_FAILED = (
    "Check confinement failed before the command produced a result ({detail}); "
    "this is a runtime fault, not a check outcome."
)
TRUNCATED_CHECK = (
    "Check output exceeded its recorded size limit; a truncated capture is not a check result."
)
TRUNCATED_REVIEW = (
    "Reviewer output exceeded its recorded size limit; a truncated stream is not a review."
)
UNCONFIRMED_CHECK = (
    "Owned runtime termination is unconfirmed after the check; reconcile its supervisor "
    "before retrying effects."
)
UNCONFIRMED_REVIEW = "Reviewer process cleanup remains unresolved; its result is not accepted."


class AdapterError(RuntimeError):
    """A diagnosed runtime limitation; never evidence that a check passed."""


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _read_process(pid: int) -> dict[str, Any] | None:
    """Read birth and group identity, without inspecting command args or environment."""
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    except (FileNotFoundError, ProcessLookupError, IndexError, OSError):
        return None
    return {
        "pid": pid,
        "state": fields[0],
        "pgid": int(fields[2]),
        "sid": int(fields[3]),
        "start_ticks": int(fields[19]),
    }


def _boot_id() -> str:
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def _runtime_paths() -> list[Path]:
    """The files this adapter executes from; a candidate may not contain them."""
    here = Path(__file__).resolve()
    paths = [here, here.with_name(LAUNCHER_SCRIPT)]
    engine = shutil.which(ENGINE_BINARY)
    if engine is not None:
        paths.append(Path(engine).resolve())
    return paths


def _same_process(actual: dict[str, Any] | None, expected: dict[str, Any]) -> bool:
    return actual is not None and all(
        actual.get(key) == expected.get(key) for key in ("pid", "pgid", "sid", "start_ticks")
    )


def _signal_process(expected: dict[str, Any], sig: int) -> bool:
    """A pidfd prevents a recycled PID being signalled after identity validation."""
    try:
        descriptor = pidfd_open(expected["pid"])
    except (ProcessLookupError, ValueError):
        return True
    try:
        if not _same_process(_read_process(expected["pid"]), expected):
            return False
        pidfd_send_signal(descriptor, sig)
        return True
    except ProcessLookupError:
        return True
    finally:
        os.close(descriptor)


def _error_message(exc: BaseException) -> str:
    """Keep credentials and arbitrary runtime stderr out of public error text."""
    if isinstance(exc, (AdapterError, SandboxError)):
        return str(exc)[:4096]
    if isinstance(exc, FileNotFoundError):
        return (
            "The Claude Code CLI or its supervisor is unavailable; repair the local "
            "installation and retry."
        )
    if isinstance(exc, PermissionError):
        return "Archon cannot access required local state; resume through the host permission flow."
    name = type(exc).__name__
    if "Validation" in name or isinstance(exc, (ValueError, json.JSONDecodeError)):
        return "Claude Code returned malformed or unsupported evidence; a fresh invocation is required."
    if isinstance(exc, OSError):
        return f"The managed runtime could not be supervised ({name}); inspect the host and retry."
    return f"Claude Code invocation failed ({name}); inspect the local runtime and retry safely."


def review_schema() -> dict[str, Any]:
    """The provider-facing subset of the local review schema.

    Keyword stripping keeps the schema inside the strict structured-output subset
    the engine will accept; ``ReviewPayload.model_validate`` keeps every dropped
    constraint and remains the only authority over a returned payload.
    """
    schema = ReviewPayload.model_json_schema()

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            for keyword in SCHEMA_UNSUPPORTED_KEYWORDS:
                node.pop(keyword, None)
            if node.get("type") == "object" and "properties" in node:
                node["required"] = list(node["properties"])
                node["additionalProperties"] = False
            for child in list(node.values()):
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(schema)
    return schema


def review_settings(snapshot: Path, scratch: Path, state_dir: Path) -> dict[str, Any]:
    """Render the engine-side sandbox the reviewer session runs under.

    Bare-name denies remove a tool from the catalog, which is the layer that was
    measured to hold; path-scoped denies are defence in depth only.  The snapshot
    is already read-only on disk.
    """
    return {
        "permissions": {
            "defaultMode": REQUIRED_PERMISSION_MODE,
            "allow": list(REVIEW_ALLOW),
            "deny": list(REVIEW_DENY),
        },
        "sandbox": {
            "enabled": True,
            "failIfUnavailable": True,
            "autoAllowBashIfSandboxed": True,
            "allowUnsandboxedCommands": False,
            "filesystem": {
                "allowWrite": [str(scratch)],
                "denyWrite": [str(snapshot)],
                "denyRead": [*REVIEW_DENY_READ, str(state_dir)],
            },
            "network": {"allowedDomains": [], "strictAllowlist": True, "allowLocalBinding": False},
        },
        "attribution": {"commit": "", "pr": "", "sessionUrl": False},
        "env": {MANAGED_REVIEW_ENV: "1"},
    }


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
class _Sink:
    """A byte capture that stops at its cap and remembers that it did."""

    limit: int
    data: bytearray = field(default_factory=bytearray)
    truncated: bool = False

    def write(self, chunk: bytes) -> bytes:
        room = max(0, self.limit - len(self.data))
        accepted = chunk[:room]
        self.data.extend(accepted)
        if len(chunk) > room:
            self.truncated = True
        return bytes(accepted)

    def text(self) -> str:
        return bytes(self.data).decode("utf-8", errors="replace")


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
        if catalog != set(self.tools) | {STRUCTURED_OUTPUT_TOOL}:
            raise AdapterError(
                f"{NOT_HERMETIC}tool catalog is {sorted(catalog)}, not "
                f"{sorted(set(self.tools) | {STRUCTURED_OUTPUT_TOOL})}"
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
                int(resets_at) if isinstance(resets_at, int) else int(time.time()),
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


def _write_private(path: Path, payload: str) -> Path:
    descriptor = os.open(
        path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, PRIVATE_FILE_MODE
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(payload)
    return path


def _role_prompt(role: str) -> str:
    """Load the built-in role prompt; a repository may not supply one."""
    if role not in REVIEWER_ROLES:
        raise AdapterError(f"unknown reviewer role: {role!r}")
    asset = Path(__file__).resolve().parent.joinpath(*REVIEWER_ASSETS, f"{role}.md")
    try:
        return asset.read_text(encoding="utf-8")
    except OSError as exc:
        raise AdapterError("the built-in reviewer role prompt is missing from the package") from exc


def _evidence_directory() -> Path | None:
    for parent in Path(__file__).resolve().parents:
        candidate = parent.joinpath(*EVIDENCE_DIRECTORY)
        if candidate.is_dir():
            return candidate
    return None


def _version_tuple(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def tested_engine_range() -> list[str]:
    """Derive the tested engine range from recorded spike evidence, never by hand."""
    directory = _evidence_directory()
    if directory is None:
        return []
    versions: set[str] = set()
    for path in sorted(directory.glob(EVIDENCE_PATTERN)):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        version = record.get("engine_version")
        if not isinstance(version, str) or record.get("verdict") == FAILED_VERDICT:
            continue
        if VERSION_PATTERN.fullmatch(version):
            versions.add(version)
    if not versions:
        return []
    ordered = sorted(versions, key=_version_tuple)
    return [ordered[0], ordered[-1]]


def _version_inside(version: str | None, tested: Sequence[str]) -> bool | None:
    if version is None or len(tested) != 2:
        return None
    try:
        return _version_tuple(tested[0]) <= _version_tuple(version) <= _version_tuple(tested[1])
    except ValueError:
        return None


@dataclass
class _Invocation:
    """One supervised child: its control directory, receipt and lifecycle flags."""

    invocation_id: str
    kind: str
    control_dir: Path
    nonce: str
    receipt_path: str
    process: asyncio.subprocess.Process | None = None
    process_identity: dict[str, Any] | None = None
    process_stopped: bool = False
    cancelled: bool = False
    closed: bool = False
    startup_started: bool = False
    startup_done: asyncio.Event = field(default_factory=asyncio.Event)
    close_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class ClaudeAdapter:
    """Runs checks under bubblewrap and reviews as hermetic ``claude -p`` sessions."""

    def __init__(
        self,
        *,
        receipt_root: Path | str | None = None,
        claude_bin: str = ENGINE_BINARY,
        config_dir: Path | str | None = None,
        launcher_command: Sequence[str] | None = None,
    ) -> None:
        self._receipt_root = (
            Path(receipt_root)
            if receipt_root is not None
            else (
                Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state")
                / "archon"
                / "supervisors"
            )
        )
        self._claude_bin = claude_bin
        self._config_dir = Path(config_dir) if config_dir is not None else None
        # The same entry point as the ``archon-launch`` console script, reached
        # without depending on the script being installed on PATH.
        self._launcher: tuple[str, ...] = (
            tuple(launcher_command)
            if launcher_command is not None
            else (sys.executable, "-I", str(Path(__file__).resolve().with_name(LAUNCHER_SCRIPT)))
        )
        self._active: dict[str, _Invocation] = {}
        self._stopped: set[str] = set()
        self._pending_stops: dict[str, _Invocation] = {}
        self._probe: BwrapProbe | None = None
        self._closed = False

    # ---------------------------------------------------------------- capability

    async def capabilities(self) -> dict[str, Any]:
        """Report installed-dependency metadata and local probes only."""
        version = await asyncio.to_thread(self._engine_version)
        probe = await asyncio.to_thread(self._bwrap_probe)
        tested = await asyncio.to_thread(tested_engine_range)
        inside = _version_inside(version, tested)
        supported = pidfd_supported()
        return {
            "available": bool(version and supported and probe.available and not self._closed),
            "engine_version": version,
            "engine_binary": shutil.which(self._claude_bin),
            "tested_range": tested,
            "engine_version_tested": inside,
            "warning": self._version_warning(version, tested, inside),
            "bwrap": probe.as_dict(),
            "pidfd": supported,
            "platform": sys.platform,
            "crash_recovery": "linux-subreaper-receipt" if supported else "unsupported",
            "structured_reviews": True,
            "live_authenticated": None,
            "measurement": (
                "installed dependency metadata plus local probes (claude --version, bubblewrap, "
                "kernel PID handles); no live authenticated invocation and no spend"
            ),
        }

    @staticmethod
    def _version_warning(
        version: str | None, tested: Sequence[str], inside: bool | None
    ) -> str | None:
        """An untested engine is a warning with a re-probe instruction, never a block."""
        if version is None:
            return "The Claude Code CLI was not found on PATH; install it and re-run `archon doctor`."
        if not tested:
            return (
                "No spike evidence is on record, so no tested engine range exists. Run "
                "`scripts/spikes/run_all.py` and commit its evidence before trusting reviews."
            )
        if inside is False:
            return (
                f"Claude Code {version} is outside the tested range {tested[0]}-{tested[1]}. "
                "Re-run the spike book (docs/spikes.md) and commit the evidence to widen it."
            )
        return None

    def _engine_version(self) -> str | None:
        binary = shutil.which(self._claude_bin)
        if binary is None:
            return None
        try:
            completed = subprocess.run(
                [binary, "--version"],
                capture_output=True,
                text=True,
                stdin=subprocess.DEVNULL,
                timeout=ENGINE_PROBE_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        match = VERSION_PATTERN.search(completed.stdout or "")
        return match.group(1) if match else None

    def _bwrap_probe(self) -> BwrapProbe:
        if self._probe is None or not self._probe.available:
            self._probe = probe_bwrap()
        return self._probe

    # ------------------------------------------------------------------ plumbing

    @staticmethod
    async def _emit(callback: EventCallback | None, job: _Invocation, **event: Any) -> None:
        if callback is not None:
            await callback({"invocation_id": job.invocation_id, **event})

    def _new_invocation(
        self, invocation_id: str, kind: str, cwd: Path, *, repo_root: Path | None = None
    ) -> _Invocation:
        if self._closed:
            raise AdapterError("The Archon adapter is closed; the manager should reopen its service.")
        if invocation_id in self._active:
            raise AdapterError("This invocation is already running; inspect its existing job.")
        if not pidfd_supported():
            raise AdapterError("Managed execution requires usable Linux kernel PID handles.")
        owner = (repo_root or cwd).resolve()
        if any(path.is_relative_to(owner) for path in _runtime_paths()):
            raise AdapterError(
                "Archon's own runtime lives inside the repository under verification. "
                "Verify this repository from an installation outside it."
            )
        control_dir = Path(mkdtemp(prefix="runtime-", dir=self._receipt_state(cwd, owner)))
        nonce = uuid4().hex
        job = _Invocation(
            invocation_id=invocation_id,
            kind=kind,
            control_dir=control_dir,
            nonce=nonce,
            receipt_path=str(control_dir / RECEIPT_NAME),
        )
        self._stopped.discard(invocation_id)
        self._pending_stops.pop(invocation_id, None)
        self._active[invocation_id] = job
        return job

    def _receipt_state(self, cwd: Path, owner: Path) -> Path:
        """Private, uid-owned, symlink-free state outside the repository and snapshot."""
        root = self._receipt_root
        if not root.is_absolute() or any(path.is_symlink() for path in (root, *root.parents)):
            raise AdapterError(
                "Supervisor receipts require an absolute private state directory without symlinks."
            )
        root = root.resolve()
        if any(root.is_relative_to(path.resolve()) for path in (cwd, owner)):
            raise AdapterError(
                "Supervisor receipts must live outside the active repository and review snapshot."
            )
        root.mkdir(parents=True, mode=PRIVATE_DIR_MODE, exist_ok=True)
        info = root.stat()
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != PRIVATE_DIR_MODE:
            raise AdapterError(
                "Supervisor receipt state must be owned by the current user with mode 0700."
            )
        return root

    def _launcher_argv(self, job: _Invocation, command: Sequence[str]) -> list[str]:
        return [*self._launcher, str(job.control_dir), job.nonce, job.kind, ARGV_SEPARATOR, *command]

    @staticmethod
    def _require_process(job: _Invocation) -> asyncio.subprocess.Process:
        if job.process is None:
            raise AdapterError("The supervised runtime was never dispatched.")
        return job.process

    async def _dispatch(
        self,
        job: _Invocation,
        command: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str] | None,
        stdin_data: bytes | None,
        on_event: EventCallback | None,
    ) -> None:
        """Start the supervisor, prove ownership, then release the payload.

        The check's argv is the supervisor's own child, so the supervisor *is* the
        dispatch: the ownership record is emitted as soon as identity is provable,
        before any output is read.
        """
        if job.cancelled:
            raise AdapterError("The invocation was cancelled before dispatch.")
        job.startup_started = True
        try:
            job.process = await asyncio.create_subprocess_exec(
                *self._launcher_argv(job, command),
                stdin=asyncio.subprocess.PIPE if stdin_data is not None else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(cwd),
                env=None if env is None else dict(env),
                limit=MAX_STREAM_LINE_BYTES,
            )
            job.process_identity = await self._observe_identity(job)
        finally:
            job.startup_done.set()
        await self._emit(on_event, job, kind="provider_process", process_identity=job.process_identity)
        await self._emit(on_event, job, kind="dispatch", process_id=job.invocation_id)
        if job.cancelled:
            raise AdapterError("The invocation was cancelled during startup.")
        if stdin_data is not None:
            await self._write_stdin(job, stdin_data)

    @staticmethod
    async def _write_stdin(job: _Invocation, payload: bytes) -> None:
        """The packet goes on stdin; argv is readable by every process on the host."""
        process = ClaudeAdapter._require_process(job)
        if process.stdin is None:
            raise AdapterError("The reviewer session has no input channel.")
        process.stdin.write(payload)
        with contextlib.suppress(ConnectionResetError, BrokenPipeError):
            await process.stdin.drain()
        process.stdin.close()

    async def _observe_identity(self, job: _Invocation) -> dict[str, Any]:
        """Wait for the supervisor's own session, or accept its completed receipt."""
        process = self._require_process(job)
        deadline = time.monotonic() + IDENTITY_TIMEOUT_SECONDS
        while True:
            info = _read_process(process.pid)
            if info is not None and info["pid"] == info["pgid"] == info["sid"]:
                info.pop("state")
                return {**info, **self._identity_suffix(job)}
            receipt = self._receipt_identity(job)
            if receipt is not None:
                return receipt
            if time.monotonic() > deadline:
                raise AdapterError("The supervisor did not establish its owned process session.")
            await asyncio.sleep(IDENTITY_POLL_SECONDS)

    def _identity_suffix(self, job: _Invocation) -> dict[str, Any]:
        return {"boot_id": _boot_id(), "receipt_path": job.receipt_path, "nonce": job.nonce}

    def _receipt_identity(self, job: _Invocation) -> dict[str, Any] | None:
        """A supervisor that already finished left a receipt naming itself."""
        try:
            receipt = json.loads(Path(job.receipt_path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        pid, ticks = receipt.get("pid"), receipt.get("start_ticks")
        if receipt.get("nonce") != job.nonce or not isinstance(pid, int) or not isinstance(ticks, int):
            return None
        return {
            "pid": pid,
            "pgid": pid,
            "sid": pid,
            "start_ticks": ticks,
            "boot_id": str(receipt.get("boot_id", "")),
            "receipt_path": job.receipt_path,
            "nonce": job.nonce,
        }

    async def _pump(
        self, job: _Invocation, stream: str, sink: _Sink, on_event: EventCallback | None
    ) -> None:
        process = self._require_process(job)
        reader = process.stdout if stream == "stdout" else process.stderr
        if reader is None:
            return
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while True:
            chunk = await reader.read(READ_CHUNK_BYTES)
            if not chunk:
                break
            text = decoder.decode(sink.write(chunk))
            if text:
                await self._emit(
                    on_event, job, kind="output", stream=stream, text=text, truncated=sink.truncated
                )
        tail = decoder.decode(b"", final=True)
        if tail:
            await self._emit(
                on_event, job, kind="output", stream=stream, text=tail, truncated=sink.truncated
            )

    def _artifact(self, job: _Invocation, name: str, payload: str) -> str:
        path = job.control_dir / name
        with contextlib.suppress(OSError):
            _write_private(path, payload)
        return str(path)

    # ------------------------------------------------------------------- checks

    async def run_command(
        self,
        spec: CheckSpec,
        candidate: Candidate,
        policy: Policy,
        on_event: EventCallback | None = None,
        *,
        invocation_id: str | None = None,
    ) -> CommandResult:
        """Run one check argv under the kernel's fixed profile.  No model turn."""
        invocation_id = invocation_id or f"command_{uuid4().hex}"
        started_at, started = _utc_now(), time.monotonic()
        root = Path(candidate.repo_root).resolve()
        cwd = (root / spec.cwd).resolve()
        streams = {name: _Sink(policy.max_output_bytes) for name in ("stdout", "stderr")}
        outcome: dict[str, Any] = {"exit_code": None}
        job: _Invocation | None = None
        digest: str | None = None
        try:
            self._validate_check(root, cwd, policy)
            job = self._new_invocation(invocation_id, CHECK_KIND, root, repo_root=root)
            profile = self._check_profile(job, root)
            digest = profile.digest()
            argv = render_bwrap(profile, spec.argv, cwd, probe=self._bwrap_probe())
            timeout = min(spec.timeout_seconds, policy.command_timeout_seconds)
            outcome["exit_code"] = await self._supervise_check(
                job, argv, root, streams, on_event, timeout
            )
            await self._close_job(job)
            self._finish_check(job, invocation_id, outcome, streams)
        except TimeoutError:
            await self._abort(job, invocation_id)
            outcome.update(timed_out=True, error="The check exceeded its recorded time limit.")
        except asyncio.CancelledError:
            await asyncio.shield(self._abort(job, invocation_id))
            raise
        except Exception as exc:
            outcome["error"] = _error_message(exc)
            if job is not None and job.cancelled:
                outcome["interrupted"] = True
        finally:
            await self._release(job, invocation_id)
        return CommandResult(
            invocation_id=invocation_id,
            argv=list(spec.argv),
            cwd=str(cwd),
            stdout=streams["stdout"].text(),
            stderr=streams["stderr"].text(),
            stdout_path=self._artifact(job, "stdout.log", streams["stdout"].text()) if job else None,
            stderr_path=self._artifact(job, "stderr.log", streams["stderr"].text()) if job else None,
            truncated=any(sink.truncated for sink in streams.values()),
            duration_seconds=time.monotonic() - started,
            started_at=started_at,
            finished_at=_utc_now(),
            sandbox_profile_digest=digest,
            **outcome,
        )

    @staticmethod
    def _validate_check(root: Path, cwd: Path, policy: Policy) -> None:
        if policy.network_access:
            raise AdapterError("Managed checks require the authorized offline workspace policy.")
        if not cwd.is_relative_to(root) or not cwd.is_dir():
            raise AdapterError("A check working directory must exist inside the active repository.")

    def _check_profile(self, job: _Invocation, root: Path) -> CheckProfile:
        scratch = prepare_scratch(job.control_dir / "scratch")
        return CheckProfile(
            worktree=root,
            scratch=scratch,
            state_dir=self._receipt_root.resolve(),
            home=Path.home().resolve(),
        )

    async def _supervise_check(
        self,
        job: _Invocation,
        argv: Sequence[str],
        cwd: Path,
        streams: Mapping[str, _Sink],
        on_event: EventCallback | None,
        timeout: int,
    ) -> int:
        async with asyncio.timeout(timeout):
            await self._dispatch(job, argv, cwd=cwd, env=None, stdin_data=None, on_event=on_event)
            await asyncio.gather(
                *(self._pump(job, name, sink, on_event) for name, sink in streams.items())
            )
            return await self._require_process(job).wait()

    def _finish_check(
        self,
        job: _Invocation,
        invocation_id: str,
        outcome: dict[str, Any],
        streams: Mapping[str, _Sink],
    ) -> None:
        """Classify the outcome; a confinement fault never reads as a check result."""
        if not self.termination_confirmed(invocation_id):
            outcome["error"] = UNCONFIRMED_CHECK
            return
        if job.cancelled:
            outcome.update(interrupted=True, error="The check was cancelled.")
            return
        confinement = _confinement_failure(outcome["exit_code"], streams["stderr"].text())
        if confinement is not None:
            outcome["error"] = confinement
        elif any(sink.truncated for sink in streams.values()):
            outcome["error"] = TRUNCATED_CHECK

    # ------------------------------------------------------------------ reviews

    async def run_review(
        self,
        role: Role,
        candidate: Candidate,
        packet: dict[str, Any],
        policy: Policy,
        on_event: EventCallback | None = None,
        *,
        invocation_id: str | None = None,
    ) -> ReviewResult:
        """Run one hermetic reviewer session against the frozen snapshot."""
        invocation_id = invocation_id or f"review_{uuid4().hex}"
        started = time.monotonic()
        session = _ReviewSession(session_id=str(uuid4()), model=policy.review_route(role).model)
        outcome: dict[str, Any] = {}
        job: _Invocation | None = None
        try:
            snapshot = self._validate_snapshot(candidate)
            job = self._new_invocation(
                invocation_id, REVIEW_KIND, snapshot, repo_root=Path(candidate.repo_root)
            )
            argv = self._review_argv(job, role, policy, session.session_id, snapshot)
            async with asyncio.timeout(policy.review_timeout_seconds):
                await self._dispatch(
                    job,
                    argv,
                    cwd=snapshot,
                    env=self._review_env(job),
                    stdin_data=_packet_bytes(role, candidate, packet, policy),
                    on_event=on_event,
                )
                await self._consume_review(job, session, policy, on_event)
                exit_code = await self._require_process(job).wait()
            self._accept_review(session, exit_code, outcome)
        except RateLimited:
            await self._abort(job, invocation_id)
            raise
        except TimeoutError:
            await self._abort(job, invocation_id)
            outcome["error"] = "The reviewer exceeded its recorded time limit; retry with a focused packet."
        except asyncio.CancelledError:
            await asyncio.shield(self._abort(job, invocation_id))
            raise
        except Exception as exc:
            await self._abort(job, invocation_id)
            outcome["error"] = _error_message(exc)
        finally:
            await self._release(job, invocation_id)
            if job is not None:
                _purge_credentials(job.control_dir)
            if outcome.get("payload") is not None and not self.termination_confirmed(invocation_id):
                outcome = {"error": UNCONFIRMED_REVIEW}
        return ReviewResult(
            invocation_id=invocation_id,
            role=role,
            candidate_digest=candidate.candidate_digest,
            checks_digest=candidate.checks_digest,
            duration_seconds=time.monotonic() - started,
            **outcome,
        )

    @staticmethod
    def _validate_snapshot(candidate: Candidate) -> Path:
        if not candidate.snapshot_path:
            raise AdapterError("A reviewer requires a frozen candidate snapshot.")
        snapshot = Path(candidate.snapshot_path).resolve()
        if not snapshot.is_dir() or snapshot == Path(candidate.repo_root).resolve():
            raise AdapterError("The reviewer snapshot must be a directory separate from the repository.")
        return snapshot

    def _review_env(self, job: _Invocation) -> dict[str, str]:
        env = dict(os.environ)
        env[MANAGED_REVIEW_ENV] = "1"
        config_dir = self._config_dir or _isolated_config_dir(job.control_dir)
        if config_dir is not None:
            env[CONFIG_DIR_ENV] = str(config_dir)
        return env

    def _review_argv(
        self, job: _Invocation, role: Role, policy: Policy, session_id: str, snapshot: Path
    ) -> list[str]:
        """Build the reviewer command.  The role prompt and packet stay off argv."""
        job_dir = job.control_dir / "job"
        job_dir.mkdir(mode=PRIVATE_DIR_MODE)
        scratch = prepare_scratch(job.control_dir / "scratch")
        settings = _write_private(
            job_dir / "settings.json",
            json.dumps(review_settings(snapshot, scratch, self._receipt_root.resolve())),
        )
        prompt = _write_private(job_dir / f"{role}.md", _role_prompt(role))
        route = policy.review_route(role)
        return [
            self._claude_bin,
            "-p",
            "--session-id", session_id,
            "--output-format", STREAM_FORMAT,
            "--verbose",
            "--json-schema", json.dumps(review_schema(), separators=(",", ":")),
            "--model", route.model,
            "--effort", route.effort,
            "--tools", ",".join(REVIEW_TOOLS),
            "--permission-mode", REQUIRED_PERMISSION_MODE,
            "--permission-prompts", PERMISSION_PROMPT_TARGET,
            "--setting-sources", SETTING_SOURCES,
            "--strict-mcp-config",
            "--disable-slash-commands",
            "--settings", str(settings),
            "--append-system-prompt-file", str(prompt),
            "--max-budget-usd", f"{policy.review_budget_usd:g}",
            "--no-session-persistence",
        ]  # fmt: skip

    async def _consume_review(
        self,
        job: _Invocation,
        session: _ReviewSession,
        policy: Policy,
        on_event: EventCallback | None,
    ) -> None:
        stdout, stderr = _Sink(policy.max_output_bytes), _Sink(policy.max_output_bytes)
        drain = asyncio.create_task(self._pump(job, "stderr", stderr, on_event))
        try:
            await self._read_events(job, session, stdout, on_event)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(asyncio.shield(drain), STDERR_DRAIN_SECONDS)
        finally:
            drain.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await drain
            self._artifact(job, STREAM_ARTIFACT, stdout.text())
            self._artifact(job, "stderr.log", stderr.text())
            self._artifact(job, DENIAL_ARTIFACT, json.dumps(session.denials, default=str))

    async def _read_events(
        self,
        job: _Invocation,
        session: _ReviewSession,
        sink: _Sink,
        on_event: EventCallback | None,
    ) -> None:
        """Only stdout is parsed; stderr is captured as a bounded artifact."""
        reader = self._require_process(job).stdout
        if reader is None:
            raise AdapterError("The reviewer session produced no output channel.")
        while True:
            try:
                line = await reader.readline()
            except (ValueError, asyncio.LimitOverrunError) as exc:
                raise AdapterError(TRUNCATED_REVIEW) from exc
            if not line:
                return
            sink.write(line)
            if sink.truncated:
                raise AdapterError(TRUNCATED_REVIEW)
            if not line.strip():
                continue
            event = _decode_event(line)
            session.handle(event)
            await self._emit(
                on_event,
                job,
                kind="provider_event",
                method=_event_method(event),
                session_id=session.session_id,
                model=session.reported_model,
            )

    @staticmethod
    def _accept_review(session: _ReviewSession, exit_code: int, outcome: dict[str, Any]) -> None:
        if session.payload is None:
            raise AdapterError("The reviewer ended without validated structured evidence.")
        if exit_code != 0:
            raise AdapterError(f"The reviewer session exited {exit_code}; its result is not accepted.")
        outcome.update(
            payload=session.payload,
            session_id=session.session_id,
            result_uuid=session.result_uuid,
            cost_usd=session.cost_usd,
        )
        if session.limit_hint is not None:
            outcome["rate_limited_until"] = session.limit_hint

    # ------------------------------------------------------------- cancellation

    async def cancel(self, invocation_id: str) -> None:
        job = self._active.get(invocation_id)
        if job is None or job.cancelled:
            return
        job.cancelled = True
        try:
            async with asyncio.timeout(CLEANUP_SECONDS):
                await self._terminate(job)
        except (TimeoutError, OSError):
            # Cleanup that does not complete never promotes evidence to success;
            # termination_confirmed stays False and the result carries an error.
            pass
        finally:
            await self._close_job(job)

    async def _abort(self, job: _Invocation | None, invocation_id: str) -> None:
        if job is not None:
            await self.cancel(invocation_id)

    async def _release(self, job: _Invocation | None, invocation_id: str) -> None:
        if job is not None:
            await self._close_job(job)
            self._active.pop(invocation_id, None)

    async def _terminate(self, job: _Invocation) -> None:
        """Stop the supervisor through its PID handle; a bare PID is never signalled."""
        process = job.process
        if process is None or process.returncode is not None:
            return
        identity = job.process_identity or _read_process(process.pid)
        if identity is not None:
            await asyncio.to_thread(_signal_process, dict(identity), signal.SIGTERM)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(asyncio.shield(process.wait()), CLEANUP_SECONDS)

    async def _close_job(self, job: _Invocation) -> None:
        async with job.close_lock:
            process = job.process
            if process is not None and process.returncode is None:
                await self._terminate(job)
            if job.process_identity is not None and not job.process_stopped:
                job.process_stopped = await self.recover_termination(dict(job.process_identity))
            job.closed = True
            self._pending_stops[job.invocation_id] = job
            self.termination_confirmed(job.invocation_id)

    def termination_confirmed(self, invocation_id: str) -> bool:
        """True only after the owned supervisor proves all descendants stopped."""
        pending = self._pending_stops.get(invocation_id)
        if (
            pending is not None
            and pending.closed
            and (pending.process_identity is None or pending.process_stopped)
            and (not pending.startup_started or pending.startup_done.is_set())
        ):
            self._stopped.add(invocation_id)
            self._pending_stops.pop(invocation_id, None)
        return invocation_id in self._stopped

    async def recover_termination(self, identity: dict[str, Any]) -> bool:
        """Reconcile controller-persisted ownership; model claims are never proof.

        A missing supervisor without its reaping receipt is ambiguous: descendants
        can detach, so an empty session never proves termination.
        """
        if not _identity_shaped(identity):
            return False
        try:
            if _boot_id() != identity["boot_id"]:
                return True  # Processes from a previous boot cannot still run.
            if await asyncio.to_thread(self._receipt_valid, identity):
                return True
            leader = await asyncio.to_thread(_read_process, identity["pid"])
            if not _same_process(leader, identity):
                return False
            if not await asyncio.to_thread(_signal_process, identity, signal.SIGTERM):
                return False
            for _ in range(100):
                if await asyncio.to_thread(self._receipt_valid, identity):
                    return True
                await asyncio.sleep(0.05)
            return False
        except (OSError, ValueError, IndexError):
            return False

    @staticmethod
    def _receipt_valid(identity: Mapping[str, Any]) -> bool:
        try:
            path = Path(identity["receipt_path"])
            if (
                not path.is_absolute()
                or path.name != RECEIPT_NAME
                or any(parent.is_symlink() for parent in path.parents)
            ):
                return False
            parent = path.parent.stat()
            if parent.st_uid != os.geteuid() or stat.S_IMODE(parent.st_mode) != PRIVATE_DIR_MODE:
                return False
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor) as handle:
                info = os.fstat(handle.fileno())
                if (
                    not stat.S_ISREG(info.st_mode)
                    or info.st_size > 4096
                    or info.st_uid != os.geteuid()
                ):
                    return False
                receipt = json.load(handle)
            expected = {key: identity[key] for key in ("nonce", "pid", "start_ticks", "boot_id")}
            expected["descendants_reaped"] = True
            return receipt == expected
        except (OSError, ValueError, TypeError, KeyError):
            return False

    async def close(self) -> None:
        self._closed = True
        await asyncio.gather(*(self.cancel(key) for key in list(self._active)))


def _identity_shaped(identity: Mapping[str, Any]) -> bool:
    required = {"pid", "pgid", "sid", "start_ticks", "boot_id", "receipt_path", "nonce"}
    if set(identity) != required:
        return False
    if any(not isinstance(identity[key], str) for key in ("boot_id", "receipt_path", "nonce")):
        return False
    if len(identity["nonce"]) != 32 or any(
        character not in "0123456789abcdef" for character in identity["nonce"]
    ):
        return False
    if any(
        type(identity[key]) is not int or identity[key] <= 0
        for key in ("pid", "pgid", "sid", "start_ticks")
    ):
        return False
    return identity["pid"] == identity["pgid"] == identity["sid"]


def _confinement_failure(exit_code: int | None, stderr: str) -> str | None:
    """Tell "the sandbox could not be established" from "the check failed".

    ``bwrap`` diagnoses its own setup and exec failures on the first stderr line.
    An operation the *profile* blocked surfaces as the command's own ENOENT or
    EACCES and is a genuine check failure, which this deliberately leaves alone.
    """
    if exit_code == 0:
        return None
    first = next((line for line in stderr.splitlines() if line.strip()), "")
    if first.startswith(BWRAP_DIAGNOSTIC_PREFIX):
        return CONFINEMENT_FAILED.format(detail=first.strip()[:400])
    return None


def _isolated_config_dir(control_dir: Path) -> Path | None:
    """Give the reviewer a config directory holding only a copy of the credential.

    Spike S12: both the user's own config directory and an isolated one work, and
    ``--bare`` refuses OAuth subscription credentials outright.  The isolated one
    is preferred because it exposes no settings, history or transcripts.  When no
    credential file exists (keychain or API-key auth), the reviewer inherits the
    user's configuration instead of being handed an empty one.
    """
    source = Path.home() / CLAUDE_HOME / CREDENTIALS_FILE
    try:
        payload = source.read_bytes()
    except OSError:
        return None
    target = control_dir / CONFIG_DIRNAME
    try:
        target.mkdir(mode=PRIVATE_DIR_MODE, exist_ok=True)
        descriptor = os.open(
            target / CREDENTIALS_FILE,
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW,
            PRIVATE_FILE_MODE,
        )
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
    except OSError:
        return None
    return target


def _purge_credentials(control_dir: Path) -> None:
    """No copied credential outlives the session that needed it."""
    with contextlib.suppress(OSError):
        shutil.rmtree(control_dir / CONFIG_DIRNAME)


def _packet_bytes(
    role: Role, candidate: Candidate, packet: Mapping[str, Any], policy: Policy
) -> bytes:
    payload = json.dumps(
        {"role": role, "candidate": candidate.model_dump(mode="json"), "packet": dict(packet)},
        ensure_ascii=False,
    ).encode("utf-8")
    if len(payload) > policy.max_output_bytes:
        raise AdapterError("The review packet exceeds its bounded size; reduce evidence excerpts.")
    return payload


def create_adapter(
    *,
    receipt_root: Path | str | None = None,
    claude_bin: str = ENGINE_BINARY,
    config_dir: Path | str | None = None,
) -> ClaudeAdapter:
    return ClaudeAdapter(receipt_root=receipt_root, claude_bin=claude_bin, config_dir=config_dir)
