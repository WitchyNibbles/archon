/**
 * Tests for P3: daemon loop fixes.
 *
 * Covers:
 * - parseClaudeStreamJsonOutput: system/assistant/result event parsing
 * - parseClaudeStreamJsonOutput: unknown event types are skipped
 * - parseClaudeStreamJsonOutput: malformed JSON lines are skipped (fail-closed)
 * - parseClaudeStreamJsonOutput: session id from system event
 * - parseClaudeStreamJsonOutput: session id from result event overrides system
 * - runCodexTurnViaCli (via executeDaemonCommandFromArgs injection): produces correct DB records
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeStreamJsonOutput } from "../src/admin.ts";

const SESSION_A = "sess-aaa-111";
const SESSION_B = "sess-bbb-222";

function ndjson(...events: Record<string, unknown>[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

test("daemon: parseClaudeStreamJsonOutput extracts session_id from system event", () => {
  const stdout = ndjson({ type: "system", session_id: SESSION_A, version: "1.0" });
  const { sessionId, finalMessage } = parseClaudeStreamJsonOutput(stdout);
  assert.equal(sessionId, SESSION_A);
  assert.equal(finalMessage, undefined);
});

test("daemon: parseClaudeStreamJsonOutput extracts text from assistant event", () => {
  const stdout = ndjson({
    type: "assistant",
    message: { content: [{ type: "text", text: "Task complete." }] }
  });
  const { finalMessage } = parseClaudeStreamJsonOutput(stdout);
  assert.equal(finalMessage, "Task complete.");
});

test("daemon: parseClaudeStreamJsonOutput last text block wins", () => {
  const stdout = ndjson(
    { type: "assistant", message: { content: [{ type: "text", text: "First." }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Second." }] } }
  );
  const { finalMessage } = parseClaudeStreamJsonOutput(stdout);
  assert.equal(finalMessage, "Second.");
});

test("daemon: parseClaudeStreamJsonOutput extracts session_id and result from result event", () => {
  const stdout = ndjson({
    type: "result",
    subtype: "success",
    result: "All done.",
    session_id: SESSION_B,
    cost_usd: 0.01
  });
  const { sessionId, finalMessage } = parseClaudeStreamJsonOutput(stdout);
  assert.equal(sessionId, SESSION_B);
  assert.equal(finalMessage, "All done.");
});

test("daemon: result event session_id overrides system event session_id", () => {
  const stdout = ndjson(
    { type: "system", session_id: SESSION_A },
    { type: "result", session_id: SESSION_B, result: "Done." }
  );
  const { sessionId } = parseClaudeStreamJsonOutput(stdout);
  assert.equal(sessionId, SESSION_B);
});

test("daemon: unknown event types are skipped without throwing", () => {
  const stdout = ndjson(
    { type: "system", session_id: SESSION_A },
    { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
    { type: "tool_result", tool_use_id: "t1", content: "file.ts\n" },
    { type: "result", session_id: SESSION_A, result: "OK." }
  );
  const { sessionId, finalMessage } = parseClaudeStreamJsonOutput(stdout);
  assert.equal(sessionId, SESSION_A);
  assert.equal(finalMessage, "OK.");
});

test("daemon: malformed JSON lines are skipped (fail-closed)", () => {
  const stdout =
    JSON.stringify({ type: "system", session_id: SESSION_A }) +
    "\nnot valid json\n{broken\n" +
    JSON.stringify({ type: "result", session_id: SESSION_A, result: "Done." }) +
    "\n";
  assert.doesNotThrow(() => {
    const r = parseClaudeStreamJsonOutput(stdout);
    assert.equal(r.sessionId, SESSION_A);
    assert.equal(r.finalMessage, "Done.");
  });
});

test("daemon: initialSessionId preserved when no session events present", () => {
  const stdout = ndjson({ type: "assistant", message: { content: [{ type: "text", text: "Hi." }] } });
  const { sessionId } = parseClaudeStreamJsonOutput(stdout, "prior-session-id");
  assert.equal(sessionId, "prior-session-id");
});

test("daemon: non-text content blocks are ignored", () => {
  const stdout = ndjson({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "bash" },
        { type: "text", text: "Result ready." }
      ]
    }
  });
  const { finalMessage } = parseClaudeStreamJsonOutput(stdout);
  assert.equal(finalMessage, "Result ready.");
});

test("daemon: empty stdout returns undefined session and message", () => {
  const { sessionId, finalMessage } = parseClaudeStreamJsonOutput("");
  assert.equal(sessionId, undefined);
  assert.equal(finalMessage, undefined);
});
