"""Validated workflow contracts; evidence envelopes are runtime-owned.

These models validate data, not authority. Public services must never accept a
CommandResult, ReviewResult, or verified status as caller-granted evidence.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from enum import StrEnum
from pathlib import PurePosixPath
from typing import Annotated, Any, Literal, Protocol
from uuid import uuid4

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StrictBool,
    StringConstraints,
    field_validator,
    model_validator,
)

Identifier = Annotated[
    str, StringConstraints(strict=True, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$")
]
Text = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=16_384)]
ShortText = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=512)]
Digest = Annotated[str, StringConstraints(strict=True, pattern=r"^[a-f0-9]{64}$")]
PathText = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=4096)]
Role = Literal["reviewer", "qa_engineer", "security_reviewer"]
EventCallback = Callable[[dict[str, Any]], Awaitable[None]]


class RateLimited(Exception):
    """The provider closed a usage window.  A pause, never a failure.

    ``resume_at`` is epoch seconds taken from the runtime's own signal
    (``rate_limit_event.rate_limit_info.resetsAt`` or a parsed usage-limit
    message).  A paused job consumes no attempt.
    """

    def __init__(self, resume_at: int, *, window: str = "unknown", detail: str = "") -> None:
        super().__init__(f"usage window {window} closed until {resume_at}: {detail}".strip())
        self.resume_at = int(resume_at)
        self.window = window
        self.detail = detail


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True, validate_default=True)


class RunStatus(StrEnum):
    PLANNING = "planning"
    ACTIVE = "active"
    VERIFYING = "verifying"
    REPAIR = "repair"
    VERIFIED = "verified"
    BLOCKED = "blocked"
    PAUSED = "paused"
    CANCELLED = "cancelled"


class TaskStatus(StrEnum):
    PLANNED = "planned"
    IMPLEMENTING = "implementing"
    VERIFYING = "verifying"
    REPAIR = "repair"
    VERIFIED = "verified"
    BLOCKED = "blocked"


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    PAUSED = "paused"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    INTERRUPTED = "interrupted"
    CANCELLED = "cancelled"


#: Every state in which a job may still produce a result, and therefore every
#: state that must block a plan or task-claim change, a cancellation sweep, and
#: a final gate.  ``paused`` was added to :class:`JobStatus` without reaching the
#: predicates that spell "an active job exists", so a verification parked on a
#: usage window could be mutated out from under (CORR-H2): task claims changed
#: while a coordinator was paused, `replace_plan` amended its checks, `cancel_run`
#: left paused rows behind that ordinary polling later resumed into a cancelled
#: run, and a gate could finalize `verified` with a paused job still pending.
ACTIVE_JOB_STATES: tuple[str, ...] = ("queued", "running", "paused")

#: The kernel owns the retry budget: ``Store._retry_jobs`` refuses a fourth
#: attempt and ``Store.reconcile_jobs`` stops requeuing at the same number.
ATTEMPT_CEILING = 3

#: A reviewer model must reliably call the engine's ``StructuredOutput`` tool.
#: Recorded probes (docs/spikes.md S3) show haiku returning the literal null
#: shape instead, so a manager-supplied policy may not route a Witness to it.
UNSTRUCTURED_REVIEW_MODELS: tuple[str, ...] = ("haiku",)


def review_model_text(value: str) -> str:
    """Reject a reviewer route the recorded probes show cannot be structured."""
    if not value.strip():
        raise ValueError("review model must not be blank")
    lowered = value.lower()
    if any(family in lowered for family in UNSTRUCTURED_REVIEW_MODELS):
        raise ValueError(
            "review model may not route a Witness to haiku: it does not reliably "
            "produce the engine's structured output (docs/spikes.md S3)"
        )
    return value


class ReviewDecision(StrEnum):
    APPROVE = "approve"
    REQUEST_CHANGES = "request_changes"
    BLOCKED = "blocked"


class Severity(StrEnum):
    INFO = "info"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


def relative_path(value: str) -> str:
    """Validate portable repo-relative paths/scopes without resolving symlinks."""
    if not value or len(value) > 4096 or any(ord(char) < 32 for char in value):
        raise ValueError("path must be nonempty, bounded, and contain no control characters")
    if "\\" in value or re.match(r"^[A-Za-z]:", value):
        raise ValueError("path must use repository-relative POSIX notation")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("path must stay within the repository")
    return value


class Policy(Model):
    """Kernel-owned execution policy.

    ``network_access`` stays ``Literal[False]``: no run has needed egress from a
    check, and DevGod's first field failure was a policy that could not be
    widened.  Widen it only together with a run that required it.

    ``max_attempts`` is bounded by the kernel's own retry budget: ``Store``
    refuses a fourth attempt and reconciliation stops requeuing at the same
    ceiling, so the field advertises 1-3 rather than the 1-5 it once claimed and
    silently clamped (CORR-M2).  Values below the ceiling are honoured: the
    store reads the run's policy before requeuing, and a review child is not
    retried past it.
    """

    approval_policy: Literal["never"] = "never"
    network_access: Literal[False] = False
    review_model: ShortText | None = None
    review_routes: dict[Role, ModelRoute] = Field(default_factory=dict)
    fable_allowed: StrictBool = False
    max_parallel_reviews: int = Field(default=3, strict=True, ge=1, le=3)
    max_attempts: int = Field(default=3, strict=True, ge=1, le=ATTEMPT_CEILING)
    command_timeout_seconds: int = Field(default=600, strict=True, ge=1, le=3600)
    review_timeout_seconds: int = Field(default=900, strict=True, ge=1, le=3600)
    review_budget_usd: float = Field(default=3.0, gt=0, le=50, allow_inf_nan=False)
    max_output_bytes: int = Field(default=1_048_576, strict=True, ge=1024, le=16_777_216)

    @field_validator("review_model")
    @classmethod
    def nonblank_model(cls, value: str | None) -> str | None:
        return review_model_text(value) if value is not None else value

    def review_route(self, role: Role) -> ModelRoute:
        """Resolve a reviewer's explicit route without inheriting host settings."""
        if route := self.review_routes.get(role):
            return route
        if self.review_model is not None:
            return ModelRoute(model=self.review_model, effort="high")
        return ModelRoute(model="opus", effort="high")


