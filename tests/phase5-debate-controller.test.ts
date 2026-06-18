// Phase 5: Multi-Agent Debate Runtime — unit tests.
//
// Tests cover:
//   1. shouldDebate returns true for architecture_significant
//   2. shouldDebate returns true for security_trust_boundary
//   3. shouldDebate returns true for migration_data_loss
//   4. shouldDebate returns true for high_uncertainty
//   5. shouldDebate returns true for product_behavior_ambiguous
//   6. shouldDebate returns true for release_blocking_disagreement
//   7. shouldDebate returns false for trivial_edit
//   8. shouldDebate returns false for already_approved
//   9. start — creates session with status "open"
//  10. addArgument — persists argument with correct sessionId
//  11. addArgument — throws on empty role
//  12. finalizeDecision — rejects when evidenceRefs is empty
//  13. buildDebateReport — includes topic and outcome in output
//
// Uses node:test + node:assert/strict (no vitest).

import test from "node:test";
import assert from "node:assert/strict";
import { DebateController } from "../src/runtime/debate-controller.ts";
import type {
  DebateStoreLike,
  DebateSessionRecord
} from "../src/runtime/debate-controller.ts";
import type { DebateSession, DebateArgument } from "../src/domain/types.ts";

// ---------------------------------------------------------------------------
// Mock store
// ---------------------------------------------------------------------------

class MockDebateStore implements DebateStoreLike {
  readonly sessions: Map<string, DebateSession> = new Map();
  readonly arguments: DebateArgument[] = [];
  readonly decisions: Map<string, Record<string, unknown>> = new Map();

