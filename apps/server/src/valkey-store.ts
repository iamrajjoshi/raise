import { createClient, type RedisArgument } from "@redis/client";
import {
  raiseCursorSchema,
  type EntryKind,
  type Lifecycle,
  type PendingActionKind,
  type Role,
} from "@raise/protocol";
import { isSha256HexDigest } from "./capabilities.js";
import {
  rejectInvalidCapability,
  rejectMissingScreenshot,
  rejectMutation,
  rejectUnauthorizedSession,
  rejectWrongRole,
} from "./errors.js";
import {
  assertAppendIdempotency,
  assertEncryptedEntryMatchesTransition,
  StoreCommitOutcomeUnknownError,
  type AppendEntryCommand,
  type AppendPreflightCommand,
  type AppendPreflightResult,
  type AppendReceipt,
  type AppendResult,
  type AttachmentWrite,
  type AuthorizedEncryptedAttachment,
  type AuthorizedEncryptedRaise,
  type CapabilityAccess,
  type CapabilityWrite,
  type ClaimExchangeResult,
  type ClaimInspection,
  type ClaimInspectionCommand,
  type CommitClaimExchangeCommand,
  type CreateRaiseCommand,
  type EncryptedAttachmentView,
  type EncryptedEntryView,
  type RaiseReadOptions,
  type RaiseStore,
} from "./storage.js";
import { assertRemainingHardTtlMs, RAISE_ACCEPTED_TTL_MS, RAISE_IDLE_TTL_MS } from "./retention.js";
import { initialWorkflow, permissionsFor } from "./workflow.js";
import {
  VALKEY_APPEND_ENTRY_SCRIPT,
  VALKEY_COMMIT_CLAIM_SCRIPT,
  VALKEY_CREATE_RAISE_SCRIPT,
  VALKEY_GET_ATTACHMENT_SCRIPT,
  VALKEY_GET_RAISE_SCRIPT,
  VALKEY_INSPECT_CLAIM_SCRIPT,
  VALKEY_PREFLIGHT_APPEND_SCRIPT,
} from "./valkey-scripts.js";

const KEY_ID = /^[A-Za-z0-9_-]{1,160}$/;

export interface ValkeyCommandClient {
  sendCommand(args: ReadonlyArray<RedisArgument>): Promise<unknown>;
  close(): Promise<void>;
}

export interface ValkeyRaiseStoreOptions {
  keyPrefix?: string;
  now?: () => number;
  closeClient?: boolean;
}

export interface ConnectValkeyRaiseStoreOptions extends ValkeyRaiseStoreOptions {
  url: string;
  onError: (error: Error) => void;
}

export interface ValkeyRaiseKeys {
  meta: string;
  capabilities: string;
  entries: string;
  idempotency: string;
}

interface StoredCapability extends CapabilityWrite {
  consumedAt: string;
  exchangeDigest: string;
  exchangeMode: string;
  sessionCapabilityId: string;
}

interface StoredAttachment extends AttachmentWrite {
  entryId: string;
  authorRole: Role;
}

interface SerializedEntry {
  id: string;
  authorRole: Role;
  kind: EntryKind;
  bodyEnvelope: string;
  urlEnvelope: string;
  decisionEnvelope: string;
  createdAt: string;
  attachmentsJson: string;
}

function assertKeyId(value: string, label: string): void {
  if (!KEY_ID.test(value)) throw new Error(`${label} is not safe for Valkey storage.`);
}

function assertEnvelope(value: string, prefix: "v1." | "wk1.", label: string): void {
  if (!value.startsWith(prefix)) throw new Error(`${label} is not an encrypted envelope.`);
}

function assertCapability(capability: CapabilityWrite): void {
  assertKeyId(capability.id, "Capability ID");
  if (!isSha256HexDigest(capability.secretDigest)) {
    throw new Error("Capability persistence data is invalid.");
  }
  assertEnvelope(capability.contentKeyEnvelope, "wk1.", "Capability content key");
}