class ModelRoute(Model):
    """Pinned model and effort for a role-owned Claude Code invocation.

    ``model`` is a Claude Code alias (``opus``/``sonnet``/``fable``) or a full
    model id.  A route is only ever a Witness route, so haiku is rejected here
    rather than merely discouraged: it does not reliably call the engine's
    ``StructuredOutput`` tool (docs/spikes.md S3), and a non-blank check alone
    let a manager-supplied policy weaken all three independent reviews at once
    (CORR-M4).
    """

    model: ShortText
    effort: Literal["low", "medium", "high", "xhigh", "max"] = "high"

    @field_validator("model")
    @classmethod
    def nonblank_model(cls, value: str) -> str:
        return review_model_text(value)


# Compatibility name used by service and adapter implementations.
ExecutionPolicy = Policy


class CheckSpec(Model):
    name: Identifier
    argv: list[Annotated[str, StringConstraints(strict=True, max_length=8192)]] = Field(
        min_length=1, max_length=128
    )
    cwd: PathText = "."
    timeout_seconds: int = Field(default=600, strict=True, ge=1, le=3600)
    acceptance_ids: list[Identifier] = Field(default_factory=list, max_length=256)

    _relative_cwd = field_validator("cwd")(relative_path)

    @field_validator("argv")
    @classmethod
    def bounded_argv(cls, value: list[str]) -> list[str]:
        if not value[0].strip():
            raise ValueError("command executable must not be empty")
        if any("\0" in arg for arg in value) or sum(len(arg) for arg in value) > 65_536:
            raise ValueError("command argv contains NUL or exceeds 65536 characters")
        return value


