import { describe, expect, it } from "vitest";
import { RAISE_HARD_TTL_MS, startRetentionBudget } from "./retention.js";

describe("retention budget", () => {
  it("uses monotonic elapsed time and never returns a partial mill or negative millisecond", () => {
    let now = 100;
    const budget = startRetentionBudget(() => now);

    expect(budget.remainingMs()).toBe(RAISE_HARD_TTL_MS);
    now += 1_234.25;
    expect(budget.remainingMs()).toBe(RAISE_HARD_TTL_MS - 1_235);
    now += RAISE_HARD_TTL_MS;
    expect(budget.remainingMs()).toBe(0);
  });

  it("fails closed if the supplied monotonic clock moves backwards", () => {
    let now = 100;
    const budget = startRetentionBudget(() => now);
    now = 99;

    expect(() => budget.remainingMs()).toThrow("monotonic clock moved backwards");
  });
});
