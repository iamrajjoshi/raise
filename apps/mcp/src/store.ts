import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { chmod, link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import type { CreateRaiseResponse } from "@raise/protocol";
import type { StoredSession } from "./client.js";

const pendingRecordTtlMs = 7 * 24 * 60 * 60 * 1_000;

function key(server: string, raiseId: string) {
  return `${new URL(server).origin}|${raiseId}`;
}

function claimTokenHash(claimToken: string) {
  return createHash("sha256")
    .update("raise-mcp-pending-exchange-v1\0")
    .update(claimToken)
    .digest("hex");
}

function isMissingFile(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function ensurePrivateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function createPrivateFile(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await link(temporary, path);
    await chmod(path, 0o600);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function recordExpired(createdAt: string, now: () => Date, ttlMs: number) {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) throw new Error("Local pending state has an invalid timestamp.");
  return timestamp + ttlMs <= now().getTime();
}

async function removeExpiredRecords(
  directory: string,
  prefix: string,
  now: () => Date,
  ttlMs: number,
) {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  await Promise.all(
    files
      .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
      .map(async (file) => {
        const path = join(directory, file);
        let contents: string;
        try {
          contents = await readFile(path, "utf8");
        } catch (error) {
          if (isMissingFile(error)) return;
          throw error;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(contents);
        } catch {
          return;
        }
        if (
          !parsed ||
          typeof parsed !== "object" ||
          !("createdAt" in parsed) ||
          typeof parsed.createdAt !== "string"
        ) {
          return;
        }
        const timestamp = Date.parse(parsed.createdAt);
        if (Number.isFinite(timestamp) && timestamp + ttlMs <= now().getTime()) {
          await unlink(path).catch((error: unknown) => {
            if (!isMissingFile(error)) throw error;
          });
        }
      }),
  );
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
    await ensurePrivateDirectory(this.directory);
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
        if (!isMissingFile(error)) throw error;
      }
    }
    if (!session) {
      throw new Error(
        `No local session for ${raiseId}. Open it with raise_open, raise_claim, or raise_inbox first.`,
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
      await ensurePrivateDirectory(this.directory);
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

export class PendingExchangeStore {
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(
    readonly directory = defaultStateDirectory(),
    options: { now?: () => Date; ttlMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? pendingRecordTtlMs;
  }

  private record(server: string, claimToken: string) {
    const origin = new URL(server).origin;
    const tokenHash = claimTokenHash(claimToken);
    const recordHash = createHash("sha256")
      .update(origin)
      .update("\0")
      .update(tokenHash)
      .digest("hex");
    return {
      origin,
      tokenHash,
      path: join(this.directory, `pending-exchange-${recordHash}.json`),
    };
  }

  private async read(path: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
      await chmod(path, 0o600);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw new Error("Could not read the local pending claim exchange state.", {
        cause: error,
      });
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("server" in parsed) ||
      typeof parsed.server !== "string" ||
      !("claimTokenHash" in parsed) ||
      typeof parsed.claimTokenHash !== "string" ||
      !("exchangeId" in parsed) ||
      typeof parsed.exchangeId !== "string" ||
      !("createdAt" in parsed) ||
      typeof parsed.createdAt !== "string"
    ) {
      throw new Error("The local pending claim exchange state is invalid.");
    }
    return parsed as {
      server: string;
      claimTokenHash: string;
      exchangeId: string;
      createdAt: string;
    };
  }

  async getOrCreate(server: string, claimToken: string) {
    await ensurePrivateDirectory(this.directory);
    await removeExpiredRecords(this.directory, "pending-exchange-", this.now, this.ttlMs);
    const { origin, tokenHash, path } = this.record(server, claimToken);
    for (;;) {
      const existing = await this.read(path);
      if (existing) {
        if (existing.server !== origin || existing.claimTokenHash !== tokenHash) {
          throw new Error("The local pending claim exchange state does not match this claim.");
        }
        if (!recordExpired(existing.createdAt, this.now, this.ttlMs)) {
          return existing.exchangeId;
        }
        await unlink(path).catch((error: unknown) => {
          if (!isMissingFile(error)) throw error;
        });
        continue;
      }
      const exchangeId = randomUUID();
      if (
        await createPrivateFile(path, {
          server: origin,
          claimTokenHash: tokenHash,
          exchangeId,
          createdAt: this.now().toISOString(),
        })
      ) {
        return exchangeId;
      }
    }
  }

  async clear(server: string, claimToken: string) {
    const { path } = this.record(server, claimToken);
    await unlink(path).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }
}

export interface PendingOpenInput {
  prompt: string;
  title?: string;
  url?: string;
  screenshotPaths: string[];
  expiresInHours: number;
}

export function pendingOpenDigest(input: PendingOpenInput) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "raise-mcp-pending-open-v1",
        input.prompt.trim(),
        input.title?.trim() ?? null,
        input.url ? new URL(input.url).href : null,
        input.screenshotPaths.map((path) => normalize(path)),
        input.expiresInHours,
      ]),
    )
    .digest("hex");
}

export class PendingOpenStore {
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(
    readonly directory = defaultStateDirectory(),
    options: { now?: () => Date; ttlMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? pendingRecordTtlMs;
  }

  private pathFor(inputDigest: string) {
    if (!/^[0-9a-f]{64}$/.test(inputDigest)) {
      throw new Error("The pending open input digest is invalid.");
    }
    return join(this.directory, `pending-open-${inputDigest}.json`);
  }

  async get(inputDigest: string) {
    await removeExpiredRecords(this.directory, "pending-open-", this.now, this.ttlMs);
    const path = this.pathFor(inputDigest);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
      await chmod(path, 0o600);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw new Error("Could not read the local pending open state.", { cause: error });
    }
    const created =
      parsed && typeof parsed === "object" && "created" in parsed ? parsed.created : undefined;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("inputDigest" in parsed) ||
      parsed.inputDigest !== inputDigest ||
      !("createdAt" in parsed) ||
      typeof parsed.createdAt !== "string" ||
      !created ||
      typeof created !== "object" ||
      !("raiseId" in created) ||
      typeof created.raiseId !== "string" ||
      !("ownerClaimUrl" in created) ||
      typeof created.ownerClaimUrl !== "string" ||
      !("targetClaimUrl" in created) ||
      typeof created.targetClaimUrl !== "string" ||
      !("targetRole" in created) ||
      (created.targetRole !== "human" && created.targetRole !== "agent")
    ) {
      throw new Error("The local pending open state is invalid.");
    }
    if (recordExpired(parsed.createdAt, this.now, this.ttlMs)) {
      await this.clear(inputDigest);
      return undefined;
    }
    return created as CreateRaiseResponse;
  }

  async put(inputDigest: string, created: CreateRaiseResponse) {
    await ensurePrivateDirectory(this.directory);
    const path = this.pathFor(inputDigest);
    for (;;) {
      const existing = await this.get(inputDigest);
      if (existing) return existing;
      if (
        await createPrivateFile(path, {
          inputDigest,
          createdAt: this.now().toISOString(),
          created,
        })
      ) {
        return created;
      }
    }
  }

  async clear(inputDigest: string) {
    await unlink(this.pathFor(inputDigest)).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }
}
