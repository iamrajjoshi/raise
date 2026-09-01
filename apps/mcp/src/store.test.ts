import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "./store.js";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MCP session store", () => {
  it("keeps concurrent server-scoped sessions in separate private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-store-"));
    paths.push(root);
    const directory = join(root, "sessions");
    const first = new SessionStore(directory);
    const second = new SessionStore(directory);
    await Promise.all([
      first.put({
        server: "https://raise.example",
        raiseId: "r_one",
        role: "agent",
        token: "ses_one.secret",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      second.put({
        server: "https://other.example",
        raiseId: "r_two",
        role: "agent",
        token: "ses_two.secret",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ]);

    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    await Promise.all(
      files.map(async (file) =>
        expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600),
      ),
    );
    const fresh = new SessionStore(directory);
    await expect(fresh.get("https://raise.example", "r_one")).resolves.toMatchObject({
      token: "ses_one.secret",
    });
    await expect(fresh.get("https://other.example", "r_two")).resolves.toMatchObject({
      token: "ses_two.secret",
    });
  });

  it("removes expired credentials and retains an in-memory recovery copy if disk writing fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "raise-mcp-store-"));
    paths.push(root);
    const directory = join(root, "sessions");
    const store = new SessionStore(directory);
    await store.put({
      server: "https://raise.example",
      raiseId: "r_old",
      role: "agent",
      token: "ses_old.secret",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    await expect(store.get("https://raise.example", "r_old")).rejects.toThrow("expired");
    expect((await readdir(directory)).length).toBe(0);

    const blockedPath = join(root, "not-a-directory");
    await writeFile(blockedPath, "blocked");
    const memoryOnly = new SessionStore(blockedPath);
    const session = {
      server: "https://raise.example",
      raiseId: "r_memory",
      role: "agent" as const,
      token: "ses_memory.secret",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    await expect(memoryOnly.put(session)).resolves.toBe(false);
    await expect(memoryOnly.get(session.server, session.raiseId)).resolves.toEqual(session);
    expect(await readFile(blockedPath, "utf8")).toBe("blocked");
  });
});
