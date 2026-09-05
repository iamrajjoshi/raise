import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { chmod, link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import {
  createRaiseResponseSchema,
  idempotencyKeySchema,
  raiseIdSchema,
  type CreateRaiseInput,
  type CreateRaiseResponse,
  type PostEntryInput,
} from "@raise/protocol";
import * as z from "zod/v4";
import { storedSessionSchema, type StoredSession } from "./session.js";

const pendingRecordTtlMs = 7 * 24 * 60 * 60 * 1_000;
const pendingMutationTtlMs = 7 * 60 * 60 * 1_000;

interface PendingRecordStoreOptions {
  now?: () => Date;
  ttlMs?: number;
}

const sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const pendingExchangeRecordSchema = z.object({
  server: z.url(),
  claimTokenHash: sha256DigestSchema,
  exchangeId: z.uuid(),
  createdAt: z.iso.datetime(),
});
const pendingMutationRecordSchema = z.object({
  server: z.url(),
  raiseId: raiseIdSchema,
  sessionDigest: sha256DigestSchema,
  inputDigest: sha256DigestSchema,
  idempotencyKey: idempotencyKeySchema,
  expectedVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});
type PendingMutationRecord = z.infer<typeof pendingMutationRecordSchema>;
const pendingOpenRecordSchema = z.object({
  inputDigest: sha256DigestSchema,
  createdAt: z.iso.datetime(),
  created: createRaiseResponseSchema,
});

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

async function unlinkIfPresent(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

async function readPrivateJson(path: string, errorMessage: string): Promise<unknown | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    await chmod(path, 0o600);
    return parsed;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new Error(errorMessage, { cause: error });
  }
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
    await unlinkIfPresent(temporary);
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
          await unlinkIfPresent(path);
        }
      }),
  );
}

function defaultStateDirectory() {
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
      const stored = await readPrivateJson(
        this.pathFor(server, raiseId),
        `Could not read the local session for ${raiseId}.`,
      );
      if (stored !== undefined) {
        const parsed = storedSessionSchema.safeParse(stored);
        if (!parsed.success) {
          throw new Error(`The local session for ${raiseId} is invalid.`);
        }
        session = parsed.data;
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
      await unlinkIfPresent(this.pathFor(server, raiseId));
      throw new Error(`The local session for ${raiseId} has expired.`);
    }
    this.memory.set(sessionKey, session);
    return session;
  }

  async put(session: StoredSession) {
    this.memory.set(key(session.server, session.raiseId), session);
    let temporary: string | undefined;
    try {
      await ensurePrivateDirectory(this.directory);
      const path = this.pathFor(session.server, session.raiseId);
      temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
      await chmod(path, 0o600);
      return true;
    } catch {
      return false;
    } finally {
      if (temporary) await unlinkIfPresent(temporary);
    }
  }
}

export class PendingExchangeStore {
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(
    readonly directory = defaultStateDirectory(),
    options: PendingRecordStoreOptions = {},
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
    const parsed = await readPrivateJson(
      path,
      "Could not read the local pending claim exchange state.",
    );
    if (parsed === undefined) return undefined;
    const record = pendingExchangeRecordSchema.safeParse(parsed);
    if (!record.success) {
      throw new Error("The local pending claim exchange state is invalid.");
    }
    return record.data;
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
        await unlinkIfPresent(path);
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
    await unlinkIfPresent(path);
  }
}

export type PendingOpenInput = Pick<CreateRaiseInput, "prompt" | "title" | "url"> & {
  screenshotPaths: string[];
};

export function pendingOpenDigest(input: PendingOpenInput) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "raise-mcp-pending-open-v1",
        input.prompt.trim(),
        input.title?.trim() ?? null,
        input.url ? new URL(input.url).href : null,
        input.screenshotPaths.map((path) => normalize(path)),
      ]),
    )
    .digest("hex");
}

export function pendingMutationDigest(input: PostEntryInput) {
  const attachments = input.attachments.map((attachment) => [
    attachment.name.trim(),
    attachment.mimeType,
    createHash("sha256").update(attachment.dataUrl).digest("hex"),
  ]);
  return createHash("sha256")
    .update("raise-mcp-pending-mutation-v1\0")
    .update(
      JSON.stringify([
        input.kind,
        input.body.trim(),
        input.url ? new URL(input.url).href : null,
        input.decision ?? null,
        attachments,
      ]),
    )
    .digest("hex");
}

