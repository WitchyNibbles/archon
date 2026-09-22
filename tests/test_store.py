from __future__ import annotations

import json
import sqlite3
import stat
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from archon.models import GateResult, Policy
from archon.store import Store, StoreError


@pytest.fixture
def store(tmp_path):
    value = Store(tmp_path / "private")
    value.create_run({"worktree_id": "tree-a", "run_id": "run-a", "goal": "Example"}, [
        {"task_id": "one", "depends_on": [], "allowed_paths": ["src/"]}
    ])
    yield value
    value.close()


def candidate(digest="a"):
    return {"candidate_digest": digest * 64, "checks_digest": "b" * 64, "snapshot_path": "/private/snapshot"}


def job(store, kind="check", key="first"):
    return store.enqueue_job("run-a", kind, candidate(), idempotency_key=key)


def receipt():
    return {"kind": "check", "invocation_id": "observed", "candidate_digest": "a" * 64,
            "checks_digest": "b" * 64, "payload": {"succeeded": True}}


def test_parallel_enqueue_and_claim_are_exactly_once(store):
    second = Store(store.state_dir)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            records = list(pool.map(lambda item: job(item), (store, second)))
            claims = list(pool.map(lambda item: item.claim_job(records[0]["job_id"], "executor"), (store, second)))
        assert records[0]["job_id"] == records[1]["job_id"]
        assert sum(claim is not None for claim in claims) == 1
        assert len(store.list_jobs("run-a")) == 1
    finally:
        second.close()


def test_duplicate_snapshot_identity_reuses_original_job(store):
    original = job(store)
    altered = candidate()
    altered["snapshot_path"] = "/private/second-identical-snapshot"
    same = store.enqueue_job("run-a", "check", altered, idempotency_key="first")
    assert same["candidate"]["snapshot_path"] == original["candidate"]["snapshot_path"]
    with pytest.raises(StoreError, match="different operation"):
        store.enqueue_job("run-a", "check", candidate("c"), idempotency_key="first")


def test_expired_check_is_fenced_and_never_blindly_replayed(store):
    record = job(store)
    lease = store.claim_job(record["job_id"], "dead-owner")
    recovered = store.reconcile_jobs(now=store.get_job(record["job_id"])["lease_expires_at"] + 1)
    assert recovered[0]["state"] == "interrupted"
    assert not store.finish_job(lease, "succeeded")
    with pytest.raises(StoreError, match="Expired or superseded"):
        store._record_evidence(lease, receipt())
    with pytest.raises(StoreError, match="Inspect"):
        store.retry_job(record["job_id"], reason="automatic retry")
    assert store.list_evidence("run-a") == []


def test_expired_review_can_retry_but_old_generation_cannot_publish(store):
    record = store.enqueue_job("run-a", "review", candidate(), role="reviewer", idempotency_key="review")
    stale = store.claim_job(record["job_id"], "owner-one")
    store.reconcile_jobs(now=store.get_job(record["job_id"])["lease_expires_at"] + 1)
    current = store.claim_job(record["job_id"], "owner-two")
    assert current.attempt == stale.attempt + 1
    assert not store.finish_job(stale, "succeeded")
    assert store.finish_job(current, "failed", error={"message": "Malformed result", "next_action": "repair"})
    assert store.get_job(record["job_id"])["error"]["next_action"] == "repair"


def test_known_live_process_is_not_requeued_on_lease_expiry(store):
    record = job(store, "verification")
    lease = store.claim_job(record["job_id"], "executor")
    store.heartbeat(lease, process_id=123, process_identity="start-time")
    result = store.reconcile_jobs(now=store.get_job(record["job_id"])["lease_expires_at"] + 1,
                                  process_alive=lambda pid, identity: True)
    assert result[0]["state"] == "interrupted"