function assertAttachment(attachment: AttachmentWrite): void {
  assertKeyId(attachment.id, "Attachment ID");
  assertEnvelope(attachment.displayNameEnvelope, "v1.", "Attachment name");
  if (
    !Number.isSafeInteger(attachment.size) ||
    !Number.isSafeInteger(attachment.width) ||
    !Number.isSafeInteger(attachment.height) ||
    attachment.size < 0 ||
    attachment.width < 1 ||
    attachment.height < 1
  ) {
    throw new Error("Attachment metadata is invalid.");
  }
}

function storedCapability(capability: CapabilityWrite): StoredCapability {
  return {
    id: capability.id,
    kind: capability.kind,
    role: capability.role,
    secretDigest: capability.secretDigest,
    contentKeyEnvelope: capability.contentKeyEnvelope,
    consumedAt: "",
    exchangeDigest: "",
    exchangeMode: "",
    sessionCapabilityId: "",
  };
}

function storedAttachment(
  attachment: AttachmentWrite,
  entryId: string,
  authorRole: Role,
): StoredAttachment {
  return { ...attachment, entryId, authorRole };
}

function attachmentView(attachment: AttachmentWrite): EncryptedAttachmentView {
  return {
    id: attachment.id,
    displayNameEnvelope: attachment.displayNameEnvelope,
    width: attachment.width,
    height: attachment.height,
  };
}

function corruptState(): never {
  throw new Error("Valkey contains an incomplete or invalid Raise bundle.");
}

function replyString(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  throw new Error(`Valkey returned an invalid ${label}.`);
}

function streamCursor(value: unknown, label = "Stream cursor"): string {
  const cursor = replyString(value, label);
  const parsed = raiseCursorSchema.safeParse(cursor);
  if (!parsed.success) {
    throw new Error(`Valkey returned an invalid ${label}.`);
  }
  return parsed.data;
}

function entriesMode(value: unknown): "snapshot" | "delta" {
  const mode = replyString(value, "entry read mode");
  if (mode !== "snapshot" && mode !== "delta") {
    throw new Error("Valkey returned an invalid entry read mode.");
  }
  return mode;
}

function replyArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Valkey returned an invalid ${label}.`);
  return value;
}

function replyCode(reply: unknown): { values: unknown[]; code: string } {
  const values = replyArray(reply, "script response");
  return { values, code: replyString(values[0], "script status") };
}

function flatRecord(value: unknown, label: string): Record<string, string> {
  const values = replyArray(value, label);
  if (values.length % 2 !== 0) throw new Error(`Valkey returned an invalid ${label}.`);
  const record: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    record[replyString(values[index], `${label} field`)] = replyString(
      values[index + 1],
      `${label} value`,
    );
  }
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Valkey contains invalid ${label}.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Valkey contains invalid ${label}.`);
  }
  return parsed;
}

function objectString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Valkey contains invalid ${label}.`);
  return value;
}

function objectNumber(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Valkey contains invalid ${label}.`);
  }
  return value;
}

function parseRole(value: string): Role {
  if (value !== "human" && value !== "agent") throw new Error("Valkey contains an invalid role.");
  return value;
}

function parseLifecycle(value: string): Lifecycle {
  if (value !== "open" && value !== "resolved") {
    throw new Error("Valkey contains an invalid lifecycle.");
  }
  return value;
}

function parsePendingAction(value: string): PendingActionKind | null {
  if (value === "") return null;
  if (
    value !== "provide_context" &&
    value !== "perform_work" &&
    value !== "review_result" &&
    value !== "make_changes"
  ) {
    throw new Error("Valkey contains an invalid pending action.");
  }
  return value;
}

