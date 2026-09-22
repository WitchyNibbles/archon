"""Fault tests use a simulated adapter; live provider proof is separate."""

from __future__ import annotations

import asyncio
import hashlib
import json
import stat
import time
import uuid
from pathlib import Path
from typing import Any

import pytest

from archon.claude_adapter import AdapterError
from archon.models import Candidate, CommandResult, RateLimited, RunSpec
from archon.store import Store
from archon.verification import ROLES, VerificationError, VerificationRunner


class FixtureWorkspace:
    def __init__(self, tmp_path: Path):
        self.root = tmp_path / "repo"
        self.root.mkdir()
        (self.root / "app.py").write_text("value = 1\n")
        self.state_dir = tmp_path / "private"
        self.state_dir.mkdir(mode=0o700)

    def fingerprint(self, checks=(), policy=None, *, base_revision=None, plan=None):
        return Candidate(
            repo_id="repo", repo_root=str(self.root), worktree_id="worktree", branch="archon/work",
            base_revision=base_revision or "base", head_revision="head",
            candidate_digest=hashlib.sha256((self.root / "app.py").read_bytes()).hexdigest(),
            checks_digest=hashlib.sha256(json.dumps([checks, policy, plan], sort_keys=True).encode()).hexdigest(),
        )

    def snapshot(self, *args, **kwargs):
        candidate = self.fingerprint(*args, **kwargs)
        snapshot = self.state_dir / f"snapshot-{uuid.uuid4().hex}"
        snapshot.mkdir(mode=0o700)
        (snapshot / "app.py").write_bytes((self.root / "app.py").read_bytes())
        return candidate.model_copy(update={"snapshot_path": str(snapshot)})

    def verify_snapshot(self, candidate):
        observed = hashlib.sha256((Path(candidate.snapshot_path) / "app.py").read_bytes()).hexdigest()
        if observed != candidate.candidate_digest:
            raise RuntimeError("Frozen snapshot was modified.")

    def snapshot_context(self, candidate):
        return {"relocated_paths": {}, "note": "Simulated fixture snapshot."}


class SimulatedAdapter:
    def __init__(self):
        self.commands = []
        self.reviews = []
        self.cancelled = []
        self.stopped = set()
        self.provider_identity = None
        self.recovery_allowed = False
        self.recovered_identities = []
        self.before_dispatch_failure = False
        self.exit_code = 0
        self.reject_roles = set()
        self.malformed = None
        self.mutate_source = False
        self.mutate_snapshot = False
        self.output = "fixture check passed\n"
        self.shared_thread = False
        self.wrong_invocation = False
        self.command_started = asyncio.Event()
        self.release_command = None
        # Provider faults that are pauses or bounded diagnostics, never verdicts.
        self.rate_limit_checks: int | None = None
        self.rate_limit_roles: dict[str, int] = {}
        self.null_structured_output = False
        self.cost_usd = 0.42

    async def run_command(self, spec, candidate, policy, on_event=None, *, invocation_id=None):
        self.commands.append(invocation_id)
        self.command_started.set()
        if self.rate_limit_checks is not None:
            raise RateLimited(self.rate_limit_checks, window="five_hour", detail="simulated check window")
        if self.before_dispatch_failure:
            raise RuntimeError("Simulated provider startup failure before command dispatch.")
        if on_event:
            if self.provider_identity is not None:
                await on_event({"kind": "provider_process", "invocation_id": invocation_id, "process_identity": self.provider_identity})
            await on_event({"kind": "dispatch", "invocation_id": invocation_id, "process_id": invocation_id})
            await on_event({"kind": "output", "invocation_id": invocation_id, "stream": "stdout", "text": "started\n"})
        if self.release_command is not None:
            await self.release_command.wait()
        if self.mutate_source:
            (Path(candidate.repo_root) / "app.py").write_text("value = 999\n")
        self.stopped.add(invocation_id)
        return CommandResult(
            invocation_id="wrong" if self.wrong_invocation else invocation_id,
            argv=spec.argv, cwd=str((Path(candidate.repo_root) / spec.cwd).resolve()),
            exit_code=self.exit_code, stdout=self.output,
        )

    async def run_review(self, role, candidate, packet, policy, on_event=None, *, invocation_id=None):
        self.reviews.append((role, invocation_id, candidate.candidate_digest))
        session_id = "shared" if self.shared_thread else f"thread-{invocation_id}"
        if on_event:
            await on_event({
                "kind": "provider_turn", "invocation_id": invocation_id, "session_id": session_id,
                "model": "opus", "cost_usd": self.cost_usd, "transcript": "reviewer prose and secrets",
            })
        window = self.rate_limit_roles.get(role)
        if window is not None:
            raise RateLimited(window, window="seven_day", detail="simulated review window")
        if self.null_structured_output:
            raise AdapterError("no structured output")
        payload = {
            "decision": "request_changes" if role in self.reject_roles else "approve",
            "summary": "Simulated fixture review.",
            "acceptance_ids": packet["acceptance_ids"],
            "evidence_refs": [packet["candidate_reference"]],
            "findings": [
                {"severity": "high", "summary": "Repair fixture implementation.", "path": "app.py", "line": 1}
            ] if role in self.reject_roles else [],
        }
        if self.malformed == "missing_acceptance":
            payload["acceptance_ids"] = []
        elif self.malformed == "unknown_evidence":
            payload["evidence_refs"] = ["owner-authored-receipt"]
        elif self.malformed == "escape":
            payload["findings"] = [{"severity": "high", "summary": "Escape.", "path": "../secret"}]
        elif self.malformed == "unknown_decision":
            payload["decision"] = "passed"
        if self.mutate_snapshot:
            (Path(candidate.snapshot_path) / "app.py").write_text("snapshot corruption\n")
        self.stopped.add(invocation_id)
        return {
            "invocation_id": invocation_id, "role": role,
            "candidate_digest": candidate.candidate_digest, "checks_digest": candidate.checks_digest,
            "session_id": session_id, "result_uuid": f"turn-{invocation_id}",
            "cost_usd": self.cost_usd, "payload": payload,
        }

    async def cancel(self, invocation_id):
        self.cancelled.append(invocation_id)
        self.stopped.add(invocation_id)

    def termination_confirmed(self, invocation_id):
        return invocation_id in self.stopped

    async def recover_termination(self, identity):
        self.recovered_identities.append(identity)
        return self.recovery_allowed


