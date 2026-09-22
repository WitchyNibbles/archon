"""Repository-only installation into a consuming Claude Code project.

The manifest records ownership; it never authorizes an arbitrary path. Claude Code
itself owns project trust and the first-use hook approval prompt, so ``init`` never
writes trust, ``permissions.defaultMode``, ``model``, ``sandbox``, ``statusLine``,
or anything under ``~/.claude``.

Every configuration change is a pure insertion whose exact text is recorded, so
``uninstall`` restores the original bytes by deleting what was inserted, and a
region a person edited afterwards stays active instead of being replaced. The
byte-level half of that promise lives in ``jsonc``; this module decides *what* is
owned, and ``jsonc`` decides where the bytes for it go.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# `doctor`'s two derivations moved to `diagnostics`; they are still reached through
# this module by name, so the redundant aliases are deliberate re-exports.
from .diagnostics import (
    EVIDENCE as EVIDENCE,
)
from .diagnostics import (
    _evidence_directory as _evidence_directory,
)
from .diagnostics import (
    _masked_path_entries,
    _tested_versions,
    _version_key,
)
from .diagnostics import (
    _masked_roots as _masked_roots,
)
from .jsonc import (
    InstallError,
    _block,
    _current,
    _document,
    _insert,
    _members,
    _satisfied,
    _strip,
    _Unit,
)

__all__ = ["InstallError", "doctor", "init", "uninstall"]

ASSETS = Path(__file__).parent / "assets"

MANIFEST = ".archon/native-install.json"
INSTRUCTIONS = "CLAUDE.md"
MCP_CONFIG = ".mcp.json"
SETTINGS = ".claude/settings.json"
GITIGNORE = ".gitignore"
SKILL_BASE = ".claude/skills/archon-manager"
AGENT_DIR = ".claude/agents"
ROLE_AGENT_FILES = ("archon-familiar.md", "archon-warden.md", "archon-oracle.md")

CLAUDE_BEGIN = "<!-- BEGIN ARCHON NATIVE -->"
CLAUDE_END = "<!-- END ARCHON NATIVE -->"
PRESERVED_BEGIN = "<!-- Preserved Archon custom instructions -->"
PRESERVED_END = "<!-- End preserved Archon custom instructions -->"

# Every lifecycle event Archon owns, with the engine matcher it is scoped to.
HOOK_EVENTS: tuple[tuple[str, str | None], ...] = (
    ("SessionStart", "startup|resume|compact"),
    ("PreCompact", None),
    ("SubagentStart", None),
    ("SubagentStop", None),
    ("Stop", None),
    ("PreToolUse", "Bash|Edit|Write|NotebookEdit"),
)
HOOK_TIMEOUT = 5
ENV_BIN = "/usr/bin/env"
# Repository configuration must not reach the kernel's interpreter: PYTHONPATH and
# PYTHONHOME are unset, user site-packages disabled, for hooks and the MCP server alike.
# PYTHONSAFEPATH is the env spelling of `-P`: without it a `python -m archon` whose
# argv carries no `-I` still puts the repository's own directory first on sys.path,
# and a consumer's `archon.py` is imported before the installed kernel.
NEUTRAL_ENV = ("-u", "PYTHONPATH", "-u", "PYTHONHOME", "PYTHONNOUSERSITE=1", "PYTHONSAFEPATH=1")
GITIGNORE_ENTRIES = (".archon/", ".claude/worktrees/")

SERVER_PATTERN = r"archon(?:_workflow(?:_\d+)?)?"
SKILL_PATTERN = r"\.claude/skills/archon-manager(?:-\d+)?"
OWNED_FILE_PATTERN = rf"(?:{SKILL_PATTERN}/SKILL\.md|\.claude/agents/archon-(?:familiar|warden|oracle)\.md)"
EDITABLE = (INSTRUCTIONS, MCP_CONFIG, SETTINGS, GITIGNORE)
SEEDS = {INSTRUCTIONS: "", MCP_CONFIG: '{\n  "mcpServers": {}\n}\n', SETTINGS: "{}\n", GITIGNORE: ""}

TRUST_NOTE = (
    "Claude Code owns project trust and the first-use hook approval prompt; installation "
    "cannot grant either. Start a new session so the skill, agents, MCP server, and hooks "
    "load, and approve the hook definitions when Claude Code asks. The manager skill and "
    "the MCP workflow stay usable when lifecycle hooks are unavailable."
)
OBSERVABILITY_NOTE = (
    "doctor cannot observe the model selected in the Claude Code UI, whether hook "
    "definitions were approved, or whether a subagent actually spawned; those are "
    "reported by a real session, never by this command."
)


def _digest(data: bytes | str) -> str:
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def _root(repo: Path | str) -> Path:
    root = Path(repo).expanduser().absolute()
    if not root.is_dir():
        raise InstallError("Repository path is not a directory")
    # A linked worktree carries a .git file. Never execute hooks just to install.
    if not (root / ".git").exists():
        raise InstallError("Run installation inside a Git repository worktree root")
    return root


def _safe(root: Path, relative: str) -> Path:
    p = Path(relative)
    if p.is_absolute() or not p.parts or any(x in {"..", "."} for x in p.parts):
        raise InstallError("Installation path must stay inside the repository")
    target = root
    for part in p.parts:
        target /= part
        if target.is_symlink():
            raise InstallError(f"Installation refuses a symlink path: {relative}")
    if target.exists() and not target.is_file() and target == root / p:
        raise InstallError(f"Installation target is not a regular file: {relative}")
    return target


def _read(root: Path, relative: str) -> str:
    p = _safe(root, relative)
    if not p.exists():
        return ""
    if p.stat().st_size > 2_000_000:
        raise InstallError(f"Installation file is too large: {relative}")
    return p.read_text(encoding="utf-8")


def _write(root: Path, relative: str, content: str, *, private: bool = False) -> None:
    target = _safe(root, relative)
    # An existing file keeps the mode its author chose -- except where Archon owns
    # the privacy: a manifest a repository pre-created (or chmod'd) at 0644 must not
    # stay world-readable just because it was there first, and identical bytes are
    # no evidence that the mode is right either.
    existing = stat.S_IMODE(target.stat().st_mode) if target.exists() else None
    mode = 0o600 if private else (existing if existing is not None else 0o644)
    if existing is not None and target.read_text(encoding="utf-8") == content:
        if existing != mode:
            os.chmod(target, mode)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".archon-write-", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        _safe(root, relative)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _prune(root: Path, relative: str) -> None:
    """Remove directories Archon created once they hold nothing."""
    parent = Path(relative).parent
    while parent.parts:
        directory = root / parent
        if directory.is_symlink() or not directory.is_dir() or any(directory.iterdir()):
            return
        directory.rmdir()
        parent = parent.parent


def _check_private_parents(path: Path) -> None:
    for parent in [*reversed(path.parents), path]:
        if parent.is_symlink():
            raise InstallError("Private installation state refuses symlink parents")


def _private_base(state_home: Path | str | None) -> Path:
    if state_home is not None:
        path = Path(state_home).expanduser().absolute()
    else:
        path = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state") / "archon"
    if not path.is_absolute():
        raise InstallError("Private installation state must use an absolute path")
    _check_private_parents(path / "repos")
    return path


def _state_home(flag: Path | str | None, previous: dict[str, Any]) -> tuple[str | None, str]:
    """Where private kernel state lives, and which authority decided it.

    The manifest lives inside the repository, so a model can write it, and the
    rendering it has to match is computed from inputs the repository already knows.
    It may therefore *confirm* a location, never choose one against the person
    running the command: a `--state-home` that disagrees with the recorded value is
    a divergence `init` reports and refuses, rather than silently moving the
    database, evidence and backups to one of them. With no flag the recorded value
    is adopted, because repeating `init` has to stay idempotent -- but the adopted
    value and where it came from are reported, so a path that arrived through the
    repository is never invisible. What keeps this out of critical either way is
    that the workspace refuses a state directory inside any worktree.
    """
    recorded = previous.get("state_home")
    if flag is None:
        return recorded, "manifest" if recorded is not None else "default"
    selected = str(_private_base(flag))
    if recorded is not None and recorded != selected:
        raise InstallError(
            f"The private state location on the command line ({selected}) is not the one "
            f"recorded in {MANIFEST} ({recorded}). Nothing was changed: run `archon "
            "uninstall` first to move it, or pass the recorded location."
        )
    return selected, "flag"


def _state_location(recorded: str | None, source: str) -> dict[str, str]:
    """The resolved private state directory, named in every report that adopts one."""
    try:
        return {"state_home": str(_private_base(recorded)), "state_home_source": source}
    except InstallError:
        # A report never fails on the very thing it exists to describe.
        return {"state_home": str(recorded), "state_home_source": source}


def _backup(root: Path, relative: str, content: str, state_home: Path | str | None = None) -> str:
    from .workspace import Workspace

    workspace = Workspace(root, state_root=_private_base(state_home))
    directory = workspace.state_dir / "install-backups" / workspace.worktree_id
    name = directory / f"{relative.replace('/', '__')}.{_digest(content)[:16]}.bak"
    # Traverse with open directory handles: a replaced parent cannot redirect a
    # later backup write. Every component, including existing parents, is no-follow.
    parent_fd = os.open(directory.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in directory.parts[1:]:
            try:
                os.mkdir(part, mode=0o700, dir_fd=parent_fd)
            except FileExistsError:
                pass
            child_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
            os.close(parent_fd)
            parent_fd = child_fd
        try:
            fd = os.open(name.name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
        except FileExistsError:
            fd = os.open(name.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
            with os.fdopen(fd, "r", encoding="utf-8") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode) or stream.read(2_000_001) != content:
                    raise InstallError("Installation backup collided with unrelated content")
            return str(name)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as exc:
        raise InstallError("Installation backup could not be written safely") from exc
    finally:
        os.close(parent_fd)
    return str(name)




def _argv(executable: str | Sequence[str] | None) -> list[str]:
    if executable is None:
        argv = [sys.executable, "-I", "-m", "archon"]
    else:
        argv = [executable] if isinstance(executable, str) else list(executable)
    if not argv or not all(isinstance(s, str) and s and not any(c in s for c in "\x00\r\n") for s in argv):
        raise InstallError("Executable must be a nonempty vector without control characters")
    resolved = shutil.which(argv[0]) if not Path(argv[0]).is_absolute() else argv[0]
    if not resolved or not Path(resolved).is_file():
        raise InstallError("Archon executable was not found")
    argv[0] = str(Path(resolved).absolute())
    return argv


def _options(root: Path, state_home: str | None) -> list[str]:
    return ["--repo", str(root), *(["--state-home", state_home] if state_home else [])]


def _hook_command(argv: list[str], root: Path, state_home: str | None) -> str:
    return shlex.join([ENV_BIN, *NEUTRAL_ENV, *argv, *_options(root, state_home), "hook"])


def _hook_groups(argv: list[str], root: Path, state_home: str | None = None) -> dict[str, list[dict[str, Any]]]:
    command = _hook_command(argv, root, state_home)
    groups: dict[str, list[dict[str, Any]]] = {}
    for event, matcher in HOOK_EVENTS:
        handler = {"type": "command", "command": command, "timeout": HOOK_TIMEOUT}
        group: dict[str, Any] = {"hooks": [handler]}
        if matcher is not None:
            group = {"matcher": matcher, "hooks": [handler]}
        groups[event] = [group]
    return groups


def _server_entry(argv: list[str], root: Path, state_home: str | None) -> dict[str, Any]:
    """The MCP entry, neutralized exactly as the hook command is.

    An MCP `env` block can only *add* variables, so unsetting has to happen in the
    vector itself. With the default argv `-I` already ignores the environment, but a
    custom executable -- a console script, a wrapper -- does not, and then a
    repository-set `PYTHONPATH` injects its own modules into the kernel process.
    Same neutralization, same reason, same place the packaged .mcp.json puts it.
    """
    return {
        "command": ENV_BIN,
        "args": [*NEUTRAL_ENV, *argv, *_options(root, state_home), "mcp"],
        "env": {"PYTHONNOUSERSITE": "1"},
    }


def _allow_rule(server: str) -> str:
    return f"mcp__{server}__*"


def _load(root: Path) -> dict[str, Any]:
    raw = _read(root, MANIFEST)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise InstallError("Invalid Archon installation manifest") from exc
    if not isinstance(data, dict) or data.get("version") != 1:
        raise InstallError("Unsupported Archon installation manifest version")
    if not isinstance(data.get("server"), str) or not re.fullmatch(SERVER_PATTERN, data["server"]):
        raise InstallError("Invalid MCP server name in installation manifest")
    if not re.fullmatch(SKILL_PATTERN, str(data.get("skill_dir"))):
        raise InstallError("Invalid managed skill location")
    _validate_ownership(data)
    _validate_runtime(root, data)
    return data


def _validate_ownership(data: dict[str, Any]) -> None:
    files = data.get("files", {})
    if not isinstance(files, dict) or not all(isinstance(v, str) for v in files.values()):
        raise InstallError("Malformed Archon installation ownership records")
    for path in files:
        if not re.fullmatch(OWNED_FILE_PATTERN, str(path)):
            raise InstallError(f"Manifest contains an unowned installation path: {path}")
    edits = data.get("edits", {})
    if not isinstance(edits, dict) or set(edits) - set(EDITABLE):
        raise InstallError("Manifest contains unowned configuration ownership")
    for records in edits.values():
        if not isinstance(records, list) or not all(
            isinstance(r, dict) and isinstance(r.get("id"), str) and isinstance(r.get("value"), str)
            and isinstance(r.get("text"), str) and r["text"]
            for r in records
        ):
            raise InstallError("Malformed managed configuration ownership")


def _validate_runtime(root: Path, data: dict[str, Any]) -> None:
    executable = data.get("executable")
    state_home = data.get("state_home")
    if (
        not isinstance(executable, list) or not executable
        or not all(isinstance(p, str) and p and not any(c in p for c in "\x00\r\n") for p in executable)
        or not Path(executable[0]).is_absolute()
        or (state_home is not None and (not isinstance(state_home, str) or not Path(state_home).is_absolute()))
        or data.get("hooks") != _hook_groups(list(executable), root, state_home)
    ):
        raise InstallError("Manifest hook ownership does not match the narrow Archon integration")


@dataclass
class _Plan:
    root: Path
    state_home: str | None
    pending: dict[str, str] = field(default_factory=dict)
    files: dict[str, str] = field(default_factory=dict)
    edits: dict[str, list[dict[str, str]]] = field(default_factory=dict)
    backups: list[str] = field(default_factory=list)
    retained: list[str] = field(default_factory=list)

    def back_up(self, relative: str, content: str) -> None:
        self.backups.append(_backup(self.root, relative, content, self.state_home))




def _apply(plan: _Plan, path: str, text: str, units: list[_Unit], previous: list[dict[str, str]]) -> str:
    """Re-establish owned insertions, leaving regions a person edited untouched."""
    if _current(previous, units, text):
        plan.edits[path] = list(previous)
        return text
    text, present = _strip(text, previous)
    edited = [record for record in previous if not present[record["id"]]]
    result: list[dict[str, str]] = list(edited)
    for unit in units:
        if any(record["id"] == unit.id for record in edited) or _satisfied(text, unit):
            plan.retained.append(f"{path}#{unit.id}")
            continue
        text, inserted = _insert(text, unit)
        result.append({"id": unit.id, "text": inserted, "value": unit.canonical()})
    plan.edits[path] = result
    return text


def _config_units(server: str, argv: list[str], root: Path, state_home: str | None) -> dict[str, list[_Unit]]:
    groups = _hook_groups(argv, root, state_home)
    hooks = [
        _Unit(f"hooks.{event}", ("hooks", event), None, groups[event][0])
        for event, _matcher in HOOK_EVENTS
    ]
    return {
        MCP_CONFIG: [
            _Unit(f"mcpServers.{server}", ("mcpServers",), server, _server_entry(argv, root, state_home)),
        ],
        SETTINGS: [
            _Unit("permissions.allow", ("permissions", "allow"), None, _allow_rule(server)),
            *hooks,
        ],
    }


def _server_name(text: str, previous: dict[str, Any]) -> str:
    recorded = previous.get("server")
    if isinstance(recorded, str) and re.fullmatch(SERVER_PATTERN, recorded):
        return recorded
    document = _document(text)
    existing = document.get("mcpServers", {}) if isinstance(document, dict) else {}
    if not isinstance(existing, dict):
        raise InstallError("Existing .mcp.json mcpServers must be a JSON object")
    server = "archon"
    if server in existing:
        server, suffix = "archon_workflow", 2
        while server in existing:
            server = f"archon_workflow_{suffix}"
            suffix += 1
    return server


def _skill_dir(root: Path, previous: dict[str, Any]) -> str:
    recorded = previous.get("skill_dir")
    if isinstance(recorded, str):
        if not re.fullmatch(SKILL_PATTERN, recorded):
            raise InstallError("Invalid managed skill location")
        return recorded
    skill_dir, suffix = SKILL_BASE, 2
    while (root / skill_dir).exists():
        skill_dir = f"{SKILL_BASE}-{suffix}"
        suffix += 1
    return skill_dir


def _oracle_text(text: str, fable: bool) -> str:
    if fable:
        return text
    return text.replace("model: fable\n", "model: opus\n", 1).replace("effort: xhigh\n", "effort: max\n", 1)


def _managed_files(plan: _Plan, skill_dir: str, previous: dict[str, Any], fable: bool) -> None:
    sources = {f"{skill_dir}/SKILL.md": ASSETS / "archon" / "skills" / "archon-manager" / "SKILL.md"}
    for name in ROLE_AGENT_FILES:
        sources[f"{AGENT_DIR}/{name}"] = ASSETS / "archon" / "agents" / name
    for target, source in sources.items():
        desired = source.read_text(encoding="utf-8")
        if target.endswith("SKILL.md"):
            desired = desired.replace("name: archon-manager\n", f"name: {Path(skill_dir).name}\n", 1)
        if target.endswith("archon-oracle.md"):
            desired = _oracle_text(desired, fable)
        current = _read(plan.root, target)
        old_hash = previous.get("files", {}).get(target)
        if current and current != desired and (old_hash is None or _digest(current) != old_hash):
            # A person's version stays active; the packaged revision waits privately.
            plan.back_up(target + ".new", desired)
            plan.retained.append(target)
            plan.files[target] = old_hash or _digest(desired)
        else:
            plan.pending[target] = desired
            plan.files[target] = _digest(desired)


def _instructions(plan: _Plan, text: str, block: str, previous: list[dict[str, str]]) -> str:
    recorded = previous[0] if previous else None
    if recorded and recorded["text"] in text:
        if recorded["value"] == block:
            plan.edits[INSTRUCTIONS] = list(previous)
            return text
        text = text.replace(recorded["text"], "", 1)
    elif recorded:
        plan.retained.append(f"{INSTRUCTIONS}#block")
        plan.edits[INSTRUCTIONS] = list(previous)
        return text
    span = _block(text, CLAUDE_BEGIN, CLAUDE_END)
    if span:
        # Keep an unrecorded block's wording active while owning exactly one block.
        plan.back_up(INSTRUCTIONS, text)
        plan.retained.append(INSTRUCTIONS)
        text = (
            text[: span[0]]
            + text[slice(*span)].replace(CLAUDE_BEGIN, PRESERVED_BEGIN, 1).replace(CLAUDE_END, PRESERVED_END, 1)
            + text[span[1] :]
        )
    separator = "" if not text else ("" if text.endswith("\n\n") else ("\n" if text.endswith("\n") else "\n\n"))
    inserted = separator + block + "\n"
    plan.edits[INSTRUCTIONS] = [{"id": "block", "text": inserted, "value": block}]
    return text + inserted


def _gitignore(plan: _Plan, text: str, previous: list[dict[str, str]]) -> str:
    recorded = previous[0] if previous else None
    if recorded and recorded["text"] in text:
        plan.edits[GITIGNORE] = list(previous)
        return text
    if recorded:
        plan.retained.append(f"{GITIGNORE}#entries")
        plan.edits[GITIGNORE] = list(previous)
        return text
    lines = {line.strip() for line in text.splitlines()}
    missing = [entry for entry in GITIGNORE_ENTRIES if entry not in lines]
    if not missing:
        plan.edits[GITIGNORE] = []
        return text
    separator = "" if not text or text.endswith("\n") else "\n"
    inserted = separator + "\n".join(missing) + "\n"
    plan.edits[GITIGNORE] = [{"id": "entries", "text": inserted, "value": json.dumps(missing)}]
    return text + inserted



def init(
    repo: Path | str,
    executable: str | Sequence[str] | None = None,
    *,
    migrate: bool = False,
    state_home: Path | str | None = None,
    fable: bool = False,
    gitignore: bool = False,
) -> dict[str, Any]:
    """Apply the intentional local setup. Unchanged setup writes nothing."""
    root = _root(repo)
    argv = _argv(executable)
    previous = _load(root)
    selected, source = _state_home(state_home, previous)
    if selected is not None:
        from .workspace import Workspace

        Workspace(root, state_root=_private_base(selected))
    plan = _Plan(root=root, state_home=selected)
    migrated: list[str] = []
    review: list[str] = []
    if migrate:
        from . import legacy

        plan.pending, migrated, review = legacy.changes(
            lambda relative: _read(root, relative), plan.back_up
        )
    texts = {path: plan.pending.get(path, _read(root, path)) for path in EDITABLE}
    created = previous.get("created") or {path: not _safe(root, path).exists() for path in EDITABLE}
    for path in (MCP_CONFIG, SETTINGS):  # Reject malformed input before writing anything.
        if texts[path].strip():
            _members(texts[path])
    server = _server_name(texts[MCP_CONFIG], previous)
    skill_dir = _skill_dir(root, previous)
    _managed_files(plan, skill_dir, previous, fable)
    block = _claude_block(skill_dir)
    old = previous.get("edits", {})
    texts[INSTRUCTIONS] = _instructions(plan, texts[INSTRUCTIONS] or SEEDS[INSTRUCTIONS], block, old.get(INSTRUCTIONS, []))
    for path, units in _config_units(server, argv, root, selected).items():
        texts[path] = _apply(plan, path, texts[path] or SEEDS[path], units, old.get(path, []))
    if texts[GITIGNORE] or gitignore or old.get(GITIGNORE):
        texts[GITIGNORE] = _gitignore(plan, texts[GITIGNORE], old.get(GITIGNORE, []))
    plan.pending.update({path: texts[path] for path in plan.edits})
    manifest = {
        "version": 1, "server": server, "skill_dir": skill_dir, "executable": argv,
        "state_home": selected, "oracle": "fable" if fable else "opus",
        "files": plan.files, "edits": plan.edits, "allow": _allow_rule(server),
        "hooks": _hook_groups(argv, root, selected), "created": created,
    }
    return _commit(plan, manifest, migrated, review, source)


def _claude_block(skill_dir: str) -> str:
    body = (ASSETS / "claude-block.md").read_text(encoding="utf-8")
    return body.format(skill_path=f"{skill_dir}/SKILL.md").strip()


def _commit(plan: _Plan, manifest: dict[str, Any], migrated: list[str], review: list[str],
            source: str) -> dict[str, Any]:
    root = plan.root
    for path in [*plan.pending, MANIFEST, *migrated]:
        _safe(root, path)
    changed = [path for path, value in plan.pending.items() if _read(root, path) != value]
    for path, content in plan.pending.items():
        _write(root, path, content)
    _write(root, MANIFEST, json.dumps(manifest, indent=2, sort_keys=True) + "\n", private=True)
    for path in migrated:
        _safe(root, path).unlink()
        _prune(root, path)
    location = _state_location(manifest["state_home"], source)
    notes = [TRUST_NOTE]
    if source == "manifest":
        notes.append(
            f"Private state location {location['state_home']} was adopted from {MANIFEST}, "
            "which lives in the repository; pass --state-home to choose it deliberately."
        )
    return {
        "installed": True, "repo": str(root), "changed": changed, "server": manifest["server"],
        "skill_path": f"{manifest['skill_dir']}/SKILL.md", "backups": plan.backups,
        "preserved_edits": plan.retained, "migrated": migrated, "review": review,
        "hook_trust": "host_managed_unknown", "notes": notes, **location,
    }


def uninstall(repo: Path | str) -> dict[str, Any]:
    root = _root(repo)
    manifest = _load(root)
    if not manifest:
        return {"installed": False, "removed": [], "preserved": []}
    edits: dict[str, list[dict[str, str]]] = manifest.get("edits", {})
    for path in [*manifest.get("files", {}), *edits, MANIFEST]:
        _safe(root, path)
    removed, preserved = _remove_files(root, manifest)
    for path, records in edits.items():
        original = _read(root, path)
        text, present = _strip(original, records)
        preserved.extend(f"{path}#{record['id']}" for record in records if not present[record["id"]])
        if text == original:
            continue
        if manifest.get("created", {}).get(path) and text.strip() in ("", SEEDS.get(path, "").strip()):
            _safe(root, path).unlink()
            _prune(root, path)
        else:
            _write(root, path, text)
        removed.append(f"{path} managed members")
    _safe(root, MANIFEST).unlink()
    _prune(root, MANIFEST)
    return {
        "installed": False, "removed": removed, "preserved": preserved,
        "notes": ["Private run history and installation backups are preserved."],
    }


def _remove_files(root: Path, manifest: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Delete only files still byte-identical to what was installed."""
    removed: list[str] = []
    preserved: list[str] = []
    for path, digest in manifest.get("files", {}).items():
        current = _read(root, path)
        if current and _digest(current) == digest:
            _safe(root, path).unlink()
            _prune(root, path)
            removed.append(path)
        elif current:
            preserved.append(path)
    return removed, preserved


