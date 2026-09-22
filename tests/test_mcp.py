"""MCP protocol and lifecycle tests; fake dispatch is labeled and never live proof."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def _environment() -> dict[str, str]:
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
    return environment


def consumer_repo(
    tmp_path: Path, git_init: Callable[[Path], None], environment: dict[str, str]
) -> Path:
    """Build the consuming repository through the shared isolated Git fixtures.

    A bare ``git init`` inherits the developer's ``~/.gitconfig``, including an
    init template and a global ``core.hooksPath`` that would run their own hooks
    inside a fixture.
    """
    repo = tmp_path / "consumer"
    repo.mkdir()
    git_init(repo)
    subprocess.run(
        ["git", "-C", str(repo), "-c", f"core.hooksPath={os.devnull}",
         "commit", "--allow-empty", "-qm", "baseline"],
        env=environment, check=True, capture_output=True,
    )
    return repo


def _data(result) -> dict:
    content = result.structured_content
    if content is not None:
        return content
    return json.loads(result.content[0].text)


def test_actual_stdio_initialize_schema_and_kernel_calls(
    tmp_path: Path, git_init: Callable[[Path], None], git_environment: dict[str, str]
) -> None:
    repo = consumer_repo(tmp_path, git_init, git_environment)

    async def exercise() -> None:
        parameters = StdioServerParameters(
            command=sys.executable,
            args=["-m", "archon", "--repo", str(repo), "--state-home", str(tmp_path / "state"), "mcp"],
            env=_environment(),
        )
        async with stdio_client(parameters) as streams:
            async with ClientSession(*streams, read_timeout_seconds=10) as client:
                initialized = await client.initialize()
                assert initialized.server_info.name == "Archon"
                listing = await client.list_tools()
                tools = {tool.name: tool for tool in listing.tools}
                assert {"run_start", "plan", "task_update", "checkpoint", "status", "next", "verify",
                        "verification_status", "wait", "resume", "recover", "cancel"} == set(tools)
                # Status may revoke stale evidence or persist a newly observed
                # gate, so its annotation declares the small internal mutation.
                assert tools["status"].annotations.read_only_hint is False
                assert tools["run_start"].annotations.read_only_hint is False
                assert tools["verify"].annotations.open_world_hint is True
                assert tools["recover"].annotations.open_world_hint is True
                invalid_recovery = await client.call_tool("recover", {
                    "job_id": "missing", "attempt": 0, "candidate_digest": "not-a-digest",
                    "checks_digest": "0" * 64, "observations": "Inspected effects",
                })
                assert invalid_recovery.is_error
                assert "verified" not in json.dumps(tools["task_update"].input_schema)
                schema = tools["run_start"].input_schema
                assert "AcceptanceCriterion" in schema["$defs"]
                assert schema["$defs"]["AcceptanceCriterion"]["additionalProperties"] is False
                empty = await client.call_tool("status", {})
                assert not empty.is_error
                assert isinstance(_data(empty), dict)
                started = await client.call_tool("run_start", {
                    "goal": "Implement a greeting", "acceptance": [
                        {"acceptance_id": "AC-1", "description": "A greeting is available"}],
                    "tasks": [{"task_id": "greeting", "title": "Greeting", "owner_role": "implementer",
                               "acceptance": ["AC-1"], "allowed_paths": ["hello.py"]}],
                })
                assert not started.is_error, started
                status = _data(await client.call_tool("status", {}))
                assert status["run"]["spec"]["goal"] == "Implement a greeting"
                assert status["tasks"][0]["task_id"] == "greeting"
                rejected = await client.call_tool("task_update", {
                    "task_id": "greeting", "state": "verified"})
                assert rejected.is_error
                traversal = await client.call_tool("plan", {"tasks": [{
                    "task_id": "escape", "title": "Escape", "acceptance": ["AC-1"],
                    "allowed_paths": ["../outside.py"]}]})
                assert traversal.is_error

    asyncio.run(exercise())


def test_stdio_lifespan_preserves_background_job_and_closes_it(tmp_path: Path) -> None:
    """Synthetic timer proves MCP task lifetime only, not actual check/review execution."""
    marker = tmp_path / "closed"
    script = tmp_path / "synthetic_mcp.py"
    script.write_text(
        """import asyncio
from pathlib import Path
from types import SimpleNamespace
from archon.mcp_server import create_server

