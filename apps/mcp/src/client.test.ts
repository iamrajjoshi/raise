import { describe, expect, it, vi } from "vitest";
import { RaiseClient, claimTokenFromUrl } from "./client.js";
import type { RaiseApiError } from "./client.js";

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

  it("lists and opens inbox items with the local inbox credential", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            raiseId: "r_1",
            role: "agent",
            token: "ses_1.secret",
            expiresAt: "2099-01-01T00:00:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new RaiseClient("http://localhost:8787", fetcher);

    await expect(client.listInbox("inbox_local.secret", 25)).resolves.toEqual({
      items: [],
    });
    await expect(client.openInbox("r_1", "inbox_local.secret")).resolves.toMatchObject({
      raiseId: "r_1",
      role: "agent",
    });

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:8787/api/inbox?limit=25",
      "http://localhost:8787/api/inbox/r_1/session",
    ]);
    for (const [, init] of fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer inbox_local.secret");
    }
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("content-type")).toBeNull();
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("content-type")).toBeNull();
    expect(
      fetcher.mock.calls.map(([url, init]) => `${String(url)} ${String(init?.body)}`).join("\n"),
    ).not.toContain("inbox_local.secret");
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