function parseCapability(value: unknown): StoredCapability {
  const record = parsedObject(replyString(value, "capability"), "capability");
  const kind = objectString(record, "kind", "capability kind");
  if (kind !== "claim" && kind !== "session") {
    throw new Error("Valkey contains an invalid capability kind.");
  }
  return {
    id: objectString(record, "id", "capability ID"),
    kind,
    role: parseRole(objectString(record, "role", "capability role")),
    secretDigest: objectString(record, "secretDigest", "capability digest"),
    contentKeyEnvelope: objectString(record, "contentKeyEnvelope", "content-key envelope"),
    consumedAt: objectString(record, "consumedAt", "claim consumption time"),
    exchangeDigest: objectString(record, "exchangeDigest", "exchange digest"),
    exchangeMode: objectString(record, "exchangeMode", "claim exchange mode"),
    sessionCapabilityId: objectString(record, "sessionCapabilityId", "session ID"),
  };
}

function parseAttachment(value: unknown): StoredAttachment {
  const record = parsedObject(replyString(value, "attachment"), "attachment");
  return {
    id: objectString(record, "id", "attachment ID"),
    entryId: objectString(record, "entryId", "attachment entry ID"),
    authorRole: parseRole(objectString(record, "authorRole", "attachment author role")),
    blobKey: objectString(record, "blobKey", "attachment blob key"),
    displayNameEnvelope: objectString(record, "displayNameEnvelope", "attachment name envelope"),
    size: objectNumber(record, "size", "attachment size"),
    width: objectNumber(record, "width", "attachment width"),
    height: objectNumber(record, "height", "attachment height"),
  };
}

function parseAttachmentViews(value: string): EncryptedAttachmentView[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Valkey contains invalid entry attachments.");
  }
  if (!Array.isArray(parsed)) throw new Error("Valkey contains invalid entry attachments.");
  return parsed.map((item) => {
    if (!isRecord(item)) {
      throw new Error("Valkey contains invalid entry attachments.");
    }
    return {
      id: objectString(item, "id", "attachment ID"),
      displayNameEnvelope: objectString(item, "displayNameEnvelope", "attachment name envelope"),
      width: objectNumber(item, "width", "attachment width"),
      height: objectNumber(item, "height", "attachment height"),
    };
  });
}

function parseEntry(value: unknown): EncryptedEntryView {
  const item = replyArray(value, "Stream entry");
  streamCursor(item[0], "Stream entry ID");
  const fields = flatRecord(item[1], "Stream entry fields");
  const kind = fields.kind;
  if (
    kind !== "prompt" &&
    kind !== "response" &&
    kind !== "result" &&
    kind !== "comment" &&
    kind !== "review_decision"
  ) {
    throw new Error("Valkey contains an invalid entry kind.");
  }
  const entry = {
    id: fields.id ?? "",
    authorRole: parseRole(fields.authorRole ?? ""),
    kind,
    bodyEnvelope: fields.bodyEnvelope ?? "",
    urlEnvelope: fields.urlEnvelope ?? "",
    decisionEnvelope: fields.decisionEnvelope ?? "",
    createdAt: fields.createdAt ?? "",
    attachments: parseAttachmentViews(fields.attachments ?? "[]"),
  };
  if (!entry.id || !entry.createdAt || !entry.bodyEnvelope) {
    throw new Error("Valkey contains an incomplete entry.");
  }
  return {
    id: entry.id,
    authorRole: entry.authorRole,
    kind,
    bodyEnvelope: entry.bodyEnvelope,
    ...(entry.urlEnvelope ? { urlEnvelope: entry.urlEnvelope } : {}),
    ...(entry.decisionEnvelope ? { decisionEnvelope: entry.decisionEnvelope } : {}),
    createdAt: entry.createdAt,
    attachments: entry.attachments,
  };
}

function expiresAt(value: unknown): string {
  const milliseconds = Number(replyString(value, "expiry"));
  if (!Number.isSafeInteger(milliseconds)) throw new Error("Valkey returned an invalid expiry.");
  return new Date(milliseconds).toISOString();
}

function appendReceipt(values: unknown[]): AppendReceipt {
  const entryId = replyString(values[1], "receipt entry ID");
  const resultingVersion = Number(replyString(values[2], "receipt version"));
  assertKeyId(entryId, "Receipt entry ID");
  if (!Number.isSafeInteger(resultingVersion) || resultingVersion < 2) {
    throw new Error("Valkey returned an invalid append receipt.");
  }
  return {
    entryId,
    resultingVersion,
    expiresAt: expiresAt(values[3]),
  };
}

