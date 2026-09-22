"""Linux subreaper for one Archon-owned child, launched with Python ``-I``.

Archon dispatches exactly two kinds of child: a check, whose argv is already the
rendered ``bwrap`` confinement from :mod:`archon.sandbox`, and a reviewer
``claude -p`` session.  Neither is composed here.  This supervisor stays alive
until all descendants, including detached ones, are reaped, and writes the
termination receipt the kernel needs before it may call a check passed.

It also holds the three primitives that supervision rests on and that the adapter
and the credential store both need — process identity from ``/proc``, the boot id,
and the private 0600 file write.  They live in one place rather than in each
caller because the release gate's CRITICAL finding was two copies of a list
drifting apart inside a file nobody read end to end.
"""

from __future__ import annotations

import ctypes
import errno
import json
import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, cast


def _libc_function(
    name: str, argument_types: list[type[ctypes._SimpleCData]]
) -> Callable[..., int]:
    try:
        function = getattr(ctypes.CDLL(None, use_errno=True), name)
    except AttributeError as exc:
        raise OSError(errno.ENOSYS, "Kernel PID handles are unavailable in this runtime.") from exc
    function.argtypes = argument_types
    function.restype = ctypes.c_int
    return cast(Callable[..., int], function)


def pidfd_open(pid: int) -> int:
    """Open a kernel PID handle even when Python omitted its optional binding."""
    if not isinstance(pid, int) or not 0 < pid <= 2**31 - 1:
        raise ValueError("PID must be a positive signed 32-bit integer.")
    native = getattr(os, "pidfd_open", None)
    if native is not None:
        return int(native(pid, 0))
    function = _libc_function("pidfd_open", [ctypes.c_int, ctypes.c_uint])
    descriptor = function(pid, 0)
    if descriptor < 0:
        error = ctypes.get_errno() or errno.EIO
        raise OSError(error, os.strerror(error))
    return int(descriptor)


def pidfd_send_signal(descriptor: int, sig: int) -> None:
    """Signal only the process bound to a kernel handle, never a numeric PID."""
    if not isinstance(descriptor, int) or not 0 <= descriptor <= 2**31 - 1:
        raise ValueError("PID handle must be a nonnegative signed 32-bit integer.")
    if not isinstance(sig, int) or not 0 <= sig <= 2**31 - 1:
        raise ValueError("Signal must be a nonnegative signed 32-bit integer.")
    native = getattr(signal, "pidfd_send_signal", None)
    if native is not None:
        native(descriptor, sig)
        return
    function = _libc_function(
        "pidfd_send_signal", [ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint]
    )
    if function(descriptor, sig, None, 0) < 0:
        error = ctypes.get_errno() or errno.EIO
        raise OSError(error, os.strerror(error))


def pidfd_supported() -> bool:
    """Probe actual kernel/runtime access without delivering a process signal."""
    if sys.platform != "linux" or not Path("/proc").is_dir():
        return False
    try:
        descriptor = pidfd_open(os.getpid())
        try:
            pidfd_send_signal(descriptor, 0)
        finally:
            os.close(descriptor)
    except OSError:
        return False
    return True


PRIVATE_DIR_MODE = 0o700
PRIVATE_FILE_MODE = 0o600


def read_process(pid: int) -> dict[str, Any] | None:
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


