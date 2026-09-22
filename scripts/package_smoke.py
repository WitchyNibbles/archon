#!/usr/bin/env python3
"""Build the distribution and exercise it from a clean virtual environment.

What this proves, without any model call and without any spend: the wheel
carries every packaged asset the consumer overlay writes, a clean install
imports from the environment rather than the source checkout, ``init`` is
byte-idempotent, ``doctor`` reports the installed runtime, and ``uninstall``
gives the repository's own bytes back exactly.

What it does **not** prove: reviewer behaviour, hook trust, or anything that
needs an authenticated engine. Those are ``live_smoke.py`` and
``native_smoke.py``. The engine on ``PATH`` here is the recorded fake from
``tests/fixtures/claude``, so ``doctor``'s engine block is deterministic and
free; the report labels that ceiling.

Verdicts are ``PASS``, ``FAIL`` or ``UNRESOLVED``. A missing host prerequisite
or a package index that is needed but not authorized is UNRESOLVED, never FAIL.
Exit status: 0 PASS, 1 FAIL, 3 UNRESOLVED.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
FAKE_ENGINE = REPO_ROOT / "tests" / "fixtures" / "claude" / "fake_claude.py"
FAKE_ENGINE_VERSION = "2.1.278"

# Kept identical to the assertion in .github/workflows/ci.yml on purpose: the
# overlay writes exactly these files, so an omission is a broken install.
REQUIRED_ASSETS = (
    "archon/assets/claude-block.md",
    "archon/assets/archon/skills/archon-manager/SKILL.md",
    "archon/assets/archon/agents/archon-familiar.md",
    "archon/assets/archon/agents/archon-warden.md",
    "archon/assets/archon/agents/archon-oracle.md",
    "archon/assets/archon/reviewers/reviewer.md",
    "archon/assets/archon/reviewers/qa_engineer.md",
    "archon/assets/archon/reviewers/security_reviewer.md",
    "archon/assets/archon/hooks/hooks.json",
    "archon/assets/archon/.mcp.json",
    "archon/assets/archon/.claude-plugin/plugin.json",
)
PLUGIN_MANIFEST = "archon/assets/archon/.claude-plugin/plugin.json"

# Pre-existing consumer content, including comments and an unusual key order in
# settings.json, so uninstall has something real to hand back (AC-23).
CONSUMER_SEED = {
    "CLAUDE.md": "# House rules\n\nSmall, tested changes only.\n",
    ".claude/settings.json": (
        "{\n"
        '  // A human wrote this comment and it must survive.\n'
        '  "statusLine": { "type": "command", "command": "my-statusline" },\n'
        '  "permissions": { "allow": ["Bash(git status:*)"] }\n'
        "}\n"
    ),
    ".mcp.json": '{\n  "mcpServers": {\n    "unrelated": { "command": "true" }\n  }\n}\n',
    ".gitignore": "*.tmp\n",
    "notes/user-note.txt": "Preexisting user content stays intact.\n",
}


class SmokeError(RuntimeError):
    """A real failure of the packaged artifact."""


class Unresolved(RuntimeError):
    """The environment could not authorize or supply what the check needs."""


def run(argv: list[str], *, cwd: Path, env: dict[str, str], timeout: int = 300) -> str:
    result = subprocess.run(argv, cwd=cwd, env=env, text=True,
                            capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        raise SmokeError(
            f"command failed ({result.returncode}): {shlex.join(argv)}\n"
            f"{result.stdout[-4000:]}\n{result.stderr[-4000:]}"
        )
    return result.stdout


def file_hashes(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file() and ".git" not in path.relative_to(root).parts
    }


def fake_engine_dir(root: Path) -> Path:
    """A ``claude`` on PATH that only answers ``--version``; it never calls a model."""
    directory = root / "engine"
    directory.mkdir(parents=True, exist_ok=True)
    shim = directory / "claude"
    shim.write_text(
        f"#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(FAKE_ENGINE))} \"$@\"\n",
        encoding="utf-8",
    )
    shim.chmod(0o755)
    return directory


def environment(output: Path) -> dict[str, str]:
    env = {
        key: value for key, value in os.environ.items()
        if not key.startswith("GIT_") and key not in {"PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"}
    }
    env.update(
        XDG_STATE_HOME=str(output / "state"),
        PATH=f"{fake_engine_dir(output)}{os.pathsep}{os.environ['PATH']}",
        FAKE_CLAUDE_VERSION=FAKE_ENGINE_VERSION,
        PYTHONNOUSERSITE="1",
        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
        GIT_AUTHOR_NAME="Archon Package Smoke", GIT_AUTHOR_EMAIL="smoke@example.invalid",
        GIT_COMMITTER_NAME="Archon Package Smoke", GIT_COMMITTER_EMAIL="smoke@example.invalid",
    )
    return env


def check_prerequisites() -> None:
    missing = [tool for tool in ("uv", "git", "bwrap", "socat") if shutil.which(tool) is None]
    if missing:
        raise Unresolved("host prerequisites are not installed: " + ", ".join(missing))
    if not FAKE_ENGINE.is_file():
        raise Unresolved(f"the recorded fake engine is missing: {FAKE_ENGINE}")


def build_distribution(output: Path, env: dict[str, str], *, online: bool, cache: Path) -> dict[str, Any]:
    arguments = ["uv", "build", "--out-dir", str(output / "dist"), "--cache-dir", str(cache)]
    if not online:
        arguments.append("--offline")
    try:
        run(arguments, cwd=REPO_ROOT, env=env, timeout=600)
    except SmokeError as exc:
        if not online:
            raise Unresolved(
                "the offline build could not be satisfied from the local uv cache; "
                "re-run with --online to authorize package downloads"
            ) from exc
        raise
    wheel = next((output / "dist").glob("*.whl"))
    sdist = next((output / "dist").glob("*.tar.gz"))
    return {"wheel": wheel, "sdist": sdist}


def inspect_artifacts(wheel: Path, sdist: Path) -> dict[str, Any]:
    """Every consumer asset, the plugin manifest, and the README metadata ship."""
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        missing = [name for name in REQUIRED_ASSETS if name not in names]
        if missing:
            raise SmokeError("wheel is missing packaged assets: " + ", ".join(missing))
        manifest = json.loads(archive.read(PLUGIN_MANIFEST))
        metadata = archive.read(
            next(name for name in names if name.endswith(".dist-info/METADATA"))
        ).decode()
    if manifest.get("name") != "archon":
        raise SmokeError(f"packaged plugin manifest is not named archon: {manifest.get('name')!r}")
    declared = sorted(key for key in ("skills", "agents", "hooks", "mcpServers") if key in manifest)
    if "Description-Content-Type: text/markdown" not in metadata:
        raise SmokeError("wheel metadata lost the README content type")
    with tarfile.open(sdist) as archive:
        sdist_names = archive.getnames()
    absent = [asset for asset in REQUIRED_ASSETS
              if not any(name.endswith("/src/" + asset) for name in sdist_names)]
    if absent:
        raise SmokeError("source distribution is missing assets: " + ", ".join(absent))
    return {
        "wheel_sha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
        "required_assets": list(REQUIRED_ASSETS),
        "plugin_manifest": manifest,
        "plugin_components_declared": declared,
    }


def install_wheel(output: Path, wheel: Path, env: dict[str, str], *, online: bool,
                  cache: Path) -> Path:
    venv = output / "venv"
    network = [] if online else ["--offline"]
    run(["uv", "venv", "--cache-dir", str(cache), "--python", sys.executable, str(venv)],
        cwd=output, env=env)
    python = venv / "bin" / "python"
    run(["uv", "pip", "install", *network, "--cache-dir", str(cache),
         "--python", str(python), str(wheel)], cwd=output, env=env)
    return python


def seed_consumer(output: Path, env: dict[str, str]) -> Path:
    consumer = output / "consumer"
    for relative, text in CONSUMER_SEED.items():
        path = consumer / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    git = ["git", "-c", f"core.hooksPath={os.devnull}"]
    run([*git, "init", "--initial-branch=main"], cwd=consumer, env=env)
    run([*git, "add", "."], cwd=consumer, env=env)
    run([*git, "commit", "-m", "Package smoke baseline"], cwd=consumer, env=env)
    return consumer


def exercise_overlay(python: Path, consumer: Path, venv: Path, env: dict[str, str]) -> dict[str, Any]:
    """init twice, doctor, uninstall — the whole documented consumer path."""
    location = run([str(python), "-I", "-c", "import archon; print(archon.__file__)"],
                   cwd=consumer, env=env).strip()
    if str(venv) not in location or str(REPO_ROOT / "src") in location:
        raise SmokeError(f"the clean environment imported the source checkout: {location}")
    cli = [str(python), "-I", "-m", "archon", "--repo", str(consumer), "--json"]
    before = file_hashes(consumer)
    first = json.loads(run([*cli, "init"], cwd=consumer, env=env))
    server = json.loads((consumer / ".mcp.json").read_text(encoding="utf-8"))
    entry = server["mcpServers"][first["server"]]
    # The installer spawns the server through `env` so it can unset PYTHONPATH and
    # PYTHONHOME, so the interpreter is now in the argument vector rather than in
    # `command`; the point of the assertion is unchanged — the entry must name the
    # installed interpreter and not whatever `python` the consumer's PATH resolves.
    if not any(argument.startswith(str(venv)) for argument in entry["args"]):
        raise SmokeError(f"the MCP entry does not point at the installed interpreter: {entry}")
    if "-I" not in entry["args"] or "mcp" not in entry["args"]:
        raise SmokeError(f"the MCP entry lost its isolated module invocation: {entry}")
    installed = file_hashes(consumer)
    second = json.loads(run([*cli, "init"], cwd=consumer, env=env))
    if second["changed"] or file_hashes(consumer) != installed:
        raise SmokeError(f"repeating init was not byte-idempotent: {second['changed']}")
    doctor = json.loads(run([*cli, "doctor"], cwd=consumer, env=env))
    if not doctor.get("ok") or doctor.get("problems"):
        raise SmokeError(f"doctor reported problems on a clean install: {doctor}")
    # An installed Archon with no spike evidence beside it has no tested range, so
    # it could never warn on engine drift (AC-22). The wheel must carry it, and the
    # two independent evidence locators -- the installer's and the adapter's -- must
    # agree once installed, where their differing parent walks actually diverge.
    ranges = {
        "engine": doctor.get("engine", {}).get("tested_range"),
        "runtime": doctor.get("runtime", {}).get("tested_range"),
    }
    if not all(ranges.values()):
        raise SmokeError(
            f"the installed distribution carries no spike evidence to derive a tested range: {ranges}"
        )
    if ranges["engine"] != ranges["runtime"]:
        raise SmokeError(f"the installed evidence locators disagree on the tested range: {ranges}")
    removed = json.loads(run([*cli, "uninstall"], cwd=consumer, env=env))
    restored = file_hashes(consumer)
    if restored != before:
        raise SmokeError(
            "uninstall did not restore the repository's own bytes: "
            + json.dumps({"unexpected": sorted(set(restored) - set(before)),
                          "lost": sorted(set(before) - set(restored))})
        )
    return {"import_location": location, "initialization": first, "repeated_setup": second,
            "doctor": doctor, "uninstall": removed, "consumer": str(consumer),
            "venv": str(venv), "original_bytes_restored": True}


def smoke(output: Path, *, online: bool, cache: Path) -> dict[str, Any]:
    env = environment(output)
    check_prerequisites()
    artifacts = build_distribution(output, env, online=online, cache=cache)
    report: dict[str, Any] = {"artifacts": inspect_artifacts(artifacts["wheel"], artifacts["sdist"])}
    report["artifacts"].update(wheel=str(artifacts["wheel"]), sdist=str(artifacts["sdist"]))
    python = install_wheel(output, artifacts["wheel"], env, online=online, cache=cache)
    consumer = seed_consumer(output, env)
    report.update(exercise_overlay(python, consumer, output / "venv", env))
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, help="Empty directory for artifacts and the report")
    parser.add_argument("--cache-dir", type=Path, default=Path(tempfile.gettempdir()) / "archon-uv-cache")
    parser.add_argument("--online", action="store_true",
                        help="Authorize package downloads; the default builds from the local uv cache")
    args = parser.parse_args(argv)
    output = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix="archon-package-"))
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        parser.error(f"{output} is not empty")
    output.chmod(0o700)
    report: dict[str, Any] = {
        "kind": "packaged-distribution-and-consumer-overlay",
        "started_at": datetime.now(UTC).isoformat(),
        "engine": f"recorded fake at {FAKE_ENGINE_VERSION}; no authenticated call and no spend",
        "not_covered": ["reviewer hermeticity", "hook trust", "any live model behaviour"],
        "online": bool(args.online),
    }
    try:
        report.update(smoke(output, online=args.online, cache=args.cache_dir), verdict="PASS")
        status = 0
    except Unresolved as exc:
        report.update(verdict="UNRESOLVED", reason=str(exc))
        status = 3
    except Exception as exc:  # noqa: BLE001 - every failure is reported, never raised at the user
        report.update(verdict="FAIL", reason=f"{type(exc).__name__}: {exc}")
        status = 1
    report["finished_at"] = datetime.now(UTC).isoformat()
    destination = output / "report.json"
    destination.write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps({"verdict": report["verdict"], "report": str(destination),
                      "reason": report.get("reason")}, indent=2))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