@pytest.fixture
def setup(tmp_path):
    workspace = FixtureWorkspace(tmp_path)
    store = Store(workspace.state_dir)
    spec = RunSpec.model_validate({
        "run_id": "run", "repo_id": "repo", "repo_root": str(workspace.root), "worktree_id": "worktree",
        "goal": "Implement and verify the fixture.", "branch": "archon/work", "base_revision": "base",
        "acceptance": [{"acceptance_id": "AC-1", "description": "The fixture behaves correctly."}],
        "tasks": [{"task_id": "implement", "title": "Implement fixture", "acceptance": ["AC-1"], "allowed_paths": ["app.py"]}],
        "checks": [{"name": "test", "argv": ["python", "app.py"], "acceptance_ids": ["AC-1"]}],
    })
    store.create_run(spec, spec.tasks)
    store.update_task("run", "implement", "implementing")
    store.update_task("run", "implement", "verifying", summary="Fixture implementation completed.")
    adapter = SimulatedAdapter()
    runner = VerificationRunner(workspace, store, adapter)
    yield workspace, store, adapter, runner
    store.close()


def test_rejected_candidate_repairs_and_obtains_fresh_independent_trio(setup):
    workspace, store, adapter, runner = setup

    async def scenario():
        adapter.reject_roles.add("security_reviewer")
        first = await runner.start("run")
        assert (await runner.wait(first["job_id"]))["state"] == "failed"
        assert not runner.evaluate_gate("run", runner.current_candidate("run")).verified
        assert len(adapter.reviews) == 3
        assert any(item["payload"]["payload"]["decision"] == "request_changes" for item in store.list_reviews("run"))
        # The native manager repairs real source, then requests fresh verification.
        (workspace.root / "app.py").write_text("value = 2\n")
        adapter.reject_roles.clear()
        second = await runner.start("run")
        assert first["job_id"] != second["job_id"]
        assert (await runner.wait(second["job_id"]))["state"] == "succeeded"
        current = runner.current_candidate("run")
        gate = runner.evaluate_gate("run", current)
        assert gate.verified
        assert len(gate.evidence_ids) == 4
        assert len(adapter.commands) == 2
        assert {role for role, _, digest in adapter.reviews if digest == current.candidate_digest} == set(ROLES)
        assert len({inv for _, inv, _ in adapter.reviews}) == 6
        assert store._finalize_gate("run", gate)["state"] == "verified"
        await runner.close()

    asyncio.run(scenario())


