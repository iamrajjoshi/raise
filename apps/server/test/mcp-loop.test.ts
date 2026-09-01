import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaimResponse, RaiseView } from "@raise/protocol";
import { createApp } from "../src/app.js";

const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

function claimToken(url: string) {
  return new URLSearchParams(new URL(url).hash.slice(1)).get("token") as string;
}

function toolJson(response: Awaited<ReturnType<Client["callTool"]>>) {
  const text = response.content.find((item) => item.type === "text");
  if (!text || text.type !== "text") throw new Error("MCP tool returned no JSON text block.");
  return JSON.parse(text.text) as Record<string, unknown>;
}

describe("MCP closed loop", () => {
  it("moves an agent request through human context, screenshots, changes, and acceptance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raise-mcp-loop-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const options = {
      databasePath: join(directory, "raise.db"),
      dataDir: directory,
      publicBaseUrl: "http://127.0.0.1:0",
    };
    const app = await createApp(options);
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
    const raiseId = opened.raiseId as string;
    const humanUrl = opened.humanUrl as string;
    expect(humanUrl).toContain("#token=");
    expect(JSON.stringify(opened)).not.toContain("ses_");

    const claimResponse = await fetch(`${baseUrl}/api/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: claimToken(humanUrl),
        mode: "token",
        expectedRole: "human",
      }),
    });
    const human = (await claimResponse.json()) as ClaimResponse;
    expect(human.token).toBeTruthy();

    const humanReply = await fetch(`${baseUrl}/api/raises/${raiseId}/entries`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${human.token}`,
        "content-type": "application/json",
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
      arguments: { raiseId, afterVersion: 1, timeoutSeconds: 1, includeImages: true },
    });
    const firstWaitJson = toolJson(firstWait);
    expect(firstWaitJson).toMatchObject({ changed: true, version: 2 });
    expect(firstWait.content.some((item) => item.type === "image")).toBe(true);

    const entries = firstWaitJson.entries as Array<{ attachments: Array<{ id: string }> }>;
    const attachmentId = entries.flatMap((entry) => entry.attachments)[0]?.id;
    expect(attachmentId).toBeTruthy();
    const screenshot = await mcp.callTool({
      name: "raise_screenshot",
      arguments: { raiseId, attachmentId },
    });
    expect(screenshot.content.some((item) => item.type === "image")).toBe(true);

    expect(
      toolJson(
        await mcp.callTool({
          name: "raise_reply",
          arguments: { raiseId, expectedVersion: 2, body: "Fixed the header at 375 px." },
        }),
      ),
    ).toMatchObject({ version: 3, waitingOn: "human" });

    const changes = await fetch(`${baseUrl}/api/raises/${raiseId}/entries`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${human.token}`,
        "content-type": "application/json",
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

    expect(
      toolJson(
        await mcp.callTool({
          name: "raise_wait",
          arguments: { raiseId, afterVersion: 3, timeoutSeconds: 1, includeImages: false },
        }),
      ),
    ).toMatchObject({ changed: true, version: 4, pendingAction: "make_changes" });

    expect(
      toolJson(
        await mcp.callTool({
          name: "raise_reply",
          arguments: { raiseId, expectedVersion: 4, body: "Checked and fixed 320 px." },
        }),
      ),
    ).toMatchObject({ version: 5, waitingOn: "human" });

    const accepted = await fetch(`${baseUrl}/api/raises/${raiseId}/entries`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${human.token}`,
        "content-type": "application/json",
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
    expect((await accepted.json()) as RaiseView).toMatchObject({
      lifecycle: "resolved",
      version: 6,
    });

    expect(
      toolJson(
        await mcp.callTool({
          name: "raise_wait",
          arguments: { raiseId, afterVersion: 5, timeoutSeconds: 1, includeImages: false },
        }),
      ),
    ).toMatchObject({ changed: true, lifecycle: "resolved", version: 6 });
  });
});
