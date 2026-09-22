"""What `doctor` may observe about this host, and the two facts it must never type.

The tested engine range is *derived* from the spike evidence on record, and the masked
PATH entries are read from the check profile itself. Both are here for the same reason:
a second, hand-maintained copy of either -- a version literal, a list of masked roots --
drifts from the thing it describes, and a diagnostic that reports yesterday's truth is
worse than one that reports nothing. Nothing in this module blocks anything; it returns
what was seen, and the caller decides whether that is a warning.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path


def _evidence_directory() -> Path:
    """Locate recorded spike evidence from a checkout *or* an installed wheel.

    This was a fixed ``parents[2]`` offset, which is correct in the source
    tree and silently wrong once installed: from
    ``site-packages/archon/install.py`` it resolves to ``<prefix>/docs/evidence``,
    which does not exist. `doctor` therefore derived an empty tested range and
    could never warn on engine drift (AC-22) for the distributed artifact —
    a guard that reported nothing rather than reporting a problem.

    The wheel force-includes the evidence at ``archon/docs/evidence``, so a
    parent walk finds it in both layouts. This matches
    ``claude_adapter._evidence_directory``; the two must agree, because a
    `doctor` range that disagrees with the adapter's is worse than none.
    """
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "docs" / "evidence"
        if candidate.is_dir():
            return candidate
    return Path(__file__).parent / "docs" / "evidence"


EVIDENCE = _evidence_directory()


def _version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", version)[:3])


#: A version counts as tested only once every spike in the book has a verdict
#: on record for it. See ``claude_adapter.REQUIRED_SPIKE_IDS``; the two must
#: agree, so this derives the same set rather than restating it.
REQUIRED_SPIKE_IDS: frozenset[str] = frozenset(f"S{n}" for n in range(1, 13))
RECORDED_VERDICTS: frozenset[str] = frozenset({"PASS", "FAIL", "UNRESOLVED"})


def _tested_versions() -> tuple[str, ...]:
    """Engine versions with a *complete* book on record, never a partial one.

    Counting any single evidence file is how this nearly shipped a false
    claim. The engine updated from 2.1.278 to 2.1.280 mid-session; a re-run of
    the host one-liners alone wrote one record at the new version and the
    range promptly claimed it was tested, while eleven of twelve spikes had
    never executed there. `docs/spikes.md` always said the range comes from
    versions with a complete book; only the code disagreed.
    """
    if not EVIDENCE.is_dir():
        return ()
    by_version: dict[str, set[str]] = {}
    for path in sorted(EVIDENCE.glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(record, dict):
            continue
        version = record.get("engine_version")
        spike_id = record.get("id")
        if not isinstance(version, str) or not re.match(r"\d+\.\d+", version):
            continue
        # Every verdict counts, FAIL included: the range says the book was
        # executed here, not that everything passed.
        if not isinstance(spike_id, str) or record.get("verdict") not in RECORDED_VERDICTS:
            continue
        by_version.setdefault(version, set()).add(spike_id)
    complete = [v for v, ids in by_version.items() if REQUIRED_SPIKE_IDS <= ids]
    return tuple(sorted(complete, key=_version_key))



MAX_MASKED_WARNINGS = 4


def _masked_roots() -> tuple[Path, ...]:
    """The directories the check profile hides, taken from the profile itself.

    Imported, never restated: two copies of a path list drift, and a `doctor` that
    warns about yesterday's mask list is worse than one that says nothing.
    """
    from . import sandbox

    roots: list[Path] = []
    for entry in (*sandbox.DEFAULT_MASKED, sandbox.default_runtime_dir()):
        target = Path(os.path.realpath(Path(entry).expanduser()))
        if target not in roots:
            roots.append(target)
    return tuple(roots)


def _masked_path_entries(warnings: list[str]) -> list[str]:
    """PATH directories a confined check cannot see, so an installed tool reads missing.

    `/run` and `$XDG_RUNTIME_DIR` are masked because host sockets survive
    `--unshare-net`. Version managers put their shims there: fnm publishes `node` and
    `npm` under `$XDG_RUNTIME_DIR/fnm_multishells/...`, and a check that shells out to
    `npm` then fails with ENOENT, which is indistinguishable from an uninstalled
    dependency. This is a warning and never a problem: the masking is correct, the
    confusion is not, and `doctor` must never block on either.
    """
    try:
        roots = _masked_roots()
    except (ImportError, OSError):
        return []
    hidden: list[str] = []
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if not entry or entry in hidden:
            continue
        resolved = Path(os.path.realpath(Path(entry).expanduser()))
        if any(resolved == root or root in resolved.parents for root in roots):
            hidden.append(entry)
    for entry in hidden[:MAX_MASKED_WARNINGS]:
        warnings.append(
            f"PATH entry {entry} is inside a directory the check profile masks, so a "
            'check that runs a tool found there fails with "No such file or directory" '
            "even though the tool is installed. Install or expose that tool outside the "
            "masked roots (/run, /var/run, $XDG_RUNTIME_DIR), or give the check an "
            "absolute path to an interpreter that is visible under confinement."
        )
    if len(hidden) > MAX_MASKED_WARNINGS:
        warnings.append(
            f"{len(hidden) - MAX_MASKED_WARNINGS} further PATH entries are masked the same way: "
            + ", ".join(hidden[MAX_MASKED_WARNINGS:])
        )
    return hidden


