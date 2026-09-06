import { performance } from "node:perf_hooks";

export const RAISE_IDLE_TTL_MS = 2 * 60 * 60 * 1_000;
export const RAISE_HARD_TTL_MS = 6 * 60 * 60 * 1_000;
export const RAISE_ACCEPTED_TTL_MS = 15 * 60 * 1_000;

export type MonotonicNow = () => number;

export interface RetentionBudget {
  remainingMs(): number;
}

export function assertRemainingHardTtlMs(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > RAISE_HARD_TTL_MS) {
    throw new Error("The remaining hard retention duration is invalid.");
  }
}

export function systemMonotonicNow(): number {
  return performance.now();
}

export function startRetentionBudget(
  now: MonotonicNow = systemMonotonicNow,
  durationMs = RAISE_HARD_TTL_MS,
): RetentionBudget {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new Error("A retention budget must be a positive integer number of milliseconds.");
  }

  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new Error("The monotonic clock returned an invalid time.");
  let lastObservedAt = startedAt;

  return {
    remainingMs() {
      const observedAt = now();
      if (!Number.isFinite(observedAt) || observedAt < lastObservedAt) {
        throw new Error("The monotonic clock moved backwards or returned an invalid time.");
      }
      lastObservedAt = observedAt;
      return Math.max(0, Math.floor(durationMs - (observedAt - startedAt)));
    },
  };
}

export class RetentionBudgetExhaustedError extends Error {
  constructor() {
    super("Raise creation exceeded its retention budget.");
    this.name = "RetentionBudgetExhaustedError";
  }
}
