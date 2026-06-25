/**
 * Tests for src/secrets/secret-manager.ts and src/secrets/in-memory-backend.ts (P5-S2).
 *
 * Coverage:
 *   A. parseSecretRef — allowlist enforcement
 *      A1. Rejects empty string.
 *      A2. Rejects names with spaces.
 *      A3. Rejects names with single quotes.
 *      A4. Rejects names with double quotes.
 *      A5. Rejects names with forward slashes.
 *      A6. Rejects names with backslashes.
 *      A7. Rejects names with control characters (newline, tab, NUL).
 *      A8. Rejects names starting with a digit.
 *      A9. Rejects names with uppercase letters.
 *      A10. Rejects names with leading dots.
 *      A11. Rejects names with trailing dots.
 *      A12. Rejects names with consecutive dots.
 *      A13. Rejects names with at-signs, hyphens, and other punctuation.
 *      A14. Accepts a simple single-segment name.
 *      A15. Accepts a dotted multi-segment name (e.g. forge.openai_api_key).
 *      A16. Accepts a name with digits and underscores after the first letter.
 *      A17. Accepts a deeply dotted name.
 *
 *   B. InMemorySecretManager — round-trip contract
 *      B1. set then get returns the same SecretValue (reveal matches).
 *      B2. get on unknown ref returns undefined.
 *      B3. rotate replaces the existing secret; old value no longer returned.
 *      B4. delete removes the secret; subsequent get returns undefined.
 *      B5. list returns only SecretRefs (no values) and reflects current state.
 *      B6. list on an empty backend returns an empty array.
 *      B7. set multiple refs; list returns all refs; values are never in the list.
 *      B8. delete a non-existent ref silently succeeds.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-secret-manager.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { parseSecretRef, MAX_SECRET_REF_LENGTH } from "../src/secrets/secret-manager.ts";
import { createSecretValue } from "../src/secrets/secret-value.ts";
import { InMemorySecretManager } from "../src/secrets/in-memory-backend.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_SECRET_A = "sk-test-VALUE_A_do_not_leak";
const FIXTURE_SECRET_B = "sk-test-VALUE_B_do_not_leak";

// ---------------------------------------------------------------------------
// A. parseSecretRef — allowlist enforcement
// ---------------------------------------------------------------------------

describe("parseSecretRef — rejects invalid names", () => {
  it("A1. rejects empty string", () => {
    assert.throws(
      () => parseSecretRef(""),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw Error");
        assert.ok(
          err.message.toLowerCase().includes("empty"),
          `Expected 'empty' in error: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("A2. rejects names with spaces", () => {
    assert.throws(() => parseSecretRef("forge key"), /Invalid SecretRef/);
    assert.throws(() => parseSecretRef(" forge"), /Invalid SecretRef/);
    assert.throws(() => parseSecretRef("forge "), /Invalid SecretRef/);
  });

  it("A3. rejects names with single quotes", () => {
    assert.throws(() => parseSecretRef("forge'key"), /Invalid SecretRef/);
  });

  it("A4. rejects names with double quotes", () => {
    assert.throws(() => parseSecretRef('forge"key'), /Invalid SecretRef/);
  });

  it("A5. rejects names with forward slashes", () => {
    assert.throws(() => parseSecretRef("forge/openai"), /Invalid SecretRef/);
  });

  it("A6. rejects names with backslashes", () => {
    assert.throws(() => parseSecretRef("forge\\openai"), /Invalid SecretRef/);
  });

  it("A7. rejects names with control characters (newline)", () => {
    assert.throws(() => parseSecretRef("forge\nkey"), /Invalid SecretRef/);
  });

  it("A7b. rejects names with tab", () => {
    assert.throws(() => parseSecretRef("forge\tkey"), /Invalid SecretRef/);
  });

  it("A7c. rejects names with NUL byte", () => {
    assert.throws(() => parseSecretRef("forge\x00key"), /Invalid SecretRef/);
  });

  it("A8. rejects names starting with a digit", () => {
    assert.throws(() => parseSecretRef("1forge"), /Invalid SecretRef/);
    assert.throws(() => parseSecretRef("9"), /Invalid SecretRef/);
  });

  it("A9. rejects names with uppercase letters", () => {
    assert.throws(() => parseSecretRef("Forge"), /Invalid SecretRef/);
    assert.throws(() => parseSecretRef("forge.OpenAI"), /Invalid SecretRef/);
    assert.throws(() => parseSecretRef("FORGE"), /Invalid SecretRef/);
  });

  it("A10. rejects names with a leading dot", () => {
    assert.throws(() => parseSecretRef(".forge"), /Invalid SecretRef/);
    assert.throws(() => parseSecretRef("."), /Invalid SecretRef/);
  });

  it("A11. rejects names with a trailing dot", () => {
    assert.throws(() => parseSecretRef("forge."), /Invalid SecretRef/);
    assert.throws(() => parseSecretRef("forge.key."), /Invalid SecretRef/);
  });

  it("A12. rejects names with consecutive dots", () => {
    assert.throws(() => parseSecretRef("forge..key"), /Invalid SecretRef/);
    assert.throws(() => parseSecretRef("a..b"), /Invalid SecretRef/);
  });

  it("A13. rejects names with at-signs, hyphens, and other punctuation", () => {
    assert.throws(() => parseSecretRef("forge@key"), /Invalid SecretRef/);
    assert.throws(() => parseSecretRef("forge-key"), /Invalid SecretRef/);
    assert.throws(() => parseSecretRef("forge#key"), /Invalid SecretRef/);
    assert.throws(() => parseSecretRef("forge+key"), /Invalid SecretRef/);
  });
});

describe("parseSecretRef — accepts valid names", () => {
  it("A14. accepts a simple single-segment name", () => {
    const ref = parseSecretRef("apikey");
    assert.equal(ref, "apikey");
  });

  it("A15. accepts a dotted multi-segment name (forge.openai_api_key)", () => {
    const ref = parseSecretRef("forge.openai_api_key");
    assert.equal(ref, "forge.openai_api_key");
  });

  it("A16. accepts a name with digits and underscores after the first letter", () => {
    const ref = parseSecretRef("a1_b2_c3");
    assert.equal(ref, "a1_b2_c3");
    const ref2 = parseSecretRef("x1");
    assert.equal(ref2, "x1");
  });

  it("A17. accepts a deeply dotted name", () => {
    const ref = parseSecretRef("a.b.c.d.e");
    assert.equal(ref, "a.b.c.d.e");
  });

  it("returns a value that is identity-equal to the input string", () => {
    // The brand is compile-time only; at runtime it's still a plain string.
    const raw = "forge.openai_api_key";
    const ref = parseSecretRef(raw);
    assert.equal(typeof ref, "string");
    assert.equal(ref, raw);
  });
});

// ---------------------------------------------------------------------------
// B. InMemorySecretManager — round-trip contract
// ---------------------------------------------------------------------------

describe("InMemorySecretManager — round-trip contract", () => {
  let backend: InMemorySecretManager;

  beforeEach(() => {
    backend = new InMemorySecretManager();
  });

  it("B1. set then get returns the same secret (reveal matches)", async () => {
    const ref = parseSecretRef("forge.api_key");
    const value = createSecretValue(FIXTURE_SECRET_A);

    await backend.set(ref, value);
    const retrieved = await backend.get(ref);

    assert.ok(retrieved !== undefined, "get must return a value after set");
    assert.equal(retrieved.reveal(), FIXTURE_SECRET_A);
  });

  it("B2. get on an unknown ref returns undefined", async () => {
    const ref = parseSecretRef("forge.nonexistent");
    const result = await backend.get(ref);
    assert.equal(result, undefined);
  });

  it("B3. rotate replaces the existing secret", async () => {
    const ref = parseSecretRef("forge.rotate_test");
    const original = createSecretValue(FIXTURE_SECRET_A);
    const rotated = createSecretValue(FIXTURE_SECRET_B);

    await backend.set(ref, original);
    await backend.rotate(ref, rotated);

    const retrieved = await backend.get(ref);
    assert.ok(retrieved !== undefined, "get must return a value after rotate");
    assert.equal(
      retrieved.reveal(),
      FIXTURE_SECRET_B,
      "After rotation, get must return the new secret",
    );
    assert.notEqual(
      retrieved.reveal(),
      FIXTURE_SECRET_A,
      "After rotation, old secret must not be returned",
    );
  });

  it("B4. delete removes the secret; subsequent get returns undefined", async () => {
    const ref = parseSecretRef("forge.delete_test");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET_A));

    await backend.delete(ref);

    const retrieved = await backend.get(ref);
    assert.equal(retrieved, undefined, "get must return undefined after delete");
  });

  it("B5. list returns only SecretRefs (never values)", async () => {
    const ref = parseSecretRef("forge.list_test");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET_A));

    const refs = await backend.list();

    assert.equal(refs.length, 1);
    assert.equal(refs[0], "forge.list_test");

    // Critically: the list must be an array of strings, not SecretValues.
    for (const item of refs) {
      assert.equal(typeof item, "string");
      // The fixture secret must not appear anywhere in the ref string.
      assert.ok(
        !item.includes(FIXTURE_SECRET_A),
        "list() must never contain a secret value",
      );
    }
  });

  it("B6. list on an empty backend returns an empty array", async () => {
    const refs = await backend.list();
    assert.deepEqual(refs, []);
  });

  it("B7. set multiple refs; list returns all refs; values are never in the list", async () => {
    const refA = parseSecretRef("service.key_a");
    const refB = parseSecretRef("service.key_b");
    const refC = parseSecretRef("db.password");

    await backend.set(refA, createSecretValue(FIXTURE_SECRET_A));
    await backend.set(refB, createSecretValue(FIXTURE_SECRET_B));
    await backend.set(refC, createSecretValue("another_secret_do_not_leak"));

    const refs = await backend.list();

    assert.equal(refs.length, 3);
    assert.ok(refs.includes(refA), "list must include refA");
    assert.ok(refs.includes(refB), "list must include refB");
    assert.ok(refs.includes(refC), "list must include refC");

    // Confirm none of the list entries is a SecretValue.
    for (const item of refs) {
      assert.equal(typeof item, "string", "list entries must be strings (refs)");
      assert.ok(
        !item.includes("sk-test") && !item.includes("another_secret"),
        `list entry must not be a secret value: ${item}`,
      );
    }
  });

  it("B8. delete a non-existent ref silently succeeds", async () => {
    const ref = parseSecretRef("does.not_exist");
    // Must not throw.
    await assert.doesNotReject(() => backend.delete(ref));
  });

  it("set→get→rotate→delete full lifecycle", async () => {
    const ref = parseSecretRef("forge.lifecycle_test");

    // set
    await backend.set(ref, createSecretValue(FIXTURE_SECRET_A));
    assert.equal(backend.size, 1);

    // get — must return the set value
    const afterSet = await backend.get(ref);
    assert.ok(afterSet !== undefined);
    assert.equal(afterSet.reveal(), FIXTURE_SECRET_A);

    // rotate
    await backend.rotate(ref, createSecretValue(FIXTURE_SECRET_B));
    const afterRotate = await backend.get(ref);
    assert.ok(afterRotate !== undefined);
    assert.equal(afterRotate.reveal(), FIXTURE_SECRET_B);

    // list — still one ref
    const refs = await backend.list();
    assert.equal(refs.length, 1);
    assert.equal(refs[0], ref);

    // delete
    await backend.delete(ref);
    const afterDelete = await backend.get(ref);
    assert.equal(afterDelete, undefined);

    // list — now empty
    const refsAfterDelete = await backend.list();
    assert.deepEqual(refsAfterDelete, []);
    assert.equal(backend.size, 0);
  });

  it("B-rotate-absent: rotate on a nonexistent ref throws (replace, not upsert)", async () => {
    const ref = parseSecretRef("forge.never_set");
    await assert.rejects(
      () => backend.rotate(ref, createSecretValue(FIXTURE_SECRET_A)),
      /no secret exists at ref/,
      "rotate must throw when the ref does not already exist",
    );
    // And it must NOT have created the entry as a side effect.
    assert.equal(await backend.get(ref), undefined);
  });

  it("B-set-overwrite: set twice on the same ref overwrites (last write wins)", async () => {
    const ref = parseSecretRef("forge.overwrite");
    await backend.set(ref, createSecretValue(FIXTURE_SECRET_A));
    await backend.set(ref, createSecretValue(FIXTURE_SECRET_B));
    const got = await backend.get(ref);
    assert.ok(got !== undefined);
    assert.equal(got.reveal(), FIXTURE_SECRET_B);
    const refs = await backend.list();
    assert.equal(refs.length, 1, "overwrite must not duplicate the ref");
  });
});

describe("parseSecretRef — length bound + createSecretValue empty guard", () => {
  it("rejects a ref longer than MAX_SECRET_REF_LENGTH without echoing the raw", () => {
    const tooLong = "a" + "b".repeat(200); // 201 chars, otherwise pattern-valid
    assert.throws(
      () => parseSecretRef(tooLong),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("too long"), `got: ${err.message}`);
        assert.ok(!err.message.includes(tooLong), "error must not echo the raw input");
        return true;
      },
    );
  });

  it("accepts a ref exactly at MAX_SECRET_REF_LENGTH and rejects one over by 1 (±1 boundary)", () => {
    const at = "a".repeat(MAX_SECRET_REF_LENGTH); // 128 chars, pattern-valid
    const over = "a".repeat(MAX_SECRET_REF_LENGTH + 1); // 129 chars
    assert.equal(parseSecretRef(at), at, "a ref exactly at the max length must be accepted");
    assert.throws(() => parseSecretRef(over), /too long/, "a ref one over the max must be rejected");
  });

  it("createSecretValue refuses an empty secret string", () => {
    assert.throws(
      () => createSecretValue(""),
      /refusing to wrap an empty secret/,
      "an empty secret is always a caller error and must be rejected",
    );
  });
});
