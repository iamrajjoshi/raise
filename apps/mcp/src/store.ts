import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { StoredSession } from "./client.js";

function key(server: string, raiseId: string) {
  return `${new URL(server).origin}|${raiseId}`;
}

export function defaultStateDirectory() {
  if (process.env.RAISE_STATE_DIR) return process.env.RAISE_STATE_DIR;
  if (process.env.XDG_STATE_HOME) return join(process.env.XDG_STATE_HOME, "raise", "sessions");
  return join(homedir(), ".raise", "sessions");
}

export class SessionStore {
  private readonly memory = new Map<string, StoredSession>();

  constructor(readonly directory = defaultStateDirectory()) {}

  private pathFor(server: string, raiseId: string) {
    const serverHash = createHash("sha256")
      .update(new URL(server).origin)
      .digest("hex")
      .slice(0, 12);
    const safeRaiseId = raiseId.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(this.directory, `${safeRaiseId}-${serverHash}.json`);
  }

  async assertWritable() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const probe = join(this.directory, `.write-test-${process.pid}-${randomUUID()}`);
    await writeFile(probe, "", { mode: 0o600, flag: "wx" });
    await unlink(probe);
  }

  async get(server: string, raiseId: string) {
    const sessionKey = key(server, raiseId);
    let session = this.memory.get(sessionKey);
    if (!session) {
      try {
        session = JSON.parse(
          await readFile(this.pathFor(server, raiseId), "utf8"),
        ) as StoredSession;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    if (!session) {
      throw new Error(
        `No local session for ${raiseId}. Open it with raise_open or raise_claim first.`,
      );
    }
    if (session.server !== new URL(server).origin || session.raiseId !== raiseId) {
      throw new Error(`The saved session for ${raiseId} does not match this Raise server.`);
    }
    if (session.expiresAt <= new Date().toISOString()) {
      this.memory.delete(sessionKey);
      await unlink(this.pathFor(server, raiseId)).catch(() => undefined);
      throw new Error(`The local session for ${raiseId} has expired.`);
    }
    this.memory.set(sessionKey, session);
    return session;
  }

  async put(session: StoredSession) {
    this.memory.set(key(session.server, session.raiseId), session);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      const path = this.pathFor(session.server, session.raiseId);
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
      await chmod(path, 0o600);
      return true;
    } catch {
      return false;
    }
  }
}
