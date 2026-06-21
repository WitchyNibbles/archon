import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type {
  GateReviewRole,
  RetrievalRole,
  ReviewActionContext,
  ReviewState,
  TrustedReviewActionContext
} from "../domain/types.ts";
import { reviewStates, retrievalRoles as retrievalRoleValues } from "../domain/types.ts";
import { canActorWaiveReview } from "../domain/contracts.ts";

const retrievalRoleSet = new Set<string>(retrievalRoleValues);
const trustedReviewActionContexts = new WeakSet<object>();

export interface ReviewActionContextResolverInput {
  runId: string;
  taskId: string;
  actor: string;
  reviewerRole: GateReviewRole;
  reviewState: ReviewState;
}

export type ResolveReviewActionContext = (
  input: ReviewActionContextResolverInput
) => TrustedReviewActionContext | Promise<TrustedReviewActionContext>;

export interface AuthenticatedPrincipal {
  provider: string;
  subject: string;
  verified: boolean;
  displayName?: string | undefined;
  email?: string | undefined;
  groups?: string[] | undefined;
}

export interface ReviewIdentityActorBinding {
  actor: string;
  roles: RetrievalRole[];
  // When true, this actor may waive gates its roles are allowed to waive
  // (see canActorWaiveReview). Defaults to false.
  canWaive?: boolean | undefined;
}

export interface ReviewPrincipalBinding {
  principal: {
    provider: string;
    subject: string;
  };
  actors: ReviewIdentityActorBinding[];
}

export interface ReviewIdentityBindings {
  bindings: ReviewPrincipalBinding[];
}

export interface CreateReviewActionContextResolverOptions {
  bindings: ReviewIdentityBindings | readonly ReviewPrincipalBinding[];
  resolveAuthenticatedPrincipal: (
    input: ReviewActionContextResolverInput
  ) => AuthenticatedPrincipal | Promise<AuthenticatedPrincipal>;
}

export interface ReviewPrincipalAdapterInput<AuthContext = unknown>
  extends ReviewActionContextResolverInput {
  authContext: AuthContext;
}

export type ReviewPrincipalAdapter<AuthContext = unknown> = (
  input: ReviewPrincipalAdapterInput<AuthContext>
) => AuthenticatedPrincipal | Promise<AuthenticatedPrincipal>;

export interface ReviewIdentityFixtureReview {
  actor: string;
  reviewerRole: GateReviewRole;
  reviewState: ReviewState;
  runId?: string | undefined;
  taskId?: string | undefined;
}

export interface ReviewIdentityFixtureAllowExpectation {
  outcome: "allow";
  principal: AuthenticatedPrincipal;
  context: ReviewActionContext;
}

export interface ReviewIdentityFixtureDenyExpectation {
  outcome: "deny";
  errorIncludes: string[];
}

export interface ReviewIdentityFixture<AuthContext = unknown> {
  name: string;
  authContext: AuthContext;
  review: ReviewIdentityFixtureReview;
  expect: ReviewIdentityFixtureAllowExpectation | ReviewIdentityFixtureDenyExpectation;
}

export interface ReviewIdentityFixtureDocument<AuthContext = unknown> {
  fixtures: ReviewIdentityFixture<AuthContext>[];
}

export interface VerifyReviewIdentityAdapterOptions<AuthContext = unknown> {
  bindings: ReviewIdentityBindings | readonly ReviewPrincipalBinding[];
  adapter: ReviewPrincipalAdapter<AuthContext>;
  fixtures: ReviewIdentityFixtureDocument<AuthContext> | readonly ReviewIdentityFixture<AuthContext>[];
}

export interface ReviewIdentityVerificationFailure {
  fixture: string;
  message: string;
}

export interface ReviewIdentityVerificationResult {
  passed: number;
  failed: number;
  failures: ReviewIdentityVerificationFailure[];
}

function isRetrievalRole(value: string): value is RetrievalRole {
  return retrievalRoleSet.has(value);
}

function createTrustedReviewActionContextInternal(
  context: ReviewActionContext
): TrustedReviewActionContext {
  const trustedContext = Object.freeze({
    actor: context.actor,
    actorRole: context.actorRole
  });

  trustedReviewActionContexts.add(trustedContext);
  return trustedContext as TrustedReviewActionContext;
}

/**
 * Test-only surface for minting a WeakSet-registered trusted context in unit
 * and integration tests. The clearly-named `ForTest` suffix signals that this
 * export must NOT be used in production code paths. Production code must go
 * through `createReviewActionContextResolver` so that principal binding is
 * enforced at the resolver level.
 */
