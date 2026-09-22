"""Record what the kernel-owned check profile actually denies, verbatim.

``tests/test_sandbox.py`` asserts these properties. This script exists to
*quote* them: ``docs/verification.md`` AC-16 must name the observed denial
shape for each confinement boundary, and a shape retyped from memory is
exactly the kind of claim this project refuses to accept.

Every negative arm is paired with a positive control, because the second
run of the spike book (2026-09-22) found a "denial" that was really a
missing file. A masked read that reports ENOENT proves nothing unless an
identical unmasked read succeeds in the same session.

Spends nothing and calls no model. Requires bubblewrap on the host.

    uv run python scripts/capture_confinement_evidence.py
"""

from __future__ import annotations

import contextlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from archon.sandbox import (  # noqa: E402
    BASE_FILESYSTEM,
    DEFAULT_MASKED,
    CheckProfile,
    default_runtime_dir,
    prepare_scratch,
    probe_bwrap,
    render_bwrap,
)

PLANTED_MARKER = "archon-planted-marker-value"
TIMEOUT_SECONDS = 120

#: Masks that live under the fake home, one planted marker each. `/run` and
#: `/var/run` are host-owned, so the runtime directory carries their arms.
HOME_MASKS: tuple[Path, ...] = tuple(e for e in DEFAULT_MASKED if str(e).startswith("~/"))
#: A home path no mask covers. Without it the masking arms are unfalsifiable: see
#: LAYOUT_PARENT.
UNMASKED_CONTROL = Path("~/.archon-unmasked-control")
RUNTIME_DIR = default_runtime_dir()

#: Named once, so the verdict cannot silently stop checking a control.
CONTROL_MARKER = "unmasked read of same marker (control)"
CONTROL_HOME = "unmasked read inside the fake home (control)"
CONTROL_SOCKET = "unix socket inside the worktree (control)"

#: The fake home must be built somewhere the confined child can still see, or the
#: masking arms report ENOENT by absence and prove nothing. `$TMPDIR` is /tmp,
#: which BASE_FILESYSTEM replaces with an empty tmpfs; /var/tmp is ordinary disk
#: on the read-only bind, so a planted marker there is readable unless masked.
LAYOUT_PARENT = Path("/var/tmp")


def _hidden_by_the_profile(path: Path) -> Path | None:
    """The tmpfs root that swallows ``path``, if the fixed profile masks one."""
    roots = [Path(t) for i, t in enumerate(BASE_FILESYSTEM) if BASE_FILESYSTEM[i - 1] == "--tmpfs"]
    roots += [
        Path(os.path.realpath(entry))
        for entry in (*DEFAULT_MASKED, RUNTIME_DIR)
        if entry.is_absolute()
    ]
    seen = Path(os.path.realpath(path))
    return next((root for root in roots if seen == root or root in seen.parents), None)


def _marker_path(home: Path, entry: Path) -> Path:
    """`~/.netrc` is masked as a file (a read-only bind of /dev/null); every other
    entry is a directory mask, so its marker goes inside it."""
    target = home / str(entry)[2:]
    return target if target.name == ".netrc" else target / "marker"


def _plant(home: Path, entry: Path) -> Path:
    marker = _marker_path(home, entry)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(PLANTED_MARKER, encoding="utf-8")
    return marker


def _build_profile(root: Path) -> CheckProfile:
    """A realistic layout: a fake home holding planted secrets, private state, scratch."""
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
    return CheckProfile(worktree=worktree, scratch=scratch, state_dir=state_dir, home=home)


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


def _confined(profile: CheckProfile, script: str) -> subprocess.CompletedProcess[str]:
    argv = render_bwrap(profile, [sys.executable, "-c", script], profile.worktree, {})
    return subprocess.run(argv, capture_output=True, text=True, timeout=TIMEOUT_SECONDS, check=False)


def _arm(profile: CheckProfile, name: str, kind: str, script: str) -> dict[str, Any]:
    """Run one probe and record its exit status and last stderr line verbatim."""
    outcome = _confined(profile, script)
    stderr = outcome.stderr.strip().splitlines()
    return {
        "arm": name,
        "expects": kind,
        "exit_code": outcome.returncode,
        "stdout": outcome.stdout.strip()[:400],
        "observed": (stderr[-1] if stderr else "")[:400],
        "leaked_planted_marker": PLANTED_MARKER in outcome.stdout,
        "as_expected": (outcome.returncode == 0) if kind == "allow" else (outcome.returncode != 0),
    }