def test_failed_check_never_launches_review_or_passes(setup):
    _, store, adapter, runner = setup

    async def scenario():
        adapter.exit_code = 1
        job = await runner.start("run")
        terminal = await runner.wait(job["job_id"])
        assert terminal["state"] == "failed"
        assert not adapter.reviews
        assert not runner.evaluate_gate("run", runner.current_candidate("run")).verified
        records = store.list_evidence("run")
        assert len(records) == 1 and not records[0]["payload"]["succeeded"]
        artifact = records[0]["payload"]["artifacts"][0]
        assert Path(artifact["path"]).read_text() == adapter.output
        assert stat.S_IMODE(Path(artifact["path"]).stat().st_mode) == 0o600
        await runner.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("malformed", ["missing_acceptance", "unknown_evidence", "escape", "unknown_decision"])
def test_malformed_reviews_retry_with_bounds_and_do_not_pass(setup, malformed):
    _, store, adapter, runner = setup

    async def scenario():
        adapter.malformed = malformed
        job = await runner.start("run")
        assert (await runner.wait(job["job_id"]))["state"] == "failed"
        assert len(adapter.reviews) == 6
        assert not store.list_reviews("run")
        assert not runner.evaluate_gate("run", runner.current_candidate("run")).verified
        failed = [job for job in store.list_jobs("run") if job["kind"] == "review" and job["payload"]["retry"] == 1]
        assert all(item["error"]["exhausted"] for item in failed)
        assert all("Native manager" in item["error"]["next_action"] for item in failed)
        await runner.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("mutation", ["mutate_source", "mutate_snapshot"])
def test_mutation_during_checks_or_reviews_invalidates_candidate(setup, mutation):
    _, _, adapter, runner = setup

    async def scenario():
        setattr(adapter, mutation, True)
        job = await runner.start("run")
        assert (await runner.wait(job["job_id"]))["state"] == "failed"
        assert not runner.evaluate_gate("run", runner.current_candidate("run")).verified
        await runner.close()

    asyncio.run(scenario())


def test_duplicate_requests_share_one_owned_job(setup):
    _, _, adapter, runner = setup

    async def scenario():
        adapter.release_command = asyncio.Event()
        first = await runner.start("run")
        await adapter.command_started.wait()
        second = await runner.start("run")
        assert first["job_id"] == second["job_id"]
        adapter.release_command.set()
        await runner.wait(first["job_id"])
        third = await runner.start("run")
        assert third["job_id"] == first["job_id"]
        assert len(adapter.commands) == 1
        assert len(adapter.reviews) == 3
        await runner.close()

    asyncio.run(scenario())


def test_close_interrupts_command_and_retains_diagnostic_artifacts(setup):
    _, store, adapter, runner = setup

    async def scenario():
        adapter.release_command = asyncio.Event()
        job = await runner.start("run")
        await adapter.command_started.wait()
        await runner.close()
        assert store.get_job(job["job_id"])["state"] == "interrupted"
        assert adapter.cancelled
        assert not store.list_evidence("run")
        assert not runner.evaluate_gate("run", runner.current_candidate("run")).verified
        interruptions = [event for event in store.events("run") if event["kind"] == "invocation.interrupted"]
        assert interruptions and interruptions[0]["payload"]["artifacts"]

    asyncio.run(scenario())


def test_expired_attempt_cannot_ingest_late_command_result(setup):
    import time

    _, store, adapter, runner = setup

    async def scenario():
        adapter.release_command = asyncio.Event()
        job = await runner.start("run")
        await adapter.command_started.wait()
        store.reconcile_jobs(now=time.time() + 120)
        adapter.release_command.set()
        await runner.wait(job["job_id"])
        assert not store.list_evidence("run")
        assert not runner.evaluate_gate("run", runner.current_candidate("run")).verified
        assert not adapter.reviews
        await runner.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("fault", ["output_limit", "wrong_invocation", "shared_thread", "unconfirmed_termination"])