function capabilityAccess(
  raiseId: string,
  capability: StoredCapability,
  expiry: unknown,
): CapabilityAccess {
  if (!capability.contentKeyEnvelope) throw new Error("Valkey contains an incomplete capability.");
  return {
    raiseId,
    role: capability.role,
    expiresAt: expiresAt(expiry),
    contentKeyEnvelope: capability.contentKeyEnvelope,
  };
}

export function valkeyRaiseKeys(raiseId: string, keyPrefix = "raise:"): ValkeyRaiseKeys {
  assertKeyId(raiseId, "Raise ID");
  const tag = `{${raiseId}}`;
  return {
    meta: `${keyPrefix}${tag}:meta`,
    capabilities: `${keyPrefix}${tag}:capabilities`,
    entries: `${keyPrefix}${tag}:entries`,
    idempotency: `${keyPrefix}${tag}:idem`,
  };
}

function authenticatedScriptKeys(keys: ValkeyRaiseKeys): [string, string, string, string] {
  return [keys.meta, keys.capabilities, keys.entries, keys.idempotency];
}

export async function connectValkeyRaiseStore({
  url,
  onError,
  ...storeOptions
}: ConnectValkeyRaiseStoreOptions): Promise<ValkeyRaiseStore> {
  const client = createClient({ url, disableOfflineQueue: true });
  client.on("error", onError);
  try {
    await client.connect();
  } catch (error) {
    client.destroy();
    throw error;
  }
  return new ValkeyRaiseStore(client, { ...storeOptions, closeClient: true });
}

export class ValkeyRaiseStore implements RaiseStore {
  private readonly keyPrefix: string;
  private readonly now: () => number;
  private readonly closeClient: boolean;

  constructor(
    private readonly client: ValkeyCommandClient,
    options: ValkeyRaiseStoreOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? "raise:";
    if (this.keyPrefix.includes("{") || this.keyPrefix.includes("}")) {
      throw new Error("The Valkey key prefix cannot contain hash-tag braces.");
    }
    this.now = options.now ?? Date.now;
    this.closeClient = options.closeClient ?? true;
  }

  async close(): Promise<void> {
    if (this.closeClient) await this.client.close();
  }

  async createRaise(command: CreateRaiseCommand): Promise<void> {
    assertKeyId(command.raiseId, "Raise ID");
    assertKeyId(command.entryId, "Entry ID");
    assertKeyId(command.actionId, "Action ID");
    assertEnvelope(command.titleEnvelope, "v1.", "Raise title");
    assertEnvelope(command.prompt.bodyEnvelope, "v1.", "Prompt body");
    if (command.prompt.urlEnvelope) assertEnvelope(command.prompt.urlEnvelope, "v1.", "Prompt URL");
    if (command.prompt.decisionEnvelope) {
      throw new Error("An initial prompt cannot contain a review decision.");
    }
    const { targetRole, pendingAction } = initialWorkflow(command.origin);
    if (
      command.ownerClaim.kind !== "claim" ||
      command.ownerClaim.role !== command.origin ||
      command.targetClaim.kind !== "claim" ||
      command.targetClaim.role !== targetRole
    ) {
      throw new Error("Initial capabilities do not match their Raise roles.");
    }
    assertCapability(command.ownerClaim);
    assertCapability(command.targetClaim);
    for (const attachment of command.attachments) assertAttachment(attachment);
    assertRemainingHardTtlMs(command.remainingHardTtlMs);

    const now = this.now();
    const createdAt = new Date(now).toISOString();
    const keys = valkeyRaiseKeys(command.raiseId, this.keyPrefix);
    const prompt: SerializedEntry = {
      id: command.entryId,
      authorRole: command.origin,
      kind: "prompt",
      bodyEnvelope: command.prompt.bodyEnvelope,
      urlEnvelope: command.prompt.urlEnvelope ?? "",
      decisionEnvelope: "",
      createdAt,
      attachmentsJson: JSON.stringify(command.attachments.map(attachmentView)),
    };
    const meta = {
      titleEnvelope: command.titleEnvelope,
      origin: command.origin,
      createdAt,
      waitingOn: targetRole,
      pendingAction,
      pendingActionId: command.actionId,
    };
    const owner = storedCapability(command.ownerClaim);
    const target = storedCapability(command.targetClaim);
    const attachments = command.attachments.map((attachment) =>
      storedAttachment(attachment, command.entryId, command.origin),
    );

    const response = await this.mutation(
      VALKEY_CREATE_RAISE_SCRIPT,
      [keys.meta, keys.entries, keys.capabilities, keys.idempotency],
      [
        JSON.stringify(meta),
        JSON.stringify(prompt),
        JSON.stringify(owner),
        JSON.stringify(target),
        JSON.stringify(attachments),
        String(RAISE_IDLE_TTL_MS),
        String(command.remainingHardTtlMs),
      ],
      "create",
    );
    const { code } = replyCode(response);
    if (code !== "ok") rejectMutation(code);
  }

