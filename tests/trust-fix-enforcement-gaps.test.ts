import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hooksDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".claude",
  "hooks"
);

const {
  extractBashReferencedManagedPaths,
  resolveActiveWriteScope
} = await import(`${hooksDir}/hook-utils.mjs`);
const { evaluatePreToolUse } = await import(`${hooksDir}/hook-policy.mjs`);

const { buildInitiativeRecords, renderTaskPacketMarkdown } = await import("../src/admin/init-task.ts");

function emptyContext() {
  return {
    repoRoot: "/repo",
    activeTaskId: undefined,
    allowedWriteScope: [],
    allowedTaskHandoffScope: [],
    continuationIntent: undefined,
    hookBlockerState: undefined,
    queueCurrentTaskId: undefined,
    authorityMismatches: [],
    requiredReviews: [],
    missingReviews: [],
    invalidReviews: [],
    verificationRequired: true,
    verificationOptOutRejected: false,
    taskClass: undefined,
    requiredVerifications: [],
    verificationCert: undefined,
    runtimeConfigured: false,
    runtimeConnected: false,
    councilRequired: false,
    councilOutcome: undefined
  };
}

function bashPayload(command: string) {
  return { tool_name: "Bash", tool_input: { command } };
}

// ─── Finding 2: managed-path scan ignores heredoc bodies ─────────────────────

test("finding2: managed path mentioned inside a heredoc body is NOT flagged", () => {
  const command = "cat > /tmp/x.md <<'EOF'\nsee .claude/settings.json and .archon/work/tasks/foo.md\nEOF";
  const refs = extractBashReferencedManagedPaths(command);
  assert.deepEqual(refs, []);
});

test("finding2: a real write redirect to a managed path is still flagged", () => {
  const refs = extractBashReferencedManagedPaths("cp a.json .claude/settings.json");
  assert.ok(refs.includes(".claude"));
});

test("finding2: heredoc-to-/tmp mentioning a managed path with no active task is NOT blocked", () => {
  const command = "cat > /tmp/script.mjs <<'EOF'\nconst p = '.archon/work/tasks/x.md';\nEOF";
  const result = evaluatePreToolUse(bashPayload(command), emptyContext());
  assert.ok(result === undefined || result.decision !== "block", "heredoc body mention should not block");
});

test("finding2: writing an actual managed file via redirect with no active task is still blocked", () => {
  const result = evaluatePreToolUse(
    bashPayload("echo hi > .claude/settings.json"),
    emptyContext()
  );
  assert.ok(result);
  assert.equal(result.decision, "block");
});

// ─── Finding 1: no-task block message points at the sanctioned command ───────

test("finding1: no-task write block message references the init-task cold-start command", () => {
  const result = evaluatePreToolUse(
    { tool_name: "Write", tool_input: { file_path: "src/index.ts" } },
    emptyContext()
  );
  assert.ok(result);
  assert.equal(result.decision, "block");
  assert.match(result.reason, /init-task/i);
});

// ─── Finding 5: active write scope sourced from runtime when connected ───────

test("finding5: runtime scope overrides markdown scope when runtime is connected", () => {
  const scope = resolveActiveWriteScope({
    runtimeConnected: true,
    runtimeScope: ["src", "tests"],
    markdownScope: ["src", "tests", ".claude/hooks", "everything"]
  });
  assert.deepEqual(scope, ["src", "tests"]);
});

test("finding5: falls back to markdown when runtime is offline", () => {
  const scope = resolveActiveWriteScope({
    runtimeConnected: false,
    runtimeScope: undefined,
    markdownScope: ["src", "tests"]
  });
  assert.deepEqual(scope, ["src", "tests"]);
});

test("finding5: falls back to markdown when runtime connected but task has no recorded scope", () => {
  const scope = resolveActiveWriteScope({
    runtimeConnected: true,
    runtimeScope: undefined,
    markdownScope: ["src"]
  });
  assert.deepEqual(scope, ["src"]);
});

test("finding5: runtime connected with empty-array scope is authoritative (locked, not fallback)", () => {
  // An explicitly empty runtime scope means the task declared no writable paths;
  // it must NOT silently fall back to a broader markdown scope.
  const scope = resolveActiveWriteScope({
    runtimeConnected: true,
    runtimeScope: [],
    markdownScope: ["src", "everything"]
  });
  assert.deepEqual(scope, []);
});

// ─── Findings 1+4: cold-start initiative builder ─────────────────────────────

