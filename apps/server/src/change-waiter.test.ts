import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeWaiter } from "./change-waiter.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChangeWaiter", () => {
  it("wakes every matching waiter while isolating request IDs and version thresholds", async () => {
    const waiter = new ChangeWaiter();
    const first = waiter.wait("raise-a", 1, 30_000);
    const current = waiter.wait("raise-a", 2, 30_000);
    const duplicate = waiter.wait("raise-a", 1, 30_000);
    const otherRaise = waiter.wait("raise-b", 0, 30_000);

    waiter.notify("raise-a", 2);

    await expect(first).resolves.toEqual({ reason: "change", version: 2 });
    await expect(duplicate).resolves.toEqual({ reason: "change", version: 2 });
    expect(waiter.activeWaitCount).toBe(2);

    waiter.notify("raise-b", 1);
    await expect(otherRaise).resolves.toEqual({ reason: "change", version: 1 });
    expect(waiter.activeWaitCount).toBe(1);

    waiter.notify("raise-a", 3);
    await expect(current).resolves.toEqual({ reason: "change", version: 3 });
    expect(waiter.activeWaitCount).toBe(0);
  });

  it("times out cleanly and caps waits at the configured maximum", async () => {
    vi.useFakeTimers();
    const waiter = new ChangeWaiter({ maxWaitMs: 50 });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = waiter.wait("raise-a", 3, 10_000, controller.signal);

    expect(waiter.activeWaitCount).toBe(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(waiter.activeWaitCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(waiting).resolves.toEqual({ reason: "timeout" });
    expect(waiter.activeWaitCount).toBe(0);
    expect(removeListener).toHaveBeenCalledOnce();
    waiter.notify("raise-a", 4);
    expect(waiter.activeWaitCount).toBe(0);
  });

  it("aborts an active wait and removes its timer and abort listener", async () => {
    vi.useFakeTimers();
    const waiter = new ChangeWaiter();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = waiter.wait("raise-a", 3, 30_000, controller.signal);

    controller.abort();

    await expect(waiting).resolves.toEqual({ reason: "aborted" });
    expect(removeListener).toHaveBeenCalledOnce();
    expect(waiter.activeWaitCount).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    waiter.notify("raise-a", 4);
    expect(waiter.activeWaitCount).toBe(0);
  });

  it("does not register an already-aborted wait", async () => {
    const waiter = new ChangeWaiter();
    const controller = new AbortController();
    controller.abort();
    const addListener = vi.spyOn(controller.signal, "addEventListener");

    await expect(waiter.wait("raise-a", 3, 30_000, controller.signal)).resolves.toEqual({
      reason: "aborted",
    });
    expect(addListener).not.toHaveBeenCalled();
    expect(waiter.activeWaitCount).toBe(0);

    waiter.close();
    await expect(waiter.wait("raise-a", 3, 30_000, controller.signal)).resolves.toEqual({
      reason: "aborted",
    });
  });

  it("returns an immediate timeout without registering a listener", async () => {
    const waiter = new ChangeWaiter();

    await expect(waiter.wait("raise-a", 0, 0)).resolves.toEqual({ reason: "timeout" });
    expect(waiter.activeWaitCount).toBe(0);
  });

  it("releases all listeners on close and lets a replacement waiter start cleanly", async () => {
    vi.useFakeTimers();
    const waiter = new ChangeWaiter();
    const first = waiter.wait("raise-a", 1, 30_000);
    const second = waiter.wait("raise-b", 4, 30_000);

    waiter.close();
    waiter.close();

    await expect(first).resolves.toEqual({ reason: "closed" });
    await expect(second).resolves.toEqual({ reason: "closed" });
    await expect(waiter.wait("raise-a", 1, 30_000)).resolves.toEqual({ reason: "closed" });
    expect(waiter.activeWaitCount).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(waiter.activeWaitCount).toBe(0);

    const replacement = new ChangeWaiter();
    const resumed = replacement.wait("raise-a", 1, 30_000);
    replacement.notify("raise-a", 2);
    await expect(resumed).resolves.toEqual({ reason: "change", version: 2 });
    expect(replacement.activeWaitCount).toBe(0);
  });

  it("rejects invalid bounds instead of creating an unbounded wait", () => {
    expect(() => new ChangeWaiter({ maxWaitMs: Number.POSITIVE_INFINITY })).toThrow(
      "Maximum wait duration",
    );
    const waiter = new ChangeWaiter();
    expect(() => waiter.wait("raise-a", -1, 10)).toThrow("Version");
    expect(() => waiter.wait("raise-a", 0, Number.POSITIVE_INFINITY)).toThrow("Wait duration");
    expect(() => waiter.wait("", 0, 10)).toThrow("Raise ID");
  });
});
