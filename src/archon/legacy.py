"""Archiving the two overlays that came before: TypeScript Archon and DevGod.

`init --migrate` never removes a file because of its name. It removes one only when
the predecessor's own manifest recorded that exact content hash, lifts only a marked
section it can still identify unambiguously, and drops only hook handlers whose
command is a recognised predecessor form. Everything it touches is backed up into
private state first; everything it recognises but cannot prove -- a `package.json`
script, an `.env` template -- is reported for a person to decide, never edited.

Repository access is injected rather than imported, so migration cannot reach a path
the installer's own `_safe` would refuse.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from typing import Any

from .jsonc import InstallError, _block


def _digest(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


#: Read one repository-relative text file, or "" when it does not exist.
Reader = Callable[[str], str]
#: Copy the current bytes of a repository-relative path into private state.
BackUp = Callable[[str, str], None]


MANIFESTS = (".archon/install-manifest.json", ".devgod/install-manifest.json")
TARGETS = (
    r"\.archon/(?:ACTIVE|work/.+|rules/.+|skills/.+|templates/.+)",
    r"\.claude/hooks/archon-[A-Za-z0-9._-]+\.mjs",
    r"\.claude/agents/[A-Za-z0-9._-]+/AGENT\.md",
    r"\.claude/skills/archon-[A-Za-z0-9._-]+/.+",
    r"\.agents/skills/devgod-[A-Za-z0-9._-]+/.+",
    r"\.codex/agents/devgod-[A-Za-z0-9._-]+\.toml",
)
SECTIONS = (
    ("AGENTS.md", "<!-- BEGIN DEVGOD NATIVE -->", "<!-- END DEVGOD NATIVE -->"),
    (".codex/config.toml", "# BEGIN DEVGOD NATIVE", "# END DEVGOD NATIVE"),
)
HOOK_COMMAND = re.compile(r"(?:^|\s)-m\s+devgod(?:\s|$)|devgod/(?:src/admin\.ts|dist/admin\.js)")
REVIEW_TRACES = (
    ("package.json", re.compile(r'"archon:[A-Za-z0-9:_-]+"\s*:')),
    (".env.example", re.compile(r"ARCHON_CORE_DATABASE_URL")),
    (".env.template", re.compile(r"ARCHON_CORE_DATABASE_URL")),
    (".env.sample", re.compile(r"ARCHON_CORE_DATABASE_URL")),
)


def _records(read: Reader) -> list[tuple[str, str]]:
    """Recorded (path, content hash) pairs from a previous overlay's own manifest."""
    records: list[tuple[str, str]] = []
    for relative in MANIFESTS:
        raw = read(relative)
        if not raw:
            continue
        try:
            manifest = json.loads(raw)
        except ValueError:
            continue
        entries = manifest.get("files", []) if isinstance(manifest, dict) else []
        entries = entries if isinstance(entries, list) else []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            target, content_hash = entry.get("target"), entry.get("contentHash")
            if isinstance(target, str) and isinstance(content_hash, str):
                records.append((target, content_hash))
    return records


def _hooks(text: str) -> tuple[dict[str, Any], bool]:
    """Drop only hook handlers whose command is a known DevGod form."""
    try:
        document = json.loads(text)
    except ValueError as exc:
        raise InstallError("Existing .codex/hooks.json is invalid; preserved") from exc
    hooks = document.get("hooks") if isinstance(document, dict) else None
    if not isinstance(hooks, dict):
        return {}, False
    remaining: dict[str, Any] = {}
    changed = False
    for event, entries in hooks.items():
        kept = []
        for group in entries if isinstance(entries, list) else []:
            handlers = list(group.get("hooks", []))
            live = [h for h in handlers if not HOOK_COMMAND.search(str(h.get("command", "")))]
            changed = changed or len(live) != len(handlers)
            if live:
                kept.append({**group, "hooks": live})
        remaining[event] = kept
    return ({**document, "hooks": remaining}, True) if changed else ({}, False)


def changes(read: Reader, back_up: BackUp) -> tuple[dict[str, str], list[str], list[str]]:
    """Rewrites to apply, paths to remove, and traces a person must rule on.

    Nothing is opened or written here: `read` and `back_up` come from the installer,
    so migration inherits its symlink refusal and its private backup location.
    """
    changes: dict[str, str] = {}
    removed: list[str] = []
    for relative, begin, end in SECTIONS:
        original = read(relative)
        span = _block(original, begin, end)
        if span:
            back_up(relative, original)
            changes[relative] = original[: span[0]] + original[span[1] :]
    hook_text = read(".codex/hooks.json")
    if hook_text:
        document, changed = _hooks(hook_text)
        if changed:
            back_up(".codex/hooks.json", hook_text)
            changes[".codex/hooks.json"] = json.dumps(document, indent=2) + "\n"
    for target, content_hash in _records(read):
        if not any(re.fullmatch(pattern, target) for pattern in TARGETS):
            continue
        try:
            content = read(target)
        except InstallError:
            continue
        if not content or _digest(content) != content_hash:
            continue
        back_up(target, content)
        removed.append(target)
    return changes, removed, _review(read)


def _review(read: Reader) -> list[str]:
    """Overlay traces left in place on purpose; a person decides what they mean."""
    found = []
    for relative, pattern in REVIEW_TRACES:
        try:
            text = read(relative)
        except InstallError:
            continue
        if text and pattern.search(text):
            found.append(relative)
    return found
