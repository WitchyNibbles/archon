"""The copied credential a hermetic reviewer session is authenticated by.

Spike S12 settled the shape: ``claude --bare`` refuses an OAuth subscription
credential outright, an isolated ``CLAUDE_CONFIG_DIR`` holding nothing but a 0600
copy of ``~/.claude/.credentials.json`` works, and it exposes no settings, history
or transcripts.  That copy is a real secret on disk for the life of one review, so
everything about its directory, its lifetime and its cleanup lives here rather
than scattered through the adapter.

Two findings shaped this module.  SEC-L2: ``Path.mkdir(exist_ok=True)`` succeeds
on a pre-existing symlink that points at a directory, and only the leaf was
``O_NOFOLLOW``-guarded, so the copy could be written through whatever that link
named.  SEC-M2: the adapter's docstring claimed no copied credential outlives the
session, which was true of every normal return and every exception path and false
for SIGTERM, SIGINT, OOM and a host crash — and nothing anywhere swept what those
left behind.
"""

from __future__ import annotations

import contextlib
import errno
import json
import os
import shutil
import signal
import stat
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .launcher import (
    PRIVATE_DIR_MODE,
    PRIVATE_FILE_MODE,
    read_boot_id,
    read_process,
    write_private,
)

CLAUDE_HOME = ".claude"
CREDENTIALS_FILE = ".credentials.json"
CONFIG_DIRNAME = "config"
OWNER_NAME = "owner.json"


def open_private_directory(path: Path) -> int:
    """Create and open a uid-private directory that cannot be a planted symlink.

    SEC-L2: ``O_DIRECTORY|O_NOFOLLOW`` refuses the link itself, and every later
    write goes through this descriptor with ``openat`` rather than by path.
    """
    with contextlib.suppress(FileExistsError):
        os.mkdir(path, PRIVATE_DIR_MODE)
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != PRIVATE_DIR_MODE:
            raise OSError(
                errno.EPERM, f"The reviewer configuration directory is not uid-private: {path}"
            )
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def isolated_config_dir(control_dir: Path) -> Path | None:
    """Give the reviewer a config directory holding only a copy of the credential.

    When no credential file exists — keychain or API-key auth — the reviewer
    inherits the user's own configuration rather than being handed an empty
    directory, which the engine reports as ``Not logged in`` at zero cost and one
    turn and which looks exactly like a silent refusal (S12).
    """
    source = Path.home() / CLAUDE_HOME / CREDENTIALS_FILE
    try:
        payload = source.read_bytes()
    except OSError:
        return None
    target = control_dir / CONFIG_DIRNAME
    try:
        directory = open_private_directory(target)
    except OSError:
        return None
    try:
        descriptor = os.open(
            CREDENTIALS_FILE,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            PRIVATE_FILE_MODE,
            dir_fd=directory,
        )
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
    except OSError:
        return None
    finally:
        os.close(directory)
    return target


def purge_credentials(control_dir: Path) -> None:
    """Remove a copied credential.

    SEC-M2: the copy is removed on every normal return and every exception path,
    and additionally by :func:`purge_all` on SIGTERM/SIGINT and by :func:`sweep`
    for the exits no handler can run — SIGKILL, OOM, and a host crash.  Unlinking
    the copy the moment the engine opened it is not available: the engine reads
    ``$CLAUDE_CONFIG_DIR/.credentials.json`` by path during the session, and
    whether it reopens it cannot be established without a live authenticated run,
    which no test here may spend.
    """
    with contextlib.suppress(OSError):
        shutil.rmtree(control_dir / CONFIG_DIRNAME)
    LIVE_CONTROL_DIRS.discard(control_dir)


#: Control directories with a live credential copy in this process.  Module level
#: so the signal handlers are installed once rather than once per adapter.
LIVE_CONTROL_DIRS: set[Path] = set()
_HANDLERS_INSTALLED = False


def register_control_dir(control_dir: Path) -> None:
    LIVE_CONTROL_DIRS.add(control_dir)


def purge_all() -> None:
    for control_dir in list(LIVE_CONTROL_DIRS):
        purge_credentials(control_dir)


def purge_on_signal(previous: Any) -> Callable[[int, Any], None]:
    def handle(number: int, frame: Any) -> None:
        purge_all()
        if callable(previous):
            previous(number, frame)
            return
        signal.signal(number, signal.SIG_DFL)
        os.kill(os.getpid(), number)

    return handle


def install_purge_handlers() -> None:
    """Purge copied credentials on the terminating signals a handler can see.

    The previous handler still runs, so ``KeyboardInterrupt`` and the default
    SIGTERM death are unchanged (SEC-M2).
    """
    global _HANDLERS_INSTALLED
    if _HANDLERS_INSTALLED:
        return
    try:
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, purge_on_signal(signal.getsignal(sig)))
    except (ValueError, OSError):
        return  # Not the main thread; the constructor sweep remains the backstop.
    _HANDLERS_INSTALLED = True


def sweep(receipt_root: Path) -> list[Path]:
    """Delete credential copies left by an exit that ran no handler.

    Only a control directory whose owning process is provably gone is swept: the
    owner marker names the pid, its start ticks and the boot id, so a concurrent
    Archon on the same state root keeps its own copy.  A directory with no marker
    predates the marker and is swept too, which is the leak this exists for.
    """
    swept: list[Path] = []
    try:
        candidates = sorted(receipt_root.glob("runtime-*"))
    except OSError:
        return swept
    for control_dir in candidates:
        if not (control_dir / CONFIG_DIRNAME).is_dir() or control_dir in LIVE_CONTROL_DIRS:
            continue
        if owner_alive(control_dir):
            continue
        purge_credentials(control_dir)
        swept.append(control_dir)
    return swept


def owner_alive(control_dir: Path) -> bool:
    try:
        marker = json.loads((control_dir / OWNER_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(marker, dict) or marker.get("boot_id") != read_boot_id():
        return False
    pid, ticks = marker.get("pid"), marker.get("start_ticks")
    if not isinstance(pid, int) or not isinstance(ticks, int):
        return False
    process = read_process(pid)
    return process is not None and process["start_ticks"] == ticks


def write_owner(control_dir: Path) -> None:
    """Name the process whose exit would strand this directory's credential copy."""
    own = read_process(os.getpid()) or {}
    with contextlib.suppress(OSError):
        write_private(
            control_dir / OWNER_NAME,
            json.dumps(
                {
                    "pid": os.getpid(),
                    "start_ticks": own.get("start_ticks"),
                    "boot_id": read_boot_id(),
                }
            ),
        )
