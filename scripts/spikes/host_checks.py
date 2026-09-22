"""Host one-liners folded into ``run_all.py`` per docs/spikes.md.

Writes ``docs/evidence/<date>-spike-host.json`` with: ``claude --version``,
``bwrap --version``, ``socat -V``, AppArmor status /
``/proc/sys/kernel/unprivileged_userns_clone``, pidfd availability as the
launcher itself measures it, and ``isolation: worktree`` base-branch behavior (companion
H3) via a subagent that prints ``git log -1`` in its worktree.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from . import common

SPIKE_ID = "host"

WORKTREE_AGENT_FRONTMATTER = """---
name: worktree-prober
description: Prints git log -1 and the current branch from inside its isolated worktree.
tools: Bash
isolation: worktree
model: haiku
---
Run `git log -1 --oneline` and `git branch --show-current` using the Bash tool (two
separate calls), then reply with exactly:

LOG: <the git log -1 --oneline output>
BRANCH: <the git branch --show-current output>
"""


def _run_version(args: list[str]) -> dict:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=15)
        return {"ok": proc.returncode == 0, "returncode": proc.returncode, "output": (proc.stdout or proc.stderr).strip()}
    except FileNotFoundError:
        return {"ok": False, "returncode": None, "output": "binary not found on PATH"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "returncode": None, "output": "timed out"}


def _sandbox_signals() -> dict:
    signals: dict = {}
    path = "/proc/sys/kernel/unprivileged_userns_clone"
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            signals["unprivileged_userns_clone"] = f.read().strip()
    else:
        signals["unprivileged_userns_clone"] = "path absent on this kernel"

    aa_enabled = shutil.which("aa-enabled")
    if aa_enabled:
        proc = subprocess.run([aa_enabled], capture_output=True, text=True, timeout=10)
        signals["apparmor_aa_enabled"] = {"returncode": proc.returncode, "output": (proc.stdout or proc.stderr).strip()}
    elif os.path.exists("/sys/module/apparmor/parameters/enabled"):
        with open("/sys/module/apparmor/parameters/enabled", encoding="utf-8") as f:
            signals["apparmor_module_parameter"] = f.read().strip()
    else:
        signals["apparmor"] = "no aa-enabled binary and no /sys/module/apparmor/parameters/enabled"
    return signals


def _pidfd_open_probe() -> dict:
    """Probe the capability the kernel actually uses, not just the stdlib alias.

    The first run of this book recorded ``available: false`` with the reason
    "os.pidfd_open not exposed by this Python build" under an overall PASS
    verdict. Read literally that says managed execution is impossible on the
    very host that produced a green suite, which is a contradiction a reader
    applying "UNRESOLVED restricts" would resolve the wrong way.

    The cause is that this probe tested only ``os.pidfd_open`` while
    ``archon.launcher`` carries a ctypes fallback and its own
    ``pidfd_supported()`` — which also confirms ``pidfd_send_signal`` works,
    since an fd you cannot signal through is useless to the supervisor. Both
    signals are now recorded, and the load-bearing one is the launcher's.
    """
    stdlib = hasattr(os, "pidfd_open")
    probe: dict = {"stdlib_os_pidfd_open_exposed": stdlib}
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
        from archon.launcher import pidfd_supported
    except Exception as exc:  # noqa: BLE001
        probe["available"] = False
        probe["reason"] = f"archon.launcher could not be imported: {type(exc).__name__}: {exc}"
        return probe

    supported = pidfd_supported()
    probe["available"] = supported
    probe["functional"] = supported
    probe["source"] = "archon.launcher.pidfd_supported (pidfd_open + pidfd_send_signal(0))"
    if not supported:
        probe["reason"] = "the kernel or runtime refused pidfd_open/pidfd_send_signal"
    return probe


def _status_fd_probe() -> dict:
    """Record how ``bwrap --json-status-fd`` separates a confinement fault.

    The adapter used to decide "runtime fault, not a check outcome" by testing
    whether the first stderr line began ``bwrap:``. The child's stderr and
    bwrap's own are the same stream and the exit code does not separate them,
    so a failing test suite that printed that prefix had its own failure
    reclassified — the repository deciding how its evidence is filed, which is
    what the iron rule exists to prevent.

    The status pipe is the discriminator, and this records the fact rather
    than leaving it to a unit test: bwrap emits an ``exit-code`` document
    **only** when the sandbox was established and the child actually ran. No
    ``exit-code`` means the fault was confinement's, whatever stderr says.

    Free, local, and no model call.
    """
    if not shutil.which("bwrap"):
        return {"available": False, "reason": "bwrap not on PATH"}

    def arm(argv: list[str]) -> dict:
        read_fd, write_fd = os.pipe()
        try:
            proc = subprocess.run(
                ["bwrap", "--json-status-fd", str(write_fd), *argv],
                capture_output=True,
                text=True,
                timeout=30,
                pass_fds=(write_fd,),
            )
            os.close(write_fd)
            write_fd = -1
            with os.fdopen(read_fd, encoding="utf-8") as stream:
                documents = [json.loads(line) for line in stream if line.strip()]
            read_fd = -1
        except Exception as exc:  # noqa: BLE001
            return {"error": f"{type(exc).__name__}: {exc}"}
        finally:
            for fd in (read_fd, write_fd):
                if fd >= 0:
                    os.close(fd)
        return {
            "returncode": proc.returncode,
            "documents": documents,
            "exit_code_reported": next(
                (d["exit-code"] for d in documents if "exit-code" in d), None
            ),
            "stderr_tail": proc.stderr.strip()[-200:],
        }

    base = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-all"]
    clean = arm([*base, "--", "/bin/sh", "-c", "echo 'bwrap: forged diagnostic' >&2; exit 3"])
    setup = arm([*base, "--bind", "/nonexistent-archon-probe", "/mnt", "--", "/bin/true"])
    execfail = arm([*base, "--", "/nonexistent/archon-check"])

    return {
        "available": True,
        "clean_run_child_exit_3_forging_the_prefix": clean,
        "bind_setup_failure": setup,
        "exec_failure": execfail,
        "discriminator_holds": (
            clean.get("exit_code_reported") == 3
            and setup.get("exit_code_reported") is None
            and execfail.get("exit_code_reported") is None
        ),
    }


def _worktree_base_branch_probe(ctx: common.SpikeContext) -> dict:
    if not ctx.allow_live:
        return {"skipped": True, "reason": "not authorized: --allow-live not passed"}
    if not ctx.has_headroom(0.20):
        return {"skipped": True, "reason": "budget exceeded: insufficient remaining --budget-usd headroom"}

    repo = ctx.new_temp_dir("host-worktree-repo")
    common.init_git_repo(repo)

    (repo / "README.md").write_text("main content\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=str(repo), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "main: initial commit"], cwd=str(repo), check=True)
    main_branch = subprocess.run(
        ["git", "branch", "--show-current"], cwd=str(repo), capture_output=True, text=True, check=True
    ).stdout.strip()
    main_log = subprocess.run(
        ["git", "log", "-1", "--oneline"], cwd=str(repo), capture_output=True, text=True, check=True
    ).stdout.strip()

    subprocess.run(["git", "checkout", "-q", "-b", "feature-branch"], cwd=str(repo), check=True)
    (repo / "README.md").write_text("feature content, distinct from main\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=str(repo), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "feature: distinguishing commit"], cwd=str(repo), check=True)
    feature_log = subprocess.run(
        ["git", "log", "-1", "--oneline"], cwd=str(repo), capture_output=True, text=True, check=True
    ).stdout.strip()

    agents_dir = repo / ".claude" / "agents"
    agents_dir.mkdir(parents=True, exist_ok=True)
    (agents_dir / "worktree-prober.md").write_text(WORKTREE_AGENT_FRONTMATTER, encoding="utf-8")

    args = [
        "-p",
        "Use the worktree-prober subagent (Agent tool) to run its task, then report back its "
        "exact LOG and BRANCH lines verbatim, unmodified.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
    ]
    result = common.run_claude(args, cwd=repo, timeout=90)
    cost = common.extract_cost(result)
    ctx.record_spend(cost)

    res_ev = common.result_event(result)
    agent_calls = common.executed_tool_calls(result, tool_name="Agent") or common.executed_tool_calls(
        result, tool_name="Task"
    )
    output_text = (res_ev or {}).get("result", "") or ""

    return {
        "skipped": False,
        "cost_usd": cost,
        "repo_current_branch_at_spawn_time": "feature-branch",
        "main_branch_name": main_branch,
        "main_branch_log": main_log,
        "feature_branch_log": feature_log,
        "subagent_tool_calls_observed": len(agent_calls),
        "manager_result_text": output_text[:1500],
        "manager_result_subtype": (res_ev or {}).get("subtype"),
        "worktree_appears_based_on_main_not_head": (
            main_log.split()[0] in output_text if main_log else None
        ),
        "worktree_appears_based_on_feature_head": (
            feature_log.split()[0] in output_text if feature_log else None
        ),
    }


def run(ctx: common.SpikeContext) -> common.EvidenceRecord:
    claude_version = _run_version([common.CLAUDE_BIN, "--version"])
    bwrap_version = _run_version(["bwrap", "--version"])
    socat_version = _run_version(["socat", "-V"])
    sandbox_signals = _sandbox_signals()
    pidfd = _pidfd_open_probe()
    status_fd = _status_fd_probe()
    worktree = _worktree_base_branch_probe(ctx)

    observations = {
        "claude_version": claude_version,
        "bwrap_version": bwrap_version,
        "socat_version": socat_version,
        "sandbox_kernel_signals": sandbox_signals,
        "pidfd_open": pidfd,
        "bwrap_json_status_fd": status_fd,
        "isolation_worktree_base_branch_probe": worktree,
    }

    core_tools_present = claude_version["ok"] and bwrap_version["ok"] and socat_version["ok"]
    # The status-pipe discriminator is load-bearing: without it a check that
    # prints `bwrap:` on stderr has its own failure recorded as a confinement
    # fault, letting the repository classify its own evidence.
    discriminator_ok = status_fd.get("available") is False or bool(status_fd.get("discriminator_holds"))
    verdict = "PASS" if (core_tools_present and discriminator_ok) else "FAIL"
    if worktree.get("skipped"):
        # Core one-liners can still PASS/FAIL on their own; the worktree
        # probe being skipped for lack of authorization doesn't invalidate
        # them, but is called out honestly rather than silently dropped.
        observations["worktree_probe_note"] = "worktree base-branch probe not executed: " + str(
            worktree.get("reason")
        )

    return common.EvidenceRecord(
        id=SPIKE_ID,
        date=ctx.date,
        engine_version=ctx.engine_version,
        verdict=verdict,
        literal_form=(
            "claude --version ; bwrap --version ; socat -V ; "
            "/proc/sys/kernel/unprivileged_userns_clone or aa-enabled ; archon.launcher.pidfd_supported() ; "
            "bwrap --json-status-fd N (clean / bind-setup-failure / exec-failure arms) ; "
            "claude -p '<spawn worktree-prober subagent>' (isolation: worktree agent, base-branch check)"
        ),
        observations=observations,
        cost_usd=worktree.get("cost_usd", 0.0) if isinstance(worktree, dict) else 0.0,
    )
