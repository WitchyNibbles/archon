"""Supervisor contract: kernel PID handles, the termination receipt, and the CLI.

The pidfd and subreaper cases are ported from the donor harness
(``devgod-recovery/tests/test_codex_adapter.py``); they are the proven part of
``launcher.py`` and must keep passing byte-for-byte against the same behaviour.
The CLI cases are new: Archon dispatches a rendered ``bwrap`` argv or a
``claude -p`` argv and composes neither.
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
from pathlib import Path
from typing import Any

import pytest

import archon.launcher as module
from archon.claude_adapter import ClaudeAdapter
from archon.launcher import pidfd_open, pidfd_send_signal, supervise

NONCE = "c" * 32


def _read_process(pid: int) -> dict[str, Any] | None:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    except (FileNotFoundError, ProcessLookupError):
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


def _await(predicate: Any, timeout: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


# ------------------------------------------------------- ported pidfd cases


@pytest.mark.skipif(sys.platform != "linux", reason="Linux kernel PID handles")
@pytest.mark.parametrize("missing", [(), ("open",), ("open", "signal")])
def test_pid_handles_remain_available_without_optional_python_bindings(
    monkeypatch: pytest.MonkeyPatch, missing: tuple[str, ...]
) -> None:
    from archon.launcher import pidfd_supported

    if "open" in missing:
        monkeypatch.delattr(os, "pidfd_open", raising=False)
    if "signal" in missing:
        monkeypatch.delattr(signal, "pidfd_send_signal", raising=False)
    assert pidfd_supported()
    descriptor = pidfd_open(os.getpid())
    try:
        assert not os.get_inheritable(descriptor)
        pidfd_send_signal(descriptor, 0)
    finally:
        os.close(descriptor)
    with pytest.raises(OSError) as raised:
        pidfd_send_signal(descriptor, 0)
    assert raised.value.errno == errno.EBADF


def test_pid_handle_native_bindings_take_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[Any, ...]] = []

    def native_open(pid: int, flags: int) -> int:
        calls.append(("open", pid, flags))
        return 91

    def fallback_forbidden(*args: Any) -> Any:
        raise AssertionError("native binding must not try libc fallback")

    monkeypatch.setattr(os, "pidfd_open", native_open, raising=False)
    monkeypatch.setattr(
        signal,
        "pidfd_send_signal",
        lambda fd, sig: calls.append(("signal", fd, sig)),
        raising=False,
    )
    monkeypatch.setattr(module, "_libc_function", fallback_forbidden)
    assert module.pidfd_open(123) == 91
    module.pidfd_send_signal(91, 0)
    assert calls == [("open", 123, 0), ("signal", 91, 0)]


@pytest.mark.parametrize("error", [errno.ENOSYS, errno.EPERM, errno.ESRCH])
@pytest.mark.parametrize("operation", ["open", "signal"])
def test_pid_handle_libc_preserves_kernel_errors(
    monkeypatch: pytest.MonkeyPatch, error: int, operation: str
) -> None:
    monkeypatch.delattr(os, "pidfd_open", raising=False)
    monkeypatch.delattr(signal, "pidfd_send_signal", raising=False)

    def fail(*args: Any) -> int:
        ctypes.set_errno(error)
        return -1

    monkeypatch.setattr(module, "_libc_function", lambda *args: fail)
    with pytest.raises(OSError) as raised:
        if operation == "open":
            module.pidfd_open(123)
        else:
            module.pidfd_send_signal(91, 0)
    assert raised.value.errno == error


def test_pid_handle_probe_fails_closed_when_libc_symbols_are_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delattr(os, "pidfd_open", raising=False)
    monkeypatch.delattr(signal, "pidfd_send_signal", raising=False)
    monkeypatch.setattr(ctypes, "CDLL", lambda *args, **kwargs: object())
    assert not module.pidfd_supported()


def test_pid_handle_probe_does_not_retry_denied_native_binding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def denied(*args: Any) -> Any:
        raise PermissionError(errno.EPERM, "probe denied")

    def fallback_forbidden(*args: Any) -> Any:
        raise AssertionError("a denied syscall must not try an alternative")

    monkeypatch.setattr(os, "pidfd_open", denied, raising=False)
    monkeypatch.setattr(module, "_libc_function", fallback_forbidden)
    assert not module.pidfd_supported()


def test_missing_kernel_handles_prevent_managed_child_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("must not reach a subprocess launch")

    monkeypatch.setattr(module, "pidfd_supported", lambda: False)
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    with pytest.raises(OSError, match="Kernel PID handles"):
        supervise(["unused"], tmp_path, "a" * 32)


# --------------------------------------------- ported subreaper receipt case


@pytest.mark.skipif(sys.platform != "linux", reason="Linux subreaper ownership contract")
@pytest.mark.parametrize("kill_supervisor", [False, True])
@pytest.mark.parametrize("force_libc", [False, True])
def test_subreaper_receipt_covers_detached_children(
    tmp_path: Path, kill_supervisor: bool, force_libc: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    missing_bindings = ""
    if force_libc:
        monkeypatch.delattr(os, "pidfd_open", raising=False)
        monkeypatch.delattr(signal, "pidfd_send_signal", raising=False)
        missing_bindings = (
            "import os,signal\n"
            "if hasattr(os,'pidfd_open'): del os.pidfd_open\n"
            "if hasattr(signal,'pidfd_send_signal'): del signal.pidfd_send_signal\n"
        )
    child_code = "import time; time.sleep(30)"
    parent_code = (
        "import json,os,subprocess,sys,time; "
        "child=subprocess.Popen([sys.executable,'-I','-c',"
        f"{child_code!r}],start_new_session=True); "
        "print(json.dumps({'primary':os.getpid(),'child':child.pid}),flush=True); time.sleep(30)"
    )
    receipt_dir = tmp_path / "control"
    receipt_dir.mkdir(mode=0o700)
    supervisor = tmp_path / "supervisor.py"
    supervisor.write_text(
        missing_bindings
        + "import sys\nfrom pathlib import Path\nfrom archon.launcher import supervise\n"
        f"raise SystemExit(supervise([sys.executable,'-I','-c',{parent_code!r}],"
        f"Path({str(receipt_dir)!r}),{NONCE!r}))\n",
        encoding="utf-8",
    )
    owner = subprocess.Popen(
        [sys.executable, "-I", str(supervisor)], stdout=subprocess.PIPE, text=True
    )
    receipt_path = receipt_dir / "stopped.json"
    child_handles: list[int] = []
    try:
        assert owner.stdout is not None
        children = json.loads(owner.stdout.readline())
        for pid in children.values():
            child_handles.append(pidfd_open(pid))
        identity = _read_process(owner.pid)
        assert identity is not None
        assert identity["pid"] == identity["sid"] == identity["pgid"]
        attestation = {key: identity[key] for key in ("pid", "pgid", "sid", "start_ticks")}
        attestation |= {"boot_id": _boot_id(), "receipt_path": str(receipt_path), "nonce": NONCE}
        if kill_supervisor:
            owner.kill()
            owner.wait(timeout=10)
            # SEC-M1 moved the O_EXCL claim ahead of the child, so the name is now
            # taken from the start. A SIGKILLed supervisor therefore leaves the file
            # behind — but it never wrote the attestation, and nothing may read an
            # empty receipt as termination. The absence of *content* is the point.
            assert receipt_path.read_bytes() == b""
            assert not ClaudeAdapter._receipt_valid(attestation)
            return
        descriptor = pidfd_open(owner.pid)
        try:
            pidfd_send_signal(descriptor, signal.SIGTERM)
        finally:
            os.close(descriptor)
        owner.wait(timeout=20)
        assert _await(receipt_path.exists)
        for pid in children.values():
            child = _read_process(pid)
            assert child is None or child["state"] in ("Z", "X")
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        assert receipt["descendants_reaped"] is True
        assert receipt["nonce"] == NONCE
        assert receipt["pid"] == owner.pid
        assert receipt["start_ticks"] == identity["start_ticks"]
        assert receipt["boot_id"] == _boot_id()
        assert os.stat(receipt_path).st_mode & 0o777 == 0o600
        # Positive control for the SIGKILL arm above: the same validator, the same
        # identity shape, and this one must accept.
        assert ClaudeAdapter._receipt_valid(attestation)
    finally:
        if owner.poll() is None:
            owner.kill()
            owner.wait(timeout=10)
        for handle in child_handles:
            try:
                pidfd_send_signal(handle, signal.SIGKILL)
            except (ProcessLookupError, OSError):
                pass
            finally:
                os.close(handle)


def test_the_receipt_is_never_overwritten(tmp_path: Path) -> None:
    """O_CREAT|O_EXCL: a second supervisor may not forge a receipt over the first.

    SEC-M1 moved the claim ahead of ``Popen``, so an existing name is now refused
    before anything is supervised, with a forgery diagnosis rather than a
    traceback from the write at the end.
    """
    receipt_dir = tmp_path / "control"
    receipt_dir.mkdir(mode=0o700)
    supervisor = tmp_path / "supervisor.py"
    supervisor.write_text(
        "import sys\nfrom pathlib import Path\nfrom archon.launcher import supervise\n"
        "raise SystemExit(supervise([sys.executable,'-I','-c','raise SystemExit(7)'],"
        f"Path({str(receipt_dir)!r}),{NONCE!r}))\n",
        encoding="utf-8",
    )
    first = subprocess.run(
        [sys.executable, "-I", str(supervisor)], capture_output=True, text=True, timeout=60
    )
    assert first.returncode == 7, first.stderr
    original = (receipt_dir / "stopped.json").read_bytes()
    second = subprocess.run(
        [sys.executable, "-I", str(supervisor)], capture_output=True, text=True, timeout=60
    )
    assert second.returncode != 0
    assert module.FORGED_RECEIPT in second.stderr
    assert (receipt_dir / "stopped.json").read_bytes() == original


# ------------------------------------------------------------- the new CLI


@pytest.fixture
def dispatched(monkeypatch: pytest.MonkeyPatch) -> list[tuple[list[str], Path, str]]:
    calls: list[tuple[list[str], Path, str]] = []

    def record(
        command: list[str], receipt_dir: Path, nonce: str, pass_fds: tuple[int, ...] = ()
    ) -> int:
        calls.append((command, receipt_dir, nonce))
        return 0

    monkeypatch.setattr(module, "supervise", record)
    return calls


def _invoke(monkeypatch: pytest.MonkeyPatch, *arguments: str) -> None:
    monkeypatch.setattr(sys, "argv", ["archon-launch", *arguments])
    module.main()


def test_check_dispatches_the_rendered_bwrap_argv_unchanged(
    tmp_path: Path, dispatched: list[tuple[list[str], Path, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    control = tmp_path / "control"
    control.mkdir()
    # A rendered profile contains its own `--`; only the first one is the CLI's.
    rendered = ["bwrap", "--unshare-net", "--chdir", "/w", "--", "pytest", "-q", "--", "-k", "x"]
    with pytest.raises(SystemExit) as raised:
        _invoke(monkeypatch, str(control), NONCE, "check", "--", *rendered)
    assert raised.value.code == 0
    assert dispatched == [(rendered, control, NONCE)]


def test_review_dispatches_the_claude_argv_unchanged(
    tmp_path: Path, dispatched: list[tuple[list[str], Path, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    control = tmp_path / "control"
    control.mkdir()
    command = ["claude", "-p", "--output-format", "stream-json", "--setting-sources", ""]
    with pytest.raises(SystemExit) as raised:
        _invoke(monkeypatch, str(control), NONCE, "review", "--", *command)
    assert raised.value.code == 0
    assert dispatched == [(command, control, NONCE)]


def test_review_honours_an_existing_config_dir_and_invents_none(
    tmp_path: Path, dispatched: list[tuple[list[str], Path, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    control = tmp_path / "control"
    control.mkdir()
    config = tmp_path / "claude-config"
    config.mkdir()
    monkeypatch.delenv(module.CONFIG_DIR_VARIABLE, raising=False)
    with pytest.raises(SystemExit):
        _invoke(monkeypatch, str(control), NONCE, "review", "--", "claude", "-p")
    assert module.CONFIG_DIR_VARIABLE not in os.environ
    monkeypatch.setenv(module.CONFIG_DIR_VARIABLE, str(config))
    with pytest.raises(SystemExit) as raised:
        _invoke(monkeypatch, str(control), NONCE, "review", "--", "claude", "-p")
    assert raised.value.code == 0
    assert os.environ[module.CONFIG_DIR_VARIABLE] == str(config)
    monkeypatch.setenv(module.CONFIG_DIR_VARIABLE, "relative/config")
    with pytest.raises(SystemExit) as raised:
        _invoke(monkeypatch, str(control), NONCE, "review", "--", "claude", "-p")
    assert "configuration directory" in str(raised.value.code)


@pytest.mark.parametrize(
    "arguments",
    [
        (),
        ("only-one",),
        ("a", "b", "c"),
        ("a", "b", "c", "--"),
        ("a", "b", "--", "cmd"),
        ("a", "b", "c", "d", "--", "cmd"),
    ],
)
def test_malformed_invocations_are_refused(
    monkeypatch: pytest.MonkeyPatch,
    dispatched: list[tuple[list[str], Path, str]],
    arguments: tuple[str, ...],
) -> None:
    with pytest.raises(SystemExit) as raised:
        _invoke(monkeypatch, *arguments)
    assert "archon-launch" in str(raised.value.code)
    assert dispatched == []


def test_receipt_directory_and_nonce_discipline_is_unchanged(
    tmp_path: Path, dispatched: list[tuple[list[str], Path, str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    control = tmp_path / "control"
    control.mkdir()
    link = tmp_path / "linked"
    link.symlink_to(control)
    bad_directories = [str(tmp_path / "absent"), "control", str(link), str(tmp_path / "file")]
    (tmp_path / "file").write_text("x", encoding="utf-8")
    for directory in bad_directories:
        with pytest.raises(SystemExit, match="receipt directory"):
            _invoke(monkeypatch, directory, NONCE, "check", "--", "true")
    for nonce in ("c" * 31, "c" * 33, "C" * 32, "g" * 32, "c" * 16 + "-" * 16):
        with pytest.raises(SystemExit, match="supervisor nonce"):
            _invoke(monkeypatch, str(control), nonce, "check", "--", "true")
    for kind in ("exec", "command", "Check", ""):
        with pytest.raises(SystemExit, match="archon-launch"):
            _invoke(monkeypatch, str(control), NONCE, kind, "--", "true")
    assert dispatched == []


def test_non_linux_hosts_are_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    with pytest.raises(SystemExit, match="Linux subreaper"):
        _invoke(monkeypatch, "/tmp", NONCE, "check", "--", "true")


def test_the_codex_runtime_assertion_is_gone() -> None:
    """The donor pinned `openai-codex-cli-bin==0.154.0` here and froze itself out."""
    source = Path(module.__file__).read_text(encoding="utf-8")
    for removed in (
        "openai-codex-cli-bin",
        "codex_cli_bin",
        "bundled_codex_path",
        "bundled_path_dir",
        "importlib.metadata",
        "app-server",
        "stdio://",
        "0.154.0",
    ):
        assert removed not in source, removed
    assert not hasattr(module, "importlib")
    # The one surviving mention is inside the frozen `supervise()` error string,
    # which must stay byte-identical to the proven donor implementation.
    assert source.lower().count("codex") == 1


def test_a_child_cannot_pre_forge_the_receipt_it_will_be_attested_by(tmp_path: Path) -> None:
    """SEC-M1: every receipt field is derivable by the child, so only timing protected it.

    The child's parent *is* the supervisor, so ``/proc/<ppid>/cmdline`` yields the
    nonce and ``/proc/<ppid>/stat`` the rest.  While the receipt was opened
    ``O_EXCL`` only after the child exited, a child that created that one file first
    won: the supervisor's write raised and the validator accepted the planted file,
    attesting ``descendants_reaped: True``.  The claim now happens before the child
    exists, so the same attempt fails with EEXIST.
    """
    receipt_dir = tmp_path / "control"
    receipt_dir.mkdir(mode=0o700)
    report = tmp_path / "attempt.json"
    forger = tmp_path / "forger.py"
    forger.write_text(
        "import json, os\n"
        "from pathlib import Path\n"
        f"receipt = Path({str(receipt_dir)!r})\n"
        "flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL\n"
        "outcome = {}\n"
        "for name in ('stopped.json', 'control.json'):\n"
        "    try:\n"
        "        os.close(os.open(receipt / name, flags, 0o600))\n"
        "        outcome[name] = 'created'\n"
        "    except OSError as error:\n"
        "        outcome[name] = type(error).__name__\n"
        f"Path({str(report)!r}).write_text(json.dumps(outcome))\n",
        encoding="utf-8",
    )
    supervisor = tmp_path / "supervisor.py"
    supervisor.write_text(
        "import sys\nfrom pathlib import Path\nfrom archon.launcher import supervise\n"
        f"raise SystemExit(supervise([sys.executable,'-I',{str(forger)!r}],"
        f"Path({str(receipt_dir)!r}),{NONCE!r}))\n",
        encoding="utf-8",
    )
    completed = subprocess.run(
        [sys.executable, "-I", str(supervisor)], capture_output=True, text=True, timeout=60
    )

    assert completed.returncode == 0, completed.stderr
    attempt = json.loads(report.read_text(encoding="utf-8"))
    assert attempt["stopped.json"] == "FileExistsError"
    # Positive control: the directory really is writable by this child, so the
    # refusal above is the supervisor's claim and not a missing or read-only path.
    assert attempt["control.json"] == "created"
    receipt = json.loads((receipt_dir / "stopped.json").read_text(encoding="utf-8"))
    assert receipt["nonce"] == NONCE and receipt["descendants_reaped"] is True
