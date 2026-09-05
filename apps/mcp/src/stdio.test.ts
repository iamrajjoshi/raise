import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("Raise MCP stdio server", () => {
  it("starts cleanly and advertises the agent loop", async () => {
    const client = new Client({ name: "raise-test", version: "1.0.0" });
    clients.push(client);
    const compiledEntry = process.env.RAISE_MCP_ENTRY;
    const transport = new StdioClientTransport({
      command: compiledEntry
        ? process.execPath
        : join(process.cwd(), "node_modules", ".bin", "tsx"),
      args: [compiledEntry ?? join(process.cwd(), "apps", "mcp", "src", "main.ts")],
      env: {
        PATH: process.env.PATH ?? "",
        RAISE_BASE_URL: "http://127.0.0.1:1",
        RAISE_STATE_DIR: join(process.cwd(), ".tmp", "mcp-smoke-sessions"),
      },
      stderr: "pipe",
    });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "raise_open",
      "raise_claim",
      "raise_read",
      "raise_reply",
      "raise_screenshot",
      "raise_update",
      "raise_wait",
    ]);
  });
});