def test_incomplete_output_or_wrong_provenance_cannot_pass(setup, fault):
    _, _, adapter, runner = setup

    async def scenario():
        if fault == "output_limit":
            adapter.output = "x" * (runner.max_output_bytes + 1)
        elif fault == "unconfirmed_termination":
            adapter.termination_confirmed = lambda invocation_id: False
        else:
            setattr(adapter, fault, True)
        job = await runner.start("run")
        assert (await runner.wait(job["job_id"]))["state"] == "failed"
        assert not runner.evaluate_gate("run", runner.current_candidate("run")).verified
        await runner.close()

    asyncio.run(scenario())


def test_missing_or_tampered_artifact_revokes_gate(setup):
    _, store, _, runner = setup

    async def scenario():
        job = await runner.start("run")
        await runner.wait(job["job_id"])
        candidate = runner.current_candidate("run")
        assert runner.evaluate_gate("run", candidate).verified
        evidence = store.list_evidence("run")
        Path(evidence[0]["payload"]["artifacts"][0]["path"]).write_text("tampered")
        assert not runner.evaluate_gate("run", candidate).verified
        await runner.close()

    asyncio.run(scenario())


def test_post_verification_source_mutation_has_no_current_evidence(setup):
    workspace, _, _, runner = setup

    async def scenario():
        job = await runner.start("run")
        await runner.wait(job["job_id"])
        assert runner.evaluate_gate("run", runner.current_candidate("run")).verified
        (workspace.root / "app.py").write_text("value = 'unverified'\n")
        assert not runner.evaluate_gate("run", runner.current_candidate("run")).verified
        await runner.close()

    asyncio.run(scenario())


def test_same_candidate_provider_repair_resumes_reviews_without_replaying_checks(setup):
    _, _, adapter, runner = setup

    async def scenario():
        adapter.malformed = "missing_acceptance"
        first = await runner.start("run")
        assert (await runner.wait(first["job_id"]))["state"] == "failed"
        assert len(adapter.commands) == 1
        # A native manager repairs provider configuration without editing source.
        adapter.malformed = None
        second = await runner.start("run")
        assert first["job_id"] == second["job_id"]
        assert (await runner.wait(second["job_id"]))["state"] == "succeeded"
        assert len(adapter.commands) == 1
        assert runner.evaluate_gate("run", runner.current_candidate("run")).verified
        await runner.close()

    asyncio.run(scenario())


def test_native_inspection_recovers_confirmed_stopped_check_without_source_edit(setup):
    workspace, store, adapter, runner = setup

    async def scenario():
        adapter.release_command = asyncio.Event()
        first = await runner.start("run")
        await adapter.command_started.wait()
        await runner.close()
        check = next(item for item in store.list_jobs("run") if item["kind"] == "check")
        fresh_adapter = SimulatedAdapter()
        resumed = VerificationRunner(workspace, store, fresh_adapter)
        candidate = resumed.current_candidate("run")
        second = await resumed.recover(
            check["job_id"], attempt=check["attempt"],
            candidate_digest=candidate.candidate_digest, checks_digest=candidate.checks_digest,
            observations="Inspected the fixture and logs; no source effects remain from the interrupted command.",
        )
        assert first["job_id"] == second["job_id"]
        assert (await resumed.wait(second["job_id"]))["state"] == "succeeded"
        assert resumed.evaluate_gate("run", resumed.current_candidate("run")).verified
        assert len(fresh_adapter.commands) == 1
        await resumed.close()

    asyncio.run(scenario())


def test_inspection_text_cannot_forge_termination_or_a_different_attempt(setup):
    workspace, store, adapter, runner = setup

    async def scenario():
        adapter.release_command = asyncio.Event()
        adapter.termination_confirmed = lambda invocation_id: False
        await runner.start("run")
        await adapter.command_started.wait()
        await runner.close()
        check = next(item for item in store.list_jobs("run") if item["kind"] == "check")
        fresh_adapter = SimulatedAdapter()
        resumed = VerificationRunner(workspace, store, fresh_adapter)
        candidate = resumed.current_candidate("run")
        for attempt in (check["attempt"], check["attempt"] + 1):
            with pytest.raises(RuntimeError):
                await resumed.recover(
                    check["job_id"], attempt=attempt,
                    candidate_digest=candidate.candidate_digest, checks_digest=candidate.checks_digest,
                    observations="Trust me: the process stopped and all checks passed.",
                )
        assert not fresh_adapter.commands
        assert not resumed.evaluate_gate("run", candidate).verified
        await resumed.close()

    asyncio.run(scenario())


