/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestStorage } from "./testStorage";

const storage = installTestStorage();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  storage.clear();
});

describe("browser claim exchange", () => {
  it("reuses a private random retry ID after a lost response and clears it on success", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockRejectedValueOnce(new TypeError("connection still lost"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            raiseId: "r_example12",
            role: "human",
            expiresAt: "2026-09-03T00:00:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const token = "cap_example.private-claim-secret";
    const firstLoad = await import("./api");

    await expect(firstLoad.claimRaise(token)).rejects.toThrow("connection still lost");
    const storedKeys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    expect(storedKeys).toHaveLength(1);
    expect(storedKeys[0]).not.toContain(token);

    vi.resetModules();
    const afterReload = await import("./api");
    await expect(afterReload.claimRaise(token)).resolves.toMatchObject({
      raiseId: "r_example12",
      role: "human",
    });

    const bodies = fetcher.mock.calls.map(
      ([, init]) =>
        JSON.parse(String(init?.body)) as {
          exchangeId: string;
          expectedRole: string;
          mode: string;
          token: string;
        },
    );
    expect(new Set(bodies.map((body) => body.exchangeId)).size).toBe(1);
    expect(bodies[0]).toMatchObject({ token, mode: "cookie", expectedRole: "human" });
    expect(storage.length).toBe(0);
  });

  it("clears retry state after a terminal claim error", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "invalid_capability", message: "Link expired." }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { claimRaise } = await import("./api");

    await expect(claimRaise("cap_example.invalid-private-claim")).rejects.toMatchObject({
      code: "invalid_capability",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(storage.length).toBe(0);
  });
});
