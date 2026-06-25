// Phase 3 (ahrP3RespawnBudget): unit tests for resolveRespawnBudget.
// RED phase — these must fail before the helper is created.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRespawnBudget } from "../src/runtime/respawn-budget.ts";

// ---------------------------------------------------------------------------
// Helper: run a test with a specific env value (or undefined) then restore.
// ---------------------------------------------------------------------------
function withEnv(value: string | undefined, fn: () => void): void {
  const key = "ARCHON_MAX_RESPAWNS_PER_TASK";
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

describe("resolveRespawnBudget", () => {
  describe("default — env unset", () => {
    it("returns 8 when ARCHON_MAX_RESPAWNS_PER_TASK is not set", () => {
      withEnv(undefined, () => {
        assert.equal(resolveRespawnBudget(), 8);
      });
    });

    it("returns 8 when ARCHON_MAX_RESPAWNS_PER_TASK is empty string", () => {
      withEnv("", () => {
        assert.equal(resolveRespawnBudget(), 8);
      });
    });

    it("returns 8 when ARCHON_MAX_RESPAWNS_PER_TASK is whitespace only", () => {
      withEnv("   ", () => {
        assert.equal(resolveRespawnBudget(), 8);
      });
    });
  });

  describe("valid values — clamped to [1, 50]", () => {
    it("returns 1 for '1'", () => {
      withEnv("1", () => {
        assert.equal(resolveRespawnBudget(), 1);
      });
    });

    it("returns 25 for '25'", () => {
      withEnv("25", () => {
        assert.equal(resolveRespawnBudget(), 25);
      });
    });

    it("returns 50 for '50'", () => {
      withEnv("50", () => {
        assert.equal(resolveRespawnBudget(), 50);
      });
    });

    it("returns 8 for '8'", () => {
      withEnv("8", () => {
        assert.equal(resolveRespawnBudget(), 8);
      });
    });
  });

  describe("out-of-range — falls back to 8 (SEC-MED-1 clamp)", () => {
    it("returns 8 for '0' (below minimum 1)", () => {
      withEnv("0", () => {
        assert.equal(resolveRespawnBudget(), 8);
      });
    });

    it("returns 8 for '-5' (negative)", () => {
      withEnv("-5", () => {
        assert.equal(resolveRespawnBudget(), 8);
      });
    });

    it("returns 8 for '51' (above maximum 50)", () => {
      withEnv("51", () => {
        assert.equal(resolveRespawnBudget(), 8);
      });
    });

    it("returns 8 for '999999' (far above maximum 50)", () => {
      withEnv("999999", () => {
        assert.equal(resolveRespawnBudget(), 8);
      });
    });
  });

  describe("non-numeric — falls back to 8", () => {
    it("returns 8 for 'abc'", () => {
      withEnv("abc", () => {
        assert.equal(resolveRespawnBudget(), 8);
      });
    });

    it("returns 8 for 'NaN'", () => {
      withEnv("NaN", () => {
        assert.equal(resolveRespawnBudget(), 8);
      });
    });

    it("returns 8 for 'Infinity'", () => {
      withEnv("Infinity", () => {
        assert.equal(resolveRespawnBudget(), 8);
      });
    });

    it("returns 8 for '3.5' (non-integer float)", () => {
      withEnv("3.5", () => {
        assert.equal(resolveRespawnBudget(), 8);
      });
    });
  });
});
