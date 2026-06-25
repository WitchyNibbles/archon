/**
 * Tests for src/secrets/secret-value.ts — CC-1 leak suite (P5-S2).
 *
 * This is the binding deliverable for condition CC-1 (redaction completeness).
 *
 * The test injects a known fixture secret into a `SecretValue` and asserts
 * that the fixture string does NOT surface through any of the following paths:
 *
 *   Leak channel 1:  String(v)              — toString coercion
 *   Leak channel 2:  "" + v                 — string concatenation
 *   Leak channel 3:  `${v}`                 — template literal interpolation
 *   Leak channel 4:  JSON.stringify(v)      — direct JSON serialisation
 *   Leak channel 5:  JSON.stringify({w: v}) — nested JSON serialisation
 *   Leak channel 6:  util.inspect(v)        — Node.js inspector (direct)
 *   Leak channel 7:  util.inspect({w: v}, {depth: 5}) — inspector (nested)
 *   Leak channel 8:  {...v}                 — object spread
 *   Leak channel 9:  Object.values(v)       — enumerable values
 *   Leak channel 10: Object.keys(v)         — enumerable keys
 *   Leak channel 11: Object.entries(v)      — enumerable entries
 *   Leak channel 12: structured-log record  — simulated structured logger
 *   Leak channel 13: util.format(v)         — console-format style
 *
 * POSITIVE CONTROL:
 *   v.reveal() MUST return the fixture secret, proving the test is non-vacuous.
 *   (The secret IS stored; it just cannot be reached via the above channels.)
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-secret-value.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as util from "node:util";

import { createSecretValue } from "../src/secrets/secret-value.ts";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * The fixture secret.  Chosen to be distinctive enough that any accidental
 * stringification would be trivially detectable.
 * Must NOT appear in any redacted output.
 */
const FIXTURE_SECRET = "sk-test-SUPER_SECRET_8675309_do_not_leak";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Asserts that `output` does NOT contain the fixture secret.
 * Provides a descriptive failure message identifying the leak channel.
 */
function assertNoLeak(output: string, channel: string): void {
  assert.ok(
    !output.includes(FIXTURE_SECRET),
    `SECURITY: fixture secret leaked through channel "${channel}". ` +
      `Output was: ${JSON.stringify(output.slice(0, 200))}`,
  );
}

// ---------------------------------------------------------------------------
// CC-1 leak suite
// ---------------------------------------------------------------------------

describe("SecretValue — CC-1 leak suite", () => {
  it("positive control: v.reveal() returns the fixture secret (non-vacuous)", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    assert.equal(
      v.reveal(),
      FIXTURE_SECRET,
      "reveal() must return the exact fixture secret — if this fails the store is broken",
    );
  });

  it("channel 1: String(v) does not contain the fixture secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    assertNoLeak(String(v), "String(v)");
    assert.equal(String(v), "[REDACTED]");
  });

  it('channel 2: "" + v does not contain the fixture secret', () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const result = "" + v;
    assertNoLeak(result, '"" + v (string concatenation)');
    assert.equal(result, "[REDACTED]");
  });

  it("channel 3: `${v}` template literal does not contain the fixture secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const result = `${v}`;
    assertNoLeak(result, "template literal `${v}`");
    assert.equal(result, "[REDACTED]");
  });

  it("channel 4: JSON.stringify(v) does not contain the fixture secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const result = JSON.stringify(v);
    assertNoLeak(result, "JSON.stringify(v)");
    assert.equal(result, '"[REDACTED]"');
  });

  it("channel 5: JSON.stringify({wrapped: v}) does not contain the fixture secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const result = JSON.stringify({ wrapped: v });
    assertNoLeak(result, "JSON.stringify({wrapped: v})");
    assert.equal(result, '{"wrapped":"[REDACTED]"}');
  });

  it("channel 6: util.inspect(v) does not contain the fixture secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const result = util.inspect(v);
    assertNoLeak(result, "util.inspect(v)");
    assert.equal(result, "[REDACTED]");
  });

  it("channel 7: util.inspect({wrapped: v}, {depth: 5}) does not contain the fixture secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const result = util.inspect({ wrapped: v }, { depth: 5 });
    assertNoLeak(result, "util.inspect({wrapped: v}, {depth: 5})");
    assert.ok(
      result.includes("[REDACTED]"),
      `Expected [REDACTED] in inspect output; got: ${JSON.stringify(result)}`,
    );
  });

  it("channel 8: {...v} spread does not contain the fixture secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const spread = { ...v };
    // The spread object must not have any enumerable property whose value is the secret.
    const spreadJson = JSON.stringify(spread);
    assertNoLeak(spreadJson, "{...v} spread (serialised via JSON.stringify)");
    // Also check each value directly.
    for (const val of Object.values(spread)) {
      const valStr = String(val);
      assertNoLeak(valStr, "{...v} spread individual value");
    }
  });

  it("channel 9: Object.values(v) does not contain the fixture secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const vals = Object.values(v);
    for (const val of vals) {
      const valStr = String(val as unknown);
      assertNoLeak(valStr, "Object.values(v) element");
    }
    // The fixture secret must not appear in any value.
    const allVals = JSON.stringify(vals);
    assertNoLeak(allVals, "Object.values(v) serialised");
  });

  it("channel 10: Object.keys(v) does not contain the fixture secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const keys = Object.keys(v);
    // Keys are strings; none of them should be the secret value.
    for (const key of keys) {
      assertNoLeak(key, "Object.keys(v) element");
    }
    assertNoLeak(JSON.stringify(keys), "Object.keys(v) serialised");
  });

  it("channel 11: Object.entries(v) does not contain the fixture secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const entries = Object.entries(v);
    for (const [key, val] of entries) {
      assertNoLeak(key, "Object.entries(v) key");
      assertNoLeak(String(val as unknown), "Object.entries(v) value");
    }
    assertNoLeak(JSON.stringify(entries), "Object.entries(v) serialised");
  });

  it("channel 12: structured-log record embedding v does not leak the fixture secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);

    // Simulate a structured logger: build a log record object then serialise it
    // via both JSON.stringify and util.inspect (the two common backends).
    const logRecord = {
      level: "info",
      message: "provider calling API",
      timestamp: new Date().toISOString(),
      provider: "openai_api_later_optional",
      secretRef: "forge.openai_api_key",
      // The accidental pattern: a dev adds `secret: v` to a log record.
      secret: v,
    };

    const jsonLog = JSON.stringify(logRecord);
    assertNoLeak(jsonLog, "structured log record via JSON.stringify");

    const inspectLog = util.inspect(logRecord, { depth: 5 });
    assertNoLeak(inspectLog, "structured log record via util.inspect");
  });

  it("channel 13: util.format(v) does not contain the fixture secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const result = util.format(v);
    assertNoLeak(result, "util.format(v)");
    assert.equal(result, "[REDACTED]");
  });

  it("channel 13b: util.format('%o', v) does not contain the fixture secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const result = util.format("%o", v);
    assertNoLeak(result, "util.format('%o', v)");
  });

  // Edge: ensure reveal() is the ONLY path to the raw value.
  it("reveal() is the only path to the fixture — all other paths return [REDACTED]", () => {
    const v = createSecretValue(FIXTURE_SECRET);

    // Collect outputs from every channel.
    const outputs: Array<[string, string]> = [
      ["String(v)", String(v)],
      ['"" + v', "" + v],
      ["`${v}`", `${v}`],
      ["JSON.stringify(v)", JSON.stringify(v)],
      ["JSON.stringify({w:v})", JSON.stringify({ w: v })],
      ["util.inspect(v)", util.inspect(v)],
      ["util.format(v)", util.format(v)],
    ];

    for (const [channel, output] of outputs) {
      assertNoLeak(output, channel);
    }

    // The one legitimate path.
    assert.equal(v.reveal(), FIXTURE_SECRET);
  });
});