class AcceptanceCriterion(Model):
    acceptance_id: Identifier
    description: Text


class TaskSpec(Model):
    task_id: Identifier
    title: ShortText
    acceptance: list[Identifier] = Field(min_length=1, max_length=256)
    allowed_paths: list[PathText] = Field(min_length=1, max_length=256)
    owner_role: Identifier = "implementer"
    depends_on: list[Identifier] = Field(default_factory=list, max_length=256)

    @field_validator("allowed_paths")
    @classmethod
    def relative_scopes(cls, value: list[str]) -> list[str]:
        return [relative_path(path) for path in value]

    @model_validator(mode="after")
    def no_self_dependency(self) -> TaskSpec:
        if self.task_id in self.depends_on:
            raise ValueError("a task cannot depend on itself")
        if len(set(self.depends_on)) != len(self.depends_on):
            raise ValueError("task dependencies must be unique")
        return self


class RunSpec(Model):
    run_id: Identifier = Field(default_factory=lambda: f"run_{uuid4().hex}")
    repo_id: Identifier
    repo_root: PathText
    goal: Text
    acceptance: list[AcceptanceCriterion] = Field(min_length=1, max_length=256)
    tasks: list[TaskSpec] = Field(default_factory=list, max_length=4096)
    checks: list[CheckSpec] = Field(default_factory=list, max_length=256)
    decisions: dict[ShortText, Text] = Field(default_factory=dict, max_length=256)
    policy: Policy = Field(default_factory=Policy)
    branch: Annotated[str, StringConstraints(strict=True, max_length=256)] = ""
    base_revision: Annotated[str, StringConstraints(strict=True, max_length=128)] = ""
    worktree_id: Annotated[str, StringConstraints(strict=True, max_length=96)] = ""

    @model_validator(mode="after")
    def unique_specs(self) -> RunSpec:
        acceptance_ids = {item.acceptance_id for item in self.acceptance}
        if len(acceptance_ids) != len(self.acceptance):
            raise ValueError("acceptance IDs must be unique within a run")
        if len({task.task_id for task in self.tasks}) != len(self.tasks):
            raise ValueError("task IDs must be unique within a run")
        if len({check.name for check in self.checks}) != len(self.checks):
            raise ValueError("check names must be unique within a run")
        if any(set(task.acceptance) - acceptance_ids for task in self.tasks):
            raise ValueError("task acceptance must reference declared acceptance IDs")
        if any(set(check.acceptance_ids) - acceptance_ids for check in self.checks):
            raise ValueError("check acceptance must reference declared acceptance IDs")
        return self


class Candidate(Model):
    repo_id: Identifier
    repo_root: PathText
    branch: ShortText
    base_revision: Annotated[str, StringConstraints(strict=True, max_length=128)]
    head_revision: Annotated[str, StringConstraints(strict=True, max_length=128)]
    candidate_digest: Digest
    checks_digest: Digest
    snapshot_path: PathText | None = None
    worktree_id: Annotated[str, StringConstraints(strict=True, max_length=96)] = ""


class JobLease(Model):
    job_id: Identifier
    attempt: int = Field(strict=True, ge=1)
    lease_token: ShortText
    lease_expires_at: ShortText


class NextAction(Model):
    action: Identifier
    run_id: Identifier
    reason: Text
    task_id: Identifier | None = None
    inputs: dict[str, JsonValue] = Field(default_factory=dict)


