import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RaiseView } from "@raise/protocol";
import { RaiseClient, type StoredSession } from "./client.js";
import { buildServer } from "./server.js";
import { PendingExchangeStore, PendingOpenStore, SessionStore } from "./store.js";

const cleanup: Array<() => Promise<unknown>> = [];

async function pendingFiles(directory: string, kind: "exchange" | "open") {
  return (await readdir(directory)).filter((file) => file.startsWith(`pending-${kind}-`));
}

async function pendingExchangeContents(directory: string) {
  const files = await pendingFiles(directory, "exchange");
  if (files.length !== 1 || !files[0]) {
    throw new Error(`Expected one pending exchange file, found ${files.length}.`);
  }
  return readFile(join(directory, files[0]), "utf8");
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

async function connect(
  client: RaiseClient,
  store: SessionStore,
  options: {
    pendingExchanges?: PendingExchangeStore;
    pendingOpens?: PendingOpenStore;
    inboxToken?: string;
  } = {},
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer({ client, store, ...options });
  const mcp = new Client({ name: "raise-server-test", version: "1.0.0" });
  cleanup.push(() => mcp.close());
  cleanup.push(() => server.close());
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return mcp;
}

describe("Raise MCP tools", () => {
  it("opens without an extra read when claim expiry is present", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            raiseId: "r_1",
            ownerClaimUrl: "http://localhost:8787/r/r_1#token=cap_owner.secret",
            targetClaimUrl: "http://localhost:8787/r/r_1#token=cap_target.secret",
            targetRole: "human",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            raiseId: "r_1",
            role: "agent",
            token: "ses_agent.secret",
            expiresAt: "2099-01-01T00:00:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const mcp = await connect(
      new RaiseClient("http://localhost:8787", fetcher),
      new SessionStore(join(directory, "sessions")),
    );

    const response = await mcp.callTool({
      name: "raise_open",
      arguments: { prompt: "Check the mobile header." },
    });

    expect(response.isError).not.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:8787/api/raises",
      "http://localhost:8787/api/claims",
    ]);
  });

  it("resumes an already-created raise_open after a lost claim response and restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "sessions");
    const created = {
      raiseId: "r_open_restart",
      ownerClaimUrl:
        "http://localhost:8787/r/r_open_restart#token=cap_owner.restart-private-secret",
      targetClaimUrl:
        "http://localhost:8787/r/r_open_restart#token=cap_target.restart-private-secret",
      targetRole: "human",
    };
    const failedFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(created), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockRejectedValue(new TypeError("connection reset"));
    const firstMcp = await connect(
      new RaiseClient("http://localhost:8787", failedFetcher),
      new SessionStore(directory),
    );

    const failed = await firstMcp.callTool({
      name: "raise_open",
      arguments: { prompt: "Check the restart path." },
    });

    expect(failed.isError).toBe(true);
    expect(failedFetcher).toHaveBeenCalledTimes(3);
    const exchangeId = JSON.parse(String(failedFetcher.mock.calls[1]?.[1]?.body))
      .exchangeId as string;
    expect(JSON.parse(String(failedFetcher.mock.calls[2]?.[1]?.body)).exchangeId).toBe(exchangeId);
    expect(await pendingFiles(directory, "open")).toHaveLength(1);
    expect(await pendingFiles(directory, "exchange")).toHaveLength(1);

    const recoveredFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          raiseId: created.raiseId,
          role: "agent",
          token: "ses_open_restart.private-secret",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const restartedMcp = await connect(
      new RaiseClient("http://localhost:8787", recoveredFetcher),
      new SessionStore(directory),
    );

    const recovered = await restartedMcp.callTool({
      name: "raise_open",
      arguments: { prompt: "Check the restart path." },
    });

    expect(recovered.isError).not.toBe(true);
    expect(recoveredFetcher).toHaveBeenCalledTimes(1);
    expect(String(recoveredFetcher.mock.calls[0]?.[0])).toBe("http://localhost:8787/api/claims");
    expect(JSON.parse(String(recoveredFetcher.mock.calls[0]?.[1]?.body)).exchangeId).toBe(
      exchangeId,
    );
    const textContent = recovered.content.find((item) => item.type === "text");
    if (textContent?.type !== "text") throw new Error("Expected raise_open text content.");
    expect(JSON.parse(textContent.text)).toMatchObject({
      raiseId: created.raiseId,
      humanUrl: created.targetClaimUrl,
      sessionStorage: "saved",
    });
    expect(await pendingFiles(directory, "open")).toHaveLength(0);
    expect(await pendingFiles(directory, "exchange")).toHaveLength(0);
  });

  it("explains when the inbox credential is not configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const fetcher = vi.fn<typeof fetch>();
    const mcp = await connect(
      new RaiseClient("http://localhost:8787", fetcher),
      new SessionStore(join(directory, "sessions")),
      { inboxToken: "" },
    );

    const response = await mcp.callTool({ name: "raise_inbox", arguments: {} });

    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("RAISE_INBOX_TOKEN is required"),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("lists the agent inbox without exposing its credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const inboxToken = "inbox_local.private-secret-with-32-characters";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              raiseId: "r_inbox",
              title: "Fix the mobile header",
              origin: "human",
              waitingOn: "agent",
              pendingAction: "perform_work",
              version: 1,
              createdAt: "2026-09-02T00:00:00.000Z",
              updatedAt: "2026-09-02T00:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const mcp = await connect(
      new RaiseClient("http://localhost:8787", fetcher),
      new SessionStore(join(directory, "sessions")),
      { inboxToken },
    );

    const response = await mcp.callTool({ name: "raise_inbox", arguments: {} });

    expect(response.isError).not.toBe(true);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("http://localhost:8787/api/inbox?limit=50");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${inboxToken}`,
    );
    const textContent = response.content.find((item) => item.type === "text");
    if (textContent?.type !== "text") throw new Error("Expected inbox text content.");
    expect(JSON.parse(textContent.text)).toMatchObject({
      items: [{ raiseId: "r_inbox", pendingAction: "perform_work" }],
    });
    expect(textContent.text).not.toContain(inboxToken);
  });

  it("redacts the inbox credential from upstream error messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const inboxToken = "inbox_local.private-secret-with-32-characters";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "unauthorized",
          message: `Credential ${inboxToken} was rejected.`,
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );
    const mcp = await connect(
      new RaiseClient("http://localhost:8787", fetcher),
      new SessionStore(join(directory, "sessions")),
      { inboxToken },
    );

    const response = await mcp.callTool({ name: "raise_inbox", arguments: {} });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).not.toContain(inboxToken);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("[redacted]"),
    });
  });

  it("opens a full inbox item with images from a fresh local store", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "sessions");
    const inboxToken = "inbox_local.private-secret-with-32-characters";
    const sessionToken = "ses_inbox.private-secret";
    const view: RaiseView = {
      id: "r_inbox",
      title: "Fix the mobile header",
      origin: "human",
      viewerRole: "agent",
      lifecycle: "open",
      waitingOn: "agent",
      pendingAction: "perform_work",
      version: 1,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      permissions: {
        canReply: false,
        canPostResult: true,
        canReview: false,
        canComment: true,
      },
      entries: [
        {
          id: "e_1",
          authorRole: "human",
          kind: "prompt",
          body: "Inspect the screenshot.",
          createdAt: "2026-09-02T00:00:00.000Z",
          attachments: [
            {
              id: "att_1",
              name: "header.webp",
              mediaType: "image/webp",
              url: "/api/raises/r_inbox/attachments/att_1",
              width: 1_200,
              height: 800,
            },
          ],
        },
      ],
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/inbox/r_inbox/session")) {
        return new Response(
          JSON.stringify({
            raiseId: "r_inbox",
            role: "agent",
            token: sessionToken,
            expiresAt: view.expiresAt,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/raises/r_inbox")) {
        return new Response(JSON.stringify(view), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/attachments/att_1?preview=mcp")) {
        return new Response(Buffer.from("preview"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const mcp = await connect(
      new RaiseClient("http://localhost:8787", fetcher),
      new SessionStore(directory),
      { inboxToken },
    );

    const response = await mcp.callTool({
      name: "raise_inbox",
      arguments: { raiseId: "r_inbox" },
    });

    expect(response.isError).not.toBe(true);
    expect(response.content.find((item) => item.type === "image")).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(JSON.stringify(response.content)).not.toContain(inboxToken);
    await expect(
      new SessionStore(directory).get("http://localhost:8787", "r_inbox"),
    ).resolves.toMatchObject({ token: sessionToken });
    for (const file of await readdir(directory)) {
      expect(await readFile(join(directory, file), "utf8")).not.toContain(inboxToken);
    }
    const authorizations = fetcher.mock.calls.map(([, init]) => {
      return new Headers(init?.headers).get("authorization");
    });
    expect(authorizations).toEqual([
      `Bearer ${inboxToken}`,
      `Bearer ${sessionToken}`,
      `Bearer ${sessionToken}`,
    ]);
  });

  it("recovers a lost claim exchange after an MCP process restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "sessions");
    const claimToken = "cap_agent.a-very-private-claim-secret";
    const claimUrl = `http://localhost:8787/r/r_restart#token=${claimToken}`;
    const failedFetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("connection reset"));
    const firstMcp = await connect(
      new RaiseClient("http://localhost:8787", failedFetcher),
      new SessionStore(directory),
    );

    const failed = await firstMcp.callTool({
      name: "raise_claim",
      arguments: { claimUrl, includeImages: false },
    });
    expect(failed.isError).toBe(true);
    expect(failedFetcher).toHaveBeenCalledTimes(2);
    const firstExchangeId = JSON.parse(String(failedFetcher.mock.calls[0]?.[1]?.body))
      .exchangeId as string;
    expect(JSON.parse(String(failedFetcher.mock.calls[1]?.[1]?.body)).exchangeId).toBe(
      firstExchangeId,
    );
    expect(await pendingExchangeContents(directory)).not.toContain(claimToken);

    const view: RaiseView = {
      id: "r_restart",
      title: "Restart recovery",
      origin: "human",
      viewerRole: "agent",
      lifecycle: "open",
      waitingOn: "agent",
      pendingAction: "perform_work",
      version: 1,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      permissions: {
        canReply: false,
        canPostResult: true,
        canReview: false,
        canComment: true,
      },
      entries: [],
    };
    const recoveredFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            raiseId: "r_restart",
            role: "agent",
            token: "ses_restart.private-secret",
            expiresAt: view.expiresAt,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(view), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const restartedMcp = await connect(
      new RaiseClient("http://localhost:8787", recoveredFetcher),
      new SessionStore(directory),
    );

    const recovered = await restartedMcp.callTool({
      name: "raise_claim",
      arguments: { claimUrl, includeImages: false },
    });

    expect(recovered.isError).not.toBe(true);
    expect(JSON.parse(String(recoveredFetcher.mock.calls[0]?.[1]?.body)).exchangeId).toBe(
      firstExchangeId,
    );
    expect(await pendingFiles(directory, "exchange")).toHaveLength(0);
    await expect(
      new SessionStore(directory).get("http://localhost:8787", "r_restart"),
    ).resolves.toMatchObject({ token: "ses_restart.private-secret" });
  });

  it("clears terminal claim failures but retains retryable failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const terminalDirectory = join(root, "terminal");
    const terminalFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "claim_used", message: "Claim is no longer valid." }), {
        status: 410,
        headers: { "content-type": "application/json" },
      }),
    );
    const terminalMcp = await connect(
      new RaiseClient("http://localhost:8787", terminalFetcher),
      new SessionStore(terminalDirectory),
    );
    const terminal = await terminalMcp.callTool({
      name: "raise_claim",
      arguments: {
        claimUrl: "http://localhost:8787/r/r_terminal#token=cap_agent.terminal-private-secret",
        includeImages: false,
      },
    });

    expect(terminal.isError).toBe(true);
    expect(terminalFetcher).toHaveBeenCalledTimes(1);
    expect(await pendingFiles(terminalDirectory, "exchange")).toHaveLength(0);

    const retryableDirectory = join(root, "retryable");
    const retryableFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "unavailable", message: "Try again." }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const retryableMcp = await connect(
      new RaiseClient("http://localhost:8787", retryableFetcher),
      new SessionStore(retryableDirectory),
    );
    const retryable = await retryableMcp.callTool({
      name: "raise_claim",
      arguments: {
        claimUrl: "http://localhost:8787/r/r_retryable#token=cap_agent.retryable-private-secret",
        includeImages: false,
      },
    });

    expect(retryable.isError).toBe(true);
    expect(retryableFetcher).toHaveBeenCalledTimes(2);
    expect(await pendingFiles(retryableDirectory, "exchange")).toHaveLength(1);
  });

  it("warns when saved-session retry cleanup fails", async () => {
    class FailingClearStore extends PendingExchangeStore {
      override async clear(_server: string, _claimToken: string) {
        throw new Error("cleanup failed");
      }
    }

    const root = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "sessions");
    const view: RaiseView = {
      id: "r_cleanup",
      title: "Cleanup warning",
      origin: "human",
      viewerRole: "agent",
      lifecycle: "open",
      waitingOn: "agent",
      pendingAction: "perform_work",
      version: 1,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      permissions: {
        canReply: false,
        canPostResult: true,
        canReview: false,
        canComment: true,
      },
      entries: [],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            raiseId: view.id,
            role: "agent",
            token: "ses_cleanup.private-secret",
            expiresAt: view.expiresAt,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(view), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const mcp = await connect(
      new RaiseClient("http://localhost:8787", fetcher),
      new SessionStore(directory),
      { pendingExchanges: new FailingClearStore(directory) },
    );

    const response = await mcp.callTool({
      name: "raise_claim",
      arguments: {
        claimUrl: "http://localhost:8787/r/r_cleanup#token=cap_agent.cleanup-private-secret",
        includeImages: false,
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("local pending retry state could not be cleared"),
    });
    await expect(
      new SessionStore(directory).get("http://localhost:8787", "r_cleanup"),
    ).resolves.toMatchObject({ token: "ses_cleanup.private-secret" });
  });

  it("attempts every saved raise_open cleanup when one fails", async () => {
    class FailingOpenClearStore extends PendingOpenStore {
      override async clear(_inputDigest: string) {
        throw new Error("open cleanup failed");
      }
    }

    const root = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "sessions");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            raiseId: "r_open_cleanup",
            ownerClaimUrl:
              "http://localhost:8787/r/r_open_cleanup#token=cap_owner.cleanup-private-secret",
            targetClaimUrl:
              "http://localhost:8787/r/r_open_cleanup#token=cap_target.cleanup-private-secret",
            targetRole: "human",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            raiseId: "r_open_cleanup",
            role: "agent",
            token: "ses_open_cleanup.private-secret",
            expiresAt: "2099-01-01T00:00:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const mcp = await connect(
      new RaiseClient("http://localhost:8787", fetcher),
      new SessionStore(directory),
      { pendingOpens: new FailingOpenClearStore(directory) },
    );

    const response = await mcp.callTool({
      name: "raise_open",
      arguments: { prompt: "Verify cleanup." },
    });

    expect(response.isError).not.toBe(true);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("local pending retry state could not be cleared"),
    });
    expect(await pendingFiles(directory, "open")).toHaveLength(1);
    expect(await pendingFiles(directory, "exchange")).toHaveLength(0);
  });

  it("attempts every terminal raise_open cleanup when one fails", async () => {
    class FailingOpenClearStore extends PendingOpenStore {
      override async clear(_inputDigest: string) {
        throw new Error("open cleanup failed");
      }
    }

    const root = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "sessions");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            raiseId: "r_open_terminal",
            ownerClaimUrl:
              "http://localhost:8787/r/r_open_terminal#token=cap_owner.terminal-private-secret",
            targetClaimUrl:
              "http://localhost:8787/r/r_open_terminal#token=cap_target.terminal-private-secret",
            targetRole: "human",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "claim_used", message: "Claim is no longer valid." }), {
          status: 410,
          headers: { "content-type": "application/json" },
        }),
      );
    const mcp = await connect(
      new RaiseClient("http://localhost:8787", fetcher),
      new SessionStore(directory),
      { pendingOpens: new FailingOpenClearStore(directory) },
    );

    const response = await mcp.callTool({
      name: "raise_open",
      arguments: { prompt: "Verify terminal cleanup." },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Local pending retry state could not be cleared"),
    });
    expect(await pendingFiles(directory, "open")).toHaveLength(1);
    expect(await pendingFiles(directory, "exchange")).toHaveLength(0);
  });

  it("keeps the pending exchange when session persistence fails", async () => {
    class FailingSessionStore extends SessionStore {
      override async put(_session: StoredSession) {
        return false;
      }
    }

    const root = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "sessions");
    const claimToken = "cap_agent.another-private-claim-secret";
    const view: RaiseView = {
      id: "r_memory",
      title: "Memory-only claim",
      origin: "human",
      viewerRole: "agent",
      lifecycle: "open",
      waitingOn: "agent",
      pendingAction: "perform_work",
      version: 1,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      permissions: {
        canReply: false,
        canPostResult: true,
        canReview: false,
        canComment: true,
      },
      entries: [],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            raiseId: "r_memory",
            role: "agent",
            token: "ses_memory.private-secret",
            expiresAt: view.expiresAt,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(view), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const mcp = await connect(
      new RaiseClient("http://localhost:8787", fetcher),
      new FailingSessionStore(directory),
    );

    const response = await mcp.callTool({
      name: "raise_claim",
      arguments: {
        claimUrl: `http://localhost:8787/r/r_memory#token=${claimToken}`,
        includeImages: false,
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"sessionStorage": "memory_only"'),
    });
    const pending = await pendingExchangeContents(directory);
    expect(pending).not.toContain(claimToken);
    expect(pending).toContain(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).exchangeId);
  });

  it("stops fetching previews as soon as the aggregate byte budget is exhausted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new SessionStore(join(directory, "sessions"));
    await store.put({
      server: "http://localhost:8787",
      raiseId: "r_1",
      role: "agent",
      token: "ses_agent.secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const attachments = Array.from({ length: 12 }, (_, index) => ({
      id: `att_${index}`,
      name: `screenshot-${index}.webp`,
      mediaType: "image/webp" as const,
      url: `/api/raises/r_1/attachments/att_${index}`,
      width: 1_600,
      height: 1_200,
    }));
    const view: RaiseView = {
      id: "r_1",
      title: "Preview budget",
      origin: "human",
      viewerRole: "agent",
      lifecycle: "open",
      waitingOn: "agent",
      pendingAction: "perform_work",
      version: 1,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      permissions: {
        canReply: false,
        canPostResult: true,
        canReview: false,
        canComment: true,
      },
      entries: [
        {
          id: "e_1",
          authorRole: "human",
          kind: "prompt",
          body: "Inspect every screenshot.",
          createdAt: "2026-08-31T00:00:00.000Z",
          attachments,
        },
      ],
    };
    let imageFetches = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === "http://localhost:8787/api/raises/r_1") {
        return new Response(JSON.stringify(view), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/attachments/")) {
        imageFetches += 1;
        return new Response(Buffer.alloc(4 * 1_024 * 1_024), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const mcp = await connect(new RaiseClient("http://localhost:8787", fetcher), store);

    const response = await mcp.callTool({
      name: "raise_read",
      arguments: { raiseId: "r_1", includeImages: true },
    });

    expect(response.isError).not.toBe(true);
    expect(imageFetches).toBe(2);
    expect(response.content.find((item) => item.type === "image")).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
  });

  it("labels a requested screenshot with the rendered preview MIME type", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new SessionStore(join(directory, "sessions"));
    await store.put({
      server: "http://localhost:8787",
      raiseId: "r_1",
      role: "agent",
      token: "ses_agent.secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const view: RaiseView = {
      id: "r_1",
      title: "Preview MIME type",
      origin: "human",
      viewerRole: "agent",
      lifecycle: "open",
      waitingOn: "agent",
      pendingAction: "perform_work",
      version: 1,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      permissions: {
        canReply: false,
        canPostResult: true,
        canReview: false,
        canComment: true,
      },
      entries: [
        {
          id: "e_1",
          authorRole: "human",
          kind: "prompt",
          body: "Inspect the screenshot.",
          createdAt: "2026-08-31T00:00:00.000Z",
          attachments: [
            {
              id: "att_1",
              name: "screenshot.webp",
              mediaType: "image/webp",
              url: "/api/raises/r_1/attachments/att_1",
              width: 1_600,
              height: 1_200,
            },
          ],
        },
      ],
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === "http://localhost:8787/api/raises/r_1") {
        return new Response(JSON.stringify(view), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/attachments/att_1?preview=mcp")) {
        return new Response(Buffer.from("preview"), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const mcp = await connect(new RaiseClient("http://localhost:8787", fetcher), store);

    const response = await mcp.callTool({
      name: "raise_screenshot",
      arguments: { raiseId: "r_1", attachmentId: "att_1" },
    });

    expect(response.isError).not.toBe(true);
    expect(response.content.find((item) => item.type === "image")).toMatchObject({
      type: "image",
      mimeType: "image/jpeg",
    });
  });
});
