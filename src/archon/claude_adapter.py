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
new session id, never resumed.  Not because the engine cannot: at 2.1.280 spike
S9 plants a token in a session, kills it, and gets the token back from
``--resume`` every time.  Because a resumed reviewer is a new review wearing the
previous one's identity, and three approvals with three distinct session ids is
what the gate rests on.  The
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
from datetime import UTC, datetime
from pathlib import Path
from tempfile import mkdtemp
from typing import Any
from uuid import uuid4

from .credentials import (
    install_purge_handlers,
    isolated_config_dir,
    purge_credentials,
    register_control_dir,
    sweep,
    write_owner,
)
from .launcher import (
    PRIVATE_DIR_MODE,
    pidfd_open,
    pidfd_send_signal,
    pidfd_supported,
    read_boot_id,
    read_process,
    write_private,
)
from .models import (
    Candidate,
    CheckSpec,
    CommandResult,
    EventCallback,
    Policy,
    RateLimited,
    ReviewResult,
    Role,
)
from .review_profile import (
    MANAGED_REVIEW_ENV,
    REQUIRED_PERMISSION_MODE,
    REVIEW_ALLOW,
    REVIEW_DENY,
    REVIEW_DENY_READ,
    REVIEW_TOOLS,
    SCHEMA_UNSUPPORTED_KEYWORDS,
    STRUCTURED_OUTPUT_TOOL,
    review_schema,
    review_settings,
    reviewer_deny_read,
)
from .sandbox import (
    BwrapProbe,
    CheckProfile,
    SandboxError,
    prepare_scratch,
    probe_bwrap,
    render_bwrap,
)
from .stream import (
    AdapterError,
    _decode_event,
    _event_method,
    _ReviewSession,
    parse_reset_time,
)

#: Re-exported so ``archon.claude_adapter`` stays the one import site for the
#: adapter's callers; the definitions live in :mod:`archon.review_profile`.
__all__ = [
    "AdapterError",
    "ClaudeAdapter",
    "REVIEW_ALLOW",
    "REVIEW_DENY",
    "REVIEW_DENY_READ",
    "REVIEW_TOOLS",
    "SCHEMA_UNSUPPORTED_KEYWORDS",
    "STRUCTURED_OUTPUT_TOOL",
    "create_adapter",
    "parse_reset_time",
    "reviewer_deny_read",
    "review_schema",
    "review_settings",
    "tested_engine_range",
]

#: The process-identity primitives moved to :mod:`archon.launcher` in the split.
#: ``tests/test_security.py`` imports them from here, so the names stay bound.
_read_process = read_process
_boot_id = read_boot_id

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
RECEIPT_NAME = "stopped.json"
#: The receipt gets a directory of its own inside the control directory, so no
#: path the supervised child can write shares a parent with it (SEC-M1).
RECEIPT_DIRNAME = "receipt"
#: A scratch that exists only long enough to render a profile for its digest.
#: Deliberately not ``runtime-*``: the credential sweep must not consider it.
DIGEST_SCRATCH_PREFIX = "digest-"

PERMISSION_PROMPT_TARGET = "none"
STREAM_FORMAT = "stream-json"
SETTING_SOURCES = ""
CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR"
REVIEWER_ASSETS = ("assets", "archon", "reviewers")
REVIEWER_ROLES: tuple[str, ...] = ("reviewer", "qa_engineer", "security_reviewer")

EVIDENCE_DIRECTORY = ("docs", "evidence")
EVIDENCE_PATTERN = "*-spike-*.json"
#: The book a version must complete before it counts as tested. `S8` is
#: included even though it stands UNRESOLVED: an honest unresolved verdict is
#: a result, an absent one is silence. `preflight` and `host` are not spikes.
REQUIRED_SPIKE_IDS: frozenset[str] = frozenset(f"S{n}" for n in range(1, 13))
#: A spike has a result when it carries any of these. Silence is not a result.
RECORDED_VERDICTS: frozenset[str] = frozenset({"PASS", "FAIL", "UNRESOLVED"})
FAILED_VERDICT = "FAIL"
VERSION_PATTERN = re.compile(r"(\d+(?:\.\d+){1,3})")
BWRAP_DIAGNOSTIC_PREFIX = "bwrap:"
#: ``bwrap --json-status-fd N`` writes ``{"child-pid": …}`` once the child is
#: forked and ``{"exit-code": N}`` only after that child actually ran and was
#: reaped.  A bind-setup failure and an exec failure both stop after the first
#: document, which is what separates them from a check that merely failed.
STATUS_FLAG = "--json-status-fd"
STATUS_EXIT_KEY = "exit-code"
#: Names the descriptor for the supervisor, which forwards it and never reads it.
STATUS_FD_ENV = "ARCHON_STATUS_FD"
MAX_STATUS_BYTES = 65_536
DENIAL_ARTIFACT = "permission-denials.json"
STREAM_ARTIFACT = "stream.jsonl"

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
CONFINEMENT_NO_STATUS = "the sandbox reported no child exit status"


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


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
        if not _same_process(read_process(expected["pid"]), expected):
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


