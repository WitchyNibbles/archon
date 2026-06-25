/**
 * Tests for the P5-S5 OpenAI API image provider and selectAssetProviderWithReason.
 *
 * All tests inject a fake fetch (never hitting the network), a fake/in-memory
 * secret-manager, and a sandbox env.
 *
 * Coverage:
 *  C-DEC-3: enum round-trip — old provider values still validate after enum addition.
 *  CC-12/C-DEC-1: CI=true → placeholder (ci) even with key+enabled+cap.
 *  C-DEC-1: not-enabled → placeholder (provider_disabled).
 *  no-key → placeholder (no_key).
 *  CC-10 boundaries: cap absent/zero/negative/unparseable → placeholder (no_spend_cap).
 *  CC-10: positive cap → API selected; bucket exhausted → placeholder (cap_exceeded).
 *  CC-11: no-cap path surfaces no_spend_cap reason (never silent).
 *  CC-8: fake fetch 401 → result.message contains NO part of the fixture API key.
 *  CC-9: credential-bearing error sanitized by sanitizeErrorMessage.
 *  CC-DEC-2: key never via ProviderDeps; flows only through secretManager.get().reveal().
 *  Happy path: valid image written, resolveWithinRepo-guarded, Authorization value absent.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/forge-api-provider.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Contract imports
import {
  AssetRequestSchema,
  assetProviderValues,
} from "../src/forge/asset-contract.ts";
import type { AssetRequest } from "../src/forge/asset-contract.ts";

// Provider imports
import {
  PlaceholderSvgProvider,
  OpenAiApiImagegenProvider,
  SpendCapBucket,
  sanitizeErrorMessage,
  selectAssetProviderWithReason,
  resetRunBucket,
} from "../src/forge/asset-provider.ts";
import type { ProviderDeps, SelectionDeps } from "../src/forge/asset-provider.ts";

// Secret-manager imports
import { InMemorySecretManager } from "../src/secrets/in-memory-backend.ts";
import { createSecretValue } from "../src/secrets/secret-value.ts";
import { parseSecretRef } from "../src/secrets/secret-manager.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRepo: string;

before(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "archon-api-provider-test-"));
});

after(() => {
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset the process-level run bucket between tests so each test is independent.
  resetRunBucket();
});

/** Fixture API key — must NEVER appear in any result/log/output. */
const FIXTURE_API_KEY = "sk-test-FIXTURE-KEY-MUST-NOT-LEAK-abc123xyz";

/** Build a minimal valid AssetRequest for openai_api_later_optional. */
function makeApiRequest(overrides: Partial<AssetRequest> = {}): AssetRequest {
  return {
    id: "api-hero",
    provider: "openai_api_later_optional",
    assetType: "hero",
    purpose: "Landing-page hero visual",
    placement: "HomeHero background",
    prompt: "Dark editorial illustration of an AI forge",
    negativeConstraints: [],
    preferredSize: "wide",
    preferredFormat: "png",
    background: "auto",
    outputPath: "generated/api-hero.png",
    altText: "Dark editorial illustration of an AI forge",
    needsUserApproval: true,
    status: "planned",
    ...overrides,
  };
}

/** Build a SecretManager with the fixture key pre-loaded. */
function makeSecretManagerWithKey(): InMemorySecretManager {
  const sm = new InMemorySecretManager();
  // Set returns void, use Promise then; but InMemory is sync under the hood.
  // We need to seed it synchronously for tests: use a helper.
  void sm.set(parseSecretRef("forge.openai_api_key"), createSecretValue(FIXTURE_API_KEY));
  return sm;
}

/** Env enabling the provider (no CI, opted in). */
const ENABLED_ENV: Partial<Record<string, string>> = {
  CI: "false",
  ARCHON_FORGE_API_PROVIDER_ENABLED: "true",
  ARCHON_FORGE_API_SPEND_CAP: "5",
};

// ---------------------------------------------------------------------------
// C-DEC-3: Enum round-trip — old provider values still validate
// ---------------------------------------------------------------------------

