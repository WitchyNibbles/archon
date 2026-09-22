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
===========================  =========================================  ======

A blocked check therefore looks like an ordinary nonzero exit with an errno in
{101, 111, 2, 13, 30}; only the profile digest and the fact that the kernel
rendered the confinement distinguish it from a genuine check failure.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
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
    prepare_scratch,
    probe_bwrap,
    render_bwrap,
)

PROBE = probe_bwrap()
ATTESTED = BwrapProbe(available=True, binary="bwrap", version="test")
requires_bwrap = pytest.mark.skipif(not PROBE.available, reason=PROBE.message)
PLANTED_MARKER = "archon-planted-marker-value"
NONCE = "b" * 32


@pytest.fixture
def profile(tmp_path: Path) -> CheckProfile:
    """A complete, realistic layout: fake home with secrets, private state, scratch."""
    root = tmp_path.resolve()
    worktree = root / "worktree"
    scratch = root / "scratch"
    state_dir = root / "state"
    home = root / "home"
    for directory in (worktree, state_dir, home, home / ".config"):
        directory.mkdir(parents=True)
    prepare_scratch(scratch)
    (state_dir / "archon.sqlite3").write_text(PLANTED_MARKER, encoding="utf-8")
    for entry in DEFAULT_MASKED:
        target = home / str(entry)[2:]
        if target.suffix == ".netrc" or target.name == ".netrc":
            target.write_text(PLANTED_MARKER, encoding="utf-8")
        else:
            target.mkdir(parents=True, exist_ok=True)
            (target / "marker").write_text(PLANTED_MARKER, encoding="utf-8")
    return CheckProfile(worktree=worktree, scratch=scratch, state_dir=state_dir, home=home)


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
    for index in range(0, len(BASE_FILESYSTEM), 1):
        assert BASE_FILESYSTEM[index] in argv
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
    root = tmp_path.resolve()
    worktree = root / "worktree"
    scratch = root / "scratch"
    home = root / "home"
    (worktree / "state").mkdir(parents=True)
    home.mkdir()
    prepare_scratch(scratch)
    with pytest.raises(SandboxError, match="must not sit inside a writable bind"):
        CheckProfile(
            worktree=worktree, scratch=scratch, state_dir=worktree / "state", home=home
        )
    (worktree / "secrets").mkdir()
    with pytest.raises(SandboxError, match="masked path must not sit inside"):
        CheckProfile(
            worktree=worktree,
            scratch=scratch,
            state_dir=root,
            home=home,
            masked=(worktree / "secrets",),
        )


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


@pytest.mark.sandbox
@requires_bwrap
def test_reading_a_masked_home_secret_fails(profile: CheckProfile) -> None:
    marker = profile.home / ".ssh" / "marker"
    assert marker.read_text(encoding="utf-8") == PLANTED_MARKER
    script = (
        "import sys\n"
        f"try:\n    print(open({str(marker)!r}).read())\n"
        "except OSError as error:\n    print(error.errno, error); sys.exit(7)\n"
        "sys.exit(1)\n"
    )
    result = run_confined(profile, script)
    # Observed shape: exit 7, "2 [Errno 2] No such file or directory" — the mask is
    # an empty tmpfs, so a masked secret reads as absent, not as denied.
    assert result.returncode == 7, result
    assert "No such file or directory" in result.stdout
    assert PLANTED_MARKER not in result.stdout


@pytest.mark.sandbox
@requires_bwrap
def test_reading_a_masked_home_file_fails(profile: CheckProfile) -> None:
    netrc = profile.home / ".netrc"
    assert netrc.read_text(encoding="utf-8") == PLANTED_MARKER
    script = (
        "import sys\n"
        f"try:\n    print(open({str(netrc)!r}).read())\n"
        "except OSError as error:\n    print(error.errno, error); sys.exit(7)\n"
        "sys.exit(1)\n"
    )
    result = run_confined(profile, script)
    # Observed shape: exit 7, "13 [Errno 13] Permission denied" — a *file* mask is a
    # read-only bind of /dev/null, which denies read as well as write.
    assert result.returncode == 7, result
    assert "Permission denied" in result.stdout
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
    if binary is None:
        pytest.skip("uv is not installed on this host")
    argv = render_bwrap(profile, [binary, "cache", "dir"], profile.worktree)
    result = subprocess.run(argv, capture_output=True, text=True, timeout=120, check=False)
    if result.returncode != 0:
        pytest.skip(f"uv on this host is not self-contained: {result.stderr.strip()}")
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
