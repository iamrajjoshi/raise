/** @vitest-environment happy-dom */
import type { PostEntryInput, RaiseView } from "@raise/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestStorage } from "./testStorage";

const storage = installTestStorage();
const sessionValues = new Map<string, string>();
const testSessionStorage: Storage = {
  get length() {
    return sessionValues.size;
  },
  clear() {
    sessionValues.clear();
  },
  getItem(key) {
    return sessionValues.get(key) ?? null;
  },
  key(index) {
    return Array.from(sessionValues.keys())[index] ?? null;
  },
  removeItem(key) {
    sessionValues.delete(key);
  },
  setItem(key, value) {
    sessionValues.set(key, String(value));
  },
};

function installSessionStorage() {
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: testSessionStorage,
  });
}

const testRaiseView: RaiseView = {
  id: "r_example12",
  title: "Example",
  origin: "human",
  viewerRole: "human",
  lifecycle: "open",
  waitingOn: "agent",
  pendingAction: "perform_work",
  version: 2,
  cursor: "1725552123456-0",
  entriesMode: "snapshot",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:01:00.000Z",
  expiresAt: "2026-09-01T02:01:00.000Z",
  permissions: {
    canReply: false,
    canPostResult: false,
    canReview: false,
    canComment: true,
  },
  entries: [],
};

function response(status = 200) {
  const body =
    status === 200
      ? testRaiseView
      : { code: "request_failed", message: `Request failed with status ${status}.` };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function entry(overrides: Partial<PostEntryInput> = {}): PostEntryInput {
  return {
    kind: "response",
    body: "Here is the missing context.",
    attachments: [],
    expectedVersion: 1,
    ...overrides,
  };
}

function idempotencyKeys(fetcher: ReturnType<typeof vi.fn<typeof fetch>>) {
  return fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get("Idempotency-Key"));
}

installSessionStorage();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.useRealTimers();
  storage.clear();
  testSessionStorage.clear();
  installSessionStorage();
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

    await expect(firstLoad.claimRaise("r_example12", token)).rejects.toThrow(
      "connection still lost",
    );
    const storedKeys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    expect(storedKeys).toHaveLength(1);
    expect(storedKeys[0]).not.toContain(token);

    vi.resetModules();
    const afterReload = await import("./api");
    await expect(afterReload.claimRaise("r_example12", token)).resolves.toMatchObject({
      raiseId: "r_example12",
      role: "human",
    });

    const bodies = fetcher.mock.calls.map(
      ([, init]) =>
        JSON.parse(String(init?.body)) as {
          exchangeId: string;
          expectedRole: string;
          mode: string;
          raiseId: string;
          token: string;
        },
    );
    expect(new Set(bodies.map((body) => body.exchangeId)).size).toBe(1);
    expect(bodies[0]).toMatchObject({
      raiseId: "r_example12",
      token,
      mode: "cookie",
      expectedRole: "human",
    });
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

    await expect(
      claimRaise("r_example12", "cap_example.invalid-private-claim"),
    ).rejects.toMatchObject({
      code: "invalid_capability",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(storage.length).toBe(0);
  });
});