EGRESS = """
import socket, sys
s = socket.socket(); s.settimeout(5)
s.connect(("93.184.216.34", 443))
print("CONNECTED")
"""

RESOLVE = """
import socket
print(socket.gethostbyname("example.com"))
"""

def _read_script(target: Path) -> str:
    """Read one absolute path and print the errno verbatim if it fails.

    The path is absolute on purpose. ``$HOME`` inside the sandbox is the
    scratch home, which is empty, so a probe written against ``Path.home()``
    would report ENOENT for every arm and prove nothing about the masks.
    """
    return (
        "import sys\n"
        f"try:\n    sys.stdout.write(open({str(target)!r}).read())\n"
        "except OSError as error:\n    print(error.errno, error); sys.exit(7)\n"
    )


def _write_script(target: Path) -> str:
    return (
        "import sys\n"
        f"try:\n    open({str(target)!r}, 'w').write('forged'); print('WROTE')\n"
        "except OSError as error:\n    print(error.errno, error); sys.exit(7)\n"
    )


WORKTREE_WRITE = """
import pathlib
pathlib.Path("control.txt").write_text("control")
print(pathlib.Path("control.txt").read_text())
"""

TMPDIR_WRITE = """
import os, pathlib
cache = pathlib.Path(os.environ["TMPDIR"]) / "cache" / "probe"
cache.parent.mkdir(parents=True, exist_ok=True)
cache.write_text("cache")
print(cache.read_text())
"""

HOME_WRITE = """
import pathlib
cache = pathlib.Path.home() / ".cache" / "uv" / "probe"
cache.parent.mkdir(parents=True, exist_ok=True)
cache.write_text("cache")
print(cache.read_text())
"""


def _socket_script(path: Path) -> str:
    """Connect to one filesystem socket and echo whatever the peer answers.

    SEC-H1: ``--unshare-net`` removes IP, not IPC. The kernel exempts sockets
    from the read-only-superblock check, so under ``--ro-bind / /`` alone a
    confined child held a two-way conversation with an unconfined one through
    $XDG_RUNTIME_DIR -- which on a normal host reaches the session D-Bus, and
    through it a fully unconfined process with network access.
    """
    return (
        "import socket,sys\n"
        "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(10)\n"
        f"try:\n    s.connect({str(path)!r})\n"
        "except OSError as error:\n    print(error.errno, error); sys.exit(7)\n"
        "s.sendall(b'confined-child')\n"
        "sys.stdout.write(s.recv(64).decode())\n"
    )


def _mask_arms(profile: CheckProfile) -> list[dict[str, Any]]:
    """One arm per declared home mask, so a narrowed DEFAULT_MASKED shows up here.

    QA-C1: `~/.aws` and `~/.claude` were deleted from the set and this capture
    still reported PASS, because it only ever read `.ssh` and `.netrc`.
    """
    arms = [
        _arm(profile, f"masked read {entry}", "deny", _read_script(_marker_path(profile.home, entry)))
        for entry in HOME_MASKS
    ]
    victim = profile.state_dir / "archon.sqlite3"
    arms.append(_arm(profile, "private state write", "deny", _write_script(victim)))
    return arms


def _runtime_arms(profile: CheckProfile) -> list[dict[str, Any]]:
    """The `/run` arms: a planted marker and a live socket in $XDG_RUNTIME_DIR.

    `/run` and `/var/run` are host-owned, so their masks are proven where this
    user may actually write. The socket arm is SEC-H1 itself.
    """
    if not (RUNTIME_DIR.is_dir() and os.access(RUNTIME_DIR, os.W_OK)):
        return []
    marker = RUNTIME_DIR / f"archon-capture-{os.getpid()}.marker"
    marker.write_text(PLANTED_MARKER, encoding="utf-8")
    try:
        with _unix_listener(RUNTIME_DIR / f"archon-capture-{os.getpid()}.sock") as sock:
            return [
                _arm(profile, "runtime dir marker read", "deny", _read_script(marker)),
                _arm(profile, "runtime dir unix socket", "deny", _socket_script(sock)),
            ]
    finally:
        marker.unlink(missing_ok=True)


