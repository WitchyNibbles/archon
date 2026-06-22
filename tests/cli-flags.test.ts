import test from "node:test";
import assert from "node:assert/strict";

import { resolveCommandFlag, collectCommandFlagValues, resolveFormatFlag } from "../src/cli-flags.ts";

test("resolveCommandFlag: returns value, undefined when absent, throws on missing value", () => {
  assert.equal(resolveCommandFlag(["--id", "x", "--n", "1"], "--id"), "x");
  assert.equal(resolveCommandFlag(["--id", "x"], "--missing"), undefined);
  assert.throws(() => resolveCommandFlag(["--id"], "--id"), /--id requires a value/);
  assert.throws(() => resolveCommandFlag(["--id", "--next"], "--id"), /--id requires a value/);
});

test("collectCommandFlagValues: collects repeated flag values", () => {
  assert.deepEqual(collectCommandFlagValues(["--s", "a", "--s", "b", "--x", "y"], "--s"), ["a", "b"]);
  assert.deepEqual(collectCommandFlagValues(["--x", "y"], "--s"), []);
  assert.throws(() => collectCommandFlagValues(["--s"], "--s"), /--s requires a value/);
});

test("resolveFormatFlag: defaults to json, accepts text, rejects invalid", () => {
  assert.equal(resolveFormatFlag([]), "json");
  assert.equal(resolveFormatFlag(["--format", "text"]), "text");
  assert.throws(() => resolveFormatFlag(["--format", "yaml"]), /Invalid --format value/);
});