class CommandResult(Model):
    invocation_id: Identifier
    exit_code: int | None = Field(strict=True)
    argv: list[str] = Field(default_factory=list, max_length=128)
    cwd: str = ""
    stdout: str = Field(default="", max_length=16_777_216)
    stderr: str = Field(default="", max_length=16_777_216)
    error: Text | None = None
    timed_out: StrictBool = False
    interrupted: StrictBool = False
    truncated: StrictBool = False
    duration_seconds: float = Field(default=0, ge=0, allow_inf_nan=False)
    started_at: ShortText | None = None
    finished_at: ShortText | None = None
    stdout_path: PathText | None = None
    stderr_path: PathText | None = None
    sandbox_profile_digest: Digest | None = None

    @property
    def succeeded(self) -> bool:
        return (
            self.exit_code == 0
            and self.error is None
            and not self.timed_out
            and not self.interrupted
        )


class Finding(Model):
    severity: Severity
    summary: Text
    path: PathText | None = None
    line: int | None = Field(default=None, strict=True, ge=1)
    recommendation: str = Field(default="", max_length=16_384)
    evidence_refs: list[PathText] = Field(default_factory=list, max_length=256)

    @field_validator("path")
    @classmethod
    def relative_finding(cls, value: str | None) -> str | None:
        return relative_path(value) if value is not None else value


class ReviewPayload(Model):
    decision: ReviewDecision
    summary: Text
    findings: list[Finding] = Field(default_factory=list, max_length=256)
    acceptance_ids: list[Identifier] = Field(default_factory=list, max_length=256)
    evidence_refs: list[PathText] = Field(default_factory=list, max_length=256)


class ReviewResult(Model):
    invocation_id: Identifier
    role: Role
    candidate_digest: Digest
    checks_digest: Digest
    payload: ReviewPayload | None = None
    session_id: ShortText | None = None
    result_uuid: ShortText | None = None
    error: Text | None = None
    rate_limited_until: int | None = Field(default=None, strict=True, ge=0)
    cost_usd: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    duration_seconds: float = Field(default=0, ge=0, allow_inf_nan=False)

    @property
    def succeeded(self) -> bool:
        return self.payload is not None and self.error is None


class GateResult(Model):
    verified: StrictBool
    candidate_digest: Digest
    checks_digest: Digest
    unmet_requirements: list[Text] = Field(default_factory=list, max_length=4096)
    evidence_ids: list[Identifier] = Field(default_factory=list, max_length=4096)

    @model_validator(mode="after")
    def consistent_result(self) -> GateResult:
        if self.verified and self.unmet_requirements:
            raise ValueError("verified gate cannot have unmet requirements")
        return self


class VerificationResult(Model):
    job_id: Identifier
    run_id: Identifier
    candidate: Candidate
    checks: list[CommandResult] = Field(default_factory=list, max_length=256)
    reviews: list[ReviewResult] = Field(default_factory=list, max_length=32)
    gate: GateResult | None = None
    error: Text | None = None


class ExecutionAdapter(Protocol):
    async def run_command(
        self,
        spec: CheckSpec,
        candidate: Candidate,
        policy: Policy,
        on_event: EventCallback | None = None,
        *,
        invocation_id: str | None = None,
    ) -> CommandResult: ...

    async def run_review(
        self,
        role: Role,
        candidate: Candidate,
        packet: dict[str, Any],
        policy: Policy,
        on_event: EventCallback | None = None,
        *,
        invocation_id: str | None = None,
    ) -> ReviewResult: ...

    def check_profile_digest(self, candidate: Candidate, policy: Policy) -> str:
        """The digest of the confinement the kernel itself would render here.

        The gate re-derives what it expects instead of trusting the digest a
        result reports: a receipt naming any other self-consistent profile used
        to pass (CORR-M3).  Synchronous, because the gate evaluates from the
        record.  Never a quoted value: the profile's shape changes.
        """
        ...

    async def cancel(self, invocation_id: str) -> None: ...

    def termination_confirmed(self, invocation_id: str) -> bool:
        """True only after the owned supervisor proves all descendants stopped."""
        ...

    async def recover_termination(self, identity: dict[str, Any]) -> bool:
        """Reconcile controller-persisted ownership; model claims are not proof."""
        ...

    async def capabilities(self) -> dict[str, Any]: ...

    async def close(self) -> None: ...