export function createTrustedReviewActionContextForTest(
  context: ReviewActionContext
): TrustedReviewActionContext {
  return createTrustedReviewActionContextInternal(context);
}

export function isTrustedReviewActionContext(
  context: ReviewActionContext | TrustedReviewActionContext | Record<string, unknown>
): context is TrustedReviewActionContext {
  return typeof context === "object" && context !== null && trustedReviewActionContexts.has(context);
}

export function toReviewActionContextSnapshot(
  context: ReviewActionContext | TrustedReviewActionContext
): ReviewActionContext {
  return {
    actor: context.actor,
    actorRole: context.actorRole
  };
}

function normalizeBindings(
  bindings: CreateReviewActionContextResolverOptions["bindings"]
): ReviewIdentityBindings {
  const candidate = bindings as ReviewIdentityBindings | readonly ReviewPrincipalBinding[];

  if (Array.isArray(candidate)) {
    return { bindings: [...candidate] };
  }

  return candidate as ReviewIdentityBindings;
}

function uniqueTrimmed(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values ?? []) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAuthenticatedPrincipal(principal: AuthenticatedPrincipal): AuthenticatedPrincipal {
  if (typeof principal.provider !== "string" || principal.provider.trim().length === 0) {
    throw new Error("Authenticated principal provider is required");
  }

  if (typeof principal.subject !== "string" || principal.subject.trim().length === 0) {
    throw new Error("Authenticated principal subject is required");
  }

  if (typeof principal.verified !== "boolean") {
    throw new Error("Authenticated principal verified must be a boolean");
  }

  const groups = uniqueTrimmed(principal.groups);
  if (groups.length !== (principal.groups?.length ?? 0)) {
    throw new Error("Authenticated principal groups must not contain empty or duplicate values");
  }

  return {
    provider: principal.provider.trim(),
    subject: principal.subject.trim(),
    verified: principal.verified,
    displayName: normalizeOptionalString(principal.displayName),
    email: normalizeOptionalString(principal.email),
    groups: groups.length > 0 ? groups : undefined
  };
}

export function validateReviewIdentityBindings(bindings: ReviewIdentityBindings): string[] {
  const errors: string[] = [];
  const principalKeys = new Set<string>();
  const actorKeys = new Set<string>();

  bindings.bindings.forEach((binding, bindingIndex) => {
    const provider = binding.principal.provider.trim();
    const subject = binding.principal.subject.trim();
    const bindingLabel = `binding[${bindingIndex}]`;

    if (provider.length === 0) {
      errors.push(`${bindingLabel}: principal.provider is required`);
    }

    if (subject.length === 0) {
      errors.push(`${bindingLabel}: principal.subject is required`);
    }

    if (provider.length > 0 && subject.length > 0) {
      const principalKey = `${provider}:${subject}`;
      if (principalKeys.has(principalKey)) {
        errors.push(`${bindingLabel}: duplicate principal ${principalKey}`);
      }
      principalKeys.add(principalKey);
    }

    if (binding.actors.length === 0) {
      errors.push(`${bindingLabel}: at least one actor binding is required`);
    }

    binding.actors.forEach((actorBinding, actorIndex) => {
      const actorLabel = `${bindingLabel}.actors[${actorIndex}]`;
      const actor = actorBinding.actor.trim();
      if (actor.length === 0) {
        errors.push(`${actorLabel}: actor is required`);
      } else {
        if (actorKeys.has(actor)) {
          errors.push(`${actorLabel}: duplicate actor ${actor}`);
        }
        actorKeys.add(actor);
      }

      const roles = uniqueTrimmed(actorBinding.roles);
      if (roles.length !== actorBinding.roles.length) {
        errors.push(`${actorLabel}: roles must not contain empty or duplicate values`);
      }

      if (roles.length === 0) {
        errors.push(`${actorLabel}: at least one role is required`);
      }

      for (const role of roles) {
        if (!isRetrievalRole(role)) {
          errors.push(`${actorLabel}: invalid role ${role}`);
        }
      }

      if (actorBinding.canWaive !== undefined && typeof actorBinding.canWaive !== "boolean") {
        errors.push(`${actorLabel}: canWaive must be a boolean when present`);
      }
    });
  });

  return errors;
}

export async function loadReviewIdentityBindings(filePath: string): Promise<ReviewIdentityBindings> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as ReviewIdentityBindings;
  const errors = validateReviewIdentityBindings(parsed);
  if (errors.length > 0) {
    throw new Error(`Invalid review identity bindings: ${errors.join("; ")}`);
  }
  return parsed;
}

