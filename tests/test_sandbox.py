"""Confinement contract for the kernel-owned check profile.

Observed denial shapes on Linux 6.6 / bubblewrap 0.9.0 (WSL2), recorded for
spike S5 so the adapter can classify "blocked by sandbox" apart from "the check
failed".  Every one of these is asserted below:

===========================  =========================================  ======
Blocked action               stderr / exception text                    code
===========================  =========================================  ======
egress, external host by IP  ``OSError 101 Network is unreachable``      ENETUNREACH
egress, external host by DNS ``socket.gaierror -3 Temporary failure``    EAI_AGAIN
egress, listening localhost  ``ConnectionRefusedError 111 Connection     ECONNREFUSED
                             refused``
read masked home directory   ``No such file or directory`` (ENOENT;      ENOENT
                             the tmpfs is empty, not absent)
read masked home file        ``Permission denied`` (EACCES; a read-only  EACCES
                             bind of /dev/null)
write masked state directory ``Read-only file system`` (EROFS)           EROFS
connect a host unix socket   ``No such file or directory`` (ENOENT; the  ENOENT
in $XDG_RUNTIME_DIR          runtime directory is masked)
===========================  =========================================  ======

A blocked check therefore looks like an ordinary nonzero exit with an errno in
{101, 111, 2, 13, 30}; only the profile digest and the fact that the kernel
rendered the confinement distinguish it from a genuine check failure.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from archon.sandbox import (
    BASE_FILESYSTEM,
    DEFAULT_MASKED,
    ENV_BASE_ALLOWLIST,
    MASK_FILE_SOURCE,
    NAMESPACE_FLAGS,
    BwrapProbe,
    CheckProfile,
    SandboxError,
    default_runtime_dir,
    prepare_scratch,
    probe_bwrap,
    render_bwrap,
)

PROBE = probe_bwrap()
ATTESTED = BwrapProbe(available=True, binary="bwrap", version="test")
requires_bwrap = pytest.mark.skipif(not PROBE.available, reason=PROBE.message)
PLANTED_MARKER = "archon-planted-marker-value"
NONCE = "b" * 32

#: The mask set, written out rather than imported.  QA-C1: the reviewer deleted
#: ``~/.aws`` and ``~/.claude`` from ``DEFAULT_MASKED`` and all 361 tests stayed
#: green, because every assertion on the set compared it with itself.  This is the
#: single statement of the contents, so narrowing the profile costs a test edit.
EXPECTED_DEFAULT_MASKED: tuple[Path, ...] = (
    Path("~/.ssh"),
    Path("~/.aws"),
    Path("~/.gnupg"),
    Path("~/.claude"),
    Path("~/.config/gh"),
    Path("~/.netrc"),
    Path("/run"),
    Path("/var/run"),
)
#: Entries under the fixture's fake home, one planted marker each.  ``/run`` and
#: ``/var/run`` are host-owned and get their own arms against $XDG_RUNTIME_DIR.
HOME_MASKS: tuple[Path, ...] = tuple(
    entry for entry in EXPECTED_DEFAULT_MASKED if str(entry).startswith("~/")
)
RUNTIME_DIR = default_runtime_dir()
runtime_is_writable = RUNTIME_DIR.is_dir() and os.access(RUNTIME_DIR, os.W_OK)
requires_runtime_dir = pytest.mark.skipif(
    not runtime_is_writable,
    reason=f"{RUNTIME_DIR} is not a writable runtime directory on this host",
)


def _tmpfs_roots() -> tuple[Path, ...]:
    """Every path the fixed profile replaces with an empty tmpfs, layout aside."""
    base = [Path(t) for i, t in enumerate(BASE_FILESYSTEM) if BASE_FILESYSTEM[i - 1] == "--tmpfs"]
    absolute = [e for e in (*DEFAULT_MASKED, RUNTIME_DIR) if e.is_absolute()]
    return (*base, *(Path(os.path.realpath(entry)) for entry in absolute))


def _hidden_from_the_sandbox(path: Path) -> Path | None:
    seen = Path(os.path.realpath(path))
    return next((r for r in _tmpfs_roots() if seen == r or r in seen.parents), None)


def _location_reason(executable: str, root: Path) -> str:
    return (
        f"This checkout runs {executable} from inside {root}, which the fixed profile "
        "replaces with an empty tmpfs, so the confined child cannot exec it. This is "
        "the checkout's location, not a confinement regression (QA-M7): re-run the "
        f"suite from a working copy outside {root}."
    )


#: Where the fixture builds its fake home.  pytest's ``tmp_path`` is under /tmp,
#: which BASE_FILESYSTEM replaces with an empty tmpfs, so a fake home built there
#: is invisible to the confined child *whether or not it is masked*: every masking
#: arm reported ENOENT by absence.  That is the deeper half of QA-C1.  /var/tmp is
#: ordinary disk on the read-only bind, so a marker there is readable unless masked.
LAYOUT_PARENT = Path("/var/tmp")
#: A home entry no mask covers: the per-arm control that the fake home is visible.
UNMASKED_CONTROL = Path("~/.archon-unmasked-control")

#: QA-M7: a byte-identical checkout under /tmp used to fail nine sandbox tests with
#: misleading confinement errors.  One skip, stating the cause, instead.
INTERPRETER_MASK = _hidden_from_the_sandbox(Path(sys.executable))
LOCATION_REASON = (
    None if INTERPRETER_MASK is None else _location_reason(sys.executable, INTERPRETER_MASK)
)
layout_is_visible = (
    LAYOUT_PARENT.is_dir()
    and os.access(LAYOUT_PARENT, os.W_OK)
    and _hidden_from_the_sandbox(LAYOUT_PARENT) is None
)
requires_visible_layout = pytest.mark.skipif(
    not layout_is_visible,
    reason=(
        f"{LAYOUT_PARENT} cannot hold a sandbox-visible layout here; a fake home under "
        "a tmpfs reads as absent whether masked or not, so an arm would prove nothing"
    ),
)


@pytest.fixture(autouse=True)
def _refuse_to_report_a_masked_checkout_as_a_confinement_failure(
    request: pytest.FixtureRequest,
) -> None:
    if request.node.get_closest_marker("sandbox") and LOCATION_REASON is not None:
        pytest.skip(LOCATION_REASON)


@pytest.fixture
def profile(tmp_path: Path) -> Iterator[CheckProfile]:
    """A complete, realistic layout: fake home with secrets, private state, scratch.
    Built under LAYOUT_PARENT, not tmp_path, so the fake home is reachable from
    inside the confinement; see that constant for the failure it prevents."""
    parent = LAYOUT_PARENT if layout_is_visible else tmp_path
    root = Path(tempfile.mkdtemp(prefix="archon-profile-", dir=parent)).resolve()
    try:
        worktree = root / "worktree"
        scratch = root / "scratch"
        state_dir = root / "state"
        home = root / "home"
        for directory in (worktree, state_dir, home, home / ".config"):
            directory.mkdir(parents=True)
        prepare_scratch(scratch)
        (state_dir / "archon.sqlite3").write_text(PLANTED_MARKER, encoding="utf-8")
        for entry in (*HOME_MASKS, UNMASKED_CONTROL):
            _plant(home, entry)
        yield CheckProfile(worktree=worktree, scratch=scratch, state_dir=state_dir, home=home)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _planted_marker_path(home: Path, entry: Path) -> Path:
    """``~/.netrc`` is masked as a *file* (a read-only bind of /dev/null); every
    other entry is a directory mask, so its marker goes inside it."""
    target = home / str(entry)[2:]
    return target if target.name == ".netrc" else target / "marker"


def _plant(home: Path, entry: Path) -> Path:
    marker = _planted_marker_path(home, entry)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(PLANTED_MARKER, encoding="utf-8")
    return marker


def _read_script(target: Path) -> str:
    """Read one absolute path, exit 7 with the errno if the read is refused."""
    return (
        "import sys\n"
        f"try:\n    sys.stdout.write(open({str(target)!r}).read())\n"
        "except OSError as error:\n    print(error.errno, error); sys.exit(7)\n"
    )


def run_confined(
    profile: CheckProfile, script: str, **extra: str
) -> subprocess.CompletedProcess[str]:
    """Execute a Python snippet under the real profile and return its outcome."""
    argv = render_bwrap(profile, [sys.executable, "-c", script], profile.worktree, extra)
    return subprocess.run(argv, capture_output=True, text=True, timeout=120, check=False)


# ---------------------------------------------------------------- pure unit


def test_rendered_argv_carries_every_required_confinement_flag(profile: CheckProfile) -> None:
    argv = render_bwrap(profile, ["/bin/true"], profile.worktree, probe=ATTESTED)
    for flag in NAMESPACE_FLAGS:
        assert flag in argv, flag
    for token in BASE_FILESYSTEM:
        assert token in argv
    joined = " ".join(argv)
    assert "--ro-bind / /" in joined
    assert "--dev /dev" in joined and "--proc /proc" in joined and "--tmpfs /tmp" in joined
    assert f"--bind {profile.worktree} {profile.worktree}" in joined
    assert f"--bind {profile.scratch} {profile.scratch}" in joined
    assert f"--tmpfs {profile.state_dir}" in joined
    assert f"--remount-ro {profile.state_dir}" in joined
    assert f"--tmpfs {profile.home / '.ssh'}" in joined
    assert f"--ro-bind {MASK_FILE_SOURCE} {profile.home / '.netrc'}" in joined
    assert "--clearenv" in joined
    assert f"--setenv HOME {profile.sandbox_home}" in joined
    for name in ("TMPDIR", "TMP", "TEMP"):
        assert f"--setenv {name} {profile.sandbox_tmp}" in joined
    assert argv[-4:] == ["--chdir", str(profile.worktree), "--", "/bin/true"]
    assert argv[0] == "bwrap"


def test_masks_are_sealed_read_only_after_the_writable_binds(profile: CheckProfile) -> None:
    """Ordering is load-bearing: a mask mounted after a bind would clobber it, and a
    mask never remounted read-only would be a *writable* tmpfs."""
    argv = render_bwrap(profile, ["/bin/true"], profile.worktree, probe=ATTESTED)
    assert argv.index("--tmpfs") < argv.index("--bind") < argv.index("--remount-ro")


def test_a_check_argv_cannot_inject_a_bind_or_widen_the_namespace(profile: CheckProfile) -> None:
    hostile = [
        "/bin/sh",
        "--bind",
        "/etc",
        "/etc",
        "--share-net",
        "--ro-bind",
        str(profile.state_dir),
        "/mnt",
    ]
    argv = render_bwrap(profile, hostile, profile.worktree, probe=ATTESTED)
    separator = argv.index("--")
    confinement, command = argv[:separator], argv[separator + 1 :]
    assert command == hostile  # every hostile token landed after the separator
    assert confinement.count("--bind") == 2  # worktree and scratch, nothing else
    assert "--share-net" not in confinement
    assert "/etc" not in confinement
    assert "/mnt" not in confinement
    assert confinement.count("--unshare-net") == 1


def test_a_check_cannot_supply_a_kernel_owned_or_malformed_environment_name(
    profile: CheckProfile,
) -> None:
    for name in ("HOME", "TMPDIR", "TMP", "TEMP"):
        with pytest.raises(SandboxError, match="kernel-owned"):
            render_bwrap(profile, ["/bin/true"], profile.worktree, {name: "/"}, probe=ATTESTED)
    for name in ("not a name", "2BAD", "", "A=B"):
        with pytest.raises(SandboxError, match="portable variable name"):
            render_bwrap(profile, ["/bin/true"], profile.worktree, {name: "x"}, probe=ATTESTED)
    with pytest.raises(SandboxError, match="NUL-free"):
        render_bwrap(profile, ["/bin/true"], profile.worktree, {"OK": "a\0b"}, probe=ATTESTED)


def test_only_the_declared_allowlist_and_passthrough_reach_the_child(
    profile: CheckProfile,
) -> None:
    source = {name: f"value-{name}" for name in ENV_BASE_ALLOWLIST}
    source["AWS_SECRET_ACCESS_KEY"] = PLANTED_MARKER
    argv = render_bwrap(
        profile,
        ["/bin/true"],
        profile.worktree,
        {"CI": "1"},
        probe=ATTESTED,
        source_env=source,
    )
    names = {argv[index + 1] for index, token in enumerate(argv) if token == "--setenv"}
    assert names == {*ENV_BASE_ALLOWLIST, "CI", "HOME", "TMPDIR", "TMP", "TEMP"}
    assert PLANTED_MARKER not in " ".join(argv)


@pytest.mark.parametrize("escape", ["/etc", "..", "../..", "sub/../../outside"])
def test_a_working_directory_outside_the_worktree_is_rejected(
    profile: CheckProfile, escape: str
) -> None:
    (profile.worktree / "sub").mkdir()
    with pytest.raises(SandboxError, match="inside the delivery worktree"):
        render_bwrap(profile, ["/bin/true"], Path(escape), probe=ATTESTED)


def test_a_working_directory_must_exist(profile: CheckProfile) -> None:
    with pytest.raises(SandboxError, match="must exist"):
        render_bwrap(profile, ["/bin/true"], Path("absent"), probe=ATTESTED)


def test_a_symlink_argument_leaving_the_bind_set_for_a_mask_is_rejected(
    profile: CheckProfile,
) -> None:
    (profile.worktree / "README.md").write_text("ok", encoding="utf-8")
    (profile.worktree / "to-state").symlink_to(profile.state_dir)
    (profile.worktree / "to-ssh").symlink_to(profile.home / ".ssh" / "marker")
    (profile.worktree / "inside").symlink_to(profile.worktree / "README.md")
    # A `.venv/bin/python` is a symlink out of the worktree on every real project;
    # the whole root is bound read-only, so that is not an escape and must work.
    (profile.worktree / "toolchain").symlink_to(sys.executable)
    for escape in ("to-state", "to-ssh"):
        with pytest.raises(SandboxError, match="symlink leaving the bind set"):
            render_bwrap(profile, ["/bin/cat", escape], profile.worktree, probe=ATTESTED)
    for allowed in ("inside", "toolchain"):
        render_bwrap(profile, ["/bin/cat", allowed], profile.worktree, probe=ATTESTED)


def test_a_mask_or_state_directory_inside_a_writable_bind_is_refused(tmp_path: Path) -> None:
    """The nesting invariants, including SEC-L1: the last case used to pass, because
    the check ran on the declared path while the mount uses the realpath, and bwrap
    then rejected the argv with `Can't remount readonly on ...: Invalid argument`
    instead of the module naming the problem."""
    root = tmp_path.resolve()
    worktree = root / "worktree"
    home = root / "home"
    (worktree / "secrets").mkdir(parents=True)
    (worktree / "state").mkdir()
    home.mkdir()
    prepare_scratch(root / "scratch")
    (home / ".ssh").symlink_to(worktree / "secrets")
    fields: dict[str, object] = {
        "worktree": worktree,
        "scratch": root / "scratch",
        "state_dir": root,
        "home": home,
    }
    with pytest.raises(SandboxError, match="state directory must not sit inside"):
        CheckProfile(**{**fields, "state_dir": worktree / "state"})  # type: ignore[arg-type]
    with pytest.raises(SandboxError, match="masked path must not sit inside"):
        CheckProfile(**fields, masked=(worktree / "secrets",))  # type: ignore[arg-type]
    with pytest.raises(SandboxError, match="reached through"):
        CheckProfile(**fields, masked=(Path("~/.ssh"),))  # type: ignore[arg-type]
    with pytest.raises(SandboxError, match="must not sit inside a writable bind"):
        CheckProfile(**fields, masked=(), runtime_dir=worktree / "runtime")  # type: ignore[arg-type]


def test_a_scratch_without_tmp_and_home_is_refused(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    for name in ("worktree", "scratch", "state", "home"):
        (root / name).mkdir()
    with pytest.raises(SandboxError, match="prepare_scratch"):
        CheckProfile(
            worktree=root / "worktree",
            scratch=root / "scratch",
            state_dir=root / "state",
            home=root / "home",
        )


def test_the_profile_refuses_symlinked_and_relative_roots(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    for name in ("worktree", "state", "home"):
        (root / name).mkdir()
    prepare_scratch(root / "scratch")
    link = root / "linked"
    link.symlink_to(root / "worktree")
    with pytest.raises(SandboxError, match="must not be a symlink"):
        CheckProfile(
            worktree=link, scratch=root / "scratch", state_dir=root / "state", home=root / "home"
        )
    with pytest.raises(SandboxError, match="absolute path"):
        CheckProfile(
            worktree=Path("worktree"),
            scratch=root / "scratch",
            state_dir=root / "state",
            home=root / "home",
        )


def test_the_declared_mask_set_is_pinned_literally() -> None:
    """QA-C1: `~/.aws` and `~/.claude` were deleted from DEFAULT_MASKED and every one
    of 361 tests still passed. Narrowing the profile now breaks this assertion, which
    is the only statement of the set that does not move with the source."""
    assert DEFAULT_MASKED == EXPECTED_DEFAULT_MASKED


def test_digest_identifies_the_shape_not_the_host_paths(tmp_path: Path) -> None:
    def build(name: str, **overrides: object) -> CheckProfile:
        root = (tmp_path / name).resolve()
        for directory in ("worktree", "state", "home"):
            (root / directory).mkdir(parents=True)
        prepare_scratch(root / "scratch")
        fields: dict[str, object] = {
            "worktree": root / "worktree",
            "scratch": root / "scratch",
            "state_dir": root / "state",
            "home": root / "home",
        }
        fields.update(overrides)
        return CheckProfile(**fields)  # type: ignore[arg-type]

    first = build("one")
    second = build("two")
    assert first.digest() == second.digest()
    assert len(first.digest()) == 64 and first.digest().isalnum()
    narrower = build("three", masked=DEFAULT_MASKED[:-1])
    assert narrower.digest() != first.digest()
    wider = build("four", masked=(*DEFAULT_MASKED, Path("~/.docker")))
    assert wider.digest() != first.digest() and wider.digest() != narrower.digest()
    # $XDG_RUNTIME_DIR carries the uid, so it is canonicalised like home and state:
    # two users running the same profile must agree on the digest.
    elsewhere = build("five", runtime_dir=Path("/run/user/4242"))
    assert elsewhere.digest() == first.digest()


def test_probe_failure_stops_dispatch_before_any_child(
    profile: CheckProfile, monkeypatch: pytest.MonkeyPatch
) -> None:
    import archon.sandbox as module

    def forbidden(*args: object, **kwargs: object) -> object:
        raise AssertionError("an unconfined child must never be dispatched")

    monkeypatch.setattr(shutil, "which", lambda name: None)
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    denied = module.probe_bwrap("bwrap")
    assert not denied.available
    assert module.APT_PACKAGE in denied.message
    with pytest.raises(SandboxError, match=module.APT_PACKAGE):
        render_bwrap(profile, ["/bin/true"], profile.worktree)
    with pytest.raises(SandboxError, match=module.APT_PACKAGE):
        render_bwrap(profile, ["/bin/true"], profile.worktree, probe=denied)


def test_a_user_namespace_denial_names_the_apparmor_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import archon.sandbox as module

    monkeypatch.setattr(shutil, "which", lambda name: "/usr/bin/bwrap")

    def denied(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        if "--version" in argv:
            return subprocess.CompletedProcess(argv, 0, "bubblewrap 0.9.0\n", "")
        return subprocess.CompletedProcess(
            argv, 1, "", "bwrap: Creating new namespace failed: Operation not permitted\n"
        )

    monkeypatch.setattr(module.subprocess, "run", denied)
    result = module.probe_bwrap()
    assert not result.available and result.version == "bubblewrap 0.9.0"
    assert module.APPARMOR_PROFILE in result.message
    assert module.APPARMOR_SYSCTL in result.message
    assert "Operation not permitted" in result.message


# ------------------------------------------------------------- real bwrap
# AC-16.  These run the rendered profile for real; they skip only where
# bubblewrap is genuinely unavailable.


@pytest.mark.sandbox
@requires_bwrap
def test_egress_to_an_external_host_fails(profile: CheckProfile) -> None:
    script = (
        "import socket,sys\n"
        "try:\n"
        "    socket.create_connection(('1.1.1.1', 443), timeout=5)\n"
        "except OSError as error:\n"
        "    print(error.errno, error); sys.exit(7)\n"
        "print('CONNECTED'); sys.exit(1)\n"
    )
    result = run_confined(profile, script)
    # Observed shape: exit 7, stdout "101 [Errno 101] Network is unreachable".
    assert result.returncode == 7, result
    assert "101" in result.stdout and "Network is unreachable" in result.stdout


@pytest.mark.sandbox
@requires_bwrap
def test_name_resolution_for_an_external_host_fails(profile: CheckProfile) -> None:
    script = (
        "import socket,sys\n"
        "try:\n"
        "    socket.getaddrinfo('example.com', 443)\n"
        "except OSError as error:\n"
        "    print(type(error).__name__, error); sys.exit(7)\n"
        "print('RESOLVED'); sys.exit(1)\n"
    )
    result = run_confined(profile, script)
    # Observed shape: exit 7, "gaierror [Errno -3] Temporary failure in name resolution".
    # With curl the same denial surfaces as exit 6, "Could not resolve host".
    assert result.returncode == 7, result
    assert "gaierror" in result.stdout


@pytest.mark.sandbox
@requires_bwrap
def test_egress_to_a_listening_localhost_port_fails(profile: CheckProfile) -> None:
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(5)
    port = listener.getsockname()[1]
    try:
        script = (
            "import socket,sys\n"
            "try:\n"
            f"    socket.create_connection(('127.0.0.1', {port}), timeout=5)\n"
            "except OSError as error:\n"
            "    print(error.errno, error); sys.exit(7)\n"
            "print('CONNECTED'); sys.exit(1)\n"
        )
        result = run_confined(profile, script)
    finally:
        listener.close()
    # Observed shape: exit 7, "111 [Errno 111] Connection refused" — the private
    # netns has a loopback of its own, so the host's listener is unreachable.
    assert result.returncode == 7, result
    assert "111" in result.stdout and "Connection refused" in result.stdout


@contextlib.contextmanager
def _unix_listener(path: Path) -> Iterator[Path]:
    """An unconfined peer answering on a filesystem socket, for the SEC-H1 arms."""
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.settimeout(30)
    server.bind(str(path))
    server.listen(2)

    def serve() -> None:
        with contextlib.suppress(OSError):
            while True:
                connection, _ = server.accept()
                with connection:
                    connection.recv(64)
                    connection.sendall(PLANTED_MARKER.encode("utf-8"))

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield path
    finally:
        server.close()
        path.unlink(missing_ok=True)
        thread.join(timeout=5)


def _socket_script(path: Path) -> str:
    """Connect to one filesystem socket and echo whatever the peer answers."""
    return (
        "import socket,sys\n"
        "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(10)\n"
        f"try:\n    s.connect({str(path)!r})\n"
        "except OSError as error:\n    print(error.errno, error); sys.exit(7)\n"
        "s.sendall(b'confined-child')\n"
        "sys.stdout.write(s.recv(64).decode())\n"
    )


def _reach_from_the_host(path: Path) -> str:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
        peer.settimeout(10)
        peer.connect(str(path))
        peer.sendall(b"unconfined-peer")
        return peer.recv(64).decode()


@pytest.mark.sandbox
@requires_bwrap
@requires_visible_layout
@pytest.mark.parametrize("entry", HOME_MASKS, ids=str)
def test_each_declared_home_mask_hides_its_own_planted_marker(
    profile: CheckProfile, entry: Path
) -> None:
    """One arm per declared entry (QA-C1).

    The reviewer deleted `~/.aws` and `~/.claude` from DEFAULT_MASKED and the suite
    stayed green at 361 passed. Markers are planted from the test's own literal
    list, so a narrowed profile turns the matching arm from a denial into a leak."""
    marker = _planted_marker_path(profile.home, entry)
    # Two positive controls, because one is not enough here. The first says the
    # secret is on disk at all; the second says an *unmasked* file in the same fake
    # home is readable from inside this sandbox. Without the second, a fake home
    # that the profile hides wholesale (a tmp_path under the /tmp tmpfs) makes every
    # arm report ENOENT and pass while masking nothing.
    assert marker.read_text(encoding="utf-8") == PLANTED_MARKER
    control = _planted_marker_path(profile.home, UNMASKED_CONTROL)
    visible = run_confined(profile, _read_script(control))
    assert visible.returncode == 0 and PLANTED_MARKER in visible.stdout, (
        f"the fixture home is not visible inside the sandbox ({visible.stdout!r}); "
        "a denial from a masked path would be an absence and this arm proves nothing"
    )
    result = run_confined(profile, _read_script(marker))
    # Observed shapes: a directory mask is an empty tmpfs, so its contents read as
    # absent (ENOENT); a file mask is a read-only bind of /dev/null, which denies
    # the read itself (EACCES). Both are exit 7 here.
    expected = "Permission denied" if marker.name == ".netrc" else "No such file or directory"
    assert result.returncode == 7, result
    assert expected in result.stdout, result.stdout
    assert PLANTED_MARKER not in result.stdout
    assert PLANTED_MARKER not in result.stderr


@pytest.mark.sandbox
@requires_bwrap
@requires_runtime_dir
def test_a_marker_in_the_host_runtime_directory_is_hidden(profile: CheckProfile) -> None:
    """The arm for the `/run` half of the mask set: those are host-owned, so the
    marker goes in $XDG_RUNTIME_DIR, inside `/run` on this host."""
    marker = RUNTIME_DIR / f"archon-test-{os.getpid()}.marker"
    marker.write_text(PLANTED_MARKER, encoding="utf-8")
    control = profile.worktree / "unmasked-control"
    control.write_text(PLANTED_MARKER, encoding="utf-8")
    try:
        assert marker.read_text(encoding="utf-8") == PLANTED_MARKER
        denied = run_confined(profile, _read_script(marker))
        allowed = run_confined(profile, _read_script(control))
    finally:
        marker.unlink(missing_ok=True)
    assert allowed.returncode == 0 and PLANTED_MARKER in allowed.stdout, allowed
    assert denied.returncode == 7, denied
    assert PLANTED_MARKER not in denied.stdout


@pytest.mark.sandbox
@requires_bwrap
def test_a_unix_socket_inside_the_worktree_is_reachable(profile: CheckProfile) -> None:
    """Positive control for SEC-H1: AF_UNIX IPC works inside this profile, so the
    denial in the next test is the mask and not a broken mechanism."""
    with _unix_listener(profile.worktree / "control.sock") as sock:
        result = run_confined(profile, _socket_script(sock))
    assert result.returncode == 0, result
    assert result.stdout.strip() == PLANTED_MARKER


@pytest.mark.sandbox
@requires_bwrap
@requires_runtime_dir
def test_a_unix_socket_in_the_host_runtime_directory_is_unreachable(
    profile: CheckProfile,
) -> None:
    """SEC-H1, demonstrated live on 2026-09-22 before the masks existed.

    `--unshare-net` takes away IP, not IPC: the kernel exempts sockets from the
    read-only-superblock check, so `--ro-bind / /` left every host socket
    connectable and a confined child exchanged messages with an unconfined one
    through $XDG_RUNTIME_DIR (exit 0, "REACHED"). On a normal host that set
    includes the session D-Bus, which reaches `systemd --user StartTransientUnit`
    and therefore a process with no confinement and full egress."""
    path = RUNTIME_DIR / f"archon-test-{os.getpid()}.sock"
    with _unix_listener(path) as sock:
        # Positive control on the *same* socket: an unconfined peer is answered.
        assert _reach_from_the_host(sock) == PLANTED_MARKER
        result = run_confined(profile, _socket_script(sock))
    # Observed shape: exit 7, "2 [Errno 2] No such file or directory" — the runtime
    # directory is an empty tmpfs, so the socket reads as absent rather than denied.
    assert result.returncode == 7, result
    assert PLANTED_MARKER not in result.stdout


@pytest.mark.sandbox
@requires_bwrap
def test_writing_the_masked_state_directory_fails(profile: CheckProfile) -> None:
    victim = profile.state_dir / "archon.sqlite3"
    script = (
        "import sys\n"
        f"try:\n    open({str(victim)!r}, 'w').write('forged')\n"
        "except OSError as error:\n    print(error.errno, error); sys.exit(7)\n"
        "sys.exit(1)\n"
    )
    result = run_confined(profile, script)
    # Observed shape: exit 7, "30 [Errno 30] Read-only file system" — the mask is a
    # tmpfs remounted read-only, so a write cannot even be swallowed silently.
    assert result.returncode == 7, result
    assert "Read-only file system" in result.stdout
    assert victim.read_text(encoding="utf-8") == PLANTED_MARKER


@pytest.mark.sandbox
@requires_bwrap
def test_writing_inside_the_worktree_succeeds(profile: CheckProfile) -> None:
    target = profile.worktree / "build" / "artifact.txt"
    script = (
        "import pathlib\n"
        f"path = pathlib.Path({str(target)!r})\n"
        "path.parent.mkdir(parents=True, exist_ok=True)\n"
        "path.write_text('built')\n"
    )
    result = run_confined(profile, script)
    assert result.returncode == 0, result.stderr
    assert target.read_text(encoding="utf-8") == "built"


@pytest.mark.sandbox
@requires_bwrap
def test_a_uv_style_cache_write_under_tmpdir_and_home_succeeds(profile: CheckProfile) -> None:
    """The bug that killed the donor: no writable /tmp, no `uv` cache, every check failed."""
    script = (
        "import os, pathlib\n"
        "tmp = pathlib.Path(os.environ['TMPDIR'])\n"
        "home = pathlib.Path(os.environ['HOME'])\n"
        "assert os.environ['TMP'] == os.environ['TEMP'] == str(tmp), os.environ\n"
        "staging = tmp / '.tmpuvSTAGE' / 'archive-v0'\n"
        "staging.mkdir(parents=True, exist_ok=True)\n"
        "(staging / 'wheel.whl').write_bytes(b'0' * 4096)\n"
        "cache = home / '.cache' / 'uv' / 'archive-v0' / 'abcd'\n"
        "cache.mkdir(parents=True, exist_ok=True)\n"
        "(cache / 'entry').write_text('cached')\n"
        "(home / '.local' / 'share' / 'uv').mkdir(parents=True, exist_ok=True)\n"
        "print(str(tmp), str(home))\n"
    )
    result = run_confined(profile, script)
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == [str(profile.sandbox_tmp), str(profile.sandbox_home)]
    assert (profile.sandbox_home / ".cache/uv/archive-v0/abcd/entry").read_text() == "cached"
    assert (profile.sandbox_tmp / ".tmpuvSTAGE/archive-v0/wheel.whl").stat().st_size == 4096


@pytest.mark.sandbox
@requires_bwrap
def test_real_uv_places_its_cache_inside_the_scratch_home(profile: CheckProfile) -> None:
    binary = shutil.which("uv")
    if binary is None:  # the only absence that is not a result
        pytest.skip("uv is not installed on this host")
    hidden = _hidden_from_the_sandbox(Path(binary))
    if hidden is not None:  # QA-M7, not a confinement result
        pytest.skip(_location_reason(binary, hidden))
    argv = render_bwrap(profile, [binary, "cache", "dir"], profile.worktree)
    result = subprocess.run(argv, capture_output=True, text=True, timeout=120, check=False)
    # QA-C2: this used to turn *any* nonzero exit into a skip. Breaking the profile
    # (--remount-ro replaced with --ro-bind-try) then reported SKIPPED while nine
    # sibling tests failed, and docs/verification.md cites this test as the standing
    # proof against the donor's fatal /tmp bug. A rendered profile that will not run
    # is the regression, so it fails here.
    assert result.returncode == 0, f"confined `uv cache dir` exited {result.returncode}: {result.stderr.strip()}"
    assert result.stdout.strip() == str(profile.sandbox_home / ".cache" / "uv")
    clean = subprocess.run(
        render_bwrap(profile, [binary, "cache", "clean"], profile.worktree),
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    assert clean.returncode == 0, clean.stderr


@pytest.mark.sandbox
@requires_bwrap
def test_a_detached_child_is_reaped_and_the_receipt_is_written(
    profile: CheckProfile, tmp_path: Path
) -> None:
    """`--die-with-parent` plus `--unshare-pid` plus the subreaper: setsid does not help."""
    survivor = profile.worktree / "survived"
    child = (
        "import os,pathlib,time; os.setsid(); time.sleep(20); "
        f"pathlib.Path({str(survivor)!r}).write_text('survived')"
    )
    parent = (
        "import pathlib,subprocess,sys,time; "
        f"subprocess.Popen([sys.executable,'-I','-c',{child!r}]); "
        f"pathlib.Path({str(profile.worktree / 'started')!r}).write_text('go'); time.sleep(20)"
    )
    argv = render_bwrap(profile, [sys.executable, "-I", "-c", parent], profile.worktree)
    receipt_dir = tmp_path / "control"
    receipt_dir.mkdir(mode=0o700)
    script = tmp_path / "supervisor.py"
    script.write_text(
        "from pathlib import Path\nfrom archon.launcher import supervise\n"
        f"raise SystemExit(supervise({argv!r}, Path({str(receipt_dir)!r}), {NONCE!r}))\n",
        encoding="utf-8",
    )
    owner = subprocess.Popen([sys.executable, "-I", str(script)])
    try:
        deadline = time.monotonic() + 30
        while not (profile.worktree / "started").exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert (profile.worktree / "started").exists(), "confined child never started"
        owner.terminate()
        assert owner.wait(timeout=30) == 1
    finally:
        if owner.poll() is None:
            owner.kill()
            owner.wait(timeout=10)
    receipt = json.loads((receipt_dir / "stopped.json").read_text(encoding="utf-8"))
    assert receipt["descendants_reaped"] is True
    assert receipt["nonce"] == NONCE
    assert os.stat(receipt_dir / "stopped.json").st_mode & 0o777 == 0o600
    time.sleep(1.0)
    assert not survivor.exists(), "a setsid descendant outlived the supervisor"