// ---------------------------------------------------------------------------
// CC-1 reflection-channel suite — regression guard for the round-1 CRITICAL
// (symbol-keyed own property was reachable via getOwnPropertySymbols). The raw
// value now lives in a module-private WeakMap, so the object has NO own props.
// ---------------------------------------------------------------------------

describe("SecretValue — CC-1 reflection channels (no own property holds the secret)", () => {
  it("Object.getOwnPropertySymbols(v) exposes no property carrying the secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const symbols = Object.getOwnPropertySymbols(v);
    for (const sym of symbols) {
      const val = (v as unknown as Record<symbol, unknown>)[sym];
      assertNoLeak(String(val), `getOwnPropertySymbols → v[${String(sym)}]`);
    }
    // Strongest assertion: there are NO own symbol properties at all.
    assert.deepEqual(symbols, [], "SecretValue must have no own symbol properties");
  });

  it("Reflect.ownKeys(v) exposes no property carrying the secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const keys = Reflect.ownKeys(v);
    for (const k of keys) {
      const val = (v as unknown as Record<PropertyKey, unknown>)[k];
      assertNoLeak(String(val), `Reflect.ownKeys → v[${String(k)}]`);
    }
    assert.deepEqual(keys, [], "SecretValue must have no own keys (string or symbol)");
  });

  it("Object.getOwnPropertyDescriptors(v) exposes no descriptor carrying the secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    assertNoLeak(util.inspect(descriptors, { depth: 6 }), "getOwnPropertyDescriptors");
    assert.deepEqual(descriptors, {}, "SecretValue must expose no own property descriptors");
  });

  it("structuredClone(v) does not carry the secret (WeakMap entry is per-instance)", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    // structuredClone of a plain frozen object with no own data props yields {}.
    const clone = structuredClone({ ...v });
    assertNoLeak(JSON.stringify(clone), "structuredClone({...v})");
  });

  it("valueOf(v) does not surface the secret", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    // Default Object.prototype.valueOf returns the object; coercing it goes through toString.
    assertNoLeak(String((v as unknown as { valueOf(): unknown }).valueOf()), "valueOf");
  });

  it("reveal() throws on an object not minted by createSecretValue (no silent undefined)", () => {
    // A structurally-conforming impostor must not yield a raw value.
    const impostor = {
      reveal(): string {
        // Borrow the real reveal via the prototype? Simulate calling reveal bound to a foreign obj.
        return "should-not-reach";
      },
    };
    // Call the real reveal with a foreign `this`.
    const real = createSecretValue(FIXTURE_SECRET);
    const stolenReveal = real.reveal.bind(impostor as unknown as { reveal(): string });
    assert.throws(
      () => stolenReveal(),
      /not produced by createSecretValue/,
      "reveal() bound to a foreign object must throw, never return undefined or a value",
    );
    void impostor;
  });

  it("{...v} spread is an empty object (no own enumerable data)", () => {
    const v = createSecretValue(FIXTURE_SECRET);
    assert.deepEqual({ ...v }, {}, "spread of a SecretValue must be empty");
  });
});