  async inspectClaim(command: ClaimInspectionCommand): Promise<ClaimInspection> {
    assertKeyId(command.raiseId, "Raise ID");
    assertKeyId(command.claim.id, "Capability ID");
    const keys = valkeyRaiseKeys(command.raiseId, this.keyPrefix);
    const { values, code } = replyCode(
      await this.evaluate(VALKEY_INSPECT_CLAIM_SCRIPT, authenticatedScriptKeys(keys), [
        String(this.now()),
        command.claim.id,
        command.claim.secretDigest,
        command.mode,
        command.expectedRole ?? "",
        command.exchangeDigest ?? "",
      ]),
    );

    if (code === "invalid_capability") rejectInvalidCapability();
    if (code === "corrupt_state") corruptState();
    if (code === "wrong_role") {
      rejectWrongRole(parseRole(replyString(values[1], "claim role")), command.expectedRole);
    }
    if (code === "incomplete_claim")
      throw new Error("Valkey contains an incomplete claim exchange.");
    if (code === "new") {
      return {
        ...capabilityAccess(command.raiseId, parseCapability(values[1]), values[2]),
        sessionExpiresAt: expiresAt(values[3]),
      };
    }
    if (code === "replay") {
      return {
        raiseId: command.raiseId,
        role: parseRole(replyString(values[1], "claim role")),
        expiresAt: expiresAt(values[4]),
        sessionExpiresAt: expiresAt(values[5]),
        existingExchange: {
          sessionCapabilityId: replyString(values[2], "session capability ID"),
          sessionSecretDigest: replyString(values[3], "session capability digest"),
        },
      };
    }
    throw new Error(`Valkey returned an unknown claim status (${code}).`);
  }

  async commitClaimExchange(command: CommitClaimExchangeCommand): Promise<ClaimExchangeResult> {
    assertKeyId(command.raiseId, "Raise ID");
    assertKeyId(command.claim.id, "Capability ID");
    assertCapability(command.session);
    if (command.session.kind !== "session") throw new Error("Claim exchange requires a session.");
    const keys = valkeyRaiseKeys(command.raiseId, this.keyPrefix);
    const { values, code } = replyCode(
      await this.mutation(
        VALKEY_COMMIT_CLAIM_SCRIPT,
        authenticatedScriptKeys(keys),
        [
          String(this.now()),
          command.claim.id,
          command.claim.secretDigest,
          command.mode,
          command.expectedRole ?? "",
          command.exchangeDigest ?? "",
          JSON.stringify(storedCapability(command.session)),
        ],
        "claim exchange",
      ),
    );

    if (code === "invalid_capability") rejectInvalidCapability();
    if (code === "corrupt_state") corruptState();
    if (code === "wrong_role") {
      rejectWrongRole(parseRole(replyString(values[1], "claim role")), command.expectedRole);
    }
    if (code === "incomplete_claim")
      throw new Error("Valkey contains an incomplete claim exchange.");
    if (code !== "new" && code !== "replay") rejectMutation(code);
    return {
      raiseId: command.raiseId,
      role: parseRole(replyString(values[1], "claim role")),
      sessionCapabilityId: replyString(values[2], "session capability ID"),
      sessionSecretDigest: replyString(values[3], "session capability digest"),
      contentKeyEnvelope: replyString(values[4], "content-key envelope"),
      expiresAt: expiresAt(values[5]),
      sessionExpiresAt: expiresAt(values[6]),
    };
  }