def _tool(name: str) -> str | None:
    """Locate one external prerequisite; the single seam doctor's tests replace."""
    return shutil.which(name)


def _run(argv: Sequence[str]) -> str | None:
    try:
        result = subprocess.run(list(argv), capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout if result.returncode == 0 else None


def _engine_version() -> str | None:
    binary = _tool("claude")
    output = _run([binary, "--version"]) if binary else None
    match = re.search(r"\d+\.\d+\.\d+", output or "")
    return match.group() if match else None


def _claude_status() -> dict[str, Any]:
    """Login state only; the account's email address is never read out."""
    binary = _tool("claude")
    output = _run([binary, "auth", "status"]) if binary else None
    if output is None:
        return {"logged_in": None, "subscription": None}
    try:
        record = json.loads(output)
    except ValueError:
        return {"logged_in": None, "subscription": None}
    return {
        "logged_in": bool(record.get("loggedIn")) if isinstance(record, dict) else None,
        "subscription": record.get("subscription_type") or record.get("subscriptionType"),
    }


def _check_installed(root: Path, manifest: dict[str, Any], problems: list[str]) -> None:
    for path, digest in manifest.get("files", {}).items():
        if _digest(_read(root, path)) != digest:
            problems.append(f"Managed file is missing or edited: {path}")
    for path, records in manifest.get("edits", {}).items():
        present = _strip(_read(root, path), records)[1]
        for record in records:
            if not present[record["id"]]:
                problems.append(f"Managed configuration is missing or edited: {path}#{record['id']}")

def _engine_notes(problems: list[str], warnings: list[str]) -> dict[str, Any]:
    for tool in ("bwrap", "socat"):
        if not _tool(tool):
            problems.append(f"{tool} is not installed; kernel-executed checks cannot be confined")
    if not _tool("claude"):
        problems.append("The Claude Code CLI is not on PATH; sessions and reviewers cannot run")
    version = _engine_version()
    tested = _tested_versions()
    if version and tested and not (_version_key(tested[0]) <= _version_key(version) <= _version_key(tested[-1])):
        warnings.append(
            f"Claude Code {version} is outside the tested range {tested[0]}..{tested[-1]}; "
            "re-run `uv run python scripts/spikes/run_all.py --allow-live` and commit the evidence"
        )
    return {"claude": version, "tested_range": list(tested),
            "bwrap": bool(_tool("bwrap")), "socat": bool(_tool("socat")),
            "masked_path_entries": _masked_path_entries(warnings)}


def doctor(repo: Path | str) -> dict[str, Any]:
    root = _root(repo)
    problems: list[str] = []
    warnings: list[str] = []
    notes = [TRUST_NOTE, OBSERVABILITY_NOTE]
    try:
        manifest = _load(root)
        settings = _document(_read(root, SETTINGS))
    except (InstallError, ValueError) as exc:
        return {"installed": False, "ok": False, "problems": [str(exc)], "warnings": warnings,
                "notes": notes, "hook_trust": "not_observable"}
    if not manifest:
        problems.append("Archon native integration is not installed")
    else:
        _check_installed(root, manifest, problems)
    if isinstance(settings, dict) and settings.get("permissions", {}).get("defaultMode") == "bypassPermissions":
        notes.append("This project sets permissions.defaultMode = bypassPermissions; Archon never writes it")
    engine = _engine_notes(problems, warnings)
    from . import legacy

    for relative in legacy.MANIFESTS:
        if _read(root, relative):
            notes.append(f"Legacy overlay manifest {relative} is present; `init --migrate` archives what it records")
    recorded = manifest.get("state_home")
    # The manifest is repository-writable, so where it points is a finding, not trivia.
    location = _state_location(recorded, "manifest" if recorded else "default")
    return {
        "installed": bool(manifest), "ok": not problems, "problems": problems, "warnings": warnings,
        "notes": notes, "hook_trust": "not_observable", "oracle": manifest.get("oracle"),
        "engine": engine, "auth": _claude_status(), **location,
    }
