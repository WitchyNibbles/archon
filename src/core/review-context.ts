// Archon review context — full port in Phase 8
import type { ReviewActionContext, TrustedReviewActionContext } from "../domain/types.ts";

const trustedReviewActionContexts = new WeakSet<object>();

export function isTrustedReviewActionContext(
  context: ReviewActionContext | TrustedReviewActionContext | Record<string, unknown>
): context is TrustedReviewActionContext {
  return (
    typeof context === "object" &&
    context !== null &&
    (context as Record<string, unknown>).identityAssurance === "authenticated" &&
    trustedReviewActionContexts.has(context)
  );
}

export function createTrustedReviewActionContext(
  context: ReviewActionContext
): TrustedReviewActionContext {
  const trustedContext = Object.freeze({
    actor: context.actor,
    actorRole: context.actorRole,
    waiverAuthority: context.waiverAuthority ?? "none",
    identityAssurance: "authenticated" as const
  });

  trustedReviewActionContexts.add(trustedContext);
  return trustedContext as TrustedReviewActionContext;
}
