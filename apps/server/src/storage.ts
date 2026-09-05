import type {
  ClaimMode,
  Decision,
  EntryKind,
  Lifecycle,
  PendingActionKind,
  RaiseEntriesMode,
  RaisePermissions,
  Role,
} from "@raise/protocol";
import { isSha256HexDigest, type CapabilityKind } from "./capabilities.js";

export const BLOB_KEY_PREFIX = "ephemeral/v1/";

export interface CapabilityProof {
  id: string;
  secretDigest: string;
}

export interface CapabilityWrite extends CapabilityProof {
  kind: CapabilityKind;
  role: Role;
  contentKeyEnvelope: string;
}

export interface CapabilityAccess {
  raiseId: string;
  role: Role;
  expiresAt: string;
  contentKeyEnvelope: string;
}

export interface EntryTransition {
  kind: Exclude<EntryKind, "prompt">;
  expectedVersion: number;
  decision?: Decision;
}

export interface AttachmentWrite {
  id: string;
  blobKey: string;
  displayNameEnvelope: string;
  size: number;
  width: number;
  height: number;
}

export interface EncryptedEntryWrite {
  bodyEnvelope: string;
  urlEnvelope?: string;
  decisionEnvelope?: string;
}

export interface CreateRaiseCommand {
  raiseId: string;
  entryId: string;
  actionId: string;
  /** Remaining portion of the immutable hard lifetime, after preprocessing and blob staging. */
  remainingHardTtlMs: number;
  origin: Role;
  titleEnvelope: string;
  prompt: EncryptedEntryWrite;
  attachments: readonly AttachmentWrite[];
  ownerClaim: CapabilityWrite;
  targetClaim: CapabilityWrite;
}

export interface ClaimInspectionCommand {
  raiseId: string;
  claim: CapabilityProof;
  mode: ClaimMode;
  expectedRole?: Role;
  exchangeDigest?: string;
}

interface ExistingClaimExchange {
  sessionCapabilityId: string;
  sessionSecretDigest: string;
}

interface SessionRetention {
  /** Latest time a client should retain the session credential. Access may end earlier. */
  sessionExpiresAt: string;
}

export type ClaimInspection =
  | (CapabilityAccess & SessionRetention & { existingExchange?: never })
  | (Omit<CapabilityAccess, "contentKeyEnvelope"> &
      SessionRetention & {
        existingExchange: ExistingClaimExchange;
      });

export interface CommitClaimExchangeCommand extends ClaimInspectionCommand {
  session: CapabilityWrite;
}

export type ClaimExchangeResult = CapabilityAccess & ExistingClaimExchange & SessionRetention;

export interface AppendPreflightCommand {
  raiseId: string;
  session: CapabilityProof;
  transition: EntryTransition;
  idempotency: AppendIdempotency;
}

export interface AppendIdempotency {
  keyDigest: string;
  requestDigest: string;
}

export function assertAppendIdempotency(idempotency: AppendIdempotency): void {
  if (!isSha256HexDigest(idempotency.keyDigest) || !isSha256HexDigest(idempotency.requestDigest)) {
    throw new Error("Append idempotency data is invalid.");
  }
}

export function assertEncryptedEntryMatchesTransition(
  content: EncryptedEntryWrite,
  transition: EntryTransition,
): void {
  if (Boolean(content.decisionEnvelope) !== Boolean(transition.decision)) {
    throw new Error("Encrypted decision content does not match the state transition.");
  }
}

export interface AppendReceipt {
  entryId: string;
  resultingVersion: number;
  expiresAt: string;
}

export type AppendPreflightResult =
  | { status: "authorized"; access: CapabilityAccess }
  | { status: "replayed"; receipt: AppendReceipt };

export type AppendResult =
  { status: "committed"; receipt: AppendReceipt } | { status: "replayed"; receipt: AppendReceipt };

export interface AppendEntryCommand extends AppendPreflightCommand {
  entryId: string;
  nextActionId: string;
  content: EncryptedEntryWrite;
  attachments: readonly AttachmentWrite[];
}

export type EncryptedAttachmentView = Pick<
  AttachmentWrite,
  "id" | "displayNameEnvelope" | "width" | "height"
>;

export interface EncryptedEntryView extends EncryptedEntryWrite {
  id: string;
  authorRole: Role;
  kind: EntryKind;
  createdAt: string;
  attachments: EncryptedAttachmentView[];
}

export interface AuthorizedEncryptedRaise extends CapabilityAccess {
  id: string;
  titleEnvelope: string;
  origin: Role;
  lifecycle: Lifecycle;
  waitingOn: Role | null;
  pendingAction: PendingActionKind | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  permissions: RaisePermissions;
  cursor: string;
  entriesMode: RaiseEntriesMode;
  entries: EncryptedEntryView[];
}

export interface RaiseReadOptions {
  after?: string;
}

export interface AuthorizedEncryptedAttachment extends CapabilityAccess {
  blobKey: string;
  authorRole: Role;
}

export interface RaiseStore {
  /** Throw StoreCommitOutcomeUnknownError only when the create may have committed. */
  createRaise(command: CreateRaiseCommand): Promise<void>;
  inspectClaim(command: ClaimInspectionCommand): Promise<ClaimInspection>;
  /** Reauthenticate and consume the claim atomically with session creation. */
  commitClaimExchange(command: CommitClaimExchangeCommand): Promise<ClaimExchangeResult>;
  getRaise(
    raiseId: string,
    session: CapabilityProof,
    options?: RaiseReadOptions,
  ): Promise<AuthorizedEncryptedRaise>;
  preflightAppend(command: AppendPreflightCommand): Promise<AppendPreflightResult>;
  /** Throw StoreCommitOutcomeUnknownError only when the append may have committed. */
  appendEntry(command: AppendEntryCommand): Promise<AppendResult>;
  getAttachment(
    raiseId: string,
    attachmentId: string,
    session: CapabilityProof,
  ): Promise<AuthorizedEncryptedAttachment>;
  close(): Promise<void>;
}

export interface BlobWrite {
  key: string;
  bytes: Buffer;
}

export interface BlobStore {
  /** The caller owns the key and may delete it after either success or failure. */
  put(input: BlobWrite): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}

/** The store may have committed, but the adapter could not confirm the result. */
export class StoreCommitOutcomeUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreCommitOutcomeUnknownError";
  }
}
