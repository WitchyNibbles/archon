"""Placeholder replaced in P3 by the Claude Code execution adapter."""

from __future__ import annotations


class AdapterError(RuntimeError):
    """Diagnosed runtime limitation; never evidence that a check passed."""


def create_adapter(*args: object, **kwargs: object) -> object:
    raise AdapterError("The Claude Code adapter is not implemented yet (P3).")
