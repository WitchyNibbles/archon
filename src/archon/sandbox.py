"""Kernel-owned bubblewrap confinement for repository checks.

The profile is a fixed tuple.  A ``CheckSpec`` found in repository configuration
is a proposal to run *under* this profile, never authority to widen it: nothing
here reads a spec, and the only caller-supplied inputs are an argv, a working
directory that must resolve inside the delivery worktree, and environment names
drawn from a declared passthrough allowlist.  There is no parameter, hook, or
override by which a repository can add a bind, restore egress, or leak a name.

DevGod died eight minutes into its first real run because its policy excluded
``/tmp`` and ``uv`` could not write a cache.  The scratch directory with its own
``TMPDIR``/``TMP``/``TEMP``/``HOME`` exists for that run and is not optional.

``--unshare-net`` takes away IP, not IPC.  ``--ro-bind / /`` leaves every filesystem
socket on the host in place and the kernel exempts sockets from the read-only
superblock check, so a confined child used to hold a two-way conversation with an
unconfined one through ``$XDG_RUNTIME_DIR`` — the session D-Bus (and therefore
``systemd --user StartTransientUnit``, i.e. an unconfined process with egress), the
gpg-agent socket even with ``~/.gnupg`` masked, and Claude Code's own sockets.  The
runtime directory, ``/run`` and ``/var/run`` are masked for that reason; a check
needs none of them.

The price is named rather than paid quietly: a *toolchain* installed under the
runtime directory becomes unreachable too.  ``fnm`` puts its per-shell ``node``
and ``npm`` in ``$XDG_RUNTIME_DIR/fnm_multishells/...``, so on such a host a check
that shells out to ``npm`` now fails with ENOENT inside the confinement.  It fails
closed, which is the contract; the answer is a node installed outside the runtime
directory, never a bind added back for this host.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

BWRAP_BINARY = "bwrap"
PROBE_ARGUMENTS: tuple[str, ...] = ("--ro-bind", "/", "/", "--unshare-net", "--", "true")
PROBE_TIMEOUT_SECONDS = 10.0

APT_PACKAGE = "bubblewrap"
APPARMOR_PROFILE = "bwrap-userns-restrict"
APPARMOR_SYSCTL = "kernel.apparmor_restrict_unprivileged_userns"
INSTALL_REMEDY = (
    f"Install bubblewrap (`sudo apt install {APT_PACKAGE}`) and re-run `archon doctor`."
)
USERNS_REMEDY = (
    "Unprivileged user namespaces are denied on this host. On Ubuntu 24.04 this is the "
    f"AppArmor profile `{APPARMOR_PROFILE}` (see /etc/apparmor.d/{APPARMOR_PROFILE}); allow it "
    f"with `sudo sysctl -w {APPARMOR_SYSCTL}=0` or `sudo aa-complain /usr/bin/bwrap`, then "
    "re-run `archon doctor`. Archon will not run a check unconfined."
)
USERNS_MARKERS: tuple[str, ...] = (
    "creating new namespace failed",
    "no permissions to creating new namespace",
    "unable to create new namespace",
    "setting up uid map",
    "clone failed",
    "user namespace",
)

NAMESPACE_FLAGS: tuple[str, ...] = (
    "--unshare-net",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--die-with-parent",
    "--new-session",
)
BASE_FILESYSTEM: tuple[str, ...] = (
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
)

#: A read-only bind of ``/dev/null`` masks a *file*: reads and writes both fail
#: EACCES, where ``--tmpfs`` on a file path fails at mount time (ENOTDIR).
MASK_FILE_SOURCE = "/dev/null"

#: Declared, not discovered.  ``tests/test_sandbox.py`` pins this tuple literally
#: and runs one real-bwrap arm per entry: deleting ``~/.aws`` and ``~/.claude`` from
#: here once left the whole suite green (QA-C1).
#: ``/run`` and ``/var/run`` carry the host's filesystem sockets, which survive
#: ``--unshare-net`` and a read-only bind (SEC-H1); on a usrmerge host ``/var/run``
#: is a symlink to ``/run`` and ``masked_paths()`` collapses the pair.
DEFAULT_MASKED: tuple[Path, ...] = (
    Path("~/.ssh"),
    Path("~/.aws"),
    Path("~/.gnupg"),
    Path("~/.claude"),
    Path("~/.config/gh"),
    Path("~/.netrc"),
    Path("/run"),
    Path("/var/run"),
)

#: Inherited from the host only when the caller does not supply the name itself.
ENV_BASE_ALLOWLIST: tuple[str, ...] = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM")
#: Kernel-owned; a caller-supplied value for any of these is rejected, not merged.
ENV_KERNEL_OWNED: tuple[str, ...] = ("HOME", "TMPDIR", "TMP", "TEMP")
ENV_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
MAX_ENV_VALUE_BYTES = 65_536
MAX_COMMAND_ARGUMENTS = 128
MAX_ARGUMENT_BYTES = 8192

SCRATCH_TMP = "tmp"
SCRATCH_HOME = "home"
SCRATCH_DIRECTORIES: tuple[str, ...] = (SCRATCH_TMP, SCRATCH_HOME)
SCRATCH_MODE = 0o700

CANONICAL_WORKTREE = "/<worktree>"
CANONICAL_SCRATCH = "/<scratch>"
CANONICAL_STATE = "/<state>"
CANONICAL_RUNTIME = "/<runtime>"
CANONICAL_HOME = "/<home>"
CANONICAL_COMMAND: tuple[str, ...] = ("/<command>",)
CANONICAL_ENV_VALUE = "<inherited>"
DIGEST_VERSION = "archon-check-profile-v1"


class SandboxError(RuntimeError):
    """Confinement could not be established.

    Raised instead of running anything.  A check that cannot be confined does not
    run less confined; it does not run.
    """


@dataclass(frozen=True)
class BwrapProbe:
    """Structured result of the pre-dispatch bubblewrap probe."""

    available: bool
    binary: str | None = None
    version: str | None = None
    reason: str | None = None
    remedy: str | None = None

    @property
    def message(self) -> str:
        reason = self.reason or "bubblewrap confinement is unavailable"
        return f"{reason} {self.remedy}".strip() if self.remedy else reason

    def require(self) -> str:
        """Return the usable binary, or stop before any child is dispatched."""
        if self.available and self.binary is not None:
            return self.binary
        raise SandboxError(self.message)

    def as_dict(self) -> dict[str, object]:
        return {
            "available": self.available,
            "binary": self.binary,
            "version": self.version,
            "reason": self.reason,
            "remedy": self.remedy,
        }


def _looks_like_userns_denial(stderr: str) -> bool:
    lowered = stderr.lower()
    return any(marker in lowered for marker in USERNS_MARKERS)


def _bwrap_version(binary: str, timeout: float) -> str | None:
    try:
        completed = subprocess.run(
            [binary, "--version"], capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return completed.stdout.strip() or None


def _denied(
    reason: str, remedy: str, binary: str | None = None, version: str | None = None
) -> BwrapProbe:
    return BwrapProbe(
        available=False, binary=binary, version=version, reason=reason, remedy=remedy
    )


def _run_probe(
    binary: str, timeout: float, version: str | None
) -> BwrapProbe | subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            [binary, *PROBE_ARGUMENTS],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        reason = f"The bubblewrap probe did not finish within {timeout:g}s."
        return _denied(reason, USERNS_REMEDY, binary, version)
    except OSError as exc:
        return _denied(f"The bubblewrap probe could not start: {exc}.", INSTALL_REMEDY, binary)


def probe_bwrap(
    binary: str = BWRAP_BINARY, *, timeout: float = PROBE_TIMEOUT_SECONDS
) -> BwrapProbe:
    """Run ``bwrap --ro-bind / / --unshare-net -- true`` and classify the outcome.

    Mirrors ``launcher.pidfd_supported``: it fails closed, and its failure is an
    actionable diagnosis naming the apt package or the AppArmor profile, never a
    reason to widen the confinement.
    """
    if sys.platform != "linux":
        return _denied(
            "Archon confines checks with bubblewrap, which is Linux-only.",
            "Run the kernel on Linux (WSL2 counts).",
        )
    resolved = shutil.which(binary)
    if resolved is None:
        return _denied(f"bubblewrap (`{binary}`) is not on PATH.", INSTALL_REMEDY)
    version = _bwrap_version(resolved, timeout)
    outcome = _run_probe(resolved, timeout, version)
    if isinstance(outcome, BwrapProbe):
        return outcome
    if outcome.returncode == 0:
        return BwrapProbe(available=True, binary=resolved, version=version)
    stderr = outcome.stderr.strip()
    return _denied(
        f"The bubblewrap probe exited {outcome.returncode}: {stderr or 'no stderr'}.",
        USERNS_REMEDY if _looks_like_userns_denial(stderr) else INSTALL_REMEDY,
        resolved,
        version,
    )


def prepare_scratch(scratch: Path, *, mode: int = SCRATCH_MODE) -> Path:
    """Create the private ``tmp/`` and ``home/`` the caches of `uv`, `npm`, `pip` need."""
    if not scratch.is_absolute():
        raise SandboxError("The scratch directory must be an absolute path.")
    scratch.mkdir(mode=mode, parents=True, exist_ok=True)
    for name in SCRATCH_DIRECTORIES:
        (scratch / name).mkdir(mode=mode, exist_ok=True)
    return scratch


def _contains(root: Path, candidate: Path) -> bool:
    return candidate == root or root in candidate.parents


def _require_real_directory(label: str, path: Path) -> None:
    if not path.is_absolute():
        raise SandboxError(f"The {label} must be an absolute path, got {path!r}.")
    if path.is_symlink():
        raise SandboxError(f"The {label} must not be a symlink: {path}.")
    if not path.is_dir():
        raise SandboxError(f"The {label} must be an existing directory: {path}.")
    if path.resolve() != path:
        raise SandboxError(
            f"The {label} must be given fully resolved (no symlinked parents): {path}."
        )


def _expand(home: Path, path: Path) -> Path:
    text = str(path)
    if text == "~":
        return home
    if text.startswith("~/"):
        return home / text[2:]
    if not path.is_absolute():
        raise SandboxError(f"A masked path must be absolute or start with '~/', got {path!r}.")
    return path


def _realpath(path: Path) -> Path:
    """Mask where the secret actually lives, not only where it is linked from."""
    return Path(os.path.realpath(path))


def default_runtime_dir(env: Mapping[str, str] | None = None) -> Path:
    """The per-session socket directory this host puts filesystem sockets in.

    Usually inside ``/run``, which is masked anyway, but a container or a
    hand-rolled session may point ``XDG_RUNTIME_DIR`` somewhere else entirely, and
    an unmasked one is a live IPC channel out of the confinement (SEC-H1).
    """
    source = os.environ if env is None else env
    declared = source.get("XDG_RUNTIME_DIR", "").strip()
    if declared.startswith("/"):
        return Path(declared)
    return Path(f"/run/user/{os.getuid()}")


#: Read once at import so a profile's shape does not drift mid-process.
DEFAULT_RUNTIME_DIR: Path = default_runtime_dir()


@dataclass(frozen=True)
class _Layout:
    """The absolute (or canonical placeholder) strings a render is built from."""

    worktree: str
    scratch: str
    state_dir: str
    mask_directories: tuple[str, ...]
    mask_files: tuple[str, ...]


@dataclass(frozen=True)
class CheckProfile:
    """The fixed confinement a repository check runs under.

    ``worktree`` is bound read-write by design: checks run in the active delivery
    worktree so a ``.venv``, ``node_modules`` or ``.uv-cache`` inside it works, and
    the caller hashes the source before and after.
    """

    worktree: Path
    scratch: Path
    state_dir: Path
    home: Path
    masked: tuple[Path, ...] = DEFAULT_MASKED
    runtime_dir: Path = DEFAULT_RUNTIME_DIR
    binary: str = BWRAP_BINARY

    def __post_init__(self) -> None:
        for label, path in (
            ("delivery worktree", self.worktree),
            ("scratch directory", self.scratch),
            ("state directory", self.state_dir),
            ("home directory", self.home),
        ):
            _require_real_directory(label, path)
        for name in SCRATCH_DIRECTORIES:
            if not (self.scratch / name).is_dir():
                raise SandboxError(
                    f"The scratch directory is missing {name}/; call prepare_scratch() first."
                )
        if _contains(self.worktree, self.scratch) or _contains(self.scratch, self.worktree):
            raise SandboxError("The worktree and the scratch directory must not nest.")
        for writable in (self.worktree, self.scratch):
            if _contains(writable, self.state_dir):
                raise SandboxError(
                    "Archon's state directory must not sit inside a writable bind."
                )
        if not self.runtime_dir.is_absolute():
            raise SandboxError(
                f"The runtime directory must be an absolute path, got {self.runtime_dir!r}."
            )
        self._reject_masks_inside_writable_binds()
        if not self.binary or "\0" in self.binary:
            raise SandboxError("The bubblewrap binary name must be a nonempty string.")

    def _reject_masks_inside_writable_binds(self) -> None:
        """Validate the path that gets mounted, not the one that was declared.

        SEC-L1: this ran on ``_expand()`` output while ``masked_paths()`` and
        ``_layout()`` mount ``_realpath()`` output, so a mask whose realpath landed
        inside a writable bind passed here and then made bwrap refuse the whole argv
        with ``Can't remount readonly on ...: Invalid argument``.  It failed closed,
        but the operator got bwrap's message instead of the actual problem.
        """
        for entry in (*self.masked, self.runtime_dir):
            declared = _expand(self.home, entry)
            target = _realpath(declared)
            for writable in (self.worktree, self.scratch):
                if _contains(writable, target):
                    through = "" if target == declared else f" (reached through {declared})"
                    raise SandboxError(
                        f"A masked path must not sit inside a writable bind: {target}{through}."
                    )

    @property
    def sandbox_home(self) -> Path:
        return self.scratch / SCRATCH_HOME

    @property
    def sandbox_tmp(self) -> Path:
        return self.scratch / SCRATCH_TMP

    def masked_paths(self) -> tuple[Path, ...]:
        """Every path this profile hides: the declared masks, the session runtime
        directory, and Archon's own state directory.  Realpaths, so a symlinked
        ``/var/run`` collapses onto ``/run`` instead of being mounted twice."""
        ordered: list[Path] = []
        for entry in (*self.masked, self.runtime_dir, self.state_dir):
            target = _realpath(_expand(self.home, entry))
            if target not in ordered:
                ordered.append(target)
        return tuple(ordered)

    def _layout(self) -> _Layout:
        directories: list[str] = []
        files: list[str] = []
        for target in self.masked_paths():
            if target.is_dir():
                directories.append(str(target))
            elif target.exists():
                files.append(str(target))
        directories.sort(key=lambda value: (value.count("/"), value))
        return _Layout(
            worktree=str(self.worktree),
            scratch=str(self.scratch),
            state_dir=str(self.state_dir),
            mask_directories=tuple(directories),
            mask_files=tuple(files),
        )

    def _canonical_layout(self) -> _Layout:
        masks = tuple(
            _canonical_mask(entry)
            for entry in (*self.masked, Path(CANONICAL_RUNTIME), Path(CANONICAL_STATE))
        )
        return _Layout(
            worktree=CANONICAL_WORKTREE,
            scratch=CANONICAL_SCRATCH,
            state_dir=CANONICAL_STATE,
            mask_directories=masks,
            mask_files=(),
        )

    def argv(
        self,
        command: Sequence[str],
        cwd: Path,
        env: Mapping[str, str] | None = None,
        *,
        probe: BwrapProbe | None = None,
    ) -> list[str]:
        return render_bwrap(self, command, cwd, env, probe=probe)

    def digest(self) -> str:
        """sha256 of the confinement *shape*, with the variable absolute paths removed.

        Two profiles over different worktrees share a digest; changing a flag, a
        declared mask, or the env allowlist changes it.  The per-host subset of
        masks that happen to exist does not: a path that is absent leaks nothing.
        Caller-supplied passthrough names are recorded in the invocation argv, not
        here — ``digest()`` identifies the profile, which is what the plan stores
        in ``CommandResult.sandbox_profile_digest``.
        """
        canonical = _render(
            binary=BWRAP_BINARY,
            layout=self._canonical_layout(),
            command=CANONICAL_COMMAND,
            cwd=CANONICAL_WORKTREE,
            env_pairs=tuple((name, CANONICAL_ENV_VALUE) for name in ENV_BASE_ALLOWLIST),
        )
        payload = "\0".join((DIGEST_VERSION, *canonical)).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()


def _canonical_mask(entry: Path) -> str:
    text = str(entry)
    if text == "~":
        return CANONICAL_HOME
    if text.startswith("~/"):
        return f"{CANONICAL_HOME}/{text[2:]}"
    return text


def _validate_command(command: Sequence[str]) -> tuple[str, ...]:
    if not command:
        raise SandboxError("A check command must have at least one argument.")
    if len(command) > MAX_COMMAND_ARGUMENTS:
        raise SandboxError(f"A check command may not exceed {MAX_COMMAND_ARGUMENTS} arguments.")
    for argument in command:
        if not isinstance(argument, str):
            raise SandboxError("Every check argument must be a string.")
        if "\0" in argument:
            raise SandboxError("A check argument may not contain a NUL byte.")
        if len(argument.encode("utf-8")) > MAX_ARGUMENT_BYTES:
            raise SandboxError(f"A check argument may not exceed {MAX_ARGUMENT_BYTES} bytes.")
    if not command[0].strip():
        raise SandboxError("A check command must name an executable.")
    return tuple(command)


def _resolve_cwd(profile: CheckProfile, cwd: Path) -> Path:
    candidate = cwd if cwd.is_absolute() else profile.worktree / cwd
    resolved = candidate.resolve()
    if not _contains(profile.worktree, resolved):
        raise SandboxError(
            f"A check working directory must stay inside the delivery worktree: {cwd}."
        )
    if not resolved.is_dir():
        raise SandboxError(f"A check working directory must exist: {resolved}.")
    return resolved


def _argument_candidates(command: Iterable[str], cwd: Path) -> list[Path]:
    candidates: list[Path] = []
    for argument in command:
        if not argument or argument.startswith("-"):
            continue
        candidate = Path(argument) if argument.startswith("/") else cwd / argument
        if os.path.lexists(candidate):
            candidates.append(candidate)
    return candidates


def _reject_escaping_symlinks(profile: CheckProfile, command: Sequence[str], cwd: Path) -> None:
    """A repository-controlled symlink may not name a path outside the bind set.

    Everything that is not the worktree or the scratch is bound read-only or
    masked, so a symlink that merely leaves the worktree — every ``.venv/bin/python``
    and every ``/bin/sh`` on a usrmerge host is one — is ordinary and must keep
    working.  What must not work is a symlink out of the writable bind set into
    the profile's blind spots: the masked home directories and Archon's own state.
    Those are rejected here rather than left to fail as ENOENT inside the mask, so
    the diagnosis names the laundering attempt.
    """
    writable = (profile.worktree, profile.scratch)
    masked = profile.masked_paths()
    for candidate in _argument_candidates(command, cwd):
        if not candidate.is_symlink():
            continue
        if not any(_contains(root, candidate) for root in writable):
            continue
        target = candidate.resolve()
        for secret in masked:
            if _contains(secret, target):
                raise SandboxError(
                    "A check argument is a symlink leaving the bind set for a masked path: "
                    f"{candidate} -> {target}."
                )


def _validate_env(env: Mapping[str, str] | None) -> tuple[tuple[str, str], ...]:
    if not env:
        return ()
    pairs: list[tuple[str, str]] = []
    for name in sorted(env):
        value = env[name]
        if not ENV_NAME_PATTERN.match(name):
            raise SandboxError(f"Environment name {name!r} is not a portable variable name.")
        if name in ENV_KERNEL_OWNED:
            raise SandboxError(
                f"{name} is kernel-owned; the profile points it at the private scratch."
            )
        if not isinstance(value, str) or "\0" in value:
            raise SandboxError(f"Environment value for {name} must be a NUL-free string.")
        if len(value.encode("utf-8")) > MAX_ENV_VALUE_BYTES:
            raise SandboxError(f"Environment value for {name} exceeds {MAX_ENV_VALUE_BYTES} bytes.")
        pairs.append((name, value))
    return tuple(pairs)


def _env_pairs(
    profile: CheckProfile, passthrough: tuple[tuple[str, str], ...], source: Mapping[str, str]
) -> tuple[tuple[str, str], ...]:
    supplied = {name for name, _ in passthrough}
    inherited = tuple(
        (name, source[name])
        for name in ENV_BASE_ALLOWLIST
        if name not in supplied and source.get(name) is not None
    )
    owned = (
        ("HOME", str(profile.sandbox_home)),
        ("TMPDIR", str(profile.sandbox_tmp)),
        ("TMP", str(profile.sandbox_tmp)),
        ("TEMP", str(profile.sandbox_tmp)),
    )
    return (*passthrough, *inherited, *owned)


def _render(
    *,
    binary: str,
    layout: _Layout,
    command: Sequence[str],
    cwd: str,
    env_pairs: Sequence[tuple[str, str]],
) -> list[str]:
    """Emit the argv in the one order that survives nesting.

    Masks are mounted before the writable binds so a scratch inside the state
    directory can still be created, and sealed read-only afterwards so the mask
    itself is not a writable tmpfs.
    """
    argv: list[str] = [binary, *NAMESPACE_FLAGS, *BASE_FILESYSTEM]
    for target in layout.mask_directories:
        argv += ["--tmpfs", target]
    for target in layout.mask_files:
        argv += ["--ro-bind", MASK_FILE_SOURCE, target]
    argv += ["--bind", layout.worktree, layout.worktree]
    argv += ["--bind", layout.scratch, layout.scratch]
    for target in reversed(layout.mask_directories):
        argv += ["--remount-ro", target]
    argv.append("--clearenv")
    for name, value in env_pairs:
        argv += ["--setenv", name, value]
    argv += ["--chdir", cwd, "--", *command]
    return argv


def render_bwrap(
    profile: CheckProfile,
    command: Sequence[str],
    cwd: Path,
    env: Mapping[str, str] | None = None,
    *,
    probe: BwrapProbe | None = None,
    source_env: Mapping[str, str] | None = None,
) -> list[str]:
    """Render the full ``bwrap`` argv for one check.

    ``env`` is the caller's declared passthrough allowlist; kernel-owned names are
    rejected rather than merged, and nothing else inherits past ``--clearenv``.
    ``probe`` may carry a probe the caller already ran for this dispatch; an
    unavailable probe raises whether it was supplied or taken here.
    """
    attested = probe if probe is not None else probe_bwrap(profile.binary)
    binary = attested.require()
    validated = _validate_command(command)
    target = _resolve_cwd(profile, cwd)
    _reject_escaping_symlinks(profile, validated, target)
    passthrough = _validate_env(env)
    return _render(
        binary=binary,
        layout=profile._layout(),
        command=validated,
        cwd=str(target),
        env_pairs=_env_pairs(
            profile, passthrough, os.environ if source_env is None else source_env
        ),
    )