def _control_arms(profile: CheckProfile, control: Path) -> list[dict[str, Any]]:
    """The positive controls. Each says a denial above was a denial and not an
    absence, a missing mechanism, or an unreachable layout."""
    with _unix_listener(profile.worktree / "control.sock") as sock:
        reachable = _arm(profile, CONTROL_SOCKET, "allow", _socket_script(sock))
    home_marker = _marker_path(profile.home, UNMASKED_CONTROL)
    return [
        _arm(profile, CONTROL_MARKER, "allow", _read_script(control)),
        _arm(profile, CONTROL_HOME, "allow", _read_script(home_marker)),
        reachable,
        _arm(profile, "worktree write (control)", "allow", WORKTREE_WRITE),
        _arm(profile, "$TMPDIR cache write (control)", "allow", TMPDIR_WRITE),
        _arm(profile, "scratch $HOME cache write (control)", "allow", HOME_WRITE),
    ]


def _unresolved(reason: str, remedy: str) -> dict[str, Any]:
    return {
        "date": date.today().isoformat(),
        "verdict": "UNRESOLVED",
        "reason": reason,
        "remedy": remedy,
    }


def _verdict(arms: list[dict[str, Any]], profile: CheckProfile, version: str | None) -> dict[str, Any]:
    denies = [arm for arm in arms if arm["expects"] == "deny"]
    allows = [arm for arm in arms if arm["expects"] == "allow"]
    controls = {arm["arm"]: arm for arm in allows}
    # Three things must hold before a denial counts. The marker was readable at
    # all; an *unmasked* file in the same fake home was readable from inside this
    # sandbox (a home under a tmpfs reads as absent whether or not it is masked);
    # and AF_UNIX IPC works in here, so a refused connect is the mask and not a
    # missing mechanism.
    control_valid = all(
        controls[name]["leaked_planted_marker"]
        for name in (CONTROL_MARKER, CONTROL_HOME, CONTROL_SOCKET)
    )
    leaked = any(arm["leaked_planted_marker"] for arm in denies)
    clean = all(arm["as_expected"] for arm in arms) and control_valid and not leaked
    return {
        "date": date.today().isoformat(),
        "verdict": "PASS" if clean else "FAIL",
        "bwrap_version": version,
        "profile_digest": profile.digest(),
        # Recorded, not asserted: the arms below are derived from this set, so a
        # deleted entry removes its own arm instead of failing one. The falsifying
        # pin is tests/test_sandbox.py::test_the_declared_mask_set_is_pinned_literally
        # (QA-C1); writing the set here makes the narrowing visible in this diff.
        "declared_masks": [str(entry) for entry in DEFAULT_MASKED],
        "declared_runtime_dir": str(RUNTIME_DIR),
        "denied_arms": len(denies),
        "permitted_arms": len(allows),
        "positive_control_read_the_planted_marker": control_valid,
        "planted_marker_leaked_past_a_mask": leaked,
        "arms": arms,
    }


def collect() -> dict[str, Any]:
    probe = probe_bwrap()
    if not probe.available:
        return _unresolved(probe.message, probe.remedy or "")
    # QA-M7: a checkout under /tmp cannot exec its own interpreter in here. That
    # is the layout, not a confinement result, and it must not be captured as one.
    hidden = _hidden_by_the_profile(Path(sys.executable))
    if hidden is not None:
        return _unresolved(
            f"{sys.executable} sits inside {hidden}, which the profile masks.",
            f"Re-run this capture from a working copy outside {hidden}.",
        )
    if not (LAYOUT_PARENT.is_dir() and os.access(LAYOUT_PARENT, os.W_OK)):
        return _unresolved(
            f"{LAYOUT_PARENT} is not writable, so the fake home would have to live "
            "under a tmpfs and every masking arm would report absence, not denial.",
            f"Make {LAYOUT_PARENT} writable and re-run.",
        )

    with tempfile.TemporaryDirectory(prefix="archon-confinement-", dir=LAYOUT_PARENT) as raw:
        profile = _build_profile(Path(raw).resolve())
        control = profile.worktree / "unmasked-control"
        control.write_text(PLANTED_MARKER, encoding="utf-8")
        arms = [
            _arm(profile, "external egress", "deny", EGRESS),
            _arm(profile, "external name resolution", "deny", RESOLVE),
            *_mask_arms(profile),
            *_runtime_arms(profile),
            *_control_arms(profile, control),
        ]
    return _verdict(arms, profile, probe.version)


def main() -> int:
    record = collect()
    out = Path(__file__).resolve().parents[1] / "docs" / "evidence"
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{record['date']}-confinement.json"
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    for arm in record.get("arms", []):
        mark = "ok " if arm["as_expected"] else "BAD"
        print(f"{mark} {arm['expects']:5} {arm['arm']:44} exit={arm['exit_code']:<4} {arm['observed'][:80]}")
    print(f"\nverdict: {record['verdict']}  ->  {path}")
    return 0 if record["verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