def test_evidence_ingestion_is_bound_idempotent_and_terminal(store):
    record = job(store)
    lease = store.claim_job(record["job_id"], "executor")
    wrong = receipt() | {"candidate_digest": "c" * 64}
    with pytest.raises(StoreError, match="candidate_digest"):
        store._record_evidence(lease, wrong)
    accepted = store._record_evidence(lease, receipt())
    assert store._record_evidence(lease, receipt())["evidence_id"] == accepted["evidence_id"]
    assert store.list_evidence("run-a") == []
    with pytest.raises(StoreError, match="Conflicting"):
        store._record_evidence(lease, receipt() | {"payload": {"succeeded": False}})
    store.finish_job(lease, "succeeded")
    assert len(store.list_evidence("run-a", "a" * 64, "b" * 64)) == 1
    assert store.list_evidence("run-a", "c" * 64) == []


def test_cancel_fences_all_owned_work_and_preserves_receipts(store):
    record = job(store)
    lease = store.claim_job(record["job_id"], "executor")
    owned = store.cancel_run("run-a")
    assert owned[0]["job_id"] == record["job_id"]
    assert store.get_run("run-a")["state"] == "cancelled"
    assert not store.finish_job(lease, "succeeded")
    with pytest.raises(StoreError, match="Cancelled"):
        store.update_task("run-a", "one", "implementing")


def test_task_claim_and_empty_gate_cannot_force_verified(store):
    with pytest.raises(StoreError, match="verification owns"):
        store.update_task("run-a", "one", "verified")
    store.update_task("run-a", "one", "implementing")
    store.update_task("run-a", "one", "verifying")
    with pytest.raises(StoreError, match="Incomplete evidence"):
        store._finalize_gate("run-a", GateResult(verified=True, candidate_digest="a" * 64, checks_digest="b" * 64))
    assert store.get_run("run-a")["state"] != "verified"


def test_runs_distinguish_worktrees_and_restore_checkpoint(store):
    with pytest.raises(StoreError, match="active run"):
        store.create_run({"worktree_id": "tree-a", "run_id": "another"})
    store.create_run({"worktree_id": "tree-b", "run_id": "run-b"})
    saved = store.save_checkpoint("run-a", {"next": "implement", "decisions": {"ux": "native"}})
    assert store.get_run("run-a")["checkpoint"] == saved
    assert len(store.list_runs("tree-a")) == 1
    store.append_event("run-a", "hook.stop", {"attempt": 1}, event_key="stop-event")
    store.append_event("run-a", "hook.stop", {"attempt": 1}, event_key="stop-event")
    assert len([e for e in store.events("run-a") if e["kind"] == "hook.stop"]) == 1


def test_competing_run_creation_claims_before_branch_preparation(store):
    second = Store(store.state_dir)
    preparations = []

    def create(pair):
        selected, run_id = pair
        spec = {"worktree_id": "new-tree", "run_id": run_id}

        def prepare():
            preparations.append(run_id)
            return spec, {}

        try:
            return selected.create_run(spec, _prepare=prepare)
        except StoreError:
            return None

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            created = list(pool.map(create, ((store, "first-run"), (second, "second-run"))))
        assert sum(item is not None for item in created) == 1
        assert len(preparations) == 1
    finally:
        second.close()


def test_large_derived_baseline_is_not_limited_like_model_context(store):
    baseline = {
        f"src/components/{number:08d}/implementation_long_filename.py": {
            "sha256": "a" * 64, "mode": 420, "size": 123, "kind": "file"
        }
        for number in range(15_000)
    }
    run = store.create_run({"worktree_id": "large-tree", "run_id": "large-run"}, baseline=baseline)
    assert run["baseline"] == baseline
    with pytest.raises(StoreError, match="2 MB"):
        store.save_checkpoint("large-run", {"text": "x" * 2_000_001})