function normalizeFixtures<AuthContext>(
  fixtures: VerifyReviewIdentityAdapterOptions<AuthContext>["fixtures"]
): ReviewIdentityFixtureDocument<AuthContext> {
  if (Array.isArray(fixtures)) {
    return { fixtures: [...fixtures] };
  }

  return fixtures as ReviewIdentityFixtureDocument<AuthContext>;
}

function normalizeFixtureReview(input: ReviewIdentityFixtureReview): ReviewActionContextResolverInput {
  if (typeof input.actor !== "string" || input.actor.trim().length === 0) {
    throw new Error("review.actor is required");
  }

  if (!reviewStates.includes(input.reviewState)) {
    throw new Error(`review.reviewState must be one of: ${reviewStates.join(", ")}`);
  }

  return {
    actor: input.actor.trim(),
    reviewerRole: input.reviewerRole,
    reviewState: input.reviewState,
    runId: input.runId?.trim() || "verify-review-identity-run",
    taskId: input.taskId?.trim() || "verify-review-identity-task"
  };
}

export function validateReviewIdentityFixtures<AuthContext>(
  document: ReviewIdentityFixtureDocument<AuthContext>
): string[] {
  const errors: string[] = [];
  const names = new Set<string>();

  if (document.fixtures.length === 0) {
    errors.push("at least one fixture is required");
  }

  document.fixtures.forEach((fixture, fixtureIndex) => {
    const fixtureLabel = `fixtures[${fixtureIndex}]`;
    const name = fixture.name.trim();

    if (name.length === 0) {
      errors.push(`${fixtureLabel}: name is required`);
    } else {
      if (names.has(name)) {
        errors.push(`${fixtureLabel}: duplicate fixture name ${name}`);
      }
      names.add(name);
    }

    try {
      normalizeFixtureReview(fixture.review);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${fixtureLabel}: ${message}`);
    }

    if (fixture.expect.outcome === "allow") {
      try {
        normalizeAuthenticatedPrincipal(fixture.expect.principal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${fixtureLabel}: expect.principal ${message}`);
      }

      if (fixture.expect.context.actor.trim().length === 0) {
        errors.push(`${fixtureLabel}: expect.context.actor is required`);
      }

      if (!isRetrievalRole(fixture.expect.context.actorRole)) {
        errors.push(`${fixtureLabel}: invalid expect.context.actorRole ${fixture.expect.context.actorRole}`);
      }

    }

    if (fixture.expect.outcome === "deny") {
      const errorIncludes = uniqueTrimmed(fixture.expect.errorIncludes);
      if (errorIncludes.length !== fixture.expect.errorIncludes.length) {
        errors.push(`${fixtureLabel}: expect.errorIncludes must not contain empty or duplicate values`);
      }
      if (errorIncludes.length === 0) {
        errors.push(`${fixtureLabel}: expect.errorIncludes requires at least one value`);
      }
    }
  });

  return errors;
}

export async function loadReviewIdentityFixtures<AuthContext = unknown>(
  filePath: string
): Promise<ReviewIdentityFixtureDocument<AuthContext>> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as ReviewIdentityFixtureDocument<AuthContext>;
  const errors = validateReviewIdentityFixtures(parsed);
  if (errors.length > 0) {
    throw new Error(`Invalid review identity fixtures: ${errors.join("; ")}`);
  }
  return parsed;
}

function resolveActorBinding(
  principal: AuthenticatedPrincipal,
  bindings: ReviewIdentityBindings,
  actor: string
): ReviewIdentityActorBinding {
  const principalBinding = bindings.bindings.find(
    (binding) =>
      binding.principal.provider === principal.provider && binding.principal.subject === principal.subject
  );

  if (!principalBinding) {
    throw new Error(`No review identity binding for ${principal.provider}:${principal.subject}`);
  }

  const actorBinding = principalBinding.actors.find((binding) => binding.actor === actor);
  if (!actorBinding) {
    throw new Error(`Actor ${actor} is not bound to ${principal.provider}:${principal.subject}`);
  }

  return actorBinding;
}

