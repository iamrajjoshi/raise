import type { RaiseView } from "@raise/protocol";
import { describe, expect, it, vi } from "vitest";
import { RaiseClient, claimTokenFromUrl } from "./client.js";
import type { RaiseApiError } from "./client.js";

const updatedRaise: RaiseView = {
  id: "r_1",
  title: "Example",
  origin: "human",
  viewerRole: "agent",
  lifecycle: "open",
  waitingOn: "human",
  pendingAction: "review_result",
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

describe("Raise MCP HTTP client", () => {
  it("requires HTTPS away from the local machine", () => {
    expect(() => new RaiseClient("http://raise.example")).toThrow("must use HTTPS");
    expect(() => new RaiseClient("http://127.0.0.1:8787")).not.toThrow();
    expect(() => new RaiseClient("https://raise.example")).not.toThrow();
  });

  it("extracts a claim token only from the configured Raise origin", () => {
    expect(
      claimTokenFromUrl(
        "http://localhost:8787/r/r_1#token=cap_abc.secret",
        "http://localhost:8787",
      ),
    ).toBe("cap_abc.secret");
    expect(() =>
      claimTokenFromUrl(
        "https://other.example/r/r_1#token=cap_abc.secret",
        "http://localhost:8787",
      ),
    ).toThrow("belongs to https://other.example");
  });

  it("exchanges a pasted URL without sending its fragment", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          raiseId: "r_1",
          role: "agent",
          token: "ses_1.secret",
          expiresAt: "2026-09-01T00:00:00.000Z",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const client = new RaiseClient("http://localhost:8787", fetcher);
    const exchangeId = "79f46eb8-2752-42fc-8a35-61ce9e91d562";

    await expect(
      client.exchangeClaim("http://localhost:8787/r/r_1#token=cap_abc.secret", exchangeId),
    ).resolves.toMatchObject({ raiseId: "r_1", token: "ses_1.secret" });
    expect(fetcher).toHaveBeenCalledWith("http://localhost:8787/api/claims", expect.any(Object));
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      raiseId: "r_1",
      token: "cap_abc.secret",
      mode: "token",
      expectedRole: "agent",
      exchangeId,
    });
  });

  it("retries a lost claim response with the same exchange ID", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            raiseId: "r_1",
            role: "agent",
            token: "ses_1.secret",
            expiresAt: "2026-09-01T00:00:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new RaiseClient("http://localhost:8787", fetcher);
    const exchangeId = "13162363-fb99-441b-aeee-06a2295c1c58";

    await expect(
      client.exchangeClaim("http://localhost:8787/r/r_1#token=cap_abc.secret", exchangeId),
    ).resolves.toMatchObject({ token: "ses_1.secret" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { exchangeId: string };
    const second = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as {
      exchangeId: string;
    };
    expect(second.exchangeId).toBe(first.exchangeId);
    expect(first.exchangeId).toBe(exchangeId);
  });

  it("retries a lost entry response once with the same idempotency key", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValue(
        new Response(JSON.stringify(updatedRaise), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = new RaiseClient("http://localhost:8787", fetcher);
    const session = {
      server: "http://localhost:8787",
      raiseId: "r_1",
      role: "agent" as const,
      token: "ses_1.secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const idempotencyKey = "86e1958f-5d99-49f5-aa7a-54fc77ad31ba";

    await expect(
      client.post(
        session,
        { kind: "comment", body: "Still working.", attachments: [], expectedVersion: 1 },
        idempotencyKey,
      ),
    ).resolves.toMatchObject({ id: "r_1", version: 2 });

    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("idempotency-key")).toBe(idempotencyKey);
      expect(headers.get("authorization")).toBe(`Bearer ${session.token}`);
      expect(String(init?.body)).not.toContain(idempotencyKey);
    }
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[0]?.[1]?.body);
  });

  it("does not retry a definite entry rejection", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "state_conflict", message: "Read it again." }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new RaiseClient("http://localhost:8787", fetcher);

    await expect(
      client.post(
        {
          server: "http://localhost:8787",
          raiseId: "r_1",
          role: "agent",
          token: "ses_1.secret",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        { kind: "comment", body: "Stale note.", attachments: [], expectedVersion: 1 },
        "2fb0ec52-eeb6-449d-950f-d91791767323",
      ),
    ).rejects.toMatchObject({ status: 409, code: "state_conflict" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns concrete API errors to the agent", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "state_conflict", message: "Reload and try again." }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new RaiseClient("http://localhost:8787", fetcher);

    await expect(
      client.read({
        server: "http://localhost:8787",
        raiseId: "r_1",
        role: "agent",
        token: "ses_1.secret",
        expiresAt: "2026-09-01T00:00:00.000Z",
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<RaiseApiError>>({ code: "state_conflict" }));
  });

  it("rejects a malformed successful API response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "r_1", version: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new RaiseClient("http://localhost:8787", fetcher);

    await expect(
      client.read({
        server: "http://localhost:8787",
        raiseId: "r_1",
        role: "agent",
        token: "ses_1.secret",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow();
  });

  it("performs one bounded cursor wait and parses a delta", async () => {
    const delta: RaiseView = {
      ...updatedRaise,
      cursor: "1725552123457-0",
      entriesMode: "delta",
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(delta), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new RaiseClient("http://localhost:8787", fetcher);
    const session = {
      server: "http://localhost:8787",
      raiseId: "r_1",
      role: "agent" as const,
      token: "ses_1.secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };

    await expect(client.changes(session, "1725552123456-0", 30)).resolves.toEqual(delta);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "http://localhost:8787/api/raises/r_1/changes?cursor=1725552123456-0&wait=30",
    );
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${session.token}`,
    );
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps an unchanged cursor wait to null and preserves a caller signal", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new RaiseClient("http://localhost:8787", fetcher);
    const controller = new AbortController();

    await expect(
      client.changes(
        {
          server: "http://localhost:8787",
          raiseId: "r_1",
          role: "agent",
          token: "ses_1.secret",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        "1725552123456-0",
        20,
        controller.signal,
      ),
    ).resolves.toBeNull();
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("returns the MIME type of the rendered agent preview", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(Buffer.from("preview"), {
        status: 200,
        headers: { "content-type": "image/webp; charset=binary" },
      }),
    );
    const client = new RaiseClient("http://localhost:8787", fetcher);

    await expect(
      client.image(
        {
          server: "http://localhost:8787",
          raiseId: "r_1",
          role: "agent",
          token: "ses_1.secret",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        "/api/raises/r_1/attachments/att_1",
      ),
    ).resolves.toEqual({ data: Buffer.from("preview"), mimeType: "image/webp" });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "http://localhost:8787/api/raises/r_1/attachments/att_1?preview=mcp",
    );
  });

  it("aborts a stalled request at the caller’s deadline", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const client = new RaiseClient("http://localhost:8787", fetcher);
    const controller = new AbortController();
    const pending = client.read(
      {
        server: "http://localhost:8787",
        raiseId: "r_1",
        role: "agent",
        token: "ses_1.secret",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      controller.signal,
    );
    controller.abort(new Error("wait deadline reached"));

    await expect(pending).rejects.toThrow("wait deadline reached");
  });
});