def read_boot_id() -> str:
    """Processes from a previous boot cannot still be running under these PIDs."""
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def write_private(path: Path, payload: str) -> Path:
    """Create a uid-private file, never write through a link or over a plant."""
    descriptor = os.open(
        path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, PRIVATE_FILE_MODE
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(payload)
    return path


def _birth(pid: int) -> int | None:
    process = read_process(pid)
    return None if process is None else int(process["start_ticks"])


def _children() -> list[int]:
    return [
        int(value) for value in Path(f"/proc/self/task/{os.getpid()}/children").read_text().split()
    ]


def _kill_children() -> None:
    """Reparenting to a live subreaper catches descendants that called setsid."""
    while True:
        for pid in _children():
            try:
                descriptor = pidfd_open(pid)
            except ProcessLookupError:
                continue
            try:
                stat = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
                if int(stat[1]) == os.getpid():
                    pidfd_send_signal(descriptor, signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError):
                pass
            finally:
                os.close(descriptor)
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return  # ECHILD is the only successful completion condition.
        if pid == 0:
            time.sleep(0.02)


RECEIPT_NAME = "stopped.json"
FORGED_RECEIPT = (
    "Archon supervisor receipt already exists; refusing to supervise a control directory "
    "whose termination attestation was written by something else."
)


def _claim_receipt(receipt_dir: Path) -> int:
    """Claim the receipt name before the supervised child exists (SEC-M1).

    The receipt used to be opened ``O_EXCL`` only *after* the child exited, and
    none of its fields are secret to that child: the nonce is in
    ``/proc/<ppid>/cmdline``, the rest in ``/proc/<ppid>/stat`` and the boot id.
    A child that created this one file before exiting won the race, the
    supervisor's own write then raised, and the validator accepted the planted
    file — attesting ``descendants_reaped: True`` while descendants were alive.
    Claiming the name first inverts that: the child can no longer create it, and
    an ``EEXIST`` here is a forgery signal, not a lifecycle error.
    """
    try:
        return os.open(
            receipt_dir / RECEIPT_NAME,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            PRIVATE_FILE_MODE,
        )
    except FileExistsError as exc:
        raise SystemExit(FORGED_RECEIPT) from exc


def supervise(
    command: list[str], receipt_dir: Path, nonce: str, pass_fds: tuple[int, ...] = ()
) -> int:
    """Internal supervisor primitive; the executable entry fixes the command."""
    if not pidfd_supported():
        raise OSError(errno.ENOSYS, "Kernel PID handles are unavailable for managed execution.")
    stop_requested = False

    def request_stop(_signal: int, _frame: object) -> None:
        nonlocal stop_requested
        stop_requested = True

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, request_stop)
    parent_pid = os.getppid()
    parent_birth = _birth(parent_pid)
    libc = ctypes.CDLL(None, use_errno=True)
    for option, value in ((36, 1), (1, signal.SIGTERM)):
        if libc.prctl(option, value, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "Cannot establish the Codex supervisor lifecycle")
    if os.getppid() != parent_pid or _birth(parent_pid) != parent_birth:
        stop_requested = True
    os.setsid()
    own_birth = _birth(os.getpid())
    boot_id = read_boot_id()
    exit_code = 1
    descriptor = _claim_receipt(receipt_dir)
    try:
        if not stop_requested:
            primary = subprocess.Popen(command, pass_fds=pass_fds)
            while not stop_requested:
                code = primary.poll()
                if code is not None:
                    exit_code = code
                    break
                time.sleep(0.02)
    finally:
        _kill_children()
    receipt = {
        "nonce": nonce,
        "pid": os.getpid(),
        "start_ticks": own_birth,
        "boot_id": boot_id,
        "descendants_reaped": True,
    }
    with os.fdopen(descriptor, "w") as handle:
        json.dump(receipt, handle)
        handle.flush()
        os.fsync(handle.fileno())
    directory_fd = os.open(receipt_dir, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    return exit_code


SEPARATOR = "--"
KINDS: tuple[str, ...] = ("check", "review")
CONFIG_DIR_VARIABLE = "CLAUDE_CONFIG_DIR"
STATUS_FD_VARIABLE = "ARCHON_STATUS_FD"
NONCE_DIGITS = "0123456789abcdef"
NONCE_LENGTH = 32
USAGE = "Usage: archon-launch <control_dir> <nonce> {check|review} -- <argv...>"


def _split_invocation(arguments: list[str]) -> tuple[list[str], list[str]]:
    """Separate the supervisor's own arguments from the child argv it must not read."""
    if SEPARATOR not in arguments:
        raise SystemExit(USAGE)
    boundary = arguments.index(SEPARATOR)
    head, command = arguments[:boundary], arguments[boundary + 1 :]
    if len(head) != 3 or not command:
        raise SystemExit(USAGE)
    return head, command


def _honour_config_dir(environ: Mapping[str, str]) -> None:
    """Honour an adapter-supplied reviewer config directory; never invent one."""
    value = environ.get(CONFIG_DIR_VARIABLE)
    if value is None:
        return
    directory = Path(value)
    if not directory.is_absolute() or not directory.is_dir() or directory.is_symlink():
        raise SystemExit("Invalid Archon reviewer configuration directory.")


def status_fds(environ: Mapping[str, str]) -> tuple[int, ...]:
    """Forward the kernel's ``bwrap --json-status-fd`` pipe, or nothing at all.

    The descriptor is named by the adapter that opened it; this supervisor keeps
    it across the exec and never reads it.  It is the channel that separates "the
    sandbox never ran the child" from "the check failed" (SEC-H4), so a name that
    does not resolve to an open descriptor is refused rather than dropped: a
    silently missing status pipe would make every check look like a runtime fault.
    """
    value = environ.get(STATUS_FD_VARIABLE)
    if value is None:
        return ()
    if not value.isdigit():
        raise SystemExit("Invalid Archon supervisor status descriptor.")
    descriptor = int(value)
    try:
        os.fstat(descriptor)
    except OSError as exc:
        raise SystemExit("Invalid Archon supervisor status descriptor.") from exc
    return (descriptor,)


def main() -> None:
    if sys.platform != "linux":
        raise SystemExit("Archon managed execution requires Linux subreaper support.")
    head, command = _split_invocation(sys.argv[1:])
    receipt_dir = Path(head[0])
    nonce, kind = head[1], head[2]
    if not receipt_dir.is_absolute() or not receipt_dir.is_dir() or receipt_dir.is_symlink():
        raise SystemExit("Invalid Archon supervisor receipt directory.")
    if len(nonce) != NONCE_LENGTH or any(character not in NONCE_DIGITS for character in nonce):
        raise SystemExit("Invalid Archon supervisor nonce.")
    if kind not in KINDS:
        raise SystemExit(USAGE)
    if kind == "review":
        _honour_config_dir(os.environ)
    raise SystemExit(supervise(command, receipt_dir, nonce, status_fds(os.environ)))


if __name__ == "__main__":
    main()
