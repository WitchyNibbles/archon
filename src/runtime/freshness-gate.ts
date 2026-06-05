export type FreshnessGateStatus =
  | "fresh"
  | "stale"
  | "missing_timestamp"
  | "invalid_timestamp"
  | "future_timestamp"
  | "invalid_max_age";

export interface FreshnessGateInput {
  createdAt?: string | undefined;
  maxAgeDays: number;
}

export interface FreshnessGateDecision {
  status: FreshnessGateStatus;
  createdAt?: string | undefined;
  ageDays?: number | undefined;
  maxAgeDays: number;
}

export type GuardedFreshnessResult<T> =
  | { gate: FreshnessGateDecision; invoked: false }
  | { gate: FreshnessGateDecision; invoked: true; value: T };

export function assessFreshness(
  input: FreshnessGateInput,
  now: string = new Date().toISOString()
): FreshnessGateDecision {
  if (!Number.isFinite(input.maxAgeDays) || !Number.isInteger(input.maxAgeDays) || input.maxAgeDays < 0) {
    return {
      status: "invalid_max_age",
      createdAt: input.createdAt,
      maxAgeDays: input.maxAgeDays
    };
  }

  if (!input.createdAt) {
    return {
      status: "missing_timestamp",
      maxAgeDays: input.maxAgeDays
    };
  }

  const createdAtMs = Date.parse(input.createdAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(createdAtMs) || Number.isNaN(nowMs)) {
    return {
      status: "invalid_timestamp",
      createdAt: input.createdAt,
      maxAgeDays: input.maxAgeDays
    };
  }

  if (createdAtMs > nowMs) {
    return {
      status: "future_timestamp",
      createdAt: input.createdAt,
      maxAgeDays: input.maxAgeDays
    };
  }

  const ageDays = Math.max(0, Math.floor((nowMs - createdAtMs) / 86_400_000));
  return {
    status: ageDays > input.maxAgeDays ? "stale" : "fresh",
    createdAt: input.createdAt,
    ageDays,
    maxAgeDays: input.maxAgeDays
  };
}

export async function runWithFreshnessGate<T>(
  input: FreshnessGateInput,
  next: () => Promise<T>,
  now?: string
): Promise<GuardedFreshnessResult<T>> {
  const gate = assessFreshness(input, now);
  if (gate.status !== "fresh") {
    return {
      gate,
      invoked: false
    };
  }

  return {
    gate,
    invoked: true,
    value: await next()
  };
}
