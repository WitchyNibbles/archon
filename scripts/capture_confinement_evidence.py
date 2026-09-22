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

import json
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from archon.sandbox import (  # noqa: E402
    DEFAULT_MASKED,
    CheckProfile,
    prepare_scratch,
    probe_bwrap,
    render_bwrap,
)

PLANTED_MARKER = "archon-planted-marker-value"
TIMEOUT_SECONDS = 120


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
    for entry in DEFAULT_MASKED:
        target = home / str(entry)[2:]
        if target.name == ".netrc":
            target.write_text(PLANTED_MARKER, encoding="utf-8")
        else:
            target.mkdir(parents=True, exist_ok=True)
            (target / "marker").write_text(PLANTED_MARKER, encoding="utf-8")
    return CheckProfile(worktree=worktree, scratch=scratch, state_dir=state_dir, home=home)


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


def collect() -> dict[str, Any]:
    probe = probe_bwrap()
    if not probe.available:
        return {
            "date": date.today().isoformat(),
            "verdict": "UNRESOLVED",
            "reason": probe.message,
            "remedy": probe.remedy,
        }

    with tempfile.TemporaryDirectory(prefix="archon-confinement-") as raw:
        profile = _build_profile(Path(raw).resolve())

        # The positive control for every masking arm. It carries the same
        # planted marker and sits under the same temporary root, but inside
        # the worktree bind rather than behind a mask. If this arm cannot
        # read the marker either, the masking arms prove nothing and the
        # whole capture is invalid.
        control = profile.worktree / "unmasked-control"
        control.write_text(PLANTED_MARKER, encoding="utf-8")

        secret = profile.home / ".ssh" / "marker"
        netrc = profile.home / ".netrc"
        assert secret.read_text(encoding="utf-8") == PLANTED_MARKER
        assert netrc.read_text(encoding="utf-8") == PLANTED_MARKER

        arms = [
            _arm(profile, "external egress", "deny", EGRESS),
            _arm(profile, "external name resolution", "deny", RESOLVE),
            _arm(profile, "masked home directory read", "deny", _read_script(secret)),
            _arm(profile, "masked home file read", "deny", _read_script(netrc)),
            _arm(profile, "private state write", "deny", _write_script(profile.state_dir / "archon.sqlite3")),
            _arm(profile, "unmasked read of same marker (control)", "allow", _read_script(control)),
            _arm(profile, "worktree write (control)", "allow", WORKTREE_WRITE),
            _arm(profile, "$TMPDIR cache write (control)", "allow", TMPDIR_WRITE),
            _arm(profile, "scratch $HOME cache write (control)", "allow", HOME_WRITE),
        ]

    denies = [a for a in arms if a["expects"] == "deny"]
    allows = [a for a in arms if a["expects"] == "allow"]
    control_read = next(a for a in arms if a["arm"].startswith("unmasked read"))
    # A masking arm only counts once the control proves the marker was
    # readable at all. Without that, ENOENT means "absent", not "masked".
    control_valid = bool(control_read["leaked_planted_marker"])
    clean = (
        all(a["as_expected"] for a in arms)
        and control_valid
        and not any(a["leaked_planted_marker"] for a in denies)
    )
    return {
        "date": date.today().isoformat(),
        "verdict": "PASS" if clean else "FAIL",
        "bwrap_version": probe.version,
        "profile_digest": profile.digest(),
        "denied_arms": len(denies),
        "permitted_arms": len(allows),
        "positive_control_read_the_planted_marker": control_valid,
        "planted_marker_leaked_past_a_mask": any(a["leaked_planted_marker"] for a in denies),
        "arms": arms,
    }


def main() -> int:
    record = collect()
    out = Path(__file__).resolve().parents[1] / "docs" / "evidence"
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{record['date']}-confinement.json"
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    for arm in record.get("arms", []):
        mark = "ok " if arm["as_expected"] else "BAD"
        print(f"{mark} {arm['expects']:5} {arm['arm']:36} exit={arm['exit_code']:<4} {arm['observed'][:90]}")
    print(f"\nverdict: {record['verdict']}  ->  {path}")
    return 0 if record["verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