export interface PendingMutation {
  idempotencyKey: string;
  expectedVersion: number;
  resumed: boolean;
}

export class PendingMutationStore {
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(
    readonly directory = defaultStateDirectory(),
    options: PendingRecordStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? pendingMutationTtlMs;
  }

  private identity(session: StoredSession, inputDigest: string, expectedVersion: number) {
    if (!/^[0-9a-f]{64}$/.test(inputDigest)) {
      throw new Error("The pending mutation input digest is invalid.");
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new Error("The pending mutation version is invalid.");
    }
    const server = new URL(session.server).origin;
    const sessionDigest = createHash("sha256")
      .update("raise-mcp-session-identity-v1\0")
      .update(server)
      .update("\0")
      .update(session.raiseId)
      .update("\0")
      .update(session.token)
      .digest("hex");
    const recordHash = createHash("sha256")
      .update(server)
      .update("\0")
      .update(session.raiseId)
      .update("\0")
      .update(sessionDigest)
      .update("\0")
      .update(inputDigest)
      .update("\0")
      .update(String(expectedVersion))
      .digest("hex");
    return {
      server,
      raiseId: session.raiseId,
      sessionDigest,
      inputDigest,
      expectedVersion,
      path: join(this.directory, `pending-mutation-${recordHash}.json`),
    };
  }

  private async read(path: string): Promise<PendingMutationRecord | undefined> {
    const parsed = await readPrivateJson(path, "Could not read the local pending mutation state.");
    if (parsed === undefined) return undefined;
    const record = pendingMutationRecordSchema.safeParse(parsed);
    if (!record.success) {
      throw new Error("The local pending mutation state is invalid.");
    }
    return record.data;
  }

  async getOrCreate(
    session: StoredSession,
    inputDigest: string,
    expectedVersion: number,
  ): Promise<PendingMutation> {
    await ensurePrivateDirectory(this.directory);
    await removeExpiredRecords(this.directory, "pending-mutation-", this.now, this.ttlMs);
    const identity = this.identity(session, inputDigest, expectedVersion);
    for (;;) {
      const existing = await this.read(identity.path);
      if (existing) {
        if (
          existing.server !== identity.server ||
          existing.raiseId !== identity.raiseId ||
          existing.sessionDigest !== identity.sessionDigest ||
          existing.inputDigest !== identity.inputDigest ||
          existing.expectedVersion !== identity.expectedVersion
        ) {
          throw new Error("The local pending mutation state does not match this operation.");
        }
        if (!recordExpired(existing.createdAt, this.now, this.ttlMs)) {
          return {
            idempotencyKey: existing.idempotencyKey,
            expectedVersion: existing.expectedVersion,
            resumed: true,
          };
        }
        await unlinkIfPresent(identity.path);
        continue;
      }

      const idempotencyKey = randomUUID();
      if (
        await createPrivateFile(identity.path, {
          server: identity.server,
          raiseId: identity.raiseId,
          sessionDigest: identity.sessionDigest,
          inputDigest: identity.inputDigest,
          idempotencyKey,
          expectedVersion: identity.expectedVersion,
          createdAt: this.now().toISOString(),
        } satisfies PendingMutationRecord)
      ) {
        return { idempotencyKey, expectedVersion: identity.expectedVersion, resumed: false };
      }
    }
  }

  async clear(session: StoredSession, inputDigest: string, expectedVersion: number) {
    const { path } = this.identity(session, inputDigest, expectedVersion);
    await unlinkIfPresent(path);
  }
}

export class PendingOpenStore {
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(
    readonly directory = defaultStateDirectory(),
    options: PendingRecordStoreOptions = {},
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
    const parsed = await readPrivateJson(path, "Could not read the local pending open state.");
    if (parsed === undefined) return undefined;
    const record = pendingOpenRecordSchema.safeParse(parsed);
    if (!record.success || record.data.inputDigest !== inputDigest) {
      throw new Error("The local pending open state is invalid.");
    }
    if (recordExpired(record.data.createdAt, this.now, this.ttlMs)) {
      await this.clear(inputDigest);
      return undefined;
    }
    return record.data.created;
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
    await unlinkIfPresent(this.pathFor(inputDigest));
  }
}