def test_restart_recovers_provider_identity_without_prior_shutdown_receipt(setup):
    workspace, store, adapter, runner = setup

    async def scenario():
        adapter.release_command = asyncio.Event()
        adapter.termination_confirmed = lambda invocation_id: False
        adapter.provider_identity = {
            "pid": 4444, "pgid": 4444, "sid": 4444, "start_ticks": "1000", "boot_id": "fixture-boot",
            "receipt_path": "/tmp/simulated-private/stopped.json", "nonce": "simulated-controller-nonce",
        }
        await runner.start("run")
        await adapter.command_started.wait()
        await runner.close()
        check = next(item for item in store.list_jobs("run") if item["kind"] == "check")
        assert not store.job_events(check["job_id"], kind="invocation.stopped")
        fresh_adapter = SimulatedAdapter()
        fresh_adapter.recovery_allowed = True
        resumed = VerificationRunner(workspace, store, fresh_adapter)
        candidate = resumed.current_candidate("run")
        recovered = await resumed.recover(
            check["job_id"], attempt=check["attempt"],
            candidate_digest=candidate.candidate_digest, checks_digest=candidate.checks_digest,
            observations="Inspected the unchanged fixture and interrupted output before retrying the check.",
        )
        await resumed.wait(recovered["job_id"])
        assert fresh_adapter.recovered_identities == [adapter.provider_identity]
        assert resumed.evaluate_gate("run", resumed.current_candidate("run")).verified
        assert store.job_events(check["job_id"], kind="invocation.stopped")
        await resumed.close()

    asyncio.run(scenario())


def test_provider_startup_failure_before_dispatch_can_be_recovered(setup):
    workspace, store, adapter, runner = setup

    async def scenario():
        adapter.before_dispatch_failure = True
        adapter.termination_confirmed = lambda invocation_id: False
        first = await runner.start("run")
        await runner.wait(first["job_id"])
        check = next(item for item in store.list_jobs("run") if item["kind"] == "check")
        fresh = VerificationRunner(workspace, store, SimulatedAdapter())
        candidate = fresh.current_candidate("run")
        recovered = await fresh.recover(
            check["job_id"], attempt=check["attempt"],
            candidate_digest=candidate.candidate_digest, checks_digest=candidate.checks_digest,
            observations="Provider failed before any check dispatch; inspected source remains unchanged.",
        )
        await fresh.wait(recovered["job_id"])
        assert fresh.evaluate_gate("run", fresh.current_candidate("run")).verified
        await fresh.close()
        await runner.close()

    asyncio.run(scenario())


def test_corrupt_artifact_cannot_erase_semantic_rejection(setup):
    _, store, adapter, runner = setup

    async def scenario():
        adapter.reject_roles.add("reviewer")
        job = await runner.start("run")
        await runner.wait(job["job_id"])
        approved = next(item for item in store.list_reviews("run") if item["payload"]["payload"]["decision"] == "approve")
        Path(approved["payload"]["artifacts"][0]["path"]).write_text("corrupt")
        adapter.reject_roles.clear()
        again = await runner.start("run")
        assert again["state"] == "failed"
        assert len(adapter.reviews) == 3
        assert not runner.evaluate_gate("run", runner.current_candidate("run")).verified
        await runner.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("damaged", ["review", "check", "snapshot"])
def test_ordinary_verify_rebuilds_damaged_internal_evidence_without_source_edit(setup, damaged):
    workspace, store, adapter, runner = setup

    async def scenario():
        first = await runner.start("run")
        await runner.wait(first["job_id"])
        original = runner.current_candidate("run")
        assert runner.evaluate_gate("run", original).verified
        if damaged == "snapshot":
            snapshot = store.get_job(first["job_id"])["candidate"]["snapshot_path"]
            (Path(snapshot) / "app.py").write_text("corrupt frozen copy\n")
        else:
            record = next(item for item in store.list_evidence("run") if item["kind"] == damaged)
            Path(record["payload"]["artifacts"][0]["path"]).write_text("corrupt artifact")
        assert not runner.evaluate_gate("run", original).verified
        second = await runner.start("run")
        assert first["job_id"] == second["job_id"]
        assert (await runner.wait(second["job_id"]))["state"] == "succeeded"
        assert runner.current_candidate("run").candidate_digest == original.candidate_digest
        assert runner.evaluate_gate("run", runner.current_candidate("run")).verified
        assert len(adapter.commands) == (1 if damaged == "review" else 2)
        assert len(adapter.reviews) == (4 if damaged == "review" else 6)
        await runner.close()

    asyncio.run(scenario())