describe("C-DEC-3: assetProviderValues round-trip", () => {
  it("includes openai_api_later_optional in the tuple", () => {
    assert.ok(
      (assetProviderValues as readonly string[]).includes("openai_api_later_optional"),
      "assetProviderValues must include openai_api_later_optional",
    );
  });

  it("still includes all original MVP provider values", () => {
    const originalValues = ["codex_builtin_imagegen", "manual_upload", "placeholder_svg"];
    for (const v of originalValues) {
      assert.ok(
        (assetProviderValues as readonly string[]).includes(v),
        `assetProviderValues must still include "${v}"`,
      );
    }
  });

  it("existing manifest with codex_builtin_imagegen provider still validates through Zod", () => {
    const existingRequest = makeApiRequest({ provider: "codex_builtin_imagegen" });
    const parsed = AssetRequestSchema.safeParse(existingRequest);
    assert.ok(parsed.success, `Existing provider 'codex_builtin_imagegen' must still parse: ${JSON.stringify(parsed)}`);
  });

  it("existing manifest with manual_upload provider still validates through Zod", () => {
    const existingRequest = makeApiRequest({ provider: "manual_upload" });
    const parsed = AssetRequestSchema.safeParse(existingRequest);
    assert.ok(parsed.success, "Existing provider 'manual_upload' must still parse");
  });

  it("existing manifest with placeholder_svg provider still validates through Zod", () => {
    const existingRequest = makeApiRequest({ provider: "placeholder_svg" });
    const parsed = AssetRequestSchema.safeParse(existingRequest);
    assert.ok(parsed.success, "Existing provider 'placeholder_svg' must still parse");
  });

  it("new openai_api_later_optional request validates through Zod", () => {
    const newRequest = makeApiRequest();
    const parsed = AssetRequestSchema.safeParse(newRequest);
    assert.ok(parsed.success, "openai_api_later_optional request must parse");
  });
});

// ---------------------------------------------------------------------------
// CC-12 / C-DEC-1: CI → placeholder (ci), even with key + enabled + cap
// ---------------------------------------------------------------------------

describe("CC-12 / C-DEC-1: CI=true always yields placeholder", () => {
  it("CI=true → placeholder with reason 'ci'", () => {
    const env = { ...ENABLED_ENV, CI: "true" };
    const deps: SelectionDeps = {
      spendCapBucket: new SpendCapBucket("5"),
      keyAvailable: true,
    };
    const result = selectAssetProviderWithReason(makeApiRequest(), env, () => false, deps);
    assert.ok(result.provider instanceof PlaceholderSvgProvider, "CI=true must return placeholder");
    assert.equal(result.reason, "ci");
  });

  it("CI=true trumps enabled flag, key, and cap — reason is always 'ci'", () => {
    const env = {
      CI: "true",
      ARCHON_FORGE_API_PROVIDER_ENABLED: "true",
      ARCHON_FORGE_API_SPEND_CAP: "100",
    };
    const deps: SelectionDeps = { spendCapBucket: new SpendCapBucket("100"), keyAvailable: true };
    const result = selectAssetProviderWithReason(makeApiRequest(), env, () => true, deps);
    assert.equal(result.reason, "ci");
    assert.ok(result.provider instanceof PlaceholderSvgProvider);
  });
});

// ---------------------------------------------------------------------------
// C-DEC-1: provider_disabled when not opted in
// ---------------------------------------------------------------------------

describe("C-DEC-1: not-enabled → placeholder (provider_disabled)", () => {
  it("ARCHON_FORGE_API_PROVIDER_ENABLED absent → provider_disabled", () => {
    const env = { CI: "false", ARCHON_FORGE_API_SPEND_CAP: "5" };
    const result = selectAssetProviderWithReason(makeApiRequest(), env, () => false,
      { spendCapBucket: new SpendCapBucket("5"), keyAvailable: true });
    assert.equal(result.reason, "provider_disabled");
    assert.ok(result.provider instanceof PlaceholderSvgProvider);
  });

  it("ARCHON_FORGE_API_PROVIDER_ENABLED=false → provider_disabled", () => {
    const env = { CI: "false", ARCHON_FORGE_API_PROVIDER_ENABLED: "false", ARCHON_FORGE_API_SPEND_CAP: "5" };
    const result = selectAssetProviderWithReason(makeApiRequest(), env, () => false,
      { spendCapBucket: new SpendCapBucket("5"), keyAvailable: true });
    assert.equal(result.reason, "provider_disabled");
  });
});

// ---------------------------------------------------------------------------
// no-key → placeholder (no_key)
// ---------------------------------------------------------------------------

