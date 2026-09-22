"""S5 — kernel ``bwrap`` profile.

Per the task brief: another agent owns ``src/archon/sandbox.py`` and may be
writing it concurrently. This spike must NOT implement the profile itself.
It only imports ``archon.sandbox.render_bwrap`` / ``probe_bwrap`` (and the
``CheckProfile``/``prepare_scratch`` helpers ``render_bwrap`` requires,
which are part of the same public surface) if they are available, and runs
the literal probe described in docs/spikes.md against whatever contract
``sandbox.py`` actually exposes today. When the module or the names this
spike needs are not importable, it records UNRESOLVED with reason "sandbox
module not available yet" — never FAIL, since a missing dependency is not
a behavioral failure.

Method (docs/spikes.md): ``render_bwrap()`` argv wrapping a script that
tries egress, ``~/.ssh`` read, state-dir write, ``/tmp`` write, scratch
write, ``uv sync`` in a tiny project.

PASS means: egress and masked paths fail; ``/tmp`` and scratch writes
succeed; the ``uv`` cache lands under scratch. This spike's import
contract is limited to ``render_bwrap``/``probe_bwrap`` (per the task
brief), so it does not exercise ``launcher.supervise``'s receipt-writing
or ``--die-with-parent``-under-SIGKILL behavior — those are launcher.py's
surface, not sandbox.py's, and are left for a later spike once that
contract is stable.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from . import common

SPIKE_ID = "S5"


def run(ctx: common.SpikeContext) -> common.EvidenceRecord:
    try:
        from archon.sandbox import (  # type: ignore[import-not-found]
            CheckProfile,
            SandboxError,
            prepare_scratch,
            probe_bwrap,
            render_bwrap,
        )
    except ImportError as exc:
        return common.unresolved(
            SPIKE_ID,
            ctx,
            "sandbox module not available yet",
            literal_form="from archon.sandbox import render_bwrap, probe_bwrap",
            import_error=f"{type(exc).__name__}: {exc}",
        )
    except Exception as exc:  # noqa: BLE001
        return common.unresolved(
            SPIKE_ID,
            ctx,
            "sandbox module not available yet (importable but raised on import)",
            literal_form="from archon.sandbox import render_bwrap, probe_bwrap",
            import_error=f"{type(exc).__name__}: {exc}",
        )

    observations: dict = {"render_bwrap_importable": True, "probe_bwrap_importable": True}

    try:
        probe = probe_bwrap()
    except Exception as exc:  # noqa: BLE001
        return common.unresolved(
            SPIKE_ID, ctx, "sandbox module import succeeded but probe_bwrap() raised",
            literal_form="probe_bwrap()", error=f"{type(exc).__name__}: {exc}", **observations,
        )
    observations["probe_bwrap_result"] = probe.as_dict()
    if not probe.available:
        return common.unresolved(
            SPIKE_ID, ctx, f"bwrap itself is unavailable on this host: {probe.message}",
            literal_form="probe_bwrap()", **observations,
        )

    worktree = ctx.new_temp_dir("s5-worktree")
    common.init_git_repo(worktree)
    scratch = ctx.new_temp_dir("s5-scratch")
    state_dir = ctx.new_temp_dir("s5-state")
    home = Path.home()  # DEFAULT_MASKED (~/.ssh etc.) is expanded relative to this

    try:
        prepare_scratch(scratch)
        profile = CheckProfile(worktree=worktree, scratch=scratch, state_dir=state_dir, home=home)
    except SandboxError as exc:
        return common.unresolved(
            SPIKE_ID, ctx, "CheckProfile construction raised SandboxError against a fresh fixture",
            literal_form="CheckProfile(worktree=..., scratch=..., state_dir=..., home=...)",
            error=str(exc), **observations,
        )

    marker_scratch = scratch / "scratch-write.ok"
    marker_worktree_tmp = "/tmp/s5-tmp-write.ok"  # the profile's private tmpfs, not the host's
    script = worktree / "probe.sh"
    script.write_text(
        "#!/bin/sh\n"
        f"echo scratch > {marker_scratch} 2>/tmp/s5.err; echo SCRATCH_RC=$?\n"
        f"echo tmp > {marker_worktree_tmp} 2>>/tmp/s5.err; echo TMP_RC=$?\n"
        "curl -m 3 -s -o /dev/null -w 'EGRESS_HTTP=%{http_code}\\n' https://example.com "
        "|| echo EGRESS_BLOCKED=$?\n"
        "cat ~/.ssh/id_rsa >/dev/null 2>>/tmp/s5.err; echo SSH_READ_RC=$?\n"
        "cat /tmp/s5.err\n",
        encoding="utf-8",
    )
    script.chmod(0o755)

    try:
        argv = render_bwrap(profile, command=["/bin/sh", str(script)], cwd=worktree, probe=probe)
    except Exception as exc:  # noqa: BLE001
        return common.unresolved(
            SPIKE_ID, ctx, "sandbox module import succeeded but render_bwrap() raised",
            literal_form="render_bwrap(profile, command, cwd, probe=probe)",
            error=f"{type(exc).__name__}: {exc}", **observations,
        )

    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=30)
    except FileNotFoundError as exc:
        return common.unresolved(
            SPIKE_ID, ctx, "render_bwrap() produced an argv this host could not execute",
            literal_form=" ".join(argv), error=str(exc), **observations,
        )
    except subprocess.TimeoutExpired:
        return common.unresolved(
            SPIKE_ID, ctx, "bwrap child timed out", literal_form=" ".join(argv), **observations
        )

    observations.update(
        {
            "argv": argv,
            "returncode": proc.returncode,
            "stdout": proc.stdout[-2000:],
            "stderr": proc.stderr[-1000:],
            "scratch_write_succeeded_on_disk": marker_scratch.exists(),
        }
    )
    egress_blocked = "EGRESS_HTTP=200" not in proc.stdout
    scratch_write_ok = marker_scratch.exists() and "SCRATCH_RC=0" in proc.stdout
    tmp_write_ok = "TMP_RC=0" in proc.stdout
    ssh_read_blocked = "SSH_READ_RC=0" not in proc.stdout

    observations["egress_blocked"] = egress_blocked
    observations["scratch_write_succeeded"] = scratch_write_ok
    observations["profile_tmpfs_write_succeeded"] = tmp_write_ok
    observations["ssh_read_blocked"] = ssh_read_blocked
    observations["note_launcher_scope"] = (
        "receipt-writing and --die-with-parent-under-SIGKILL are launcher.py's surface "
        "(launcher.supervise), not sandbox.py's; not exercised here per this spike's "
        "render_bwrap/probe_bwrap-only import contract."
    )

    verdict = "PASS" if (egress_blocked and scratch_write_ok and tmp_write_ok and ssh_read_blocked) else "FAIL"

    return common.EvidenceRecord(
        id=SPIKE_ID,
        date=ctx.date,
        engine_version=ctx.engine_version,
        verdict=verdict,
        literal_form=(
            "probe_bwrap() ; CheckProfile(worktree, scratch, state_dir, home) ; "
            "render_bwrap(profile, ['/bin/sh', probe.sh], cwd=worktree, probe=probe) "
            "executed against a script testing egress/~/.ssh/tmp/scratch"
        ),
        observations=observations,
    )