describe("browser API response validation", () => {
  it("rejects a malformed successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ id: "r_example12", version: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { getRaise } = await import("./api");

    await expect(getRaise("r_example12")).rejects.toThrow();
  });

  it("reads one bounded cursor wait and maps no change to null", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetcher);
    const { getRaiseChanges } = await import("./api");

    await expect(getRaiseChanges("r_example12", "1725552123456-0", 20)).resolves.toBeNull();
    await expect(getRaiseChanges("r_example12", "1725552123456-0", 20)).resolves.toEqual(
      testRaiseView,
    );

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/raises/r_example12/changes?cursor=1725552123456-0&wait=20",
      "/api/raises/r_example12/changes?cursor=1725552123456-0&wait=20",
    ]);
  });

  it("passes an abort signal through a cursor wait", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { getRaiseChanges } = await import("./api");
    const controller = new AbortController();
    const waiting = getRaiseChanges("r_example12", "1725552123456-0", 20, controller.signal);

    controller.abort(new Error("page closed"));

    await expect(waiting).rejects.toThrow("page closed");
    expect(fetcher.mock.calls[0]?.[1]?.signal).not.toBe(controller.signal);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

describe("browser entry idempotency", () => {
  it("automatically retries a lost request once with the same UUID key", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetcher);
    const { postEntry } = await import("./api");

    await expect(postEntry("r_example12", entry())).resolves.toEqual(testRaiseView);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const keys = idempotencyKeys(fetcher);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(testSessionStorage.length).toBe(1);
  });

  it("reuses the stored key after reload for the same normalized input", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockRejectedValueOnce(new TypeError("connection still lost"))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetcher);
    const firstLoad = await import("./api");
    const attachment = {
      name: " screenshot.png ",
      mimeType: "image/png" as const,
      dataUrl: "data:image/png;base64,c2VjcmV0LWltYWdl",
    };

    await expect(
      firstLoad.postEntry(
        "r_example12",
        entry({ body: "  Please fix this.  ", attachments: [attachment] }),
      ),
    ).rejects.toThrow("connection still lost");

    const persisted = Array.from(sessionValues.entries()).flat().join(" ");
    expect(persisted).not.toContain("r_example12");
    expect(persisted).not.toContain("Please fix this");
    expect(persisted).not.toContain("c2VjcmV0LWltYWdl");
    const storedRecord = JSON.parse(Array.from(sessionValues.values())[0] ?? "{}") as object;
    expect(Object.keys(storedRecord).sort()).toEqual(["digest", "key", "timestamp"]);

    vi.resetModules();
    const afterReload = await import("./api");
    await expect(
      afterReload.postEntry(
        "r_example12",
        entry({
          body: "Please fix this.",
          attachments: [{ ...attachment, name: "screenshot.png" }],
        }),
      ),
    ).resolves.toEqual(testRaiseView);

    const keys = idempotencyKeys(fetcher);
    expect(new Set(keys).size).toBe(1);
    expect(new Set(fetcher.mock.calls.map(([, init]) => init?.body)).size).toBe(1);
  });

  it("keeps a successful mapping so a lost response can be replayed after reload", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetcher);
    const firstLoad = await import("./api");

    await firstLoad.postEntry("r_example12", entry());
    vi.resetModules();
    const afterReload = await import("./api");
    await afterReload.postEntry("r_example12", entry());

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Set(idempotencyKeys(fetcher)).size).toBe(1);
    expect(testSessionStorage.length).toBe(1);
  });

  it("uses new keys when the request ID, content, or expected version changes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetcher);
    const { postEntry } = await import("./api");

    await postEntry("r_example12", entry());
    await postEntry("r_other123", entry());
    await postEntry("r_example12", entry({ body: "Different context." }));
    await postEntry("r_example12", entry({ expectedVersion: 2 }));

    const keys = idempotencyKeys(fetcher);
    expect(keys.every((key) => key && /^[A-Za-z0-9_-]{16,128}$/.test(key))).toBe(true);
    expect(new Set(keys).size).toBe(4);
  });

  it.each([408, 500])("retries status %i once with the same key", async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetcher);
    const { postEntry } = await import("./api");

    await expect(postEntry("r_example12", entry())).resolves.toEqual(testRaiseView);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Set(idempotencyKeys(fetcher)).size).toBe(1);
  });

  it("retains but does not immediately retry a rate-limited request", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetcher);
    const { postEntry } = await import("./api");

    await expect(postEntry("r_example12", entry())).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(testSessionStorage.length).toBe(1);

    await expect(postEntry("r_example12", entry())).resolves.toEqual(testRaiseView);
    expect(idempotencyKeys(fetcher)[1]).toBe(idempotencyKeys(fetcher)[0]);
  });

  it("clears the mapping after a definite client rejection", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(409))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetcher);
    const { postEntry } = await import("./api");

    await expect(postEntry("r_example12", entry())).rejects.toMatchObject({ status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(testSessionStorage.length).toBe(0);

    await expect(postEntry("r_example12", entry())).resolves.toEqual(testRaiseView);
    const keys = idempotencyKeys(fetcher);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("replaces a retry key after its seven-hour retention window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockRejectedValueOnce(new TypeError("connection still lost"))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetcher);
    const firstLoad = await import("./api");

    await expect(firstLoad.postEntry("r_example12", entry())).rejects.toThrow();
    vi.setSystemTime(new Date("2026-09-03T07:00:00.001Z"));
    vi.resetModules();
    const afterExpiry = await import("./api");
    await afterExpiry.postEntry("r_example12", entry());

    const keys = idempotencyKeys(fetcher);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("falls back to memory when session storage is unavailable", async () => {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("storage blocked");
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetcher);
    const { postEntry } = await import("./api");

    await expect(postEntry("r_example12", entry())).resolves.toEqual(testRaiseView);
    expect(new Set(idempotencyKeys(fetcher)).size).toBe(1);
  });
});
