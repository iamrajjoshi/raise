import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RaiseView } from "@raise/protocol";
import { RaiseClient } from "./client.js";
import { buildServer } from "./server.js";
import { SessionStore } from "./store.js";

const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

async function connect(client: RaiseClient, store: SessionStore) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer({ client, store });
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