def test_paused_job_is_hidden_from_claim_until_resume_at_then_claimable(store, monkeypatch):
    record = job(store)
    lease = store.claim_job(record["job_id"], "executor")
    resume_at = int(time.time()) + 1000
    assert store.pause_job(record["job_id"], lease.attempt, lease.lease_token, resume_at, "usage window closed")
    paused = store.get_job(record["job_id"])
    assert paused["state"] == "paused"
    assert paused["resume_at"] == resume_at
    assert store.claim_job(record["job_id"], "someone-else") is None
    # Advance the store's own clock (not a synthetic `now` passed only to one
    # call) so both `unpause_due_jobs` and `claim_job`'s own `time.time()`
    # agree the window has reopened, exactly as they would in production.
    monkeypatch.setattr("archon.store.time.time", lambda: resume_at + 1)
    requeued = store.unpause_due_jobs()
    assert [item["job_id"] for item in requeued] == [record["job_id"]]
    assert store.get_job(record["job_id"])["state"] == "queued"
    resumed = store.claim_job(record["job_id"], "someone-else")
    assert resumed is not None
    assert store.get_job(record["job_id"])["state"] == "running"


def test_pause_and_resume_preserve_the_running_attempt_number(store):
    record = job(store)
    lease = store.claim_job(record["job_id"], "executor")
    before = lease.attempt
    assert store.pause_job(record["job_id"], lease.attempt, lease.lease_token, int(time.time()) - 1, "usage window closed")
    store.unpause_due_jobs()
    resumed = store.claim_job(record["job_id"], "executor-2")
    assert resumed.attempt == before
    assert store.get_job(record["job_id"])["attempt"] == before


def test_pause_job_rejected_for_stale_lease_wrong_attempt_or_not_running(store, monkeypatch):
    record = job(store)
    lease = store.claim_job(record["job_id"], "executor")
    resume_at = int(time.time()) + 1000
    assert not store.pause_job(record["job_id"], lease.attempt + 1, lease.lease_token, resume_at, "wrong attempt")
    assert not store.pause_job(record["job_id"], lease.attempt, "wrong-token", resume_at, "wrong token")
    expired_at = store.get_job(record["job_id"])["lease_expires_at"] + 1
    monkeypatch.setattr("archon.store.time.time", lambda: expired_at)
    assert not store.pause_job(record["job_id"], lease.attempt, lease.lease_token, resume_at, "stale lease")
    monkeypatch.undo()
    other = job(store, key="not-running")
    assert not store.pause_job(other["job_id"], 1, "whatever", resume_at, "not running")
    assert store.pause_job(record["job_id"], lease.attempt, lease.lease_token, resume_at, "actually pause")
    assert store.get_job(record["job_id"])["state"] == "paused"
    assert not store.pause_job(record["job_id"], lease.attempt, lease.lease_token, resume_at, "already paused")


def test_unpause_due_jobs_requeues_exactly_once_even_if_called_repeatedly(store):
    record = job(store)
    lease = store.claim_job(record["job_id"], "executor")
    assert store.pause_job(record["job_id"], lease.attempt, lease.lease_token, int(time.time()) - 1, "already due")
    first = store.unpause_due_jobs()
    assert [item["job_id"] for item in first] == [record["job_id"]]
    assert store.get_job(record["job_id"])["state"] == "queued"
    assert store.unpause_due_jobs() == []
    assert store.reconcile_jobs() == []


