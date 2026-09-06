import { createHash, createHmac, randomBytes } from "node:crypto";
import type {
  ClaimMode,
  ClaimResponse,
  CreateRaiseInput,
  CreateRaiseResponse,
  Decision,
  PostEntryInput,
  RaiseView,
  Role,
} from "@raise/protocol";
import {
  createCapability,
  deriveExchangeSessionSecret,
  digestCapabilitySecret,
  encodeCapabilityToken,
  generateCapabilityId,
  generateCapabilitySecret,
  parseCapabilityToken,
  verifyCapabilitySecretDigest,
  type CapabilityKind,
  type CreatedCapability,
  type ParsedCapability,
} from "./capabilities.js";
import {
  generateContentKey,
  openContent,
  openText,
  sealContent,
  sealText,
  unwrapContentKey,
  wrapContentKey,
  type AuthenticatedContentContext,
  type ContentKeyWrapContext,
} from "./content-crypto.js";
import { prepareImages, type PreparedImage } from "./images.js";
import {
  RetentionBudgetExhaustedError,
  startRetentionBudget,
  systemMonotonicNow,
  type MonotonicNow,
} from "./retention.js";
import {
  StoreCommitOutcomeUnknownError,
  BLOB_KEY_PREFIX,
  type AttachmentWrite,
  type AppendIdempotency,
  type BlobStore,
  type CapabilityProof,
  type CapabilityWrite,
  type EncryptedEntryWrite,
  type EntryTransition,
  type RaiseStore,
} from "./storage.js";
import { otherRole } from "./workflow.js";

type ClaimExchangeResponse = Omit<ClaimResponse, "token"> & { sessionToken: string };