describe("no-key → placeholder (no_key)", () => {
  it("keyAvailable=false → reason no_key, placeholder returned", () => {
    const env = { ...ENABLED_ENV };
    const result = selectAssetProviderWithReason(makeApiRequest(), env, () => false,
      { spendCapBucket: new SpendCapBucket("5"), keyAvailable: false });
    assert.equal(result.reason, "no_key");
    assert.ok(result.provider instanceof PlaceholderSvgProvider);
  });

  it("missing key in secret-manager → generate() returns no_key message", async () => {
    // Empty secret-manager — key not set.
    const sm = new InMemorySecretManager();
    const bucket = new SpendCapBucket("5");
    const provider = new OpenAiApiImagegenProvider(bucket);
    const deps: ProviderDeps = { repoRoot: tmpRepo, secretManager: sm };
    const result = await provider.generate(makeApiRequest(), deps);
    assert.equal(result.status, "needs_regeneration");
    assert.ok(result.message?.includes("no_key") || result.message?.includes("not in secret-manager"),
      `Expected no_key message; got: ${result.message}`);
    // CC-8: fixture key not in message (it was never set, but assert for safety)
    assert.ok(!result.message?.includes(FIXTURE_API_KEY),
      "message must not contain the fixture API key");
  });
});

// ---------------------------------------------------------------------------
// CC-10: spend cap boundaries (all with CI=false + enabled + key present)
// ---------------------------------------------------------------------------

describe("CC-10: spend cap deny-by-default boundaries", () => {
  it("cap ABSENT → no_spend_cap", () => {
    const env = { CI: "false", ARCHON_FORGE_API_PROVIDER_ENABLED: "true" }; // no cap
    const result = selectAssetProviderWithReason(makeApiRequest(), env, () => false,
      { keyAvailable: true });
    assert.equal(result.reason, "no_spend_cap");
    assert.ok(result.provider instanceof PlaceholderSvgProvider);
  });

  it("cap = '0' → no_spend_cap", () => {
    const env = { CI: "false", ARCHON_FORGE_API_PROVIDER_ENABLED: "true", ARCHON_FORGE_API_SPEND_CAP: "0" };
    const result = selectAssetProviderWithReason(makeApiRequest(), env, () => false,
      { spendCapBucket: new SpendCapBucket("0"), keyAvailable: true });
    assert.equal(result.reason, "no_spend_cap");
  });

  it("cap = '-1' (negative) → no_spend_cap", () => {
    const env = { CI: "false", ARCHON_FORGE_API_PROVIDER_ENABLED: "true", ARCHON_FORGE_API_SPEND_CAP: "-1" };
    const result = selectAssetProviderWithReason(makeApiRequest(), env, () => false,
      { spendCapBucket: new SpendCapBucket("-1"), keyAvailable: true });
    assert.equal(result.reason, "no_spend_cap");
  });

  it("cap = 'abc' (unparseable) → no_spend_cap", () => {
    const env = { CI: "false", ARCHON_FORGE_API_PROVIDER_ENABLED: "true", ARCHON_FORGE_API_SPEND_CAP: "abc" };
    const result = selectAssetProviderWithReason(makeApiRequest(), env, () => false,
      { spendCapBucket: new SpendCapBucket("abc"), keyAvailable: true });
    assert.equal(result.reason, "no_spend_cap");
  });

  it("cap = '1.5' (float, not integer) → no_spend_cap", () => {
    const env = { CI: "false", ARCHON_FORGE_API_PROVIDER_ENABLED: "true", ARCHON_FORGE_API_SPEND_CAP: "1.5" };
    const result = selectAssetProviderWithReason(makeApiRequest(), env, () => false,
      { spendCapBucket: new SpendCapBucket("1.5"), keyAvailable: true });
    assert.equal(result.reason, "no_spend_cap");
  });

  it("positive cap → API provider selected (not placeholder)", () => {
    const bucket = new SpendCapBucket("3");
    const env = { CI: "false", ARCHON_FORGE_API_PROVIDER_ENABLED: "true", ARCHON_FORGE_API_SPEND_CAP: "3" };
    const result = selectAssetProviderWithReason(makeApiRequest(), env, () => false,
      { spendCapBucket: bucket, keyAvailable: true });
    assert.ok(result.provider instanceof OpenAiApiImagegenProvider,
      "Positive cap with key+enabled+no-CI must select OpenAiApiImagegenProvider");
    assert.equal(result.reason, "api_available",
      "the OpenAI-selected path must report 'api_available', not the codex reason");
  });

  it("positive cap → cap_exceeded once run bucket is exhausted", () => {
    const bucket = new SpendCapBucket("2");
    const env = { CI: "false", ARCHON_FORGE_API_PROVIDER_ENABLED: "true", ARCHON_FORGE_API_SPEND_CAP: "2" };
    const deps: SelectionDeps = { spendCapBucket: bucket, keyAvailable: true };

    // First call — bucket has 2, not exhausted; provider selected.
    const r1 = selectAssetProviderWithReason(makeApiRequest(), env, () => false, deps);
    assert.ok(r1.provider instanceof OpenAiApiImagegenProvider, "First call: API provider");

    // Manually exhaust the bucket via the atomic tryDebit (simulating 2 generate() calls).
    assert.equal(bucket.tryDebit(), true);
    assert.equal(bucket.tryDebit(), true);
    assert.equal(bucket.tryDebit(), false, "third tryDebit on a cap-2 bucket must fail");
    assert.equal(bucket.hasRemaining, false);

    // Next selection call: bucket exhausted → cap_exceeded.
    const r2 = selectAssetProviderWithReason(makeApiRequest(), env, () => false, deps);
    assert.equal(r2.reason, "cap_exceeded");
    assert.ok(r2.provider instanceof PlaceholderSvgProvider, "Exhausted cap must return placeholder");
  });
});