def versions_with_a_complete_book() -> list[str]:
    """Engine versions that have a verdict on record for *every* spike in the book.

    A single evidence file used to be enough to widen the range, and that is
    how this project nearly shipped a lie about itself. The engine updated
    from 2.1.278 to 2.1.280 mid-session; re-running only the host one-liners
    wrote one record at the new version, and the derived range immediately
    claimed 2.1.280 was tested when eleven of twelve spikes had never run
    there.

    ``docs/spikes.md`` already said the right thing — the range comes from
    versions with a *complete* book — but the code counted any record at all.
    A partial book now widens nothing, so `doctor` keeps warning about an
    untested engine until someone actually runs the book against it.
    """
    directory = _evidence_directory()
    if directory is None:
        return []
    by_version: dict[str, set[str]] = {}
    for path in sorted(directory.glob(EVIDENCE_PATTERN)):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        version = record.get("engine_version")
        spike_id = record.get("id")
        if not isinstance(version, str) or not VERSION_PATTERN.fullmatch(version):
            continue
        # Every verdict counts toward completeness, FAIL included. The range
        # says the book was *executed* at this version, which is all a drift
        # warning needs; it does not say everything passed. S9 stands FAIL
        # because `--resume` genuinely cannot recover a killed session, and
        # dropping that honest result would empty the range entirely.
        if not isinstance(spike_id, str) or record.get("verdict") not in RECORDED_VERDICTS:
            continue
        by_version.setdefault(version, set()).add(spike_id)
    complete = [v for v, ids in by_version.items() if REQUIRED_SPIKE_IDS <= ids]
    return sorted(complete, key=_version_tuple)


def tested_engine_range() -> list[str]:
    """Derive the tested engine range from recorded spike evidence, never by hand."""
    complete = versions_with_a_complete_book()
    if not complete:
        return []
    return [complete[0], complete[-1]]


def _version_inside(version: str | None, tested: Sequence[str]) -> bool | None:
    if version is None or len(tested) != 2:
        return None
    try:
        return _version_tuple(tested[0]) <= _version_tuple(version) <= _version_tuple(tested[1])
    except ValueError:
        return None


@dataclass(frozen=True)
class _CheckExit:
    """What the supervisor returned, and what the sandbox itself attested.

    ``sandbox_exit`` is ``None`` when ``bwrap`` never reported an ``exit-code``,
    which is the only reliable statement that the child did not run.
    """

    supervisor_code: int
    sandbox_exit: int | None

    @property
    def reported(self) -> int:
        """bwrap's own number wins: the supervisor can exit on a signal instead."""
        return self.supervisor_code if self.sandbox_exit is None else self.sandbox_exit


class _StatusPipe:
    """A kernel-held pipe that only ``bwrap`` writes to.

    The write end is inherited by the supervisor and by ``bwrap``; the confined
    child never sees it — measured at bubblewrap 0.9.0, a child that enumerated
    its own descriptors held exactly ``0, 1, 2`` while this pipe still received
    both status documents.  So the channel cannot be forged from inside the
    confinement, which is what makes it a decision and stderr merely diagnosis.
    """

    def __init__(self) -> None:
        self.read_fd, self.write_fd = os.pipe()
        os.set_blocking(self.read_fd, False)
        os.set_inheritable(self.write_fd, True)

    @classmethod
    def open(cls) -> _StatusPipe:
        return cls()

    def __enter__(self) -> _StatusPipe:
        return self

    def __exit__(self, *exception: object) -> None:
        self.release_write()
        with contextlib.suppress(OSError):
            os.close(self.read_fd)

    def release_write(self) -> None:
        """Drop the kernel's copy once the supervisor holds one, so reads see EOF."""
        if self.write_fd >= 0:
            with contextlib.suppress(OSError):
                os.close(self.write_fd)
            self.write_fd = -1

    def exit_code(self) -> int | None:
        """The child's exit code, or ``None`` when the sandbox never ran one."""
        return _parse_status(self._drain())

    def _drain(self) -> bytes:
        captured = bytearray()
        while len(captured) < MAX_STATUS_BYTES:
            try:
                chunk = os.read(self.read_fd, READ_CHUNK_BYTES)
            except (BlockingIOError, InterruptedError, OSError):
                break
            if not chunk:
                break
            captured.extend(chunk)
        return bytes(captured)


