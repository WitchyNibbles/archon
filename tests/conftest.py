"""Shared fixtures keep repository state and secrets outside real user projects."""

from __future__ import annotations

import os
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest


def _isolated_environment() -> dict[str, str]:
    """A Git environment that cannot see the developer's own configuration.

    A bare `git init` inherits `~/.gitconfig` and `/etc/gitconfig`: an init template
    that seeds files, a global `core.hooksPath`, `init.defaultBranch`, `core.autocrlf`.
    A suite that inherits those passes or fails on the machine it runs on rather than
    on the code, and a global hooks path would run a developer's own hooks inside a
    fixture. Every repository a test creates is built through this environment.
    """
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(
        GIT_AUTHOR_NAME="Archon Test",
        GIT_AUTHOR_EMAIL="test@example.invalid",
        GIT_COMMITTER_NAME="Archon Test",
        GIT_COMMITTER_EMAIL="test@example.invalid",
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_GLOBAL=os.devnull,
    )
    return env


@pytest.fixture
def git_environment() -> dict[str, str]:
    return _isolated_environment()


@pytest.fixture
def git_init() -> Callable[[Path], None]:
    """Create a repository the developer's global Git configuration cannot reach."""

    def initialize(root: Path) -> None:
        subprocess.run(
            ["git", "-c", f"core.hooksPath={os.devnull}", "init", "-q",
             "--initial-branch=main", str(root)],
            env=_isolated_environment(),
            check=True,
            capture_output=True,
        )

    return initialize


@pytest.fixture
def git_repo(tmp_path: Path, git_init: Callable[[Path], None]) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    env = _isolated_environment()

    def git(*args: str) -> None:
        subprocess.run(
            ["git", "-c", f"core.hooksPath={os.devnull}", "-C", str(root), *args],
            env=env,
            check=True,
            capture_output=True,
        )

    git_init(root)
    (root / "README.md").write_text("# Fixture project\n", encoding="utf-8")
    git("add", "README.md")
    git("commit", "-m", "Initial fixture")
    return root