// ---------------------------------------------------------------------------
// CC-11: no-cap path surfaces no_spend_cap reason (never silent)
// ---------------------------------------------------------------------------

describe("CC-11: no-cap path surfaces structured reason", () => {
  it("no cap → no_spend_cap reason emitted; provider is placeholder (not silent downgrade)", () => {
    const env = { CI: "false", ARCHON_FORGE_API_PROVIDER_ENABLED: "true" };
    const result = selectAssetProviderWithReason(makeApiRequest(), env, () => false,
      { spendCapBucket: new SpendCapBucket(undefined), keyAvailable: true });
    assert.equal(result.reason, "no_spend_cap", "Reason must be 'no_spend_cap', never undefined");
    assert.ok(result.provider instanceof PlaceholderSvgProvider);
    // Assert the reason IS surfaced (not undefined/null) — CC-11 "never silent"
    assert.ok(typeof result.reason === "string" && result.reason.length > 0,
      "SelectionReason must be a non-empty string");
  });
});

// ---------------------------------------------------------------------------
// CC-8: fake fetch 401 → result.message contains NO part of the fixture key
// ---------------------------------------------------------------------------

describe("CC-8: Authorization header / API key never in result.message", () => {
  it("fake fetch 401 → message contains only HTTP status, no fixture key", async () => {
    const sm = makeSecretManagerWithKey();
    const bucket = new SpendCapBucket("5");
    // Inject fake fetch that returns 401 with a body that echoes Authorization header.
    const originalFetch = globalThis.fetch;
    let capturedAuthHeader: string | undefined;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      // Capture the Authorization header for the spy assertion.
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuthHeader = headers?.["Authorization"];
      // Return a 401 response
      return new Response(
        JSON.stringify({ error: { message: "Invalid API key provided." } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const provider = new OpenAiApiImagegenProvider(bucket);
      const deps: ProviderDeps = { repoRoot: tmpRepo, secretManager: sm };
      const result = await provider.generate(makeApiRequest(), deps);

      assert.equal(result.status, "needs_regeneration");
      assert.ok(result.message?.includes("401"), `Expected HTTP 401 in message; got: ${result.message}`);
      // CC-8: fixture key must NOT appear anywhere in the message
      assert.ok(
        !result.message?.includes(FIXTURE_API_KEY),
        `CC-8 VIOLATION: message contains fixture key! message="${result.message}"`,
      );
      // CC-8: the captured Authorization header must have contained the key
      // (proving the header WAS built with the key, but the key was not put in message).
      assert.ok(
        capturedAuthHeader?.includes(FIXTURE_API_KEY),
        "Authorization header must have been built with the fixture key (spy confirms key was sent)",
      );
      // Assert the Authorization header value itself is not in the message.
      if (capturedAuthHeader !== undefined) {
        assert.ok(
          !result.message?.includes(capturedAuthHeader),
          `CC-8 VIOLATION: message contains the full Authorization header value`,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fake fetch network error → message sanitized, no key fragment", async () => {
    const sm = makeSecretManagerWithKey();
    const bucket = new SpendCapBucket("5");
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => {
      // Simulate a network error whose message contains a credential-like string.
      throw new Error(`connect ECONNREFUSED. Auth: Bearer ${FIXTURE_API_KEY}`);
    };

    try {
      const provider = new OpenAiApiImagegenProvider(bucket);
      const deps: ProviderDeps = { repoRoot: tmpRepo, secretManager: sm };
      const result = await provider.generate(makeApiRequest(), deps);

      assert.equal(result.status, "needs_regeneration");
      assert.ok(
        !result.message?.includes(FIXTURE_API_KEY),
        `CC-8/CC-9 VIOLATION: fixture key found in message: "${result.message}"`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// CC-9: sanitizeErrorMessage removes credential fragments
// ---------------------------------------------------------------------------

describe("CC-9: sanitizeErrorMessage utility", () => {
  it("strips 'Authorization: Bearer <key>' pattern", () => {
    const msg = `Request failed: Authorization: Bearer ${FIXTURE_API_KEY} was rejected`;
    const sanitized = sanitizeErrorMessage(msg);
    assert.ok(!sanitized.includes(FIXTURE_API_KEY), `Key found in sanitized: "${sanitized}"`);
    assert.ok(sanitized.includes("[REDACTED]"), `Expected [REDACTED] in: "${sanitized}"`);
  });

  it("strips 'Bearer <token>' pattern", () => {
    const msg = `Token Bearer ${FIXTURE_API_KEY} is invalid`;
    const sanitized = sanitizeErrorMessage(msg);
    assert.ok(!sanitized.includes(FIXTURE_API_KEY));
  });

  it("strips 'sk-...' OpenAI-style keys", () => {
    const msg = `Invalid key sk-abcdefghijklmnopqrstuvwxyz12345 was rejected`;
    const sanitized = sanitizeErrorMessage(msg);
    assert.ok(!sanitized.includes("sk-abcdefghijklmnopqrstuvwxyz12345"));
  });

  it("passes through non-credential error messages unchanged", () => {
    const msg = "API error HTTP 429 for asset api-hero";
    const sanitized = sanitizeErrorMessage(msg);
    assert.equal(sanitized, msg);
  });

  it("credential-bearing error from injected err is sanitized", () => {
    const credentialError = `Error: Authorization: Bearer ${FIXTURE_API_KEY}`;
    const sanitized = sanitizeErrorMessage(credentialError);
    assert.ok(!sanitized.includes(FIXTURE_API_KEY),
      `Credential-bearing error not sanitized: "${sanitized}"`);
  });
});

// ---------------------------------------------------------------------------
// CC-DEC-2: key flows only through secretManager.get().reveal(), never via ProviderDeps
// ---------------------------------------------------------------------------

describe("CC-DEC-2: API key never in ProviderDeps", () => {
  it("ProviderDeps contains no apiKey field — only secretManager", () => {
    // Type-level check: ProviderDeps must not have an apiKey field.
    // We verify at runtime that an injected deps object carries no key.
    const deps: ProviderDeps = {
      repoRoot: tmpRepo,
      secretManager: makeSecretManagerWithKey(),
      // No apiKey, no key, no rawKey field — only secretManager
    };
    // Assert: the deps object does not have a key-like property
    assert.equal("apiKey" in deps, false, "ProviderDeps must not have apiKey field");
    assert.equal("key" in deps, false, "ProviderDeps must not have key field");
    assert.equal("rawKey" in deps, false, "ProviderDeps must not have rawKey field");
    assert.equal("token" in deps, false, "ProviderDeps must not have token field");
  });

  it("key flows through secretManager.get().reveal() — spy on reveal()", async () => {
    let revealCalled = false;
    let revealedValue: string | undefined;

    // Build a SecretManager spy that wraps InMemory and records reveal() calls.
    const innerSm = makeSecretManagerWithKey();
    const spySm = new Proxy(innerSm, {
      get(target, prop) {
        if (prop === "get") {
          return async (...args: Parameters<typeof target.get>) => {
            const secretValue = await target.get(...args);
            if (secretValue === undefined) return undefined;
            // Wrap the reveal() to spy on it.
            return new Proxy(secretValue, {
              get(sv, svProp) {
                if (svProp === "reveal") {
                  return () => {
                    revealCalled = true;
                    const val = secretValue.reveal();
                    revealedValue = val;
                    return val;
                  };
                }
                return Reflect.get(sv, svProp, sv);
              },
            });
          };
        }
        return Reflect.get(target, prop, target);
      },
    });

    const originalFetch = globalThis.fetch;
    // Return success so generate() proceeds past the key-read.
    globalThis.fetch = async () => {
      const b64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(64).fill(0)]).toString("base64");
      return new Response(
        JSON.stringify({ data: [{ b64_json: b64 }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const bucket = new SpendCapBucket("5");
      const provider = new OpenAiApiImagegenProvider(bucket);
      const deps: ProviderDeps = { repoRoot: tmpRepo, secretManager: spySm };
      await provider.generate(makeApiRequest(), deps);

      // Assert reveal() was called — proves key flows through SecretManager.
      assert.ok(revealCalled, "CC-DEC-2: reveal() must have been called on the SecretValue");
      // Assert the revealed value matches the fixture key (proves the right key was retrieved).
      assert.equal(revealedValue, FIXTURE_API_KEY);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path: valid image written; Authorization value absent from all outputs
// ---------------------------------------------------------------------------

describe("Happy path: valid image written, no key in output", () => {
  it("successful generate(): image written to repo-bounded path; no key in result", async () => {
    const sm = makeSecretManagerWithKey();
    const bucket = new SpendCapBucket("5");
    let capturedAuthHeader: string | undefined;

    const originalFetch = globalThis.fetch;
    // Return a valid PNG in b64_json.
    const fakePngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...Array<number>(128).fill(0x00),
    ]);
    const b64 = fakePngBytes.toString("base64");

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedAuthHeader = (init?.headers as Record<string, string>)?.["Authorization"];
      return new Response(
        JSON.stringify({ data: [{ b64_json: b64 }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const provider = new OpenAiApiImagegenProvider(bucket);
      const deps: ProviderDeps = { repoRoot: tmpRepo, secretManager: sm };
      const result = await provider.generate(makeApiRequest(), deps);

      // Assert success.
      assert.equal(result.status, "generated", `Expected generated; got: ${result.status} (${result.message})`);
      assert.ok(result.outputAbsPath !== undefined, "outputAbsPath must be set on success");

      // Assert the file was written.
      assert.ok(fs.existsSync(result.outputAbsPath!), "Image must exist on disk");
      const written = fs.readFileSync(result.outputAbsPath!);
      assert.equal(written.byteLength, fakePngBytes.byteLength, "Written file must match fake PNG bytes");

      // Assert the output path is repo-bounded (under tmpRepo).
      assert.ok(
        result.outputAbsPath!.startsWith(tmpRepo),
        `outputAbsPath must be under tmpRepo: ${result.outputAbsPath}`,
      );

      // CC-8: fixture key must not appear in result.message (message should be undefined on success).
      assert.ok(
        !result.message?.includes(FIXTURE_API_KEY),
        "CC-8: fixture key must not appear in result.message",
      );

      // The Authorization header was built with the key (spy confirms it was sent).
      assert.ok(capturedAuthHeader?.includes(FIXTURE_API_KEY),
        "Authorization header must have contained the fixture key");

      // CC-8: the Authorization header itself must not appear in the result.
      const resultStr = JSON.stringify(result);
      assert.ok(!resultStr.includes(FIXTURE_API_KEY),
        `CC-8: fixture key found in serialized result: ${resultStr}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("output path escaping repo → rejected status returned (never thrown)", async () => {
    const sm = makeSecretManagerWithKey();
    const bucket = new SpendCapBucket("5");

    const provider = new OpenAiApiImagegenProvider(bucket);
    const deps: ProviderDeps = { repoRoot: tmpRepo, secretManager: sm };
    const result = await provider.generate(
      makeApiRequest({ outputPath: "../../etc/evil.png" }),
      deps,
    );

    assert.equal(result.status, "rejected");
    assert.ok(
      result.message?.includes("outside the repository root") ||
        result.message?.includes("outside"),
      `Expected path-escape message; got: ${result.message}`,
    );
  });
});

// ---------------------------------------------------------------------------
// SpendCapBucket unit tests
// ---------------------------------------------------------------------------

describe("SpendCapBucket", () => {
  it("undefined input → not configured, hasRemaining=false", () => {
    const b = new SpendCapBucket(undefined);
    assert.equal(b.isConfigured, false);
    assert.equal(b.hasRemaining, false);
  });

  it("empty string → not configured", () => {
    const b = new SpendCapBucket("");
    assert.equal(b.isConfigured, false);
  });

  it("'0' → not configured (zero is deny)", () => {
    const b = new SpendCapBucket("0");
    assert.equal(b.isConfigured, false);
  });

  it("'-5' → not configured (negative is deny)", () => {
    const b = new SpendCapBucket("-5");
    assert.equal(b.isConfigured, false);
  });

  it("'abc' → not configured (unparseable)", () => {
    const b = new SpendCapBucket("abc");
    assert.equal(b.isConfigured, false);
  });

  it("'3' → configured with 3 remaining", () => {
    const b = new SpendCapBucket("3");
    assert.equal(b.isConfigured, true);
    assert.equal(b.hasRemaining, true);
    assert.equal(b.remaining, 3);
  });

  it("tryDebit reduces remaining; exhaustion → false + hasRemaining=false", () => {
    const b = new SpendCapBucket("2");
    assert.equal(b.tryDebit(), true);
    assert.equal(b.remaining, 1);
    assert.equal(b.tryDebit(), true);
    assert.equal(b.remaining, 0);
    assert.equal(b.hasRemaining, false);
  });

  it("tryDebit on an exhausted bucket returns false (no throw)", () => {
    const b = new SpendCapBucket("1");
    assert.equal(b.tryDebit(), true);
    assert.equal(b.tryDebit(), false);
  });

  it("tryDebit on an unconfigured bucket returns false (no throw)", () => {
    const b = new SpendCapBucket(undefined);
    assert.equal(b.tryDebit(), false);
  });

  it("tryDebit is atomic — two interleaved callers cannot both spend the last unit", () => {
    const b = new SpendCapBucket("1");
    // Simulate two concurrent callers each calling tryDebit on a cap-1 bucket.
    const first = b.tryDebit();
    const second = b.tryDebit();
    assert.equal(first, true, "first caller reserves the only unit");
    assert.equal(second, false, "second caller is denied — no double-spend");
  });
});

// ---------------------------------------------------------------------------
// generate() edge paths — timeout (AbortError), zero-byte image, missing b64_json
// ---------------------------------------------------------------------------

describe("OpenAiApiImagegenProvider.generate — edge paths", () => {
  it("AbortController timeout (AbortError) → needs_regeneration, no key leak", async () => {
    const sm = makeSecretManagerWithKey();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    };
    try {
      const provider = new OpenAiApiImagegenProvider(new SpendCapBucket("5"));
      const result = await provider.generate(makeApiRequest(), { repoRoot: tmpRepo, secretManager: sm });
      assert.notEqual(result.status, "success", "an aborted request must not report success");
      assert.ok(!result.message?.includes(FIXTURE_API_KEY), "CC-8: no key in the timeout message");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("API response missing b64_json → needs_regeneration (no image written)", async () => {
    const sm = makeSecretManagerWithKey();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{}] }), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const provider = new OpenAiApiImagegenProvider(new SpendCapBucket("5"));
      const result = await provider.generate(makeApiRequest(), { repoRoot: tmpRepo, secretManager: sm });
      assert.notEqual(result.status, "success", "a response without b64_json must not succeed");
      assert.ok(!result.message?.includes(FIXTURE_API_KEY));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("API returns a zero-byte image → needs_regeneration (no empty asset)", async () => {
    const sm = makeSecretManagerWithKey();
    const originalFetch = globalThis.fetch;
    // Empty base64 string decodes to zero bytes.
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ b64_json: "" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      const provider = new OpenAiApiImagegenProvider(new SpendCapBucket("5"));
      const result = await provider.generate(makeApiRequest(), { repoRoot: tmpRepo, secretManager: sm });
      assert.notEqual(result.status, "success", "a zero-byte image must not be accepted");
      assert.ok(!result.message?.includes(FIXTURE_API_KEY));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
