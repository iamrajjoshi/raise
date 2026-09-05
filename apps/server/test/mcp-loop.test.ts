import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { claimResponseSchema, raiseViewSchema } from "@raise/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createValkeyTestApp,
  createValkeyTestStore,
  startValkeyTestServer,
  type ValkeyTestServer,
} from "./valkey-test-server.js";

const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanup: Array<() => Promise<void>> = [];
let server: ValkeyTestServer;

beforeAll(async () => {
  server = await startValkeyTestServer();
});

afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

afterAll(async () => server?.stop());

function claimToken(url: string) {
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get("token");
  if (!token) throw new Error("Claim URL has no token.");
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`MCP JSON field ${key} is not a string.`);
  return value;
}

function firstAttachmentId(record: Record<string, unknown>): string | undefined {
  const entries = record.entries;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.attachments)) continue;
    for (const attachment of entry.attachments) {
      if (isRecord(attachment) && typeof attachment.id === "string") return attachment.id;
    }
  }
  return undefined;
}

function toolJson(response: Awaited<ReturnType<Client["callTool"]>>) {
  const text = response.content.find((item) => item.type === "text");
  if (!text || text.type !== "text") throw new Error("MCP tool returned no JSON text block.");
  const parsed: unknown = JSON.parse(text.text);
  if (!isRecord(parsed)) throw new Error("MCP tool returned invalid JSON output.");
  return parsed;
}

describe("MCP closed loop", () => {
  it("moves an agent request through human context, screenshots, changes, and acceptance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-mcp-loop-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const options = {
      dataDir: directory,
      publicBaseUrl: "http://127.0.0.1:0",
    };
    const testStore = await createValkeyTestStore(server.url, "mcp-loop");
    cleanup.push(() => testStore.cleanup());
    const app = await createValkeyTestApp(testStore.store, options);
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    options.publicBaseUrl = baseUrl;
    cleanup.push(() => app.close());

    const mcp = new Client({ name: "raise-loop-test", version: "1.0.0" });
    cleanup.push(() => mcp.close());
    await mcp.connect(
      new StdioClientTransport({
        command: join(process.cwd(), "node_modules", ".bin", "tsx"),
        args: [join(process.cwd(), "apps", "mcp", "src", "main.ts")],
        env: {
          PATH: process.env.PATH ?? "",
          RAISE_BASE_URL: baseUrl,
          RAISE_STATE_DIR: join(directory, "mcp-sessions"),
        },
        stderr: "pipe",
      }),
    );

    const opened = toolJson(
      await mcp.callTool({
        name: "raise_open",
        arguments: { prompt: "Which mobile header state is wrong?" },
      }),
    );
    const raiseId = requiredString(opened, "raiseId");
    const humanUrl = requiredString(opened, "humanUrl");
    expect(humanUrl).toContain("#token=");
    expect(JSON.stringify(opened)).not.toContain("ses_");

    const initialRead = toolJson(
      await mcp.callTool({
        name: "raise_read",
        arguments: { raiseId, includeImages: false },
      }),
    );
    expect(initialRead).toMatchObject({
      version: 1,
      entriesMode: "snapshot",
      entries: [{ kind: "prompt" }],
    });
    expect(initialRead.cursor).toMatch(/^\d+-\d+$/);

    const claimResponse = await fetch(`${baseUrl}/api/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        raiseId,
        token: claimToken(humanUrl),
        mode: "token",
        expectedRole: "human",
      }),
    });
    const human = claimResponseSchema.parse(await claimResponse.json());
    expect(human.token).toBeTruthy();

    const humanReply = await fetch(`${baseUrl}/api/raises/${raiseId}/entries`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${human.token}`,
        "content-type": "application/json",
        "idempotency-key": "human-context-entry-0001",
      },
      body: JSON.stringify({
        kind: "response",
        body: "The header clips at 375 px. Screenshot attached.",
        attachments: [{ name: "header.png", mimeType: "image/png", dataUrl: onePixelPng }],
        expectedVersion: 1,
      }),
    });
    expect(humanReply.status).toBe(201);

    const firstWait = await mcp.callTool({
      name: "raise_wait",
      arguments: {
        raiseId,
        cursor: initialRead.cursor,
        timeoutSeconds: 1,
        includeImages: true,
      },
    });
    const firstWaitJson = toolJson(firstWait);
    expect(firstWaitJson).toMatchObject({
      changed: true,
      version: 2,
      entriesMode: "delta",
      entries: [{ kind: "response" }],
    });
    expect(firstWaitJson.cursor).not.toBe(initialRead.cursor);
    expect(firstWait.content.some((item) => item.type === "image")).toBe(true);

    const attachmentId = firstAttachmentId(firstWaitJson);
    expect(attachmentId).toBeTruthy();
    const screenshot = await mcp.callTool({
      name: "raise_screenshot",
      arguments: { raiseId, attachmentId },
    });
    expect(screenshot.content.some((item) => item.type === "image")).toBe(true);

    const firstReply = toolJson(
      await mcp.callTool({
        name: "raise_reply",
        arguments: { raiseId, expectedVersion: 2, body: "Fixed the header at 375 px." },
      }),
    );
    expect(firstReply).toMatchObject({
      version: 3,
      waitingOn: "human",
      entriesMode: "snapshot",
    });
    expect(firstReply.cursor).toMatch(/^\d+-\d+$/);

    const changes = await fetch(`${baseUrl}/api/raises/${raiseId}/entries`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${human.token}`,
        "content-type": "application/json",
        "idempotency-key": "human-changes-entry-0001",
      },
      body: JSON.stringify({
        kind: "review_decision",
        decision: "request_changes",
        body: "Check 320 px too.",
        attachments: [],
        expectedVersion: 3,
      }),
    });
    expect(changes.status).toBe(201);

    const changesWait = toolJson(
      await mcp.callTool({
        name: "raise_wait",
        arguments: {
          raiseId,
          cursor: firstReply.cursor,
          timeoutSeconds: 1,
          includeImages: false,
        },
      }),
    );
    expect(changesWait).toMatchObject({
      changed: true,
      version: 4,
      pendingAction: "make_changes",
      entriesMode: "delta",
      entries: [{ kind: "review_decision", decision: "request_changes" }],
    });

    const secondReply = toolJson(
      await mcp.callTool({
        name: "raise_reply",
        arguments: { raiseId, expectedVersion: 4, body: "Checked and fixed 320 px." },
      }),
    );
    expect(secondReply).toMatchObject({
      version: 5,
      waitingOn: "human",
      entriesMode: "snapshot",
    });

    const accepted = await fetch(`${baseUrl}/api/raises/${raiseId}/entries`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${human.token}`,
        "content-type": "application/json",
        "idempotency-key": "human-accept-entry-0001",
      },
      body: JSON.stringify({
        kind: "review_decision",
        decision: "accept",
        body: "",
        attachments: [],
        expectedVersion: 5,
      }),
    });
    expect(accepted.status).toBe(201);
    expect(raiseViewSchema.parse(await accepted.json())).toMatchObject({
      lifecycle: "resolved",
      version: 6,
    });

    expect(
      toolJson(
        await mcp.callTool({
          name: "raise_wait",
          arguments: {
            raiseId,
            cursor: secondReply.cursor,
            timeoutSeconds: 1,
            includeImages: false,
          },
        }),
      ),
    ).toMatchObject({
      changed: true,
      lifecycle: "resolved",
      version: 6,
      entriesMode: "delta",
      entries: [{ kind: "review_decision", decision: "accept" }],
    });
  });
});
