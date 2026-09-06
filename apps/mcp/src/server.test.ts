import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RaiseView } from "@raise/protocol";
import { RaiseClient, type StoredSession } from "./client.js";
import { buildServer } from "./server.js";
import { PendingExchangeStore, PendingOpenStore, SessionStore } from "./store.js";
import type { PendingMutationStore } from "./store.js";

const cleanup: Array<() => Promise<void>> = [];

async function pendingFiles(directory: string, kind: "exchange" | "mutation" | "open") {
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
    pendingMutations?: PendingMutationStore;
    pendingOpens?: PendingOpenStore;
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
      cursor: "1725552123456-0",
      entriesMode: "snapshot",
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
            expiresAt: "2099-01-02T00:00:00.000Z",
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
    ).resolves.toMatchObject({
      token: "ses_restart.private-secret",
      expiresAt: "2099-01-02T00:00:00.000Z",
    });
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
      cursor: "1725552123456-0",
      entriesMode: "snapshot",
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
      cursor: "1725552123456-0",
      entriesMode: "snapshot",
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

  it("replays a lost reply across restart without a stale pre-read", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "sessions");
    const store = new SessionStore(directory);
    await store.put({
      server: "http://localhost:8787",
      raiseId: "r_reply_restart",
      role: "agent",
      token: "ses_reply.private-secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const current: RaiseView = {
      id: "r_reply_restart",
      title: "Lost reply",
      origin: "human",
      viewerRole: "agent",
      lifecycle: "open",
      waitingOn: "agent",
      pendingAction: "perform_work",
      version: 1,
      cursor: "1725552123456-0",
      entriesMode: "snapshot",
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
    const updated: RaiseView = {
      ...current,
      waitingOn: "human",
      pendingAction: "review_result",
      version: 2,
      permissions: {
        canReply: false,
        canPostResult: false,
        canReview: false,
        canComment: true,
      },
      entries: [
        {
          id: "e_result",
          authorRole: "agent",
          kind: "result",
          body: "The header is fixed.",
          createdAt: "2026-09-02T00:01:00.000Z",
          attachments: [],
        },
      ],
    };
    const failedFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(current), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockRejectedValueOnce(new TypeError("connection reset after write"))
      .mockRejectedValueOnce(new TypeError("connection reset after retry"));
    const firstMcp = await connect(new RaiseClient("http://localhost:8787", failedFetcher), store);

    const failed = await firstMcp.callTool({
      name: "raise_reply",
      arguments: {
        raiseId: current.id,
        expectedVersion: 1,
        body: "The header is fixed.",
      },
    });

    expect(failed.isError).toBe(true);
    expect(failedFetcher).toHaveBeenCalledTimes(3);
    const firstPostHeaders = new Headers(failedFetcher.mock.calls[1]?.[1]?.headers);
    const retryPostHeaders = new Headers(failedFetcher.mock.calls[2]?.[1]?.headers);
    const idempotencyKey = firstPostHeaders.get("idempotency-key");
    expect(idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(retryPostHeaders.get("idempotency-key")).toBe(idempotencyKey);
    expect(await pendingFiles(directory, "mutation")).toHaveLength(1);

    const recoveredFetcher = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify(updated), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const restartedMcp = await connect(
      new RaiseClient("http://localhost:8787", recoveredFetcher),
      new SessionStore(directory),
    );

    const recovered = await restartedMcp.callTool({
      name: "raise_reply",
      arguments: {
        raiseId: current.id,
        expectedVersion: 1,
        body: "The header is fixed.",
      },
    });
    const replayedAgain = await restartedMcp.callTool({
      name: "raise_reply",
      arguments: {
        raiseId: current.id,
        expectedVersion: 1,
        body: "The header is fixed.",
      },
    });

    expect(recovered.isError).not.toBe(true);
    expect(replayedAgain.isError).not.toBe(true);
    expect(recoveredFetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of recoveredFetcher.mock.calls) {
      expect(String(url)).toBe("http://localhost:8787/api/raises/r_reply_restart/entries");
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(idempotencyKey);
      expect(JSON.parse(String(init?.body))).toMatchObject({ expectedVersion: 1 });
    }
    expect(await pendingFiles(directory, "mutation")).toHaveLength(1);
  });

  it("clears rejected mutations and retains retryable ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const view: RaiseView = {
      id: "r_mutation_failure",
      title: "Mutation failure",
      origin: "human",
      viewerRole: "agent",
      lifecycle: "open",
      waitingOn: "agent",
      pendingAction: "perform_work",
      version: 1,
      cursor: "1725552123456-0",
      entriesMode: "snapshot",
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

    for (const scenario of [
      { name: "terminal", status: 409, code: "state_conflict", retained: 0 },
      { name: "retryable", status: 503, code: "unavailable", retained: 1 },
    ]) {
      const directory = join(root, scenario.name);
      const store = new SessionStore(directory);
      await store.put({
        server: "http://localhost:8787",
        raiseId: view.id,
        role: "agent",
        token: `ses_${scenario.name}.private-secret`,
        expiresAt: view.expiresAt,
      });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(view), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ code: scenario.code, message: "Could not save the entry." }),
            {
              status: scenario.status,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      const mcp = await connect(new RaiseClient("http://localhost:8787", fetcher), store);

      const response = await mcp.callTool({
        name: "raise_reply",
        arguments: {
          raiseId: view.id,
          expectedVersion: 1,
          body: `${scenario.name} reply`,
        },
      });

      expect(response.isError).toBe(true);
      expect(await pendingFiles(directory, "mutation")).toHaveLength(scenario.retained);
    }
  });

  it("waits once from a supplied cursor and inlines only delta screenshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new SessionStore(join(directory, "sessions"));
    await store.put({
      server: "http://localhost:8787",
      raiseId: "r_wait_delta",
      role: "agent",
      token: "ses_wait.private-secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const delta: RaiseView = {
      id: "r_wait_delta",
      title: "Wait delta",
      origin: "human",
      viewerRole: "agent",
      lifecycle: "open",
      waitingOn: "agent",
      pendingAction: "perform_work",
      version: 2,
      cursor: "1725552123457-0",
      entriesMode: "delta",
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:01:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      permissions: {
        canReply: false,
        canPostResult: true,
        canReview: false,
        canComment: true,
      },
      entries: [
        {
          id: "e_delta",
          authorRole: "human",
          kind: "response",
          body: "New context.",
          createdAt: "2026-09-02T00:01:00.000Z",
          attachments: [
            {
              id: "img_delta",
              name: "new.webp",
              mediaType: "image/webp",
              url: "/api/raises/r_wait_delta/attachments/img_delta",
              width: 10,
              height: 10,
            },
          ],
        },
      ],
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/changes?")) {
        return new Response(JSON.stringify(delta), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/attachments/img_delta")) {
        return new Response(Buffer.from("preview"), {
          status: 200,
          headers: { "content-type": "image/webp" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const mcp = await connect(new RaiseClient("http://localhost:8787", fetcher), store);

    const response = await mcp.callTool({
      name: "raise_wait",
      arguments: {
        raiseId: "r_wait_delta",
        cursor: "1725552123456-0",
        timeoutSeconds: 20,
        includeImages: true,
      },
    });

    expect(response.isError).not.toBe(true);
    const payload = response.content.find((item) => item.type === "text");
    expect(payload?.type === "text" ? JSON.parse(payload.text) : null).toMatchObject({
      changed: true,
      cursor: "1725552123457-0",
      entriesMode: "delta",
      entries: [{ id: "e_delta" }],
    });
    expect(response.content.filter((item) => item.type === "image")).toHaveLength(1);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:8787/api/raises/r_wait_delta/changes?cursor=1725552123456-0&wait=20",
      "http://localhost:8787/api/raises/r_wait_delta/attachments/img_delta?preview=mcp",
    ]);
  });

  it("returns an empty delta after an unchanged cursor wait", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new SessionStore(join(directory, "sessions"));
    await store.put({
      server: "http://localhost:8787",
      raiseId: "r_wait_timeout",
      role: "agent",
      token: "ses_wait.private-secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const mcp = await connect(new RaiseClient("http://localhost:8787", fetcher), store);

    const response = await mcp.callTool({
      name: "raise_wait",
      arguments: {
        raiseId: "r_wait_timeout",
        cursor: "1725552123456-0",
        timeoutSeconds: 1,
        includeImages: true,
      },
    });

    const payload = response.content.find((item) => item.type === "text");
    expect(payload?.type === "text" ? JSON.parse(payload.text) : null).toEqual({
      changed: false,
      waitedSeconds: 1,
      cursor: "1725552123456-0",
      entriesMode: "delta",
      entries: [],
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps no-argument and afterVersion waits compatible through one initial read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new SessionStore(join(directory, "sessions"));
    await store.put({
      server: "http://localhost:8787",
      raiseId: "r_wait_compat",
      role: "agent",
      token: "ses_wait.private-secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const snapshot: RaiseView = {
      id: "r_wait_compat",
      title: "Compatibility wait",
      origin: "human",
      viewerRole: "agent",
      lifecycle: "open",
      waitingOn: "agent",
      pendingAction: "perform_work",
      version: 2,
      cursor: "1725552123457-0",
      entriesMode: "snapshot",
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:01:00.000Z",
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
        new Response(JSON.stringify(snapshot), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(snapshot), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const mcp = await connect(new RaiseClient("http://localhost:8787", fetcher), store);

    const noCursor = await mcp.callTool({
      name: "raise_wait",
      arguments: { raiseId: "r_wait_compat", timeoutSeconds: 1, includeImages: false },
    });
    const noCursorText = noCursor.content.find((item) => item.type === "text");
    expect(noCursorText?.type === "text" ? JSON.parse(noCursorText.text) : null).toMatchObject({
      changed: false,
      cursor: snapshot.cursor,
      entriesMode: "snapshot",
    });

    const oldVersion = await mcp.callTool({
      name: "raise_wait",
      arguments: {
        raiseId: "r_wait_compat",
        afterVersion: 1,
        timeoutSeconds: 1,
        includeImages: false,
      },
    });
    const oldVersionText = oldVersion.content.find((item) => item.type === "text");
    expect(oldVersionText?.type === "text" ? JSON.parse(oldVersionText.text) : null).toMatchObject({
      changed: true,
      version: 2,
      cursor: snapshot.cursor,
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:8787/api/raises/r_wait_compat",
      `http://localhost:8787/api/raises/r_wait_compat/changes?cursor=${snapshot.cursor}&wait=1`,
      "http://localhost:8787/api/raises/r_wait_compat",
    ]);
  });

  it("rejects cursor and afterVersion when supplied together", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-mcp-server-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const fetcher = vi.fn<typeof fetch>();
    const mcp = await connect(
      new RaiseClient("http://localhost:8787", fetcher),
      new SessionStore(join(directory, "sessions")),
    );

    const response = await mcp.callTool({
      name: "raise_wait",
      arguments: {
        raiseId: "r_wait_invalid",
        cursor: "1725552123456-0",
        afterVersion: 1,
      },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Pass cursor or afterVersion, not both."),
    });
    expect(fetcher).not.toHaveBeenCalled();
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
      cursor: "1725552123456-0",
      entriesMode: "snapshot",
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
      cursor: "1725552123456-0",
      entriesMode: "snapshot",
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