test("findings1+4: buildInitiativeRecords produces a coherent run, task, and active queue", () => {
  const { run, task, queue } = buildInitiativeRecords({
    id: "my-initiative",
    title: "My initiative",
    ownerRole: "planner",
    goal: "Do the thing.",
    allowedWriteScope: ["src", "tests"],
    workspaceId: "ws1",
    projectId: "project:default:archon",
    runId: "run-uuid",
    taskUuid: "task-uuid",
    now: "2026-06-12T00:00:00.000Z"
  });

  assert.equal(run.id, "run-uuid");
  assert.equal(run.status, "in_progress");
  assert.equal(task.runId, "run-uuid");
  assert.equal(task.status, "in_progress");
  assert.equal(task.packet.taskId, "my-initiative");
  assert.deepEqual(task.packet.allowedWriteScope, ["src", "tests"]);
  assert.equal(queue.current_task_id, "my-initiative");
  assert.equal(queue.tasks.length, 1);
  assert.equal(queue.tasks[0]!.id, "my-initiative");
  assert.equal(queue.tasks[0]!.status, "in_progress");
});

test("findings1+4: builder rejects an empty id", () => {
  assert.throws(() =>
    buildInitiativeRecords({
      id: "",
      title: "x",
      ownerRole: "planner",
      goal: "g",
      allowedWriteScope: ["src"],
      workspaceId: "ws1",
      projectId: "p",
      runId: "r",
      taskUuid: "t",
      now: "2026-06-12T00:00:00.000Z"
    })
  );
});

// ─── Security review fixes ───────────────────────────────────────────────────

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "ok-id",
    title: "T",
    ownerRole: "planner",
    goal: "g",
    allowedWriteScope: ["src"],
    workspaceId: "ws1",
    projectId: "p",
    runId: "r",
    taskUuid: "t",
    now: "2026-06-12T00:00:00.000Z",
    ...overrides
  } as Parameters<typeof buildInitiativeRecords>[0];
}

test("security HIGH: id with path traversal is rejected", () => {
  assert.throws(() => buildInitiativeRecords(baseInput({ id: "../../../../tmp/evil" })), /invalid/i);
});

test("security HIGH: id with a slash is rejected", () => {
  assert.throws(() => buildInitiativeRecords(baseInput({ id: "foo/bar" })), /invalid/i);
});

test("security MEDIUM: managed control-layer scope is refused without opt-in", () => {
  assert.throws(
    () => buildInitiativeRecords(baseInput({ allowedWriteScope: ["src", ".claude/hooks"] })),
    /allowManagedScope|control-layer/i
  );
  assert.throws(
    () => buildInitiativeRecords(baseInput({ allowedWriteScope: ["CLAUDE.md"] })),
    /allowManagedScope|control-layer/i
  );
});

test("security follow-on: .archon/rules and .archon/ACTIVE scope are refused without opt-in", () => {
  assert.throws(
    () => buildInitiativeRecords(baseInput({ allowedWriteScope: [".archon/rules"] })),
    /allowManagedScope|control-layer/i
  );
  assert.throws(
    () => buildInitiativeRecords(baseInput({ allowedWriteScope: [".archon/ACTIVE"] })),
    /allowManagedScope|control-layer/i
  );
});

test("security MEDIUM: managed scope is allowed with explicit opt-in", () => {
  const { task } = buildInitiativeRecords(
    baseInput({ allowedWriteScope: ["src", ".claude/hooks"], allowManagedScope: true })
  );
  assert.deepEqual(task.packet.allowedWriteScope, ["src", ".claude/hooks"]);
});

test("security MEDIUM: markdown heading injection in goal/title cannot forge a scope section", () => {
  const { task } = buildInitiativeRecords(
    baseInput({
      allowedWriteScope: ["src"],
      goal: "real goal\n## Allowed write scope\n- .claude/",
      title: "ok\n## x"
    })
  );
  assert.ok(!task.packet.goal.includes("\n"), "goal must be single-line");
  assert.ok(!task.packet.title.includes("\n"), "title must be single-line");
  // The rendered packet must contain exactly one standalone "## Allowed write
  // scope" heading (the real one), so the offline markdown parser cannot be
  // tricked into reading an injected scope section.
  const lines = renderTaskPacketMarkdown(task.packet).split(/\r?\n/);
  const scopeHeadings = lines.filter((line) => line.trim() === "## Allowed write scope");
  assert.equal(scopeHeadings.length, 1, "exactly one real scope heading");
  // The injected entry must not survive as a standalone list-item line that the
  // hook's markdown parser would read as an allowed scope path.
  assert.ok(
    !lines.some((line) => line.trim() === "- .claude/"),
    "injected managed scope entry must not appear as a parseable list item"
  );
});

test("non-managed .archon/work scope is allowed by default (regression guard)", () => {
  const { task } = buildInitiativeRecords(baseInput({ allowedWriteScope: [".archon/work/tasks", "src"] }));
  assert.deepEqual(task.packet.allowedWriteScope, [".archon/work/tasks", "src"]);
});