TERMINAL = {'succeeded', 'failed', 'cancelled', 'interrupted'}

# Stands in for the kernel: only job lifetime and wait plumbing are under test.
class SyntheticService:
    def __init__(self):
        self.job = {'job_id': 'job_demo', 'state': 'queued'}
        self.paused = {'job_id': 'job_parked', 'state': 'paused', 'resume_at': 1800000000}
        self.task = None
    async def verify(self, run_id=None):
        async def work():
            self.job['state'] = 'running'
            await asyncio.sleep(0.3)
            self.job['state'] = 'succeeded'
        self.task = asyncio.create_task(work())
        return dict(self.job)
    def _record(self, job_id):
        return self.paused if job_id == 'job_parked' else self.job
    def verification_status(self, job_id):
        return dict(self._record(job_id))
    async def wait(self, job_id, timeout_seconds=30):
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds
        record = self._record(job_id)
        while record['state'] not in TERMINAL and loop.time() < deadline:
            await asyncio.sleep(0.05)
        action = 'wait' if record['state'] == 'paused' else 'report'
        return {'job_id': job_id, 'run_id': 'run_demo', 'state': record['state'],
                'next_action': {'action': action, 'inputs': {k: v for k, v in record.items()
                                                             if k in ('job_id', 'resume_at')}}}
    def status(self, run_id=None):
        return {'alive': True}

class SyntheticRuntime:
    def __init__(self):
        self.service = SyntheticService()
    async def close(self):
        if self.service.task is not None and not self.service.task.done():
            self.service.task.cancel()
            await asyncio.gather(self.service.task, return_exceptions=True)
        Path(MARKER).write_text('closed')

create_server('.', runtime_factory=lambda *args: SyntheticRuntime()).run()
""".replace("MARKER", repr(str(marker)))
    )

    async def exercise() -> None:
        parameters = StdioServerParameters(command=sys.executable, args=[str(script)], env=_environment())
        async with stdio_client(parameters) as streams:
            async with ClientSession(*streams, read_timeout_seconds=10) as client:
                await client.initialize()
                started = _data(await client.call_tool("verify", {}))
                assert started["state"] == "queued"
                immediate = _data(await client.call_tool("wait", {"job_id": "job_demo", "timeout_seconds": 0}))
                assert immediate["state"] == "running"
                # A second unrelated request while verification runs proves the
                # first request is no longer holding up the tool interface.
                status = _data(await client.call_tool("status", {}))
                assert status["alive"]
                completed = _data(await client.call_tool("wait", {"job_id": "job_demo", "timeout_seconds": 2}))
                assert completed["state"] == "succeeded"
                # A job parked on a provider usage window is not terminal: the tool
                # returns the pause and the deterministic action, never an error.
                parked = _data(await client.call_tool("wait", {"job_id": "job_parked", "timeout_seconds": 0}))
                assert parked["state"] == "paused"
                assert parked["next_action"]["action"] == "wait"
                assert parked["next_action"]["inputs"]["resume_at"] == 1800000000
                rejected = await client.call_tool("wait", {"job_id": "job_demo", "timeout_seconds": 61})
                assert rejected.is_error
    asyncio.run(exercise())
    assert marker.read_text() == "closed"


def test_the_runtime_gives_the_adapter_a_receipt_root_inside_the_workspace_state(
    tmp_path: Path, git_init: Callable[[Path], None], git_environment: dict[str, str]
) -> None:
    """SEC-H2: the adapter masks its receipt root's *parent* for checks.

    That is only the workspace state root — the directory holding ``state.sqlite3``
    and ``snapshots/`` — while the runtime composes the receipt root as
    ``<state_dir>/supervisors``.  The two live in different packages, so the
    relationship the mask depends on is asserted here rather than assumed.
    """
    from archon.mcp_server import open_runtime

    repo = consumer_repo(tmp_path, git_init, git_environment)
    runtime = open_runtime(repo, tmp_path / "state")
    try:
        state_dir = Path(runtime.workspace.state_dir).resolve()

        assert runtime.adapter._receipt_root.resolve().parent == state_dir
        assert runtime.adapter._state_root() == state_dir
        assert runtime.store.path.parent == state_dir
        assert (state_dir / "supervisors") == runtime.adapter._receipt_root
    finally:
        asyncio.run(runtime.close())