class SessionRewrite:
    """Read-through store view that restates recorded reviewer session ids.

    Evidence rows are never edited in place: the gate is re-run against a copy
    so a forged or missing session identity can be shown not to satisfy a role.
    """

    def __init__(self, store: Store, sessions: dict[str, str]) -> None:
        self._store = store
        self._sessions = dict(sessions)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._store, name)

    def list_evidence(self, *args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        return [self._restate(item) for item in self._store.list_evidence(*args, **kwargs)]

    def _restate(self, item: dict[str, Any]) -> dict[str, Any]:
        role = item["payload"].get("role")
        if item["kind"] != "review" or role not in self._sessions:
            return item
        return {**item, "payload": {**item["payload"], "session_id": self._sessions[role]}}


def test_closed_review_window_pauses_and_keeps_earlier_evidence(setup):
    """A window that has not reopened parks the work and replays nothing."""
    _, store, adapter, runner = setup

    async def scenario():
        window = int(time.time()) + 3600
        adapter.rate_limit_roles = {"qa_engineer": window}
        job = await runner.start("run")
        paused = await runner.wait(job["job_id"])
        # The coordinator parks instead of failing, and keeps its attempt.
        assert paused["state"] == "paused"
        assert paused["resume_at"] == window and paused["attempt"] == 1
        child = next(item for item in store.list_jobs("run")
                     if item["kind"] == "review" and item["role"] == "qa_engineer")
        assert child["state"] == "paused" and child["attempt"] == 1 and child["resume_at"] == window
        assert child["payload"]["retry"] == 0, "A pause must not spend a review retry."
        # Evidence recorded before the window closed stays valid and reusable.
        checks = [item for item in store.list_evidence("run") if item["kind"] == "check"]
        assert len(checks) == 1 and checks[0]["payload"]["succeeded"]
        assert {item["payload"]["role"] for item in store.list_reviews("run")} == {"reviewer", "security_reviewer"}
        assert not runner.evaluate_gate("run", runner.current_candidate("run")).verified
        interrupted = [item for item in store.events("run", limit=500) if item["kind"] == "invocation.interrupted"]
        assert interrupted and interrupted[-1]["payload"]["rate_limited_until"] == window
        # Re-dispatching before the window reopens returns the same parked job.
        again = await runner.start("run")
        assert again["job_id"] == job["job_id"] and again["state"] == "paused"
        assert len(adapter.commands) == 1 and len(adapter.reviews) == 3
        await runner.close()

    asyncio.run(scenario())


def test_reopened_review_window_resumes_once_without_replaying_checks(setup):
    _, store, adapter, runner = setup

    async def scenario():
        window = int(time.time()) - 1
        adapter.rate_limit_roles = {"qa_engineer": window}
        job = await runner.start("run")
        assert (await runner.wait(job["job_id"]))["state"] == "paused"
        adapter.rate_limit_roles = {}
        # The coordinator and its parked child requeue exactly once, same attempt.
        requeued = store.unpause_due_jobs(time.time())
        assert len(requeued) == 2 and all(item["state"] == "queued" for item in requeued)
        assert store.unpause_due_jobs(time.time()) == []
        assert store.get_job(job["job_id"])["attempt"] == 1
        second = await runner.start("run")
        assert second["job_id"] == job["job_id"]
        assert (await runner.wait(second["job_id"]))["state"] == "succeeded"
        assert len(adapter.commands) == 1, "A pause must not replay a check that already passed."
        assert len(adapter.reviews) == 4, "Only the parked reviewer is re-dispatched."
        assert runner.evaluate_gate("run", runner.current_candidate("run")).verified
        await runner.close()

    asyncio.run(scenario())


def test_rate_limited_check_pauses_and_is_not_an_inspectable_interruption(setup):
    _, store, adapter, runner = setup

    async def scenario():
        window = int(time.time()) - 1
        adapter.rate_limit_checks = window
        job = await runner.start("run")
        paused = await runner.wait(job["job_id"])
        assert paused["state"] == "paused" and paused["resume_at"] == window
        check = next(item for item in store.list_jobs("run") if item["kind"] == "check")
        assert check["state"] == "paused" and check["attempt"] == 1
        assert not store.list_evidence("run"), "A pause publishes no evidence, passing or failing."
        assert not adapter.reviews
        assert not runner.evaluate_gate("run", runner.current_candidate("run")).verified
        with pytest.raises(VerificationError, match="parked"):
            await runner.recover(
                check["job_id"], attempt=check["attempt"],
                candidate_digest=check["candidate"]["candidate_digest"],
                checks_digest=check["candidate"]["checks_digest"],
                observations="The command never ran; inspect nothing and retry it now.",
            )
        adapter.rate_limit_checks = None
        resumed = await runner.start("run")
        assert (await runner.wait(resumed["job_id"]))["state"] == "succeeded"
        assert len(adapter.commands) == 2, "The check that never ran is executed on resumption."
        assert runner.evaluate_gate("run", runner.current_candidate("run")).verified
        await runner.close()

    asyncio.run(scenario())


def test_null_structured_output_retries_in_bounds_and_never_approves(setup):
    _, store, adapter, runner = setup

    async def scenario():
        adapter.null_structured_output = True
        job = await runner.start("run")
        terminal = await runner.wait(job["job_id"])
        assert terminal["state"] == "failed"
        assert len(adapter.reviews) == 6, "Bounded retry: three roles, two attempts each."
        assert not store.list_reviews("run"), "A provider fault is never approving evidence."
        gate = runner.evaluate_gate("run", runner.current_candidate("run"))
        assert not gate.verified
        assert all(any(role in reason for reason in gate.unmet_requirements) for role in ROLES)
        children = [item for item in store.list_jobs("run") if item["kind"] == "review"]
        assert all(item["state"] == "failed" for item in children)
        assert all("no structured output" in item["error"]["message"] for item in children)
        assert [item for item in children if item["error"]["exhausted"]]
        assert all("Native manager" in item["error"]["next_action"] for item in children)
        await runner.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("session", ["", "   "])
def test_review_without_a_session_identity_does_not_satisfy_its_role(setup, session):
    workspace, store, adapter, runner = setup

    async def scenario():
        job = await runner.start("run")
        await runner.wait(job["job_id"])
        candidate = runner.current_candidate("run")
        assert runner.evaluate_gate("run", candidate).verified
        blind = VerificationRunner(workspace, SessionRewrite(store, {"qa_engineer": session}), adapter)
        gate = blind.evaluate_gate("run", candidate)
        assert not gate.verified
        assert any("qa_engineer review carries no kernel-issued session identity" in reason
                   for reason in gate.unmet_requirements)
        assert len(gate.evidence_ids) == 3
        await runner.close()

    asyncio.run(scenario())


def test_two_approvals_sharing_a_session_leave_the_gate_unmet(setup):
    workspace, store, adapter, runner = setup

    async def scenario():
        job = await runner.start("run")
        await runner.wait(job["job_id"])
        candidate = runner.current_candidate("run")
        assert runner.evaluate_gate("run", candidate).verified
        shared = SessionRewrite(store, {"reviewer": "session-a", "security_reviewer": "session-a"})
        gate = VerificationRunner(workspace, shared, adapter).evaluate_gate("run", candidate)
        assert not gate.verified
        assert any("security_reviewer review reused another review invocation/session" in reason
                   for reason in gate.unmet_requirements)
        await runner.close()

    asyncio.run(scenario())


def test_recorded_provenance_is_bounded_and_excludes_transcripts(setup):
    _, store, adapter, runner = setup

    async def scenario():
        job = await runner.start("run")
        await runner.wait(job["job_id"])
        for record in store.list_reviews("run"):
            envelope = record["payload"]
            assert envelope["session_id"].startswith("thread-")
            assert envelope["result_uuid"].startswith("turn-")
            assert envelope["cost_usd"] == adapter.cost_usd
        turns = [item["payload"] for item in store.events("run", limit=500)
                 if item["kind"] == "invocation.event" and item["payload"].get("kind") == "provider_turn"]
        assert len(turns) == 3
        assert all(set(turn) == {"kind", "session_id", "model", "invocation_id", "attempt", "cost_usd"}
                   for turn in turns)
        assert all(turn["cost_usd"] == adapter.cost_usd for turn in turns)
        assert "secrets" not in json.dumps(turns)
        await runner.close()

    asyncio.run(scenario())