  async getRaise(
    raiseId: string,
    session: { id: string; secretDigest: string },
    options: RaiseReadOptions = {},
  ) {
    assertKeyId(raiseId, "Raise ID");
    assertKeyId(session.id, "Capability ID");
    const keys = valkeyRaiseKeys(raiseId, this.keyPrefix);
    const { values, code } = replyCode(
      await this.evaluate(VALKEY_GET_RAISE_SCRIPT, authenticatedScriptKeys(keys), [
        String(this.now()),
        session.id,
        session.secretDigest,
        options.after ?? "",
      ]),
    );
    if (code === "unauthorized") rejectUnauthorizedSession();
    if (code === "corrupt_state") corruptState();
    if (code === "invalid_cursor") throw new Error("The Raise cursor is invalid.");
    if (code !== "ok") throw new Error(`Valkey returned an unknown read status (${code}).`);

    const viewer = capabilityAccess(raiseId, parseCapability(values[1]), values[2]);
    const meta = flatRecord(values[3], "Raise metadata");
    const lifecycle = parseLifecycle(meta.lifecycle ?? "");
    const waitingOn = meta.waitingOn ? parseRole(meta.waitingOn) : null;
    const pendingAction = parsePendingAction(meta.pendingAction ?? "");
    const cursor = streamCursor(values[4]);
    const mode = entriesMode(values[5]);
    const stream = replyArray(values[6], "Raise event Stream");
    const result: AuthorizedEncryptedRaise = {
      ...viewer,
      id: raiseId,
      titleEnvelope: meta.titleEnvelope ?? "",
      origin: parseRole(meta.origin ?? ""),
      lifecycle,
      waitingOn,
      pendingAction,
      version: Number(meta.version),
      createdAt: meta.createdAt ?? "",
      updatedAt: meta.updatedAt ?? "",
      permissions: permissionsFor(lifecycle, waitingOn, pendingAction, viewer.role),
      cursor,
      entriesMode: mode,
      entries: stream.map(parseEntry),
    };
    if (
      !result.titleEnvelope ||
      !Number.isSafeInteger(result.version) ||
      !result.createdAt ||
      !result.updatedAt
    ) {
      throw new Error("Valkey contains incomplete Raise metadata.");
    }
    return result;
  }

  async preflightAppend(command: AppendPreflightCommand): Promise<AppendPreflightResult> {
    assertKeyId(command.raiseId, "Raise ID");
    assertKeyId(command.session.id, "Capability ID");
    assertAppendIdempotency(command.idempotency);
    const keys = valkeyRaiseKeys(command.raiseId, this.keyPrefix);
    const { values, code } = replyCode(
      await this.evaluate(VALKEY_PREFLIGHT_APPEND_SCRIPT, authenticatedScriptKeys(keys), [
        String(this.now()),
        command.session.id,
        command.session.secretDigest,
        String(command.transition.expectedVersion),
        command.transition.kind,
        command.transition.decision ?? "",
        command.idempotency.keyDigest,
        command.idempotency.requestDigest,
      ]),
    );
    if (code === "corrupt_state") corruptState();
    if (code === "replayed") return { status: "replayed", receipt: appendReceipt(values) };
    if (code !== "ok") rejectMutation(code);
    return {
      status: "authorized",
      access: capabilityAccess(command.raiseId, parseCapability(values[1]), values[2]),
    };
  }