_LEGACY_V1_SCHEMA = """
    CREATE TABLE runs (
        run_id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL, state TEXT NOT NULL,
        spec TEXT NOT NULL, baseline TEXT, checkpoint TEXT, gate TEXT,
        created_at REAL NOT NULL, updated_at REAL NOT NULL
    );
    CREATE UNIQUE INDEX active_worktree ON runs(worktree_id)
        WHERE state NOT IN ('verified','cancelled');
    CREATE TABLE tasks (
        run_id TEXT NOT NULL REFERENCES runs(run_id), task_id TEXT NOT NULL,
        state TEXT NOT NULL, spec TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(run_id,task_id)
    );
    CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
        kind TEXT NOT NULL, role TEXT, state TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, candidate TEXT NOT NULL,
        payload TEXT NOT NULL, result TEXT, error TEXT,
        attempt INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_expires_at REAL,
        owner TEXT, process_id INTEGER, process_identity TEXT,
        created_at REAL NOT NULL, updated_at REAL NOT NULL
    );
    CREATE INDEX jobs_run ON jobs(run_id,state);
    CREATE TABLE evidence (
        evidence_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
        job_id TEXT NOT NULL REFERENCES jobs(job_id), attempt INTEGER NOT NULL,
        kind TEXT NOT NULL, invocation_id TEXT NOT NULL,
        candidate_digest TEXT NOT NULL, checks_digest TEXT NOT NULL,
        payload TEXT NOT NULL, created_at REAL NOT NULL,
        UNIQUE(job_id,attempt,kind,invocation_id)
    );
    CREATE TABLE checkpoints (
        checkpoint_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
        payload TEXT NOT NULL, created_at REAL NOT NULL
    );
    CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id), job_id TEXT,
        kind TEXT NOT NULL, payload TEXT NOT NULL, created_at REAL NOT NULL,
        event_key TEXT UNIQUE
    );
    PRAGMA user_version=1;
"""