def _parse_status(payload: bytes) -> int | None:
    """Read the last ``exit-code`` bwrap wrote; a partial line proves nothing."""
    code: int | None = None
    for line in payload.decode("utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            document = json.loads(line)
        except json.JSONDecodeError:
            continue
        value = document.get(STATUS_EXIT_KEY) if isinstance(document, dict) else None
        if isinstance(value, int) and not isinstance(value, bool):
            code = int(value)
    return code


def _with_status_fd(argv: Sequence[str], write_fd: int) -> list[str]:
    """Insert ``--json-status-fd`` without touching the rendered profile.

    The flag goes directly after the binary, before any bind or the argv
    separator, so ``sandbox.render_bwrap`` stays the sole author of the
    confinement and its digest is unchanged: this adds an output channel for the
    kernel, never a capability for the check.
    """
    rendered = list(argv)
    return [*rendered[:1], STATUS_FLAG, str(write_fd), *rendered[1:]]


@dataclass
class _Invocation:
    """One supervised child: its control directory, receipt and lifecycle flags."""

    invocation_id: str
    kind: str
    control_dir: Path
    receipt_dir: Path
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
        # SEC-M2: SIGKILL, OOM and a host crash run no cleanup, so the previous
        # process's credential copies are swept here before this one starts.
        install_purge_handlers()
        self.swept_credentials = sweep(self._receipt_root)

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
        receipt_dir = control_dir / RECEIPT_DIRNAME
        receipt_dir.mkdir(mode=PRIVATE_DIR_MODE)
        nonce = uuid4().hex
        job = _Invocation(
            invocation_id=invocation_id,
            kind=kind,
            control_dir=control_dir,
            receipt_dir=receipt_dir,
            nonce=nonce,
            receipt_path=str(receipt_dir / RECEIPT_NAME),
        )
        register_control_dir(control_dir)
        write_owner(control_dir)
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
        """The supervisor is given the receipt directory, not the control directory.

        SEC-M1: the receipt used to sit beside every writable artifact path the
        supervised child holds, so a child that created one file before exiting
        won the race against a supervisor that only opened the receipt afterwards.
        Nothing but ``stopped.json`` lives in this directory now, and
        ``launcher.supervise`` claims that name ``O_EXCL`` before the child exists.
        """
        return [*self._launcher, str(job.receipt_dir), job.nonce, job.kind, ARGV_SEPARATOR, *command]

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
        pass_fds: tuple[int, ...] = (),
    ) -> None:
        """Start the supervisor, prove ownership, then release the payload.

        The check's argv is the supervisor's own child, so the supervisor *is* the
        dispatch: the ownership record is emitted as soon as identity is provable,
        before any output is read.  ``pass_fds`` carries the kernel's own bwrap
        status pipe through the supervisor; nothing else is inherited.
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
                pass_fds=pass_fds,
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
            info = read_process(process.pid)
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
        return {"boot_id": read_boot_id(), "receipt_path": job.receipt_path, "nonce": job.nonce}

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
            write_private(path, payload)
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
            exit_status = await self._supervise_check(job, argv, root, streams, on_event, timeout)
            outcome["exit_code"] = exit_status.reported
            await self._close_job(job)
            self._finish_check(job, invocation_id, outcome, streams, exit_status.sandbox_exit)
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

    def check_profile_digest(self, candidate: Candidate, policy: Policy) -> str:
        """The digest the kernel itself would render for this candidate's checks.

        The gate records ``CommandResult.sandbox_profile_digest`` so evidence binds
        to the exact confinement it was produced under, but the kernel could only
        assert that *some* self-consistent digest was present: it had no way to
        re-derive the one it expected, so a result naming any other profile still
        passed.  This closes that by rendering the real profile through the same
        construction ``run_command`` uses — never a copy of its shape, and never a
        quoted value, which would already be stale after the confinement package
        masked the host runtime directory.

        A throwaway scratch is used because ``digest()`` canonicalises every
        variable path; only the confinement's *shape* reaches the hash.
        """
        root = Path(candidate.repo_root).resolve()
        self._validate_check(root, root, policy)
        scratch = Path(mkdtemp(prefix=DIGEST_SCRATCH_PREFIX, dir=self._receipt_state(root, root)))
        try:
            return self._profile(scratch, root).digest()
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    def _check_profile(self, job: _Invocation, root: Path) -> CheckProfile:
        return self._profile(job.control_dir / "scratch", root)

    def _profile(self, scratch: Path, root: Path) -> CheckProfile:
        """Mask the whole workspace state root, not just the supervisor receipts.

        SEC-H2, demonstrated live: the profile was handed the receipt root, so the
        kernel's sole authority — ``state.sqlite3``, a *sibling* of that directory —
        stayed readable under the read-only root bind.  Writes were already blocked,
        but a repository-authored check could read every recorded review payload,
        finding and checkpoint.  Checks run in the worktree and never need the
        snapshot, so the whole state root is masked for them.
        """
        return CheckProfile(
            worktree=root,
            scratch=prepare_scratch(scratch),
            state_dir=self._state_root(),
            home=Path.home().resolve(),
        )

    def _state_root(self) -> Path:
        """The workspace state root: ``<state>/repos/<id>`` holding the database,
        ``snapshots/`` and the ``supervisors/`` receipt root this adapter was given."""
        return self._receipt_root.resolve().parent

    async def _supervise_check(
        self,
        job: _Invocation,
        argv: Sequence[str],
        cwd: Path,
        streams: Mapping[str, _Sink],
        on_event: EventCallback | None,
        timeout: int,
    ) -> _CheckExit:
        with _StatusPipe.open() as status:
            async with asyncio.timeout(timeout):
                await self._dispatch(
                    job,
                    _with_status_fd(argv, status.write_fd),
                    cwd=cwd,
                    env={**os.environ, STATUS_FD_ENV: str(status.write_fd)},
                    stdin_data=None,
                    on_event=on_event,
                    pass_fds=(status.write_fd,),
                )
                status.release_write()
                await asyncio.gather(
                    *(self._pump(job, name, sink, on_event) for name, sink in streams.items())
                )
                supervisor_code = await self._require_process(job).wait()
            return _CheckExit(supervisor_code=supervisor_code, sandbox_exit=status.exit_code())

    def _finish_check(
        self,
        job: _Invocation,
        invocation_id: str,
        outcome: dict[str, Any],
        streams: Mapping[str, _Sink],
        sandbox_exit: int | None,
    ) -> None:
        """Classify the outcome; a confinement fault never reads as a check result."""
        if not self.termination_confirmed(invocation_id):
            outcome["error"] = UNCONFIRMED_CHECK
            return
        if job.cancelled:
            outcome.update(interrupted=True, error="The check was cancelled.")
            return
        confinement = _confinement_failure(sandbox_exit, streams["stderr"].text())
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
                purge_credentials(job.control_dir)
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
        # Only a check carries a bwrap status pipe. Inheriting the name without the
        # descriptor would make the supervisor refuse the reviewer outright.
        env.pop(STATUS_FD_ENV, None)
        config_dir = self._config_dir or isolated_config_dir(job.control_dir)
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
        settings = write_private(
            job_dir / "settings.json",
            json.dumps(
                review_settings(
                    snapshot, scratch, self._receipt_root.resolve(), self._state_root()
                )
            ),
        )
        prompt = write_private(job_dir / f"{role}.md", _role_prompt(role))
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
        identity = job.process_identity or read_process(process.pid)
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
            if read_boot_id() != identity["boot_id"]:
                return True  # Processes from a previous boot cannot still run.
            if await asyncio.to_thread(self._receipt_valid, identity):
                return True
            leader = await asyncio.to_thread(read_process, identity["pid"])
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


def _confinement_failure(sandbox_exit: int | None, stderr: str) -> str | None:
    """Tell "the sandbox could not be established" from "the check failed".

    SEC-H4, demonstrated live: this used to decide on the first stderr line
    starting with ``bwrap:``.  The child's stderr and bwrap's stderr are the same
    stream and the exit code does not separate them, so a failing test suite that
    printed that prefix was recorded as a runtime fault instead of a failed check
    — the repository classifying its own evidence.

    The decision is now the JSON status pipe, measured at bubblewrap 0.9.0:

    * clean run, child exits 3 → ``{"child-pid": …}`` then ``{"exit-code": 3}``;
    * bind-setup failure (``--bind /nonexistent``) → ``{"child-pid": …}`` only;
    * exec failure (``/nonexistent/archon-check``) → ``{"child-pid": …}`` only.

    So a missing ``exit-code`` *is* the confinement fault, and the ``bwrap:``
    prefix survives only as the diagnosis text quoted back to the operator.  An
    operation the *profile* blocked still surfaces as the command's own ENOENT or
    EACCES with a real exit code, and stays a genuine check failure.
    """
    if sandbox_exit is not None:
        return None
    first = next((line for line in stderr.splitlines() if line.strip()), "")
    detail = (
        first.strip()[:400]
        if first.startswith(BWRAP_DIAGNOSTIC_PREFIX)
        else CONFINEMENT_NO_STATUS
    )
    return CONFINEMENT_FAILED.format(detail=detail)


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