  async appendEntry(command: AppendEntryCommand): Promise<AppendResult> {
    assertKeyId(command.raiseId, "Raise ID");
    assertKeyId(command.session.id, "Capability ID");
    assertAppendIdempotency(command.idempotency);
    assertKeyId(command.entryId, "Entry ID");
    assertKeyId(command.nextActionId, "Action ID");
    assertEnvelope(command.content.bodyEnvelope, "v1.", "Entry body");
    if (command.content.urlEnvelope)
      assertEnvelope(command.content.urlEnvelope, "v1.", "Entry URL");
    if (command.content.decisionEnvelope) {
      assertEnvelope(command.content.decisionEnvelope, "v1.", "Review decision");
    }
    assertEncryptedEntryMatchesTransition(command.content, command.transition);
    for (const attachment of command.attachments) assertAttachment(attachment);

    const keys = valkeyRaiseKeys(command.raiseId, this.keyPrefix);
    const now = this.now();
    const createdAt = new Date(now).toISOString();
    const entry: Omit<SerializedEntry, "authorRole"> = {
      id: command.entryId,
      kind: command.transition.kind,
      bodyEnvelope: command.content.bodyEnvelope,
      urlEnvelope: command.content.urlEnvelope ?? "",
      decisionEnvelope: command.content.decisionEnvelope ?? "",
      createdAt,
      attachmentsJson: JSON.stringify(command.attachments.map(attachmentView)),
    };
    const attachments = command.attachments.map((attachment) => ({
      ...attachment,
      entryId: command.entryId,
    }));
    const { values, code } = replyCode(
      await this.mutation(
        VALKEY_APPEND_ENTRY_SCRIPT,
        authenticatedScriptKeys(keys),
        [
          String(now),
          command.session.id,
          command.session.secretDigest,
          String(command.transition.expectedVersion),
          command.transition.kind,
          command.transition.decision ?? "",
          JSON.stringify(entry),
          JSON.stringify(attachments),
          command.nextActionId,
          String(RAISE_IDLE_TTL_MS),
          String(RAISE_ACCEPTED_TTL_MS),
          command.idempotency.keyDigest,
          command.idempotency.requestDigest,
        ],
        "append",
      ),
    );
    if (code === "corrupt_state") corruptState();
    if (code !== "committed" && code !== "replayed") rejectMutation(code);
    return { status: code, receipt: appendReceipt(values) };
  }

  async getAttachment(
    raiseId: string,
    attachmentId: string,
    session: { id: string; secretDigest: string },
  ): Promise<AuthorizedEncryptedAttachment> {
    assertKeyId(raiseId, "Raise ID");
    assertKeyId(attachmentId, "Attachment ID");
    assertKeyId(session.id, "Capability ID");
    const keys = valkeyRaiseKeys(raiseId, this.keyPrefix);
    const { values, code } = replyCode(
      await this.evaluate(VALKEY_GET_ATTACHMENT_SCRIPT, authenticatedScriptKeys(keys), [
        String(this.now()),
        session.id,
        session.secretDigest,
        attachmentId,
      ]),
    );
    if (code === "unauthorized") rejectUnauthorizedSession();
    if (code === "corrupt_state") corruptState();
    if (code === "not_found") {
      rejectMissingScreenshot();
    }
    if (code !== "ok") throw new Error(`Valkey returned an unknown attachment status (${code}).`);

    const viewer = capabilityAccess(raiseId, parseCapability(values[1]), values[2]);
    const attachment = parseAttachment(values[3]);
    return { ...viewer, blobKey: attachment.blobKey, authorRole: attachment.authorRole };
  }

  private evaluate(script: string, keys: readonly string[], arguments_: readonly string[]) {
    return this.client.sendCommand(["EVAL", script, String(keys.length), ...keys, ...arguments_]);
  }

  private async mutation(
    script: string,
    keys: readonly string[],
    arguments_: readonly string[],
    operation: string,
  ): Promise<unknown> {
    try {
      return await this.evaluate(script, keys, arguments_);
    } catch (cause) {
      throw new StoreCommitOutcomeUnknownError(
        `Valkey did not confirm the ${operation} operation.`,
        { cause },
      );
    }
  }
}
