import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import type {
  ClaimResponse,
  CreateRaiseInput,
  CreateRaiseResponse,
  Decision,
  EntryKind,
  PendingActionKind,
  PostEntryInput,
  RaiseView,
  Role,
} from "@raise/protocol";
import { HttpError } from "./errors.js";

interface CapabilityRecord {
  id: string;
  raise_id: string;
  role: Role;
  kind: "claim" | "session";
  secret_hash: string;
  consumed_at: string | null;
  expires_at: string;
}

interface ClaimExchangeRecord {
  exchange_id: string;
  session_capability_id: string;
}

interface RaiseRecord {
  id: string;
  title: string;
  origin: Role;
  lifecycle: "open" | "resolved" | "cancelled" | "expired";
  version: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface ActionRecord {
  id: string;
  target_role: Role;
  kind: PendingActionKind;
}

interface EntryRecord {
  id: string;
  author_role: Role;
  kind: EntryKind;
  body: string;
  url: string | null;
  decision: Decision | null;
  created_at: string;
}

interface AttachmentRecord {
  id: string;
  entry_id: string;
  display_name: string;
  width: number;
  height: number;
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secretsMatch(value: string, expectedHex: string): boolean {
  const actual = Buffer.from(digest(value), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function encodeToken(kind: "claim" | "session", capabilityId: string, value: string): string {
  return `${kind === "claim" ? "cap" : "ses"}_${capabilityId}.${value}`;
}

function exchangeSessionSecret(
  claimSecret: string,
  exchangeId: string,
  sessionCapabilityId: string,
): string {
  return createHmac("sha256", claimSecret)
    .update(`raise-claim-exchange-v1\0${exchangeId}\0${sessionCapabilityId}`)
    .digest("base64url");
}

function parseToken(token: string, expectedKind: "claim" | "session") {
  const match = /^(cap|ses)_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  const expectedPrefix = expectedKind === "claim" ? "cap" : "ses";
  if (!match || match[1] !== expectedPrefix) {
    throw new HttpError(401, "invalid_capability", "This link doesn’t work.");
  }
  return { id: match[2] as string, secret: match[3] as string };
}

export class RaiseDatabase {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS raises (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL CHECK (origin IN ('human', 'agent')),
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('open', 'resolved', 'cancelled', 'expired')),
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        raise_id TEXT NOT NULL REFERENCES raises(id) ON DELETE CASCADE,
        author_role TEXT NOT NULL CHECK (author_role IN ('human', 'agent')),
        kind TEXT NOT NULL CHECK (kind IN ('prompt', 'response', 'result', 'comment', 'review_decision')),
        body TEXT NOT NULL,
        url TEXT,
        decision TEXT CHECK (decision IN ('accept', 'request_changes')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS action_requests (
        id TEXT PRIMARY KEY,
        raise_id TEXT NOT NULL REFERENCES raises(id) ON DELETE CASCADE,
        target_role TEXT NOT NULL CHECK (target_role IN ('human', 'agent')),
        kind TEXT NOT NULL CHECK (kind IN ('provide_context', 'perform_work', 'review_result', 'make_changes')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'answered')),
        created_at TEXT NOT NULL,
        answered_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_action_per_raise
      ON action_requests(raise_id) WHERE state = 'pending';

      CREATE TABLE IF NOT EXISTS capabilities (
        id TEXT PRIMARY KEY,
        raise_id TEXT NOT NULL REFERENCES raises(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('human', 'agent')),
        kind TEXT NOT NULL CHECK (kind IN ('claim', 'session')),
        secret_hash TEXT NOT NULL,
        consumed_at TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS claim_exchanges (
        claim_id TEXT PRIMARY KEY REFERENCES capabilities(id) ON DELETE CASCADE,
        exchange_id TEXT NOT NULL,
        session_capability_id TEXT NOT NULL UNIQUE REFERENCES capabilities(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        raise_id TEXT NOT NULL REFERENCES raises(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        storage_key TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const raiseColumns = this.db.pragma("table_info(raises)") as Array<{ name: string }>;
    if (!raiseColumns.some((column) => column.name === "title")) {
      this.db.exec("ALTER TABLE raises ADD COLUMN title TEXT NOT NULL DEFAULT ''");
    }
  }

  createRaise(
    input: CreateRaiseInput,
    publicBaseUrl: string,
  ): CreateRaiseResponse & { entryId: string } {
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.expiresInHours * 3_600_000).toISOString();
    const raiseId = id("r");
    const entryId = id("e");
    const ownerRole = input.origin;
    const targetRole: Role = input.origin === "human" ? "agent" : "human";
    const actionKind: PendingActionKind =
      input.origin === "human" ? "perform_work" : "provide_context";
    const promptTitle = input.prompt
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !/^\[From .+\]$/.test(line));
    const title =
      input.title ??
      promptTitle?.slice(0, 180) ??
      input.url?.slice(0, 180) ??
      input.attachments[0]?.name ??
      "Untitled request";

    const ownerClaim = this.newCapability(raiseId, ownerRole, "claim", expiresAt, createdAt);
    const targetClaim = this.newCapability(raiseId, targetRole, "claim", expiresAt, createdAt);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO raises (id, title, origin, lifecycle, version, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, 'open', 1, ?, ?, ?)`,
        )
        .run(raiseId, title, input.origin, createdAt, createdAt, expiresAt);
      this.db
        .prepare(
          `INSERT INTO entries (id, raise_id, author_role, kind, body, url, created_at)
           VALUES (?, ?, ?, 'prompt', ?, ?, ?)`,
        )
        .run(entryId, raiseId, ownerRole, input.prompt, input.url ?? null, createdAt);
      this.db
        .prepare(
          `INSERT INTO action_requests (id, raise_id, target_role, kind, state, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?)`,
        )
        .run(id("a"), raiseId, targetRole, actionKind, createdAt);
      this.insertCapability(ownerClaim.record);
      this.insertCapability(targetClaim.record);
    })();

    const base = publicBaseUrl.replace(/\/$/, "");
    return {
      raiseId,
      entryId,
      ownerClaimUrl: `${base}/r/${raiseId}#token=${ownerClaim.token}`,
      targetClaimUrl: `${base}/r/${raiseId}#token=${targetClaim.token}`,
      targetRole,
    };
  }

  private newCapability(
    raiseId: string,
    role: Role,
    kind: "claim" | "session",
    expiresAt: string,
    createdAt: string,
  ) {
    const capabilityId = id("c");
    const value = secret();
    return {
      record: {
        id: capabilityId,
        raiseId,
        role,
        kind,
        secretHash: digest(value),
        expiresAt,
        createdAt,
      },
      token: encodeToken(kind, capabilityId, value),
    };
  }

  private insertCapability(record: {
    id: string;
    raiseId: string;
    role: Role;
    kind: "claim" | "session";
    secretHash: string;
    expiresAt: string;
    createdAt: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO capabilities
         (id, raise_id, role, kind, secret_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.raiseId,
        record.role,
        record.kind,
        record.secretHash,
        record.expiresAt,
        record.createdAt,
      );
  }

  exchangeClaim(
    token: string,
    expectedRole?: Role,
    exchangeId?: string,
  ): ClaimResponse & { sessionToken: string; expiresAt: string } {
    const parsed = parseToken(token, "claim");
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      const claim = this.db
        .prepare("SELECT * FROM capabilities WHERE id = ? AND kind = 'claim'")
        .get(parsed.id) as CapabilityRecord | undefined;

      if (!claim || claim.expires_at <= now || !secretsMatch(parsed.secret, claim.secret_hash)) {
        throw new HttpError(
          401,
          "invalid_capability",
          "This link has expired or was already opened.",
        );
      }
      if (expectedRole && claim.role !== expectedRole) {
        throw new HttpError(
          403,
          "wrong_role",
          `This link is for the ${claim.role}, not the ${expectedRole}.`,
        );
      }

      const priorExchange = this.db
        .prepare(
          "SELECT exchange_id, session_capability_id FROM claim_exchanges WHERE claim_id = ?",
        )
        .get(claim.id) as ClaimExchangeRecord | undefined;
      if (claim.consumed_at) {
        if (!exchangeId || !priorExchange || priorExchange.exchange_id !== exchangeId) {
          throw new HttpError(
            401,
            "invalid_capability",
            "This link has expired or was already opened.",
          );
        }
        const sessionSecret = exchangeSessionSecret(
          parsed.secret,
          exchangeId,
          priorExchange.session_capability_id,
        );
        const session = this.db
          .prepare("SELECT * FROM capabilities WHERE id = ? AND kind = 'session'")
          .get(priorExchange.session_capability_id) as CapabilityRecord | undefined;
        if (
          !session ||
          session.raise_id !== claim.raise_id ||
          session.role !== claim.role ||
          !secretsMatch(sessionSecret, session.secret_hash)
        ) {
          throw new Error("The stored claim exchange is incomplete.");
        }
        const sessionToken = encodeToken("session", session.id, sessionSecret);
        return {
          raiseId: claim.raise_id,
          role: claim.role,
          sessionToken,
          token: sessionToken,
          expiresAt: claim.expires_at,
        };
      }

      this.db.prepare("UPDATE capabilities SET consumed_at = ? WHERE id = ?").run(now, claim.id);
      const sessionCapabilityId = id("c");
      const sessionSecret = exchangeId
        ? exchangeSessionSecret(parsed.secret, exchangeId, sessionCapabilityId)
        : secret();
      const session = {
        record: {
          id: sessionCapabilityId,
          raiseId: claim.raise_id,
          role: claim.role,
          kind: "session" as const,
          secretHash: digest(sessionSecret),
          expiresAt: claim.expires_at,
          createdAt: now,
        },
        token: encodeToken("session", sessionCapabilityId, sessionSecret),
      };
      this.insertCapability(session.record);
      if (exchangeId) {
        this.db
          .prepare(
            `INSERT INTO claim_exchanges
             (claim_id, exchange_id, session_capability_id, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(claim.id, exchangeId, sessionCapabilityId, now);
      }

      return {
        raiseId: claim.raise_id,
        role: claim.role,
        sessionToken: session.token,
        token: session.token,
        expiresAt: claim.expires_at,
      };
    })();
  }

  authenticate(sessionToken: string, raiseId?: string) {
    const parsed = parseToken(sessionToken, "session");
    const capability = this.db
      .prepare("SELECT * FROM capabilities WHERE id = ? AND kind = 'session'")
      .get(parsed.id) as CapabilityRecord | undefined;
    const now = new Date().toISOString();

    if (
      !capability ||
      capability.expires_at <= now ||
      !secretsMatch(parsed.secret, capability.secret_hash) ||
      (raiseId && capability.raise_id !== raiseId)
    ) {
      throw new HttpError(401, "unauthorized", "Open this request from its original link.");
    }

    return {
      raiseId: capability.raise_id,
      role: capability.role,
      expiresAt: capability.expires_at,
    };
  }

  getRaise(raiseId: string, sessionToken: string): RaiseView {
    const viewer = this.authenticate(sessionToken, raiseId);
    const raise = this.db.prepare("SELECT * FROM raises WHERE id = ?").get(raiseId) as
      RaiseRecord | undefined;
    if (!raise) {
      throw new HttpError(404, "not_found", "We couldn’t find this request.");
    }

    const now = new Date().toISOString();
    if (raise.lifecycle === "open" && raise.expires_at <= now) {
      this.db
        .prepare(
          "UPDATE raises SET lifecycle = 'expired', version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, raiseId);
      raise.lifecycle = "expired";
      raise.version += 1;
      raise.updated_at = now;
    }

    const pending = this.db
      .prepare(
        "SELECT id, target_role, kind FROM action_requests WHERE raise_id = ? AND state = 'pending'",
      )
      .get(raiseId) as ActionRecord | undefined;
    const entryRows = this.db
      .prepare("SELECT * FROM entries WHERE raise_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(raiseId) as EntryRecord[];
    const attachmentRows = this.db
      .prepare(
        `SELECT id, entry_id, display_name, width, height
         FROM attachments WHERE raise_id = ? ORDER BY created_at ASC`,
      )
      .all(raiseId) as AttachmentRecord[];

    const attachmentsByEntry = new Map<string, AttachmentRecord[]>();
    for (const attachment of attachmentRows) {
      const current = attachmentsByEntry.get(attachment.entry_id) ?? [];
      current.push(attachment);
      attachmentsByEntry.set(attachment.entry_id, current);
    }

    const canAct = raise.lifecycle === "open" && pending?.target_role === viewer.role;
    return {
      id: raise.id,
      title: raise.title || raise.id,
      origin: raise.origin,
      viewerRole: viewer.role,
      lifecycle: raise.lifecycle,
      waitingOn: pending?.target_role ?? null,
      pendingAction: pending?.kind ?? null,
      version: raise.version,
      createdAt: raise.created_at,
      updatedAt: raise.updated_at,
      expiresAt: raise.expires_at,
      permissions: {
        canReply: canAct && pending.kind === "provide_context",
        canPostResult:
          canAct && (pending.kind === "perform_work" || pending.kind === "make_changes"),
        canReview: canAct && pending.kind === "review_result" && viewer.role === "human",
        canComment: raise.lifecycle === "open",
      },
      entries: entryRows.map((entry) => ({
        id: entry.id,
        authorRole: entry.author_role,
        kind: entry.kind,
        body: entry.body,
        ...(entry.url ? { url: entry.url } : {}),
        ...(entry.decision ? { decision: entry.decision } : {}),
        createdAt: entry.created_at,
        attachments: (attachmentsByEntry.get(entry.id) ?? []).map((attachment) => ({
          id: attachment.id,
          name: attachment.display_name,
          mediaType: "image/webp" as const,
          url: `/api/raises/${raiseId}/attachments/${attachment.id}`,
          width: attachment.width,
          height: attachment.height,
        })),
      })),
    };
  }

  postEntry(raiseId: string, sessionToken: string, input: PostEntryInput): { entryId: string } {
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      const { viewerRole, pending } = this.validatePostEntry(raiseId, sessionToken, input);

      const entryId = id("e");
      this.db
        .prepare(
          `INSERT INTO entries
           (id, raise_id, author_role, kind, body, url, decision, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entryId,
          raiseId,
          viewerRole,
          input.kind,
          input.body,
          input.url ?? null,
          input.decision ?? null,
          now,
        );

      if (input.kind !== "comment" && pending) {
        this.db
          .prepare("UPDATE action_requests SET state = 'answered', answered_at = ? WHERE id = ?")
          .run(now, pending.id);
        this.applyNextAction(raiseId, pending.kind, input, now);
      }

      this.db
        .prepare("UPDATE raises SET version = version + 1, updated_at = ? WHERE id = ?")
        .run(now, raiseId);
      return { entryId };
    })();
  }

  assertCanPostEntry(raiseId: string, sessionToken: string, input: PostEntryInput) {
    this.validatePostEntry(raiseId, sessionToken, input);
  }

  private validatePostEntry(raiseId: string, sessionToken: string, input: PostEntryInput) {
    const viewer = this.authenticate(sessionToken, raiseId);
    const raise = this.db.prepare("SELECT * FROM raises WHERE id = ?").get(raiseId) as
      RaiseRecord | undefined;
    if (!raise) {
      throw new HttpError(404, "not_found", "We couldn’t find this request.");
    }
    if (raise.lifecycle !== "open") {
      throw new HttpError(409, "raise_closed", "This request is closed.");
    }
    if (raise.version !== input.expectedVersion) {
      throw new HttpError(409, "state_conflict", "This request changed. Reload and try again.");
    }

    const pending = this.db
      .prepare(
        "SELECT id, target_role, kind FROM action_requests WHERE raise_id = ? AND state = 'pending'",
      )
      .get(raiseId) as ActionRecord | undefined;

    if (input.kind !== "comment") {
      this.assertTransition(viewer.role, pending, input);
    }
    return { viewerRole: viewer.role, pending };
  }

  private assertTransition(role: Role, pending: ActionRecord | undefined, input: PostEntryInput) {
    if (!pending || pending.target_role !== role) {
      throw new HttpError(403, "not_your_turn", "It isn’t your turn to reply.");
    }

    const valid =
      (pending.kind === "provide_context" && input.kind === "response") ||
      ((pending.kind === "perform_work" || pending.kind === "make_changes") &&
        input.kind === "result" &&
        role === "agent") ||
      (pending.kind === "review_result" && input.kind === "review_decision" && role === "human");

    if (!valid) {
      throw new HttpError(
        409,
        "invalid_transition",
        "You can’t send that at this point in the request. Reload and try again.",
      );
    }
  }

  private applyNextAction(
    raiseId: string,
    previousKind: PendingActionKind,
    input: PostEntryInput,
    now: string,
  ) {
    if (previousKind === "provide_context") {
      this.insertAction(raiseId, "agent", "perform_work", now);
      return;
    }
    if (previousKind === "perform_work" || previousKind === "make_changes") {
      this.insertAction(raiseId, "human", "review_result", now);
      return;
    }
    if (input.decision === "request_changes") {
      this.insertAction(raiseId, "agent", "make_changes", now);
      return;
    }
    this.db.prepare("UPDATE raises SET lifecycle = 'resolved' WHERE id = ?").run(raiseId);
  }

  private insertAction(raiseId: string, targetRole: Role, kind: PendingActionKind, now: string) {
    this.db
      .prepare(
        `INSERT INTO action_requests (id, raise_id, target_role, kind, state, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id("a"), raiseId, targetRole, kind, now);
  }

  addAttachment(record: {
    id: string;
    entryId: string;
    raiseId: string;
    displayName: string;
    storageKey: string;
    size: number;
    width: number;
    height: number;
  }) {
    this.db
      .prepare(
        `INSERT INTO attachments
         (id, entry_id, raise_id, display_name, media_type, storage_key, size, width, height, created_at)
         VALUES (?, ?, ?, ?, 'image/webp', ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.entryId,
        record.raiseId,
        record.displayName,
        record.storageKey,
        record.size,
        record.width,
        record.height,
        new Date().toISOString(),
      );
  }

  getAttachment(raiseId: string, attachmentId: string, sessionToken: string) {
    this.authenticate(sessionToken, raiseId);
    const record = this.db
      .prepare("SELECT storage_key FROM attachments WHERE id = ? AND raise_id = ?")
      .get(attachmentId, raiseId) as { storage_key: string } | undefined;
    if (!record) {
      throw new HttpError(404, "not_found", "We couldn’t find that screenshot.");
    }
    return record.storage_key;
  }
}
