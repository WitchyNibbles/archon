import { canActorWaiveReview } from "../domain/contracts.ts";
import type {
  GateReviewRole,
  RetrievalRole,
  ReviewActionContext,
  ReviewWaiverAuthority
} from "../domain/types.ts";

interface ReviewWaiverCandidateBinding {
  actor: string;
  roles: readonly RetrievalRole[];
  waiverAuthorities?: readonly Exclude<ReviewWaiverAuthority, "none">[] | undefined;
}

interface ReviewWaiverCandidate {
  actorRole: RetrievalRole;
  waiverAuthority: Exclude<ReviewWaiverAuthority, "none">;
}

export function deriveWaiverContext(
  actorBinding: ReviewWaiverCandidateBinding,
  reviewerRole: GateReviewRole
): ReviewActionContext {
  const candidates: ReviewWaiverCandidate[] = [];

  for (const actorRole of actorBinding.roles) {
    for (const waiverAuthority of actorBinding.waiverAuthorities ?? []) {
      if (
        canActorWaiveReview({
          actorRole,
          reviewerRole,
          waiverAuthority
        })
      ) {
        candidates.push({ actorRole, waiverAuthority });
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(`Actor ${actorBinding.actor} is not allowed to waive ${reviewerRole}`);
  }

  const candidate = candidates[0]!;
  const ambiguous = candidates.some(
    (nextCandidate) =>
      nextCandidate.actorRole !== candidate.actorRole ||
      nextCandidate.waiverAuthority !== candidate.waiverAuthority
  );

  if (ambiguous) {
    throw new Error(`Actor ${actorBinding.actor} has ambiguous waiver authority for ${reviewerRole}`);
  }

  return {
    actor: actorBinding.actor,
    actorRole: candidate.actorRole,
    waiverAuthority: candidate.waiverAuthority
  };
}
