"""Owned verification jobs and candidate-bound evidence.

Repository programs are executed exclusively by the injected sandbox adapter.
The native manager owns repairs; this module records what actually happened and
never accepts a model-authored completion receipt.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .models import (
    ATTEMPT_CEILING,
    Candidate,
    CheckSpec,
    GateResult,
    Policy,
    RateLimited,
    ReviewPayload,
)
from .store import StoreError
from .verification_gate import (
    ROLES,
    GateEvaluator,
    StaleCandidate,
    VerificationError,
    check_envelope,
)
from .verification_gate import data as _data
from .verification_gate import digest as _digest

# Provider telemetry is recorded field by field: never a raw transcript.
EVENT_FIELDS = ("kind", "session_id", "result_uuid", "process_id", "model", "method", "item_type")
IDENTITY_FIELDS = ("pid", "pgid", "sid", "start_ticks", "boot_id", "receipt_path", "nonce")
MAX_CAPTURED_EVENTS = 128

__all__ = ["ROLES", "PauseSignal", "StaleCandidate", "VerificationError", "VerificationRunner"]


@dataclass(frozen=True)
class PauseSignal:
    """A provider usage window closed: the job is parked, never finished.

    A pause is not a result.  It consumes no retry attempt, publishes no
    evidence, and leaves every earlier receipt for the same candidate valid.
    The store requeues the same attempt once ``resume_at`` passes, so the
    pipeline resumes exactly where the window interrupted it.
    """

    resume_at: int
    window: str = "unknown"


class VerificationRunner:
    """Run bounded asynchronous jobs while an MCP lifespan remains alive.

    SQLite owns durable intent and fenced results. In-memory tasks are merely
    executors: closing the host interrupts them, and reconciliation must inspect
    ambiguous command effects before issuing a replacement attempt.
    """

    def __init__(
        self,
        workspace: Any,
        store: Any,
        adapter: Any,
        *,
        max_concurrency: int = 3,
        max_review_retries: int = 1,
        max_output_bytes: int = 262_144,
        lease_seconds: int = 60,
    ) -> None:
        self.workspace = workspace
        self.store = store
        self.adapter = adapter
        self.max_review_retries = max(0, min(max_review_retries, 2))
        self.max_output_bytes = max(1024, min(max_output_bytes, 4_194_304))
        self.lease_seconds = max(3, lease_seconds)
        self._semaphore = asyncio.Semaphore(max(1, min(max_concurrency, 3)))
        self._tasks: dict[str, asyncio.Task[Any]] = {}
        self._invocations: dict[str, set[str]] = {}
        self._children: dict[str, set[str]] = {}
        self._closing = False
        self._start_lock = asyncio.Lock()
        self.owner = f"verification:{os.getpid()}:{uuid.uuid4().hex}"
        self.artifact_root = Path(workspace.state_dir) / "artifacts"
        # The gate reads only persisted evidence; keeping it beside the runner
        # rather than inside it keeps `claimed -> verified` testable on its own.
        # It is handed the adapter's own profile derivation so a check receipt is
        # compared with the confinement the kernel renders, not with itself.
        self.gate = GateEvaluator(workspace=workspace, store=store, artifact_root=self.artifact_root,
                                  profile_digest=getattr(adapter, "check_profile_digest", None))

    def _context(self, run_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        return self.gate.context(run_id)

    def _acceptance_ids(self, run_id: str) -> set[str]:
        return self.gate.acceptance_ids(run_id)

    def _artifact(self, invocation_id: str, name: str, contents: str, limit: int) -> dict[str, Any]:
        return self.gate.artifact(invocation_id, name, contents, limit)

    def _artifacts_valid(self, payload: dict[str, Any]) -> bool:
        return self.gate.artifacts_valid(payload)

    def _execution_stopped(self, job: dict[str, Any]) -> bool:
        return self.gate.execution_stopped(job)

    def evaluate_gate(self, run_id: str, candidate: Candidate, *, coordinator_job_id: str | None = None) -> GateResult:
        return self.gate.evaluate(run_id, candidate, coordinator_job_id=coordinator_job_id)

    def _validate_review(self, payload: Any, candidate: Candidate, packet: dict[str, Any]) -> ReviewPayload:
        return self.gate.validate_review(payload, candidate, packet)

    def current_candidate(self, run_id: str) -> Candidate:
        """Recompute exactly the candidate identity used for dispatch."""
        spec, plan = self._context(run_id)
        return self.workspace.fingerprint(
            checks=spec.get("checks", []),
            policy=spec.get("policy", {}),
            base_revision=spec.get("base_revision") or None,
            plan=plan,
        )

    async def start(self, run_id: str) -> dict[str, Any]:
        """Persist a deduplicated coordinator before scheduling any execution."""
        if self._closing:
            raise VerificationError("Verification service is closing; resume in the next host session.")
        async with self._start_lock:
            # Re-dispatch is also the resumption point: a window that reopened
            # returns its paused coordinator and children to the same attempt.
            # Scoped to this run: dispatching one delivery must not wake another
            # delivery's parked work in the same repository (CORR-L1..L4).
            self.store.unpause_due_jobs(time.time(), run_id=run_id)
            spec, plan = self._context(run_id)
            observed = await asyncio.to_thread(self.current_candidate, run_id)
            existing = next((
                item for item in self.store.list_jobs(run_id)
                if item["kind"] == "verification"
                and item["candidate"].get("candidate_digest") == observed.candidate_digest
                and item["candidate"].get("checks_digest") == observed.checks_digest
            ), None)
            if existing is not None:
                job_id = existing["job_id"]
                if existing["state"] in {"succeeded", "failed", "interrupted"}:
                    existing = await self._repair_damaged_evidence(existing, spec, plan)
                if existing["state"] in {"failed", "interrupted"} and self._can_resume_read_only(existing):
                    existing = self.store.retry_job(
                        job_id,
                        reason="Automatically resume read-only verification after validating completed checks and unchanged source.",
                    )
                if existing["state"] == "queued" and (job_id not in self._tasks or self._tasks[job_id].done()):
                    self._tasks[job_id] = asyncio.create_task(self._execute(job_id), name=f"archon:{job_id}")
                return existing
            candidate = await asyncio.to_thread(
                self.workspace.snapshot,
                checks=spec.get("checks", []),
                policy=spec.get("policy", {}),
                base_revision=spec.get("base_revision") or None,
                plan=plan,
            )
            key = _digest([run_id, "verification", candidate.candidate_digest, candidate.checks_digest])
            job = self.store.enqueue_job(
                run_id,
                "verification",
                _data(candidate),
                idempotency_key=key,
                payload={"spec": spec, "plan": plan},
            )
            job_id = job["job_id"]
            if job["state"] == "queued" and job_id not in self._tasks:
                self._tasks[job_id] = asyncio.create_task(self._execute(job_id), name=f"archon:{job_id}")
            return self.store.get_job(job_id)

    async def _repair_damaged_evidence(self, job: dict[str, Any], spec: dict[str, Any], plan: dict[str, Any]) -> dict[str, Any]:
        """Rebuild disposable evidence automatically without artificial source edits."""
        candidate = Candidate.model_validate(job["candidate"])
        try:
            self.workspace.verify_snapshot(candidate)
            snapshot_damaged = False
        except Exception:
            snapshot_damaged = True
        children = [item for item in self.store.list_jobs(job["run_id"]) if item["payload"].get("parent_job_id") == job["job_id"]]
        records = self.store.list_evidence(job["run_id"], candidate_digest=candidate.candidate_digest, checks_digest=candidate.checks_digest)
        damaged = [
            child for child in children if child["state"] == "succeeded"
            and (not self._execution_stopped(child) or not any(item["job_id"] == child["job_id"] and self._artifacts_valid(item["payload"]) for item in records)
                 or any(item["job_id"] == child["job_id"] and item["kind"] == "check"
                        and not self.gate.profile_current(candidate, spec, item["payload"]) for item in records))
        ]
        if not snapshot_damaged and not damaged:
            return job
        if any(
            item["kind"] == "review" and (
                item["payload"].get("payload", {}).get("decision") in {"request_changes", "blocked"}
                or any(f.get("severity") in {"high", "critical"} for f in item["payload"].get("payload", {}).get("findings", []))
            ) for item in records
        ):
            return job  # Damaged artifacts cannot erase an unresolved rejection.
        if job["attempt"] >= min(Policy.model_validate(spec.get("policy", {})).max_attempts, ATTEMPT_CEILING):
            raise VerificationError("Internal evidence rebuild budget exhausted; diagnose the storage failure before another materially different repair.")
        redo_all = snapshot_damaged or any(child["kind"] == "check" for child in damaged)
        redo = children if redo_all else damaged
        if any(child["state"] in {"queued", "running", "cancelled"} for child in redo):
            return job
        if any(child["kind"] == "check" and not self._execution_stopped(child) for child in redo):
            return job
        if snapshot_damaged:
            candidate = await asyncio.to_thread(
                self.workspace.snapshot,
                checks=spec.get("checks", []), policy=spec.get("policy", {}),
                base_revision=spec.get("base_revision") or None, plan=plan,
            )
            if (candidate.candidate_digest, candidate.checks_digest) != (job["candidate"]["candidate_digest"], job["candidate"]["checks_digest"]):
                raise StaleCandidate("Source changed while rebuilding damaged verification data.")
        cohort = [item["job_id"] for item in redo] + [job["job_id"]]
        self.store._rebuild_jobs(
            cohort, reason="Rebuild damaged internal evidence through fresh owned execution.", inspected=True,
        )
        if snapshot_damaged:
            for job_id in cohort:
                self.store._replace_job_snapshot(job_id, _data(candidate))
        return self.store.get_job(job["job_id"])

    def _can_resume_read_only(self, job: dict[str, Any]) -> bool:
        """Resume provider failures without replaying ambiguous commands."""
        policy = Policy.model_validate(job["payload"]["spec"].get("policy", {}))
        if job["attempt"] >= min(policy.max_attempts, ATTEMPT_CEILING):
            return False
        candidate = Candidate.model_validate(job["candidate"])
        try:
            self.workspace.verify_snapshot(candidate)
        except Exception:
            return False
        children = [item for item in self.store.list_jobs(job["run_id"]) if item["payload"].get("parent_job_id") == job["job_id"]]
        if not children:
            return True  # Durable dispatch intent proves no child was dispatched.
        for check in job["payload"]["spec"].get("checks", []):
            parsed = CheckSpec.model_validate(check)
            if not self._has_completed_child(job, candidate, "check", parsed.name, _digest(parsed)):
                return False
        reviews = self.store.list_reviews(job["run_id"], candidate_digest=candidate.candidate_digest, checks_digest=candidate.checks_digest)
        for record in reviews:
            payload = record["payload"].get("payload", {})
            if payload.get("decision") in {"request_changes", "blocked"} or any(f.get("severity") in {"high", "critical"} for f in payload.get("findings", [])):
                return False
        return True

    async def wait(self, job_id: str) -> dict[str, Any]:
        task = self._tasks.get(job_id)
        if task is not None:
            await asyncio.shield(task)
        return self.store.get_job(job_id)

    async def _recover_execution_stop(self, job: dict[str, Any]) -> bool:
        if self._execution_stopped(job):
            return True
        events = [item for item in self.store.job_events(job["job_id"]) if item["payload"].get("attempt") == job["attempt"]]
        started = {item["payload"]["invocation_id"] for item in events if item["kind"] == "invocation.started"}
        dispatched = any(item["kind"] == "invocation.event" and item["payload"].get("kind") == "dispatch" for item in events)
        provider_observed = any(item["kind"] == "invocation.event" and item["payload"].get("kind") == "provider_process" for item in events)
        if started and not dispatched and not provider_observed:
            # The adapter awaits the durable dispatch callback before sending
            # command/exec. A startup crash before it cannot have run the check.
            for invocation_id in started:
                self.store.append_event(job["run_id"], "invocation.stopped", {
                    "invocation_id": invocation_id, "attempt": job["attempt"],
                    "confirmation": "command_not_dispatched",
                }, job_id=job["job_id"])
            return True
        inspect_termination = getattr(self.adapter, "recover_termination", None)
        if inspect_termination is None:
            return False
        observations = [
            item["payload"] for item in self.store.job_events(job["job_id"], kind="invocation.event")
            if item["payload"].get("attempt") == job["attempt"]
            and item["payload"].get("kind") == "provider_process"
            and isinstance(item["payload"].get("process_identity"), dict)
        ]
        for observation in observations:
            confirmed = await inspect_termination(observation["process_identity"])
            if confirmed:
                self.store.append_event(job["run_id"], "invocation.stopped", {
                    "invocation_id": observation["invocation_id"], "attempt": job["attempt"],
                    "confirmation": "owned_provider_session_reconciled",
                }, job_id=job["job_id"])
        return self._execution_stopped(job)

    async def recover(
        self,
        job_id: str,
        *,
        attempt: int,
        candidate_digest: str,
        checks_digest: str,
        observations: str,
    ) -> dict[str, Any]:
        """Disposition inspected effects and rerun actual checks; never grant a pass."""
        target = self.store.get_job(job_id)
        if target["attempt"] != attempt or not observations.strip() or len(observations) > 16_384:
            raise VerificationError("Recovery requires the exact attempt and a bounded inspection summary.")
        if target["state"] == "paused":
            raise VerificationError(
                f"That attempt is parked on a provider usage window until {target['resume_at']}; "
                "it resumes itself with the same attempt and needs no inspection."
            )
        if target["state"] not in {"failed", "interrupted"}:
            raise VerificationError("Only a failed or interrupted owned attempt can be recovered.")
        observed = await asyncio.to_thread(self.current_candidate, target["run_id"])
        if (candidate_digest, checks_digest) != (observed.candidate_digest, observed.checks_digest) or (candidate_digest, checks_digest) != (target["candidate"]["candidate_digest"], target["candidate"]["checks_digest"]):
            raise StaleCandidate("Recovery inspection no longer describes the current candidate; verify the repaired source directly.")
        parent_id = target["payload"].get("parent_job_id") or target["job_id"]
        parent = self.store.get_job(parent_id)
        if parent["kind"] != "verification" or parent["state"] not in {"failed", "interrupted"}:
            raise VerificationError("The owning verification coordinator is not recoverable.")
        if parent["attempt"] >= min(Policy.model_validate(parent["payload"]["spec"].get("policy", {})).max_attempts, ATTEMPT_CEILING):
            raise VerificationError("Recovery retry budget exhausted; diagnose the failure before choosing a different safe repair.")
        children = [item for item in self.store.list_jobs(target["run_id"]) if item["payload"].get("parent_job_id") == parent_id]
        interrupted_checks = [item for item in children if item["kind"] == "check" and item["state"] in {"failed", "interrupted"}]
        for child in interrupted_checks:
            if not await self._recover_execution_stop(child):
                raise VerificationError("The previous command has no trustworthy process identity or termination confirmation; automatically inspect the recorded provider diagnostic before retrying effects.")
        await self._assert_fresh(target["run_id"], observed)
        if any(item["state"] == "running" for item in children):
            raise VerificationError("An owned child is still unresolved; terminate or reconcile it before recovery.")
        self.store.append_event(target["run_id"], "recovery.inspected", {
            "attempt": attempt, "candidate_digest": candidate_digest,
            "checks_digest": checks_digest, "observations": observations,
            "next_action": "Execute fresh sandboxed verification; inspection grants no passing evidence.",
        }, job_id=job_id)
        self.store._retry_jobs(
            [child["job_id"] for child in interrupted_checks] + [parent_id],
            reason="Native manager inspected effects and the controller confirmed termination; execute fresh evidence.",
            inspected=True,
        )
        return await self.start(target["run_id"])

    async def cancel(self, job_id: str) -> dict[str, Any]:
        """Cancel only this runner's owned execution, preserving evidence."""
        if job_id not in self._tasks:
            try:
                run = self.store.get_run(job_id)
            except ValueError:
                run = None
            if run is not None:
                for key in tuple(self._tasks):
                    if self.store.get_job(key)["run_id"] == job_id:
                        await self.cancel(key)
                return self.store.get_run(job_id)
        task = self._tasks.get(job_id)
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        return self.store.get_job(job_id)

    async def close(self) -> None:
        self._closing = True
        active = [task for task in self._tasks.values() if not task.done()]
        for task in active:
            task.cancel()
        await asyncio.gather(*active, return_exceptions=True)

    async def _heartbeat(self, lease: Any) -> None:
        while True:
            await asyncio.sleep(self.lease_seconds / 3)
            try:
                # The store raises on a lost fence rather than returning a falsy
                # lease (CORR-L1..L4: the old truthiness branch was unreachable).
                lease = self.store.heartbeat(lease, lease_seconds=self.lease_seconds, process_id=os.getpid())
            except StoreError as error:
                raise VerificationError(f"Worker lease was superseded; late results cannot be accepted: {error}") from error

    async def _owned(self, lease: Any, operation: Any) -> Any:
        """Stop work when a heartbeat fails rather than publish a late result."""
        work = asyncio.create_task(operation)
        heartbeat = asyncio.create_task(self._heartbeat(lease))
        try:
            done, _ = await asyncio.wait({work, heartbeat}, return_when=asyncio.FIRST_COMPLETED)
            if heartbeat in done:
                heartbeat.result()
                raise VerificationError("Unexpected heartbeat termination.")
            return work.result()
        finally:
            for task in (work, heartbeat):
                if not task.done():
                    task.cancel()
            await asyncio.gather(work, heartbeat, return_exceptions=True)

    async def _execute(self, job_id: str) -> None:
        lease = self.store.claim_job(job_id, self.owner, lease_seconds=self.lease_seconds)
        if lease is None:
            return
        lease = self.store.heartbeat(lease, lease_seconds=self.lease_seconds, process_id=os.getpid())
        job = self.store.get_job(job_id)
        self._invocations[job_id] = set()
        self._children[job_id] = set()
        try:
            result = await self._owned(lease, self._pipeline(job, lease))
            if isinstance(result, PauseSignal):
                self._pause(lease, result, "Verification")
            else:
                self.store.finish_job(lease, "succeeded" if result.verified else "failed", result=_data(result))
        except RateLimited as limit:
            self._pause(lease, PauseSignal(limit.resume_at, limit.window), "Verification")
        except asyncio.CancelledError:
            await self._cancel_invocations(job_id)
            state = "interrupted" if self._closing else "cancelled"
            self.store.finish_job(
                lease,
                state,
                error={
                    "code": state,
                    "message": "Verification stopped before a final current-candidate gate.",
                    "next_action": "Inspect command effects and resume from the persisted checkpoint; do not assume interrupted checks passed.",
                },
            )
        except Exception as exc:
            await self._cancel_invocations(job_id)
            self.store.finish_job(
                lease,
                "failed",
                error={
                    "code": "stale_candidate" if isinstance(exc, StaleCandidate) else "verification_failed",
                    "message": str(exc)[:2000],
                    "next_action": "Native manager: inspect the recorded failure, repair its cause, and verify the resulting candidate.",
                },
            )
        finally:
            self._invocations.pop(job_id, None)
            self._children.pop(job_id, None)

    async def _cancel_invocations(self, job_id: str) -> None:
        async def stop(invocation_id: str) -> None:
            try:
                await asyncio.wait_for(self.adapter.cancel(invocation_id), timeout=10)
            except Exception:
                # Cancellation uncertainty remains interrupted/failed, never pass.
                pass

        await asyncio.gather(*(stop(inv) for inv in tuple(self._invocations.get(job_id, ()))), return_exceptions=True)

    def _pause(self, lease: Any, signal: PauseSignal, label: str) -> PauseSignal:
        """Park one owned job on a provider window under its own lease fence.

        The store refuses the write unless this attempt still holds the lease,
        so a superseded worker can neither pause nor resurrect a job.  The
        attempt counter is untouched: a closed window is not a spent try, and
        no evidence is written, so nothing recorded earlier is invalidated.
        """
        self.store.pause_job(
            lease.job_id, lease.attempt, lease.lease_token, signal.resume_at,
            f"{label} paused: provider usage window {signal.window} closed until {signal.resume_at}.",
        )
        return signal

    async def _assert_fresh(self, run_id: str, candidate: Candidate) -> None:
        observed = await asyncio.to_thread(self.current_candidate, run_id)
        if (observed.candidate_digest, observed.checks_digest) != (candidate.candidate_digest, candidate.checks_digest):
            raise StaleCandidate("Source, task plan, or verification policy changed during verification; fresh evidence is required.")

    async def _pipeline(self, job: dict[str, Any], lease: Any) -> GateResult | PauseSignal:
        candidate = Candidate.model_validate(job["candidate"])
        spec = job["payload"]["spec"]
        policy = Policy.model_validate(spec.get("policy", {}))
        await self._assert_fresh(job["run_id"], candidate)
        checks = [CheckSpec.model_validate(check) for check in spec.get("checks", [])]
        for check in checks:
            if self._has_completed_child(job, candidate, "check", check.name, _digest(check)):
                continue
            passed = await self._check(job, candidate, check, policy)
            if isinstance(passed, PauseSignal):
                return passed
            if not passed:
                return self.evaluate_gate(job["run_id"], candidate, coordinator_job_id=job["job_id"])
        await self._assert_fresh(job["run_id"], candidate)
        packet = self.gate.review_packet(job, candidate)
        await asyncio.to_thread(self.workspace.verify_snapshot, candidate)
        # All three are independent invocations with a frozen read-only candidate.
        review_slots = asyncio.Semaphore(policy.max_parallel_reviews)

        async def review_role(role: str) -> bool | PauseSignal:
            if self._has_completed_child(job, candidate, "review", role):
                return True
            async with review_slots:
                return await self._review(job, candidate, role, packet, policy)

        review_tasks = [asyncio.create_task(review_role(role)) for role in ROLES]
        try:
            outcomes = await asyncio.gather(*review_tasks)
        finally:
            for task in review_tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*review_tasks, return_exceptions=True)
        paused = next((item for item in outcomes if isinstance(item, PauseSignal)), None)
        if paused is not None:
            # A closed window is not a verdict: leave the coordinator unfinished
            # and the gate unevaluated until the same attempt resumes.
            return paused
        await self._assert_fresh(job["run_id"], candidate)
        await asyncio.to_thread(self.workspace.verify_snapshot, candidate)
        return self.evaluate_gate(job["run_id"], candidate, coordinator_job_id=job["job_id"])

    def _has_completed_child(self, job: dict[str, Any], candidate: Candidate, kind: str, label: str, spec_digest: str | None = None) -> bool:
        records = self.store.list_evidence(job["run_id"], candidate_digest=candidate.candidate_digest, checks_digest=candidate.checks_digest)
        for item in records:
            payload = item["payload"]
            if item["kind"] != kind or not payload.get("succeeded") or not self._artifacts_valid(payload):
                continue
            if payload.get("check_name" if kind == "check" else "role") != label:
                continue
            if spec_digest is not None and payload.get("check_spec_digest") != spec_digest:
                continue
            producer = self.store.get_job(item["job_id"])
            if producer["state"] == "succeeded" and self._execution_stopped(producer):
                return True
        return False

    def _child(self, job: dict[str, Any], candidate: Candidate, kind: str, label: str, attempt: int = 0) -> tuple[dict[str, Any], Any]:
        child = self.store.enqueue_job(
            job["run_id"],
            kind,
            _data(candidate),
            role=label if kind == "review" else None,
            idempotency_key=_digest([job["job_id"], kind, label, attempt]),
            payload={"parent_job_id": job["job_id"], "label": label, "retry": attempt},
        )
        self._children[job["job_id"]].add(child["job_id"])
        if kind == "review" and child["state"] in {"failed", "interrupted"}:
            # A valid rejection requires a source repair, while a read-only
            # interrupted/malformed attempt can safely acquire a new fence.
            if (child.get("result") or {}).get("decision") in {"request_changes", "blocked"}:
                raise VerificationError("Reviewer requested source repair; verify a repaired candidate before seeking approval.")
            # CORR-M2: this resumption used to spend an attempt without asking the
            # accepted policy, so `max_attempts=1` bought a second reviewer run.
            budget = min(Policy.model_validate(job["payload"]["spec"].get("policy", {})).max_attempts, ATTEMPT_CEILING)
            if child["attempt"] >= budget:
                raise VerificationError("Reviewer retry budget for this run is exhausted; repair the provider or configuration fault before seeking approval.")
            child = self.store.retry_job(child["job_id"], reason="Automatically resume bounded read-only reviewer execution.")
        lease = self.store.claim_job(child["job_id"], self.owner, lease_seconds=self.lease_seconds)
        if lease is None:
            raise VerificationError("A verification child is already owned or terminal; inspect persisted execution before retry.")
        lease = self.store.heartbeat(lease, lease_seconds=self.lease_seconds, process_id=os.getpid())
        return child, lease

    async def _invoke(self, job_id: str, invocation_id: str, method: Any, timeout: float, *args: Any, child_job_id: str | None = None) -> Any:
        self._invocations[job_id].add(invocation_id)
        run_id = self.store.get_job(job_id)["run_id"]
        attempt = self.store.get_job(child_job_id or job_id)["attempt"]
        self.store.append_event(run_id, "invocation.started", {"invocation_id": invocation_id, "attempt": attempt}, job_id=child_job_id or job_id)
        captured: dict[str, list[str]] = {"stdout": [], "stderr": []}
        captured_bytes = 0
        event_count = 0

        async def on_event(event: Any) -> None:
            # Provider events are untrusted telemetry, never gate authority.
            nonlocal captured_bytes, event_count
            if not isinstance(event, dict) or event.get("invocation_id", invocation_id) != invocation_id:
                return
            if event.get("kind") == "output":
                stream = event.get("stream")
                if stream in captured and captured_bytes < self.max_output_bytes:
                    chunk = str(event.get("text", "")).encode("utf-8", errors="replace")[:self.max_output_bytes - captured_bytes]
                    captured[stream].append(chunk.decode("utf-8", errors="replace"))
                    captured_bytes += len(chunk)
            elif event_count < MAX_CAPTURED_EVENTS:
                self.store.append_event(run_id, "invocation.event", self._provenance(event, invocation_id, attempt), job_id=child_job_id or job_id)
                event_count += 1

        try:
            return await asyncio.wait_for(method(*args, on_event=on_event, invocation_id=invocation_id), timeout=timeout)
        except RateLimited as limit:
            # A closed window is diagnosed, not failed: the same artifacts are
            # kept, tagged with the window that has to reopen first.
            await self._abandon(run_id, invocation_id, attempt, captured, child_job_id or job_id,
                                {"rate_limited_until": limit.resume_at, "window": limit.window})
            raise
        except BaseException:
            await self._abandon(run_id, invocation_id, attempt, captured, child_job_id or job_id, {})
            raise
        finally:
            confirmed = getattr(self.adapter, "termination_confirmed", lambda _: False)(invocation_id)
            if confirmed:
                self.store.append_event(run_id, "invocation.stopped", {"invocation_id": invocation_id, "attempt": attempt, "confirmation": "owned_transport_closed"}, job_id=child_job_id or job_id)
            self._invocations[job_id].discard(invocation_id)

    def _provenance(self, event: Mapping[str, Any], invocation_id: str, attempt: int) -> dict[str, Any]:
        """Whitelist provider telemetry: identity and cost, never transcripts."""
        safe: dict[str, Any] = {key: str(event[key])[:1000] for key in EVENT_FIELDS if key in event}
        safe["invocation_id"] = invocation_id
        safe["attempt"] = attempt
        cost = event.get("cost_usd")
        if isinstance(cost, (int, float)) and not isinstance(cost, bool):
            safe["cost_usd"] = float(cost)
        identity = event.get("process_identity")
        if event.get("kind") == "provider_process" and isinstance(identity, Mapping):
            safe["process_identity"] = {key: identity[key] for key in IDENTITY_FIELDS if key in identity}
        return safe

    async def _abandon(self, run_id: str, invocation_id: str, attempt: int,
                       captured: Mapping[str, list[str]], job_id: str | None,
                       detail: Mapping[str, Any]) -> None:
        """Stop an unfinished invocation and keep its bounded diagnostic."""
        try:
            await asyncio.wait_for(self.adapter.cancel(invocation_id), timeout=10)
        except Exception:
            pass
        artifacts = [
            self._artifact(invocation_id, f"interrupted-{stream}.log", "".join(chunks), self.max_output_bytes)
            for stream, chunks in captured.items() if chunks
        ]
        payload = {"invocation_id": invocation_id, "attempt": attempt, "artifacts": artifacts, **detail}
        self.store.append_event(run_id, "invocation.interrupted", payload, job_id=job_id)

    def _check_outcome(self, invocation_id: str, result_data: dict[str, Any], artifacts: list[dict[str, Any]],
                       candidate: Candidate, policy: Policy) -> tuple[bool, bool]:
        """Decide, and record why, whether one executed check may count as passed.

        A check passes only when the runtime proved it stopped and ran under the
        confinement the kernel itself renders for this candidate (CORR-M3): a
        result naming no profile, or naming one the kernel would not produce, is
        indistinguishable from a command that ran outside the profile. An
        unconfirmed stop may still have effects in flight.
        """
        terminated = bool(getattr(self.adapter, "termination_confirmed", lambda _: False)(invocation_id))
        if not terminated and not result_data.get("error"):
            result_data["error"] = "Owned runtime termination is unconfirmed; inspect and reconcile its supervisor before retrying effects."
        expected, unrenderable = self.gate.expected_profile(candidate, policy)
        recorded = result_data.get("sandbox_profile_digest")
        confined = bool(recorded) and recorded == expected
        if not confined and not result_data.get("error"):
            if not recorded:
                result_data["error"] = "The runtime recorded no confinement profile for this check; evidence cannot bind to a profile it does not name."
            elif unrenderable:
                result_data["error"] = "; ".join(unrenderable)
            else:
                result_data["error"] = "This check ran under a confinement profile the kernel does not render for this candidate."
        passed = (
            result_data.get("exit_code") == 0
            and terminated
            and confined
            and not any(result_data.get(flag) for flag in ("error", "timed_out", "interrupted", "truncated"))
            and not any(artifact["truncated"] for artifact in artifacts)
        )
        return terminated, passed

    async def _check(self, job: dict[str, Any], candidate: Candidate, check: CheckSpec, policy: Policy) -> bool | PauseSignal:
        _, lease = self._child(job, candidate, "check", check.name)
        invocation_id = uuid.uuid4().hex
        try:
            await self._assert_fresh(job["run_id"], candidate)
            timeout = min(check.timeout_seconds, policy.command_timeout_seconds)
            result = await self._owned(
                lease,
                self._invoke(job["job_id"], invocation_id, self.adapter.run_command, timeout + 5, check, candidate, policy, child_job_id=lease.job_id),
            )
            result_data = _data(result)
            expected_cwd = (Path(candidate.repo_root) / check.cwd).resolve()
            if result_data.get("invocation_id") != invocation_id or result_data.get("argv") != list(check.argv) or Path(result_data.get("cwd", "")).resolve() != expected_cwd:
                raise VerificationError("Command result does not match the assigned invocation or command.")
            limit = min(policy.max_output_bytes, self.max_output_bytes)
            stdout = self._artifact(invocation_id, "stdout.log", result_data.pop("stdout", ""), limit)
            stderr = self._artifact(invocation_id, "stderr.log", result_data.pop("stderr", ""), limit)
            await self._assert_fresh(job["run_id"], candidate)
            terminated, passed = self._check_outcome(invocation_id, result_data, [stdout, stderr], candidate, policy)
            evidence = self.store._record_evidence(
                lease,
                {
                    "kind": "check", "invocation_id": invocation_id,
                    "candidate_digest": candidate.candidate_digest, "checks_digest": candidate.checks_digest,
                    "payload": check_envelope(check, invocation_id, result_data, [stdout, stderr], policy, passed),
                },
            )
            if not evidence:
                raise VerificationError("Lost command lease; its result is not accepted.")
            # CORR-L1: the fence's answer is the record. Proceeding after a lost
            # one would run the reviewers against an attempt whose outcome was
            # never written, and the gate would then report an absent check.
            if not self.store.finish_job(lease, "succeeded" if passed else "failed",
                                         result={"evidence_id": evidence.get("evidence_id"), "succeeded": passed,
                                                 "execution_terminated": terminated, "invocation_id": invocation_id}):
                raise VerificationError("Lost the command lease before its outcome was recorded; verify the current candidate again.")
            return passed
        except RateLimited as limit:
            return self._pause(lease, PauseSignal(limit.resume_at, limit.window), f"Check {check.name}")
        except asyncio.CancelledError:
            self.store.finish_job(lease, "interrupted", error={"message": "Check interrupted; inspect effects before resuming."})
            raise
        except Exception as exc:
            self.store.finish_job(lease, "failed", error={"message": str(exc)[:2000], "next_action": "Inspect and repair the check failure, then verify fresh source."})
            if isinstance(exc, StaleCandidate):
                raise
            return False

    def _accept_review(self, lease: Any, role: str, invocation_id: str, candidate: Candidate,
                       result_data: Mapping[str, Any], payload: ReviewPayload, policy: Policy) -> bool:
        """Bind one validated review to its candidate, artifact, and session.

        Only the store's fence decides whether the envelope is published, and
        ``approved`` here records a reviewer's verdict: the gate, not this
        method, decides whether three such verdicts add up to verified.
        """
        serialized = json.dumps(_data(payload), ensure_ascii=False, sort_keys=True)
        artifact = self._artifact(invocation_id, "review.json", serialized, min(policy.max_output_bytes, self.max_output_bytes))
        if artifact["truncated"]:
            raise VerificationError("Reviewer output exceeded the bounded evidence limit.")
        approved = payload.decision == "approve" and not any(f.severity in {"high", "critical"} for f in payload.findings)
        evidence = self.store._record_evidence(
            lease,
            {
                "kind": "review", "invocation_id": invocation_id,
                "candidate_digest": candidate.candidate_digest, "checks_digest": candidate.checks_digest,
                "payload": {
                    "role": role, "invocation_id": invocation_id,
                    "candidate_digest": candidate.candidate_digest, "checks_digest": candidate.checks_digest,
                    "session_id": result_data.get("session_id"), "result_uuid": result_data.get("result_uuid"),
                    "cost_usd": result_data.get("cost_usd"),
                    "payload": _data(payload), "artifacts": [artifact], "succeeded": approved,
                },
            },
        )
        if not evidence:
            raise VerificationError("Lost review lease; its result is not accepted.")
        # CORR-L1: an unrecorded outcome is not a verdict; a reviewer whose fence
        # expired here left the gate reading "lacks current approval" while the
        # pipeline believed the role was answered.
        if not self.store.finish_job(lease, "succeeded" if approved else "failed",
                                     result={"evidence_id": evidence.get("evidence_id"), "decision": payload.decision,
                                             "execution_terminated": True}):
            raise VerificationError("Lost the review lease before its verdict was recorded; a fresh review is required.")
        return approved

    async def _review(self, job: dict[str, Any], candidate: Candidate, role: str, packet: dict[str, Any], policy: Policy) -> bool | PauseSignal:
        retries = min(self.max_review_retries, max(0, policy.max_attempts - 1))
        async with self._semaphore:
            for attempt in range(retries + 1):
                _, lease = self._child(job, candidate, "review", role, attempt)
                invocation_id = uuid.uuid4().hex
                try:
                    result = await self._owned(
                        lease,
                        self._invoke(job["job_id"], invocation_id, self.adapter.run_review, policy.review_timeout_seconds, role, candidate, packet, policy, child_job_id=lease.job_id),
                    )
                    result_data = _data(result)
                    if result_data.get("error"):
                        raise VerificationError(str(result_data["error"])[:2000])
                    if (
                        result_data.get("invocation_id") != invocation_id
                        or result_data.get("role") != role
                        or result_data.get("candidate_digest") != candidate.candidate_digest
                        or result_data.get("checks_digest") != candidate.checks_digest
                        or not result_data.get("session_id")
                        or not result_data.get("result_uuid")
                        or not getattr(self.adapter, "termination_confirmed", lambda _: False)(invocation_id)
                    ):
                        raise VerificationError("Review result lacks the assigned invocation, candidate, independent session provenance, or confirmed runtime termination.")
                    payload = self._validate_review(result_data.get("payload"), candidate, packet)
                    return self._accept_review(lease, role, invocation_id, candidate, result_data, payload, policy)
                except RateLimited as limit:
                    # Parked, not spent: this retry index is replayed verbatim
                    # once the window reopens, and no evidence is published.
                    return self._pause(lease, PauseSignal(limit.resume_at, limit.window), f"Review {role}")
                except asyncio.CancelledError:
                    self.store.finish_job(lease, "interrupted", error={"message": "Read-only review interrupted; a fresh review may be retried."})
                    raise
                except Exception as exc:
                    self.store.finish_job(
                        lease,
                        "failed",
                        error={
                            "message": str(exc)[:2000], "exhausted": attempt == retries,
                            "next_action": "Native manager: inspect reviewer diagnostics and repair the provider/configuration issue; no manual receipt is accepted.",
                        },
                    )
            return False