def test_v1_database_opens_and_migrates_to_the_current_schema_keeping_its_rows(tmp_path):
    state_dir = tmp_path / "legacy"
    state_dir.mkdir(mode=0o700)
    legacy = sqlite3.connect(state_dir / "state.sqlite3")
    # A spec written by a release that still advertised `scratch_bytes`. `Policy`
    # forbids unknown fields, so without the migration this run would refuse to
    # load and could never be repaired (SEC-M5 removal, fail open).
    legacy_spec = {"goal": "Preexisting", "policy": {"max_attempts": 2, "scratch_bytes": 2_147_483_648}}
    try:
        legacy.executescript(_LEGACY_V1_SCHEMA)
        legacy.execute("INSERT INTO runs(run_id,worktree_id,state,spec,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                       ("legacy-run", "legacy-tree", "active", json.dumps(legacy_spec), 1.0, 1.0))
        legacy.execute(
            "INSERT INTO jobs(job_id,run_id,kind,state,idempotency_key,candidate,payload,attempt,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            ("legacy-job", "legacy-run", "check", "queued", "legacy-key", json.dumps({}), json.dumps({}), 0, 1.0, 1.0))
        legacy.commit()
    finally:
        legacy.close()

    upgraded = Store(state_dir)
    try:
        assert upgraded._db.execute("PRAGMA user_version").fetchone()[0] == 3
        run = upgraded.get_run("legacy-run")
        assert run["spec"] == {"goal": "Preexisting", "policy": {"max_attempts": 2}}
        assert Policy.model_validate(run["spec"]["policy"]).max_attempts == 2
        jobs = upgraded.list_jobs("legacy-run")
        assert len(jobs) == 1
        assert jobs[0]["job_id"] == "legacy-job"
        assert jobs[0]["resume_at"] is None
        lease = upgraded.claim_job("legacy-job", "executor")
        assert lease is not None
        assert lease.attempt == 1
    finally:
        upgraded.close()


def test_a_requeued_job_is_not_claimable_before_its_own_window_reopens(store, monkeypatch):
    """QA-M3: deleting this fence left the whole suite green.

    `unpause_due_jobs` accepts a caller-supplied clock, and reconciliation passes
    one. A sweep run ahead of the real clock requeues a row whose provider window
    is still closed; claiming it would spend a real attempt against that closed
    window. The row stays queued and unclaimable until its own `resume_at` passes.
    """
    record = job(store)
    lease = store.claim_job(record["job_id"], "executor")
    resume_at = int(time.time()) + 1000
    assert store.pause_job(record["job_id"], lease.attempt, lease.lease_token, resume_at, "usage window closed")
    assert [item["job_id"] for item in store.unpause_due_jobs(resume_at + 1)] == [record["job_id"]]
    assert store.get_job(record["job_id"])["state"] == "queued"
    assert store.claim_job(record["job_id"], "executor-2") is None, "claimed before the window reopened"
    monkeypatch.setattr("archon.store.time.time", lambda: resume_at + 1)
    resumed = store.claim_job(record["job_id"], "executor-2")
    assert resumed is not None and resumed.attempt == lease.attempt


def test_a_paused_job_is_active_for_plan_amendment_and_cancellation(store):
    """CORR-H2: `paused` never reached the predicates that spell "still active"."""
    record = job(store, "verification")
    lease = store.claim_job(record["job_id"], "executor")
    resume_at = int(time.time()) + 18_000
    assert store.pause_job(record["job_id"], lease.attempt, lease.lease_token, resume_at, "usage window closed")
    tasks = [item["spec"] for item in store.list_tasks("run-a")]
    with pytest.raises(StoreError, match="active verification"):
        store.replace_plan("run-a", tasks, [{"name": "new", "argv": ["true"]}],
                           expected_updated_at=store.get_run("run-a")["updated_at"])
    owned = store.cancel_run("run-a")
    assert [item["job_id"] for item in owned] == [record["job_id"]]
    parked = store.get_job(record["job_id"])
    assert parked["state"] == "cancelled"
    # Its window must not reopen it into a cancelled run.
    assert parked["resume_at"] is None
    assert store.unpause_due_jobs(resume_at + 1) == []


def test_completion_waits_for_this_candidates_paused_job_only(store):
    """CORR-H2 and CORR-H1: paused work counts; an abandoned candidate's does not."""
    store.update_task("run-a", "one", "implementing")
    store.update_task("run-a", "one", "verifying")
    producer = job(store, key="evidence-producer")
    lease = store.claim_job(producer["job_id"], "executor")
    evidence = store._record_evidence(lease, receipt())
    store.finish_job(lease, "succeeded")
    gate = GateResult(verified=True, candidate_digest="a" * 64, checks_digest="b" * 64,
                      evidence_ids=[evidence["evidence_id"]])

    # A sibling parked on a usage window for *this* candidate is still pending.
    parked = job(store, key="parked-sibling")
    parked_lease = store.claim_job(parked["job_id"], "executor")
    assert store.pause_job(parked["job_id"], parked_lease.attempt, parked_lease.lease_token,
                           int(time.time()) - 1, "usage window closed")
    with pytest.raises(StoreError, match="Pending jobs"):
        store._finalize_gate("run-a", gate)
    assert store.get_run("run-a")["state"] != "verified"

    # A row bound to a candidate nobody is delivering blocks nothing: a delivery
    # that passed every check must not be stranded by an abandoned attempt.
    abandoned = store.enqueue_job("run-a", "check", candidate("c"), idempotency_key="abandoned")
    abandoned_lease = store.claim_job(abandoned["job_id"], "executor")
    assert store.pause_job(abandoned["job_id"], abandoned_lease.attempt, abandoned_lease.lease_token,
                           int(time.time()) + 18_000, "usage window closed")
    store.unpause_due_jobs()
    store.finish_job(store.claim_job(parked["job_id"], "executor"), "succeeded")
    assert store.get_job(abandoned["job_id"])["state"] == "paused"
    assert store._finalize_gate("run-a", gate)["state"] == "verified"


def test_superseded_rows_are_disposed_and_revived_if_their_candidate_returns(store):
    """CORR-H1: a stale row is terminal, not claimable, and never a dead end."""
    stale = store.enqueue_job("run-a", "verification", candidate("c"), idempotency_key="abandoned-coordinator")
    current = job(store, "verification", key="current-coordinator")
    superseded = store._supersede_jobs("run-a", candidate_digest="a" * 64, checks_digest="b" * 64)
    assert [item["job_id"] for item in superseded] == [stale["job_id"]]
    assert store.get_job(stale["job_id"])["state"] == "cancelled"
    assert store.get_job(current["job_id"])["state"] == "queued"
    assert store.claim_job(stale["job_id"], "executor") is None
    assert "Superseded" in store.get_job(stale["job_id"])["error"]["message"]

    # Fail open: the dispatch key is derived from the candidate, so a manager who
    # restores exactly that source must not meet a permanently dead row.
    revived = store.enqueue_job("run-a", "verification", candidate("c"), idempotency_key="abandoned-coordinator")
    assert revived["job_id"] == stale["job_id"] and revived["state"] == "queued"
    store.cancel_run("run-a")
    again = store.enqueue_job("run-a", "verification", candidate("c"), idempotency_key="abandoned-coordinator")
    assert again["state"] == "cancelled", "a cancelled run must not resurrect its work"


def test_the_retry_budget_follows_the_accepted_policy(store):
    """CORR-M2: the store hardcoded three attempts whatever the policy said."""
    store.create_run({"worktree_id": "tree-b", "run_id": "run-b", "goal": "Example",
                      "policy": {"max_attempts": 1}})
    bounded = store.enqueue_job("run-b", "review", candidate(), role="reviewer", idempotency_key="bounded")
    lease = store.claim_job(bounded["job_id"], "executor")
    assert store.finish_job(lease, "failed", error={"message": "provider fault"})
    with pytest.raises(StoreError, match="Retry budget"):
        store.retry_job(bounded["job_id"], reason="automatic resume")
    # An expired attempt is not requeued past the same ceiling either.
    second = store.enqueue_job("run-b", "review", candidate(), role="reviewer", idempotency_key="bounded-expiry")
    store.claim_job(second["job_id"], "executor")
    store.reconcile_jobs(now=store.get_job(second["job_id"])["lease_expires_at"] + 1)
    assert store.get_job(second["job_id"])["state"] == "interrupted"

    # The control: the default policy still allows the kernel's three attempts.
    default = store.enqueue_job("run-a", "review", candidate(), role="reviewer", idempotency_key="default")
    default_lease = store.claim_job(default["job_id"], "executor")
    store.finish_job(default_lease, "failed", error={"message": "provider fault"})
    assert store.retry_job(default["job_id"], reason="automatic resume")["state"] == "queued"


def test_unpause_is_scoped_to_the_run_that_asked(store):
    """CORR-L1..L4: dispatching one run woke another run's parked work."""
    store.create_run({"worktree_id": "tree-b", "run_id": "run-b", "goal": "Other delivery"})
    other = store.enqueue_job("run-b", "check", candidate(), idempotency_key="other-run")
    mine = job(store, key="my-run")
    for record in (other, mine):
        lease = store.claim_job(record["job_id"], "executor")
        assert store.pause_job(record["job_id"], lease.attempt, lease.lease_token,
                               int(time.time()) - 1, "already due")
    assert [item["job_id"] for item in store.unpause_due_jobs(run_id="run-a")] == [mine["job_id"]]
    assert store.get_job(other["job_id"])["state"] == "paused"
    assert [item["job_id"] for item in store.unpause_due_jobs()] == [other["job_id"]]


def test_write_ahead_sidecars_are_as_private_as_the_database(tmp_path):
    """SEC-L4: the WAL holds the same committed evidence the database does.

    Write-ahead logging publishes `state.sqlite3-wal` and `-shm` beside the
    database at the ambient umask, so without this only the 0700 state directory
    stood between a run's evidence and every other account on the host.
    """
    store = Store(tmp_path / "private")
    try:
        store.create_run({"worktree_id": "tree-wal", "run_id": "run-wal", "goal": "Force a write"})
        present = 0
        for suffix in ("-wal", "-shm"):
            sidecar = store.path.with_name(store.path.name + suffix)
            if not sidecar.exists():
                continue
            present += 1
            assert stat.S_IMODE(sidecar.stat().st_mode) == 0o600, sidecar
        assert present, "write-ahead logging produced no sidecar to check"
        assert stat.S_IMODE(store.path.stat().st_mode) == 0o600
    finally:
        store.close()