  async createDebateSession(data: {
    id: string;
    runId: string;
    taskId?: string | undefined;
    topic: string;
    triggerKind: string;
    status: string;
    createdAt?: string | undefined;
  }): Promise<DebateSession> {
    const session: DebateSession = {
      id: data.id,
      runId: data.runId,
      taskId: data.taskId,
      topic: data.topic,
      triggerKind: data.triggerKind,
      status: data.status,
      createdAt: data.createdAt ?? new Date().toISOString()
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async addDebateArgument(data: {
    id: string;
    debateSessionId: string;
    round: number;
    role: string;
    position: string;
    evidenceRefs?: string[] | undefined;
    critiques?: string[] | undefined;
    vote?: string | undefined;
    createdAt?: string | undefined;
  }): Promise<DebateArgument> {
    const arg: DebateArgument = {
      id: data.id,
      debateSessionId: data.debateSessionId,
      round: data.round,
      role: data.role,
      position: data.position,
      evidenceRefs: data.evidenceRefs ?? [],
      critiques: data.critiques ?? [],
      vote: data.vote,
      createdAt: data.createdAt ?? new Date().toISOString()
    };
    this.arguments.push(arg);
    return arg;
  }

  async updateDebateDecision(
    sessionId: string,
    decision: Record<string, unknown>
  ): Promise<void> {
    this.decisions.set(sessionId, decision);
  }

  async getDebateSession(sessionId: string): Promise<DebateSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }
}

function makeController(): { controller: DebateController; store: MockDebateStore } {
  const store = new MockDebateStore();
  const controller = new DebateController(store);
  return { controller, store };
}

// ---------------------------------------------------------------------------
// shouldDebate — trigger kinds that require debate
// ---------------------------------------------------------------------------

test("shouldDebate returns true for architecture_significant", () => {
  const { controller } = makeController();
  assert.equal(controller.shouldDebate({ kind: "architecture_significant" }), true);
});

test("shouldDebate returns true for security_trust_boundary", () => {
  const { controller } = makeController();
  assert.equal(controller.shouldDebate({ kind: "security_trust_boundary" }), true);
});

test("shouldDebate returns true for migration_data_loss", () => {
  const { controller } = makeController();
  assert.equal(controller.shouldDebate({ kind: "migration_data_loss" }), true);
});

test("shouldDebate returns true for high_uncertainty", () => {
  const { controller } = makeController();
  assert.equal(controller.shouldDebate({ kind: "high_uncertainty" }), true);
});

test("shouldDebate returns true for product_behavior_ambiguous", () => {
  const { controller } = makeController();
  assert.equal(controller.shouldDebate({ kind: "product_behavior_ambiguous" }), true);
});

test("shouldDebate returns true for release_blocking_disagreement", () => {
  const { controller } = makeController();
  assert.equal(controller.shouldDebate({ kind: "release_blocking_disagreement" }), true);
});

// ---------------------------------------------------------------------------
// shouldDebate — trigger kinds that skip debate
// ---------------------------------------------------------------------------

test("shouldDebate returns false for trivial_edit", () => {
  const { controller } = makeController();
  assert.equal(controller.shouldDebate({ kind: "trivial_edit" }), false);
});

test("shouldDebate returns false for already_approved", () => {
  const { controller } = makeController();
  assert.equal(controller.shouldDebate({ kind: "already_approved" }), false);
});

// ---------------------------------------------------------------------------
// start — session creation
// ---------------------------------------------------------------------------

test("start creates session with status 'open'", async () => {
  const { controller, store } = makeController();

  const session = await controller.start({
    runId: "run_001",
    topic: "Should we adopt a new auth library?",
    triggerKind: "architecture_significant"
  });

  assert.equal(session.status, "open");
  assert.equal(session.runId, "run_001");
  assert.equal(session.topic, "Should we adopt a new auth library?");
  assert.equal(session.triggerKind, "architecture_significant");
  assert.ok(session.id.length > 0);

  // Record is in store
  const stored = store.sessions.get(session.id);
  assert.ok(stored !== undefined);
  assert.equal(stored.status, "open");
});

// ---------------------------------------------------------------------------
// addArgument — persist and validate
// ---------------------------------------------------------------------------

test("addArgument persists argument with correct sessionId", async () => {
  const { controller, store } = makeController();

  const session = await controller.start({
    runId: "run_002",
    topic: "Security boundary question",
    triggerKind: "security_trust_boundary"
  });

  await controller.addArgument(session.id, {
    role: "security_reviewer",
    round: 1,
    position: "We must not share tokens across service boundaries.",
    evidenceRefs: ["ref-001"],
    vote: "approve"
  });

  assert.equal(store.arguments.length, 1);
  const arg = store.arguments[0];
  assert.ok(arg !== undefined);
  assert.equal(arg.debateSessionId, session.id);
  assert.equal(arg.role, "security_reviewer");
  assert.equal(arg.round, 1);
  assert.equal(arg.vote, "approve");
});

test("addArgument throws on empty role", async () => {
  const { controller } = makeController();

  await assert.rejects(
    () =>
      controller.addArgument("session_001", {
        role: "   ",
        round: 1,
        position: "Some position"
      }),
    /role.*must be non-empty/i
  );
});

// ---------------------------------------------------------------------------
// finalizeDecision — validation
// ---------------------------------------------------------------------------

test("finalizeDecision rejects when evidenceRefs is empty", async () => {
  const { controller } = makeController();

  await assert.rejects(
    () =>
      controller.finalizeDecision("session_001", {
        outcome: "approved",
        vote: { approve: 3, rework: 0, reject: 0 },
        dissent: { owner: "dissenter", summary: "Minority view" },
        evidenceRefs: []
      }),
    /at least one evidenceRef/i
  );
});

// ---------------------------------------------------------------------------
// getSession — retrieve session by ID
// ---------------------------------------------------------------------------

test("getSession returns the session record when store has getDebateSession and session is found", async () => {
  const { controller, store } = makeController();

  const session = await controller.start({
    runId: "run_get_001",
    topic: "Session retrieval test",
    triggerKind: "high_uncertainty"
  });

  const retrieved = await controller.getSession(session.id);

  assert.ok(retrieved !== null, "Expected a non-null session record");
  assert.equal(retrieved?.id, session.id);
  assert.equal(retrieved?.topic, "Session retrieval test");
  assert.equal(retrieved?.status, "open");
});

test("getSession returns null when session is not found", async () => {
  const { controller } = makeController();

  const result = await controller.getSession("nonexistent_session_id");

  assert.equal(result, null, "Expected null for a session ID that does not exist");
});

// ---------------------------------------------------------------------------
// addArgument — empty position
// ---------------------------------------------------------------------------

test("addArgument rejects when position is whitespace-only", async () => {
  const { controller } = makeController();

  await assert.rejects(
    () =>
      controller.addArgument("session_001", {
        role: "planner",
        round: 1,
        position: "   "
      }),
    /position.*must be non-empty/i
  );
});

// ---------------------------------------------------------------------------
// finalizeDecision — invalid outcome and empty dissent owner
// ---------------------------------------------------------------------------

test("finalizeDecision rejects when outcome is an invalid value", async () => {
  const { controller } = makeController();

  await assert.rejects(
    () =>
      controller.finalizeDecision("session_001", {
        outcome: "invalid_value" as "approved",
        vote: { approve: 1, rework: 0, reject: 0 },
        dissent: { owner: "planner", summary: "Some dissent" },
        evidenceRefs: ["ref-001"]
      }),
    /invalid outcome/i
  );
});

test("finalizeDecision rejects when dissent owner is empty string", async () => {
  const { controller } = makeController();

  await assert.rejects(
    () =>
      controller.finalizeDecision("session_001", {
        outcome: "approved",
        vote: { approve: 3, rework: 0, reject: 0 },
        dissent: { owner: "", summary: "Minority view" },
        evidenceRefs: ["ref-001"]
      }),
    /dissent\.owner.*must be non-empty/i
  );
});

// ---------------------------------------------------------------------------
// buildDebateReport — output content
// ---------------------------------------------------------------------------

test("buildDebateReport includes topic and outcome in output", () => {
  const { controller } = makeController();

  const session: DebateSessionRecord = {
    id: "session_abc",
    runId: "run_999",
    topic: "Migrate data with zero downtime",
    triggerKind: "migration_data_loss",
    status: "completed",
    createdAt: "2026-06-17T10:00:00.000Z",
    decision: {
      outcome: "approved_with_conditions",
      vote: { approve: 2, rework: 1, reject: 0 },
      dissent: { owner: "infra_engineer", summary: "Rollback plan not sufficient" },
      conditions: ["Add rollback playbook"],
      evidenceRefs: ["evidence-001", "evidence-002"]
    }
  };

  const report = controller.buildDebateReport(session);

  assert.ok(report.includes("Migrate data with zero downtime"), "topic missing from report");
  assert.ok(report.includes("approved_with_conditions"), "outcome missing from report");
  assert.ok(report.includes("infra_engineer"), "dissent owner missing from report");
  assert.ok(report.includes("Add rollback playbook"), "condition missing from report");
  assert.ok(report.includes("evidence-001"), "evidence ref missing from report");
  assert.ok(report.includes("# Debate Report"), "report header missing");
});