function id(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

function blobKey(): string {
  return `${BLOB_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function raiseTitleContext(raiseId: string): AuthenticatedContentContext {
  return { requestId: raiseId, recordType: "raise", recordId: raiseId, field: "title" };
}

function entryFieldContext(
  raiseId: string,
  entryId: string,
  authorRole: Role,
  field: "body" | "url" | "decision",
): AuthenticatedContentContext {
  return {
    requestId: raiseId,
    recordType: "entry",
    recordId: entryId,
    field,
    authorRole,
  };
}

function attachmentFieldContext(
  raiseId: string,
  attachmentId: string,
  authorRole: Role,
  field: "bytes" | "name",
): AuthenticatedContentContext {
  return {
    requestId: raiseId,
    recordType: "attachment",
    recordId: attachmentId,
    field,
    authorRole,
  };
}

function capabilityWrapContext(
  raiseId: string,
  capabilityId: string,
  role: Role,
  purpose: CapabilityKind,
): ContentKeyWrapContext {
  return { requestId: raiseId, capabilityId, role, purpose };
}

function exchangeDigest(exchangeId: string): string {
  return createHash("sha256")
    .update("raise/claim-exchange/v1")
    .update("\0")
    .update(exchangeId)
    .digest("hex");
}

function attachmentSourceDigest(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return createHash("sha256").update(dataUrl).digest("hex");
  const source = Buffer.from(dataUrl.slice(comma + 1).replace(/\s/g, ""), "base64");
  try {
    return createHash("sha256").update(source).digest("hex");
  } finally {
    source.fill(0);
  }
}

function appendIdempotencyProof(
  raiseId: string,
  session: ParsedCapability,
  idempotencyKey: string,
  input: PostEntryInput,
): AppendIdempotency {
  const keyDigest = createHmac("sha256", session.secret)
    .update(JSON.stringify(["raise/append-key/v1", raiseId, session.id, idempotencyKey]))
    .digest("hex");
  const semanticRequest = [
    "raise/append-request/v1",
    raiseId,
    session.id,
    input.kind,
    input.expectedVersion,
    input.body,
    input.url ? new URL(input.url).href : null,
    input.decision ?? null,
    input.attachments.map((attachment) => [
      attachment.name,
      attachment.mimeType,
      attachmentSourceDigest(attachment.dataUrl),
    ]),
  ];
  return {
    keyDigest,
    requestDigest: createHmac("sha256", session.secret)
      .update(JSON.stringify(semanticRequest))
      .digest("hex"),
  };
}

function capabilityProof(kind: CapabilityKind, capability: ParsedCapability): CapabilityProof {
  return {
    id: capability.id,
    secretDigest: digestCapabilitySecret(kind, capability.id, capability.secret),
  };
}

function wrappedCapability(
  capability: CreatedCapability,
  raiseId: string,
  role: Role,
  contentKey: Uint8Array,
): CapabilityWrite {
  return {
    id: capability.id,
    kind: capability.kind,
    role,
    secretDigest: capability.secretDigest,
    contentKeyEnvelope: wrapContentKey({
      contentKey,
      capabilitySecret: capability.secret,
      context: capabilityWrapContext(raiseId, capability.id, role, capability.kind),
    }),
  };
}

function requestTitle(input: CreateRaiseInput, images: readonly PreparedImage[]): string {
  const promptTitle = input.prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !/^\[From .+\]$/.test(line));
  return (
    input.title ??
    promptTitle?.slice(0, 180) ??
    input.url?.slice(0, 180) ??
    images[0]?.displayName ??
    "Untitled request"
  );
}

function entryContent(
  raiseId: string,
  entryId: string,
  authorRole: Role,
  contentKey: Uint8Array,
  input: { body: string; url?: string; decision?: Decision },
): EncryptedEntryWrite {
  return {
    bodyEnvelope: sealText({
      plaintext: input.body,
      contentKey,
      context: entryFieldContext(raiseId, entryId, authorRole, "body"),
    }),
    ...(input.url
      ? {
          urlEnvelope: sealText({
            plaintext: input.url,
            contentKey,
            context: entryFieldContext(raiseId, entryId, authorRole, "url"),
          }),
        }
      : {}),
    ...(input.decision
      ? {
          decisionEnvelope: sealText({
            plaintext: input.decision,
            contentKey,
            context: entryFieldContext(raiseId, entryId, authorRole, "decision"),
          }),
        }
      : {}),
  };
}

function storedDecision(value: string): Decision {
  if (value !== "accept" && value !== "request_changes") {
    throw new Error("Stored review decision is invalid.");
  }
  return value;
}

async function removeBlobs(blobs: BlobStore, attachments: readonly AttachmentWrite[]) {
  await Promise.allSettled(attachments.map((attachment) => blobs.delete(attachment.blobKey)));
}

async function commitWithBlobCompensation<T>(
  blobs: BlobStore,
  attachments: readonly AttachmentWrite[],
  commit: () => Promise<T>,
): Promise<T> {
  try {
    return await commit();
  } catch (error) {
    if (!(error instanceof StoreCommitOutcomeUnknownError)) {
      await removeBlobs(blobs, attachments);
    }
    throw error;
  }
}

export class RaiseService {
  constructor(
    private readonly raises: RaiseStore,
    private readonly blobs: BlobStore,
    private readonly getPublicBaseUrl: () => string,
    private readonly monotonicNow: MonotonicNow = systemMonotonicNow,
  ) {}

  async createRaise(input: CreateRaiseInput): Promise<CreateRaiseResponse> {
    const retentionBudget = startRetentionBudget(this.monotonicNow);
    const images = await prepareImages(input.attachments);
    const raiseId = id("r");
    const entryId = id("e");
    const ownerRole = input.origin;
    const targetRole = otherRole(input.origin);
    const contentKey = generateContentKey();
    const ownerClaim = createCapability("claim");
    const targetClaim = createCapability("claim");

    try {
      const titleEnvelope = sealText({
        plaintext: requestTitle(input, images),
        contentKey,
        context: raiseTitleContext(raiseId),
      });
      const prompt = entryContent(raiseId, entryId, ownerRole, contentKey, {
        body: input.prompt,
        ...(input.url ? { url: input.url } : {}),
      });
      const attachments = await this.stageImages(images, raiseId, ownerRole, contentKey);

      await commitWithBlobCompensation(this.blobs, attachments, () => {
        const remainingHardTtlMs = retentionBudget.remainingMs();
        if (remainingHardTtlMs <= 0) throw new RetentionBudgetExhaustedError();
        return this.raises.createRaise({
          raiseId,
          entryId,
          actionId: id("a"),
          remainingHardTtlMs,
          origin: input.origin,
          titleEnvelope,
          prompt,
          attachments,
          ownerClaim: wrappedCapability(ownerClaim, raiseId, ownerRole, contentKey),
          targetClaim: wrappedCapability(targetClaim, raiseId, targetRole, contentKey),
        });
      });

      const base = this.getPublicBaseUrl().replace(/\/$/, "");
      return {
        raiseId,
        ownerClaimUrl: `${base}/r/${raiseId}#token=${ownerClaim.token}`,
        targetClaimUrl: `${base}/r/${raiseId}#token=${targetClaim.token}`,
        targetRole,
      };
    } finally {
      contentKey.fill(0);
      ownerClaim.secret.fill(0);
      targetClaim.secret.fill(0);
      for (const image of images) image.data.fill(0);
    }
  }

  async exchangeClaim(
    raiseId: string,
    token: string,
    mode: ClaimMode,
    expectedRole?: Role,
    exchangeId?: string,
  ): Promise<ClaimExchangeResponse> {
    const claim = parseCapabilityToken(token, "claim");
    const claimProof = capabilityProof("claim", claim);
    const digest = exchangeId ? exchangeDigest(exchangeId) : undefined;
    const inspection = {
      raiseId,
      claim: claimProof,
      mode,
      ...(expectedRole ? { expectedRole } : {}),
      ...(digest ? { exchangeDigest: digest } : {}),
    };

    try {
      const inspected = await this.raises.inspectClaim(inspection);

      if (inspected.existingExchange) {
        if (!exchangeId) throw new Error("A replayable claim exchange is missing its exchange ID.");
        return this.replayedClaimResponse(
          claim.secret,
          exchangeId,
          inspected,
          inspected.existingExchange,
        );
      }

      const contentKey = unwrapContentKey({
        envelope: inspected.contentKeyEnvelope,
        capabilitySecret: claim.secret,
        context: capabilityWrapContext(inspected.raiseId, claim.id, inspected.role, "claim"),
      });
      const sessionCapabilityId = generateCapabilityId();
      const sessionSecret = exchangeId
        ? deriveExchangeSessionSecret(claim.secret, exchangeId, sessionCapabilityId)
        : generateCapabilitySecret();

      try {
        const result = await this.raises.commitClaimExchange({
          ...inspection,
          session: {
            id: sessionCapabilityId,
            kind: "session",
            role: inspected.role,
            secretDigest: digestCapabilitySecret("session", sessionCapabilityId, sessionSecret),
            contentKeyEnvelope: wrapContentKey({
              contentKey,
              capabilitySecret: sessionSecret,
              context: capabilityWrapContext(
                inspected.raiseId,
                sessionCapabilityId,
                inspected.role,
                "session",
              ),
            }),
          },
        });

        if (result.sessionCapabilityId === sessionCapabilityId) {
          this.assertSessionDigest(result.sessionSecretDigest, sessionCapabilityId, sessionSecret);
          return this.claimResponse(
            result.raiseId,
            result.role,
            result.sessionExpiresAt,
            sessionCapabilityId,
            sessionSecret,
          );
        }
        if (!exchangeId) throw new Error("A non-replayable claim exchange changed sessions.");
        return this.replayedClaimResponse(claim.secret, exchangeId, result, result);
      } finally {
        contentKey.fill(0);
        sessionSecret.fill(0);
      }
    } finally {
      claim.secret.fill(0);
    }
  }

  async getRaise(raiseId: string, sessionToken: string, afterCursor?: string): Promise<RaiseView> {
    const session = parseCapabilityToken(sessionToken, "session");
    try {
      const encrypted = await this.raises.getRaise(
        raiseId,
        capabilityProof("session", session),
        afterCursor ? { after: afterCursor } : undefined,
      );
      const contentKey = this.unwrapSessionContentKey(encrypted, session);
      try {
        return {
          id: encrypted.id,
          title: openText({
            envelope: encrypted.titleEnvelope,
            contentKey,
            context: raiseTitleContext(raiseId),
          }),
          origin: encrypted.origin,
          viewerRole: encrypted.role,
          lifecycle: encrypted.lifecycle,
          waitingOn: encrypted.waitingOn,
          pendingAction: encrypted.pendingAction,
          version: encrypted.version,
          cursor: encrypted.cursor,
          entriesMode: encrypted.entriesMode,
          createdAt: encrypted.createdAt,
          updatedAt: encrypted.updatedAt,
          expiresAt: encrypted.expiresAt,
          permissions: encrypted.permissions,
          entries: encrypted.entries.map((entry) => {
            const decision = entry.decisionEnvelope
              ? storedDecision(
                  openText({
                    envelope: entry.decisionEnvelope,
                    contentKey,
                    context: entryFieldContext(raiseId, entry.id, entry.authorRole, "decision"),
                  }),
                )
              : undefined;
            return {
              id: entry.id,
              authorRole: entry.authorRole,
              kind: entry.kind,
              body: openText({
                envelope: entry.bodyEnvelope,
                contentKey,
                context: entryFieldContext(raiseId, entry.id, entry.authorRole, "body"),
              }),
              ...(entry.urlEnvelope
                ? {
                    url: openText({
                      envelope: entry.urlEnvelope,
                      contentKey,
                      context: entryFieldContext(raiseId, entry.id, entry.authorRole, "url"),
                    }),
                  }
                : {}),
              ...(decision ? { decision } : {}),
              createdAt: entry.createdAt,
              attachments: entry.attachments.map((attachment) => ({
                id: attachment.id,
                name: openText({
                  envelope: attachment.displayNameEnvelope,
                  contentKey,
                  context: attachmentFieldContext(raiseId, attachment.id, entry.authorRole, "name"),
                }),
                mediaType: "image/webp" as const,
                url: `/api/raises/${raiseId}/attachments/${attachment.id}`,
                width: attachment.width,
                height: attachment.height,
              })),
            };
          }),
        };
      } finally {
        contentKey.fill(0);
      }
    } finally {
      session.secret.fill(0);
    }
  }

  async postEntry(
    raiseId: string,
    sessionToken: string,
    input: PostEntryInput,
    idempotencyKey: string,
  ) {
    const session = parseCapabilityToken(sessionToken, "session");
    const transition: EntryTransition = {
      kind: input.kind,
      expectedVersion: input.expectedVersion,
      ...(input.decision ? { decision: input.decision } : {}),
    };
    const proof = capabilityProof("session", session);

    try {
      const idempotency = appendIdempotencyProof(raiseId, session, idempotencyKey, input);
      const preflight = await this.raises.preflightAppend({
        raiseId,
        session: proof,
        transition,
        idempotency,
      });
      if (preflight.status === "replayed") return this.getRaise(raiseId, sessionToken);

      const contentKey = this.unwrapSessionContentKey(preflight.access, session);
      const entryId = id("e");
      let attachments: AttachmentWrite[] = [];

      try {
        const content = entryContent(raiseId, entryId, preflight.access.role, contentKey, {
          body: input.body,
          ...(input.url ? { url: input.url } : {}),
          ...(input.decision ? { decision: input.decision } : {}),
        });
        const images = await prepareImages(input.attachments);
        try {
          attachments = await this.stageImages(images, raiseId, preflight.access.role, contentKey);
        } finally {
          for (const image of images) image.data.fill(0);
        }

        const result = await commitWithBlobCompensation(this.blobs, attachments, () =>
          this.raises.appendEntry({
            raiseId,
            entryId,
            nextActionId: id("a"),
            session: proof,
            transition,
            idempotency,
            content,
            attachments,
          }),
        );
        if (result.status === "replayed") await removeBlobs(this.blobs, attachments);
      } finally {
        contentKey.fill(0);
      }
    } finally {
      session.secret.fill(0);
    }
    return this.getRaise(raiseId, sessionToken);
  }

  async getAttachment(raiseId: string, attachmentId: string, sessionToken: string) {
    const session = parseCapabilityToken(sessionToken, "session");
    try {
      const attachment = await this.raises.getAttachment(
        raiseId,
        attachmentId,
        capabilityProof("session", session),
      );
      const contentKey = this.unwrapSessionContentKey(attachment, session);
      try {
        const encryptedBytes = await this.blobs.get(attachment.blobKey);
        return {
          blobKey: attachment.blobKey,
          mediaType: "image/webp" as const,
          bytes: openContent({
            envelope: encryptedBytes.toString("utf8"),
            contentKey,
            context: attachmentFieldContext(raiseId, attachmentId, attachment.authorRole, "bytes"),
          }),
        };
      } finally {
        contentKey.fill(0);
      }
    } finally {
      session.secret.fill(0);
    }
  }

  async close() {
    await Promise.all([this.raises.close(), this.blobs.close()]);
  }

  private claimResponse(
    raiseId: string,
    role: Role,
    expiresAt: string,
    capabilityId: string,
    secret: Uint8Array,
  ): ClaimExchangeResponse {
    const sessionToken = encodeCapabilityToken("session", capabilityId, secret);
    return { raiseId, role, sessionToken, expiresAt };
  }

  private assertSessionDigest(expected: string, capabilityId: string, secret: Uint8Array) {
    if (!verifyCapabilitySecretDigest(expected, "session", capabilityId, secret)) {
      throw new Error("The stored claim exchange is incomplete.");
    }
  }

  private replayedClaimResponse(
    claimSecret: Uint8Array,
    exchangeId: string,
    access: { raiseId: string; role: Role; sessionExpiresAt: string },
    exchange: { sessionCapabilityId: string; sessionSecretDigest: string },
  ) {
    const sessionSecret = deriveExchangeSessionSecret(
      claimSecret,
      exchangeId,
      exchange.sessionCapabilityId,
    );
    try {
      this.assertSessionDigest(
        exchange.sessionSecretDigest,
        exchange.sessionCapabilityId,
        sessionSecret,
      );
      return this.claimResponse(
        access.raiseId,
        access.role,
        access.sessionExpiresAt,
        exchange.sessionCapabilityId,
        sessionSecret,
      );
    } finally {
      sessionSecret.fill(0);
    }
  }

  private unwrapSessionContentKey(
    access: { raiseId: string; role: Role; contentKeyEnvelope: string },
    session: ParsedCapability,
  ) {
    return unwrapContentKey({
      envelope: access.contentKeyEnvelope,
      capabilitySecret: session.secret,
      context: capabilityWrapContext(access.raiseId, session.id, access.role, "session"),
    });
  }

  private async stageImages(
    images: readonly PreparedImage[],
    raiseId: string,
    authorRole: Role,
    contentKey: Uint8Array,
  ): Promise<AttachmentWrite[]> {
    const staged: AttachmentWrite[] = [];
    try {
      for (const image of images) {
        const attachmentId = id("img");
        const key = blobKey();
        const encryptedBytes = Buffer.from(
          sealContent({
            plaintext: image.data,
            contentKey,
            context: attachmentFieldContext(raiseId, attachmentId, authorRole, "bytes"),
          }),
          "utf8",
        );
        const attachment: AttachmentWrite = {
          id: attachmentId,
          blobKey: key,
          displayNameEnvelope: sealText({
            plaintext: image.displayName,
            contentKey,
            context: attachmentFieldContext(raiseId, attachmentId, authorRole, "name"),
          }),
          size: image.data.length,
          width: image.width,
          height: image.height,
        };
        staged.push(attachment);
        await this.blobs.put({ key, bytes: encryptedBytes });
      }
      return staged;
    } catch (error) {
      await removeBlobs(this.blobs, staged);
      throw error;
    }
  }
}