export function createReviewActionContextResolver(
  options: CreateReviewActionContextResolverOptions
): ResolveReviewActionContext {
  const bindings = normalizeBindings(options.bindings);
  const errors = validateReviewIdentityBindings(bindings);
  if (errors.length > 0) {
    throw new Error(`Invalid review identity bindings: ${errors.join("; ")}`);
  }

  return async (input) => {
    const principal = await options.resolveAuthenticatedPrincipal(input);
    if (!principal.verified) {
      throw new Error(`Authenticated principal ${principal.provider}:${principal.subject} is not verified`);
    }

    const actorBinding = resolveActorBinding(principal, bindings, input.actor);

    if (input.reviewState === "waived") {
      const waiverRoles = actorBinding.canWaive
        ? actorBinding.roles.filter((actorRole) =>
            canActorWaiveReview({ actorRole, reviewerRole: input.reviewerRole })
          )
        : [];

      if (waiverRoles.length === 0) {
        throw new Error(`Actor ${actorBinding.actor} is not allowed to waive ${input.reviewerRole}`);
      }

      const waiverRole = waiverRoles[0]!;
      if (waiverRoles.some((role) => role !== waiverRole)) {
        throw new Error(`Actor ${actorBinding.actor} has ambiguous waiver authority for ${input.reviewerRole}`);
      }

      return createTrustedReviewActionContextInternal({
        actor: actorBinding.actor,
        actorRole: waiverRole
      });
    }

    if (!actorBinding.roles.includes(input.reviewerRole)) {
      throw new Error(`Actor ${actorBinding.actor} is not allowed to record ${input.reviewerRole}`);
    }

    return createTrustedReviewActionContextInternal({
      actor: actorBinding.actor,
      actorRole: input.reviewerRole
    });
  };
}

export function createReviewPrincipalAdapter<AuthContext>(
  adapter: ReviewPrincipalAdapter<AuthContext>
): ReviewPrincipalAdapter<AuthContext> {
  return async (input) => normalizeAuthenticatedPrincipal(await adapter(input));
}

export async function verifyReviewIdentityAdapter<AuthContext>(
  options: VerifyReviewIdentityAdapterOptions<AuthContext>
): Promise<ReviewIdentityVerificationResult> {
  const bindings = normalizeBindings(options.bindings);
  const bindingErrors = validateReviewIdentityBindings(bindings);
  if (bindingErrors.length > 0) {
    throw new Error(`Invalid review identity bindings: ${bindingErrors.join("; ")}`);
  }

  const document = normalizeFixtures(options.fixtures);
  const fixtureErrors = validateReviewIdentityFixtures(document);
  if (fixtureErrors.length > 0) {
    throw new Error(`Invalid review identity fixtures: ${fixtureErrors.join("; ")}`);
  }

  const adapter = createReviewPrincipalAdapter(options.adapter);
  const failures: ReviewIdentityVerificationFailure[] = [];
  let passed = 0;

  for (const fixture of document.fixtures) {
    const reviewInput = normalizeFixtureReview(fixture.review);
    const resolver = createReviewActionContextResolver({
      bindings,
      resolveAuthenticatedPrincipal(input) {
        return adapter({
          ...input,
          authContext: fixture.authContext
        });
      }
    });

    try {
      if (fixture.expect.outcome === "deny") {
        await resolver(reviewInput);
        failures.push({
          fixture: fixture.name,
          message: "expected deny but resolver allowed the review action"
        });
        continue;
      }

      const principal = await adapter({
        ...reviewInput,
        authContext: fixture.authContext
      });
      const context = await resolver(reviewInput);
      const expectedPrincipal = normalizeAuthenticatedPrincipal(fixture.expect.principal);

      if (!isDeepStrictEqual(principal, expectedPrincipal)) {
        failures.push({
          fixture: fixture.name,
          message: `principal mismatch: expected ${JSON.stringify(expectedPrincipal)} got ${JSON.stringify(principal)}`
        });
        continue;
      }

      if (!isDeepStrictEqual(toReviewActionContextSnapshot(context), fixture.expect.context)) {
        failures.push({
          fixture: fixture.name,
          message: `context mismatch: expected ${JSON.stringify(fixture.expect.context)} got ${JSON.stringify(
            toReviewActionContextSnapshot(context)
          )}`
        });
        continue;
      }

      passed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (fixture.expect.outcome === "deny") {
        const matched = fixture.expect.errorIncludes.every((expected) => message.includes(expected));
        if (matched) {
          passed += 1;
          continue;
        }

        failures.push({
          fixture: fixture.name,
          message: `deny mismatch: expected error to include ${fixture.expect.errorIncludes.join(", ")}; got ${message}`
        });
        continue;
      }

      failures.push({
        fixture: fixture.name,
        message
      });
    }
  }

  return {
    passed,
    failed: failures.length,
    failures
  };
}
