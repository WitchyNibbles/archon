// Phase 1 (ahrP1Sampling) — turn-prompt usage extraction tests.
//
// RED phase: tests for the new `usage` field on RunCodexTurnResult and the
// extraction of usage from the `result` event inside parseClaudeStreamJsonOutput.
// These tests FAIL until turn-prompt.ts is modified.
//
// Uses node:test + node:assert/strict.

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeStreamJsonOutput } from "../src/daemon/turn-prompt.ts";
import type { RunCodexTurnResult } from "../src/daemon/turn-prompt.ts";

// ---------------------------------------------------------------------------
// parseClaudeStreamJsonOutput — usage extraction from result event
// ---------------------------------------------------------------------------

describe("parseClaudeStreamJsonOutput usage extraction", () => {
  it("extracts usage from the result event", () => {
    const stdout = JSON.stringify({
      type: "result",
      session_id: "sess-1",
      result: "done",
      usage: {
        input_tokens: 10_000,
        output_tokens: 2_000,
        cache_read_input_tokens: 5_000,
        cache_creation_input_tokens: 1_000
      }
    });

    const parsed = parseClaudeStreamJsonOutput(stdout, undefined);
    assert.deepEqual(parsed.usage, {
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 5_000,
      cacheCreationTokens: 1_000
    });
  });

  it("returns usage: undefined when result event has no usage", () => {
    const stdout = JSON.stringify({
      type: "result",
      session_id: "sess-1",
      result: "done"
    });

    const parsed = parseClaudeStreamJsonOutput(stdout, undefined);
    assert.equal(parsed.usage, undefined);
  });

  it("returns usage: undefined when result event has malformed usage (non-object)", () => {
    const stdout = JSON.stringify({
      type: "result",
      session_id: "sess-1",
      result: "done",
      usage: "not-an-object"
    });

    const parsed = parseClaudeStreamJsonOutput(stdout, undefined);
    assert.equal(parsed.usage, undefined);
  });

  it("returns usage: undefined when result event has usage with missing fields", () => {
    const stdout = JSON.stringify({
      type: "result",
      session_id: "sess-1",
      result: "done",
      usage: { input_tokens: 100 }
    });

    // Partial usage: missing output_tokens etc. — still extracts what's there
    // (zero for missing numeric fields)
    const parsed = parseClaudeStreamJsonOutput(stdout, undefined);
    assert.deepEqual(parsed.usage, {
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    });
  });

  it("does not throw on a completely unparseable line; still extracts from valid lines", () => {
    const lines = [
      "not-json{{{",
      JSON.stringify({
        type: "result",
        session_id: "sess-2",
        result: "done",
        usage: {
          input_tokens: 50_000,
          output_tokens: 1_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        }
      })
    ];
    const parsed = parseClaudeStreamJsonOutput(lines.join("\n"), undefined);
    assert.equal(parsed.sessionId, "sess-2");
    assert.deepEqual(parsed.usage, {
      inputTokens: 50_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    });
  });

  it("still extracts sessionId and finalMessage when usage is absent", () => {
    const stdout = JSON.stringify({
      type: "result",
      session_id: "sess-3",
      result: "final message text"
    });

    const parsed = parseClaudeStreamJsonOutput(stdout, undefined);
    assert.equal(parsed.sessionId, "sess-3");
    assert.equal(parsed.finalMessage, "final message text");
    assert.equal(parsed.usage, undefined);
  });

  it("does not affect non-result event parsing (assistant event still works)", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "hello" }]
        }
      }),
      JSON.stringify({
        type: "result",
        session_id: "sess-4",
        result: "",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        }
      })
    ].join("\n");

    const parsed = parseClaudeStreamJsonOutput(stdout, undefined);
    assert.equal(parsed.sessionId, "sess-4");
    assert.equal(parsed.finalMessage, "hello");
    assert.deepEqual(parsed.usage, {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    });
  });
});

// ---------------------------------------------------------------------------
// RunCodexTurnResult type — usage field should be present
// ---------------------------------------------------------------------------
// Compile-time type check: verify usage field is accepted
test("RunCodexTurnResult usage field is typed correctly", () => {
  const result: RunCodexTurnResult = {
    sessionId: "s",
    finalMessage: "m",
    stdout: "",
    stderr: "",
    exitCode: 0,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    }
  };
  assert.equal(result.usage?.inputTokens, 100);

  const resultNoUsage: RunCodexTurnResult = {
    stdout: "",
    stderr: "",
    exitCode: 0
  };
  assert.equal(resultNoUsage.usage, undefined);
});
