import { createHash } from "node:crypto";
import type { Decision, EntryKind, Role } from "@raise/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCapability,
  deriveExchangeSessionSecret,
  digestCapabilitySecret,
  generateCapabilityId,
  generateCapabilitySecret,
  type CreatedCapability,
} from "../src/capabilities.js";
import { generateContentKey, sealText, wrapContentKey } from "../src/content-crypto.js";
import { RAISE_HARD_TTL_MS } from "../src/retention.js";
import type {
  AppendEntryCommand,
  AttachmentWrite,
  CapabilityProof,
  CapabilityWrite,
  ClaimInspectionCommand,
  CommitClaimExchangeCommand,
  EncryptedEntryWrite,
  EntryTransition,
  RaiseStore,
} from "../src/storage.js";

export interface RaiseStoreFixture {
  store: RaiseStore;
  cleanup(): Promise<void>;
}

type TestCapability = Pick<CreatedCapability, "id" | "kind" | "secret" | "secretDigest">;

interface TestRaise {
  raiseId: string;
  entryId: string;
  contentKey: Buffer;
  ownerClaim: TestCapability;
  targetClaim: TestCapability;
  titleEnvelope: string;
  prompt: EncryptedEntryWrite;
  attachments: readonly AttachmentWrite[];
}

interface ClaimSession {
  proof: CapabilityProof;
  contentKeyEnvelope: string;
}

interface AppendInput {
  entryId: string;
  actionId: string;
  role: Role;
  kind: Exclude<EntryKind, "prompt">;
  expectedVersion: number;
  body: string;
  url?: string;
  decision?: Decision;
  attachments?: readonly AttachmentWrite[];
  idempotency?: AppendEntryCommand["idempotency"];
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function appCapability(kind: CreatedCapability["kind"]): TestCapability {
  const capability = createCapability(kind);
  return {
    id: capability.id,
    kind,
    secret: capability.secret,
    secretDigest: capability.secretDigest,
  };
}

function appSessionForExchange(claim: TestCapability, exchangeId: string): TestCapability {
  const id = generateCapabilityId();
  const secret = deriveExchangeSessionSecret(claim.secret, exchangeId, id);
  return {
    id,
    kind: "session",
    secret,
    secretDigest: digestCapabilitySecret("session", id, secret),
  };
}

function appSession(): TestCapability {
  const id = generateCapabilityId();
  const secret = generateCapabilitySecret();
  return {
    id,
    kind: "session",
    secret,
    secretDigest: digestCapabilitySecret("session", id, secret),
  };
}

function proof(capability: TestCapability): CapabilityProof {
  return { id: capability.id, secretDigest: capability.secretDigest };
}

function capabilityWrite(
  capability: TestCapability,
  raiseId: string,
  role: Role,
  contentKey: Uint8Array,
): CapabilityWrite {
  return {
    ...proof(capability),
    kind: capability.kind,
    role,
    contentKeyEnvelope: wrapContentKey({
      contentKey,
      capabilitySecret: capability.secret,
      context: {
        requestId: raiseId,
        capabilityId: capability.id,
        role,
        purpose: capability.kind,
      },
    }),
  };
}

function encryptedEntry(
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
      context: {
        requestId: raiseId,
        recordType: "entry",
        recordId: entryId,
        field: "body",
        authorRole,
      },
    }),
    ...(input.url
      ? {
          urlEnvelope: sealText({
            plaintext: input.url,
            contentKey,
            context: {
              requestId: raiseId,
              recordType: "entry",
              recordId: entryId,
              field: "url",
              authorRole,
            },
          }),
        }
      : {}),
    ...(input.decision
      ? {
          decisionEnvelope: sealText({
            plaintext: input.decision,
            contentKey,
            context: {
              requestId: raiseId,
              recordType: "entry",
              recordId: entryId,
              field: "decision",
              authorRole,
            },
          }),
        }
      : {}),
  };
}

function encryptedAttachment(
  raiseId: string,
  entryId: string,
  authorRole: Role,
  contentKey: Uint8Array,
  displayName: string,
): AttachmentWrite {
  return {
    id: `img_${entryId}`,
    blobKey: `ephemeral/v1/blob-${entryId}`,
    displayNameEnvelope: sealText({
      plaintext: displayName,
      contentKey,
      context: {
        requestId: raiseId,
        recordType: "attachment",
        recordId: `img_${entryId}`,
        field: "name",
        authorRole,
      },
    }),
    size: 123,
    width: 320,
    height: 640,
  };
}

function exchangeDigest(exchangeId: string): string {
  return createHash("sha256")
    .update("raise/claim-exchange/v1")
    .update("\0")
    .update(exchangeId)
    .digest("hex");
}

function exchangeInspection(
  raiseId: string,
  claim: TestCapability,
  expectedRole: Role,
  exchangeId?: string,
): ClaimInspectionCommand {
  return {
    raiseId,
    claim: proof(claim),
    mode: "token",
    expectedRole,
    ...(exchangeId ? { exchangeDigest: exchangeDigest(exchangeId) } : {}),
  };
}

function appendCommand(
  raise: TestRaise,
  session: ClaimSession,
  input: AppendInput,
): AppendEntryCommand {
  const transition: EntryTransition = {
    kind: input.kind,
    expectedVersion: input.expectedVersion,
    ...(input.decision ? { decision: input.decision } : {}),
  };
  return {
    raiseId: raise.raiseId,
    entryId: input.entryId,
    nextActionId: input.actionId,
    session: session.proof,
    transition,
    idempotency: input.idempotency ?? {
      keyDigest: digest(`append-key:${input.entryId}`),
      requestDigest: digest(
        JSON.stringify([
          input.kind,
          input.expectedVersion,
          input.body,
          input.url ?? null,
          input.decision ?? null,
          input.attachments?.map((attachment) => attachment.id) ?? [],
        ]),
      ),
    },
    content: encryptedEntry(raise.raiseId, input.entryId, input.role, raise.contentKey, {
      body: input.body,
      ...(input.url ? { url: input.url } : {}),
      ...(input.decision ? { decision: input.decision } : {}),
    }),
    attachments: input.attachments ?? [],
  };
}

export function defineRaiseStoreContract(
  adapterName: string,
  createFixture: () => Promise<RaiseStoreFixture>,
) {
  describe(`${adapterName} RaiseStore contract`, () => {
    let fixture: RaiseStoreFixture;

    beforeEach(async () => {
      fixture = await createFixture();
    });

    afterEach(async () => {
      await fixture.cleanup();
    });

    async function createHumanRaise(
      suffix = "one",
      options: { attachment?: boolean } = {},
    ): Promise<TestRaise> {
      const raiseId = `r_contract_${suffix}`;
      const entryId = `e_prompt_${suffix}`;
      const contentKey = generateContentKey();
      const ownerClaim = appCapability("claim");
      const targetClaim = appCapability("claim");
      const titleEnvelope = sealText({
        plaintext: "Mobile header cleanup",
        contentKey,
        context: {
          requestId: raiseId,
          recordType: "raise",
          recordId: raiseId,
          field: "title",
        },
      });
      const prompt = encryptedEntry(raiseId, entryId, "human", contentKey, {
        body: "Fix the clipped mobile header.",
        url: "https://example.test/mobile",
      });
      const attachments = options.attachment
        ? [encryptedAttachment(raiseId, entryId, "human", contentKey, "mobile-header.webp")]
        : [];

      await fixture.store.createRaise({
        raiseId,
        entryId,
        actionId: `a_prompt_${suffix}`,
        remainingHardTtlMs: RAISE_HARD_TTL_MS,
        origin: "human",
        titleEnvelope,
        prompt,
        attachments,
        ownerClaim: capabilityWrite(ownerClaim, raiseId, "human", contentKey),
        targetClaim: capabilityWrite(targetClaim, raiseId, "agent", contentKey),
      });

      return {
        raiseId,
        entryId,
        contentKey,
        ownerClaim,
        targetClaim,
        titleEnvelope,
        prompt,
        attachments,
      };
    }

    async function claimSession(
      raise: TestRaise,
      claim: TestCapability,
      role: Role,
      exchangeId?: string,
    ): Promise<ClaimSession> {
      const inspection = exchangeInspection(raise.raiseId, claim, role, exchangeId);
      const access = await fixture.store.inspectClaim(inspection);
      const capability = exchangeId ? appSessionForExchange(claim, exchangeId) : appSession();
      const session = capabilityWrite(capability, raise.raiseId, role, raise.contentKey);
      const committed = await fixture.store.commitClaimExchange({ ...inspection, session });

      expect(access).toMatchObject({
        raiseId: raise.raiseId,
        role,
        contentKeyEnvelope: expect.stringMatching(/^wk1\./),
      });
      expect(committed).toMatchObject({
        raiseId: raise.raiseId,
        role,
        sessionCapabilityId: capability.id,
        sessionSecretDigest: capability.secretDigest,
        contentKeyEnvelope: session.contentKeyEnvelope,
      });

      return {
        proof: proof(capability),
        contentKeyEnvelope: session.contentKeyEnvelope,
      };
    }

    it("stores separate role claims and returns only encrypted request content", async () => {
      const raise = await createHumanRaise();

      expect(raise.ownerClaim.id).not.toBe(raise.targetClaim.id);
      expect(raise.ownerClaim.secretDigest).not.toBe(raise.targetClaim.secretDigest);

      const ownerInspection = await fixture.store.inspectClaim(
        exchangeInspection(raise.raiseId, raise.ownerClaim, "human"),
      );
      const targetInspection = await fixture.store.inspectClaim(
        exchangeInspection(raise.raiseId, raise.targetClaim, "agent"),
      );
      expect(ownerInspection).toMatchObject({ raiseId: raise.raiseId, role: "human" });
      expect(targetInspection).toMatchObject({ raiseId: raise.raiseId, role: "agent" });
      expect(ownerInspection.contentKeyEnvelope).not.toBe(targetInspection.contentKeyEnvelope);
      await expect(
        fixture.store.inspectClaim(exchangeInspection(raise.raiseId, raise.ownerClaim, "agent")),
      ).rejects.toMatchObject({ code: "wrong_role" });

      const human = await claimSession(raise, raise.ownerClaim, "human");
      const agent = await claimSession(raise, raise.targetClaim, "agent");
      const humanView = await fixture.store.getRaise(raise.raiseId, human.proof);
      const agentView = await fixture.store.getRaise(raise.raiseId, agent.proof);

      expect(humanView).toMatchObject({
        id: raise.raiseId,
        role: "human",
        titleEnvelope: raise.titleEnvelope,
        origin: "human",
        lifecycle: "open",
        version: 1,
        waitingOn: "agent",
        pendingAction: "perform_work",
        contentKeyEnvelope: human.contentKeyEnvelope,
      });
      expect(humanView.permissions).toEqual({
        canReply: false,
        canPostResult: false,
        canReview: false,
        canComment: true,
      });
      expect(agentView).toMatchObject({
        role: "agent",
        contentKeyEnvelope: agent.contentKeyEnvelope,
      });
      expect(agentView.permissions.canPostResult).toBe(true);
      expect(humanView.entries).toEqual([
        expect.objectContaining({
          id: raise.entryId,
          authorRole: "human",
          kind: "prompt",
          ...raise.prompt,
          attachments: [],
        }),
      ]);

      const persistedView = JSON.stringify(humanView);
      expect(persistedView).not.toContain("Mobile header cleanup");
      expect(persistedView).not.toContain("Fix the clipped mobile header.");
      expect(persistedView).not.toContain("https://example.test/mobile");
    });

    it("returns stable snapshots and duplicate-free cursor deltas", async () => {
      const raise = await createHumanRaise("cursor");
      const agent = await claimSession(raise, raise.targetClaim, "agent");
      const initial = await fixture.store.getRaise(raise.raiseId, agent.proof);

      expect(initial).toMatchObject({
        version: 1,
        entriesMode: "snapshot",
        entries: [{ id: raise.entryId }],
      });
      expect(initial.cursor).toMatch(/^(0|[1-9]\d{0,19})-(0|[1-9]\d{0,19})$/);

      await fixture.store.appendEntry(
        appendCommand(raise, agent, {
          entryId: "e_cursor_result",
          actionId: "a_cursor_review",
          role: "agent",
          kind: "result",
          body: "Cursor result.",
          expectedVersion: 1,
        }),
      );

      const delta = await fixture.store.getRaise(raise.raiseId, agent.proof, {
        after: initial.cursor,
      });
      expect(delta).toMatchObject({
        version: 2,
        entriesMode: "delta",
        entries: [{ id: "e_cursor_result" }],
      });
      expect(delta.cursor).not.toBe(initial.cursor);

      await expect(
        fixture.store.getRaise(raise.raiseId, agent.proof, { after: delta.cursor }),
      ).resolves.toMatchObject({
        version: 2,
        cursor: delta.cursor,
        entriesMode: "delta",
        entries: [],
      });
      await expect(
        fixture.store.getRaise(raise.raiseId, agent.proof, { after: initial.cursor }),
      ).resolves.toMatchObject({
        cursor: delta.cursor,
        entriesMode: "delta",
        entries: [{ id: "e_cursor_result" }],
      });
    });

    it("replaces entries when a cursor falls outside retained history", async () => {
      const raise = await createHumanRaise("cursor-reset");
      const agent = await claimSession(raise, raise.targetClaim, "agent");

      await expect(
        fixture.store.getRaise(raise.raiseId, agent.proof, { after: "0-0" }),
      ).resolves.toMatchObject({
        version: 1,
        entriesMode: "snapshot",
        entries: [{ id: raise.entryId }],
      });
      await expect(
        fixture.store.getRaise(raise.raiseId, agent.proof, {
          after: "18446744073709551615-18446744073709551615",
        }),
      ).resolves.toMatchObject({
        version: 1,
        entriesMode: "snapshot",
        entries: [{ id: raise.entryId }],
      });
    });

    it("authenticates before rejecting a malformed cursor", async () => {
      const first = await createHumanRaise("cursor-auth-first");
      const second = await createHumanRaise("cursor-auth-second");
      const firstAgent = await claimSession(first, first.targetClaim, "agent");
      const secondAgent = await claimSession(second, second.targetClaim, "agent");

      await expect(
        fixture.store.getRaise(first.raiseId, secondAgent.proof, { after: "not-a-cursor" }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      await expect(
        fixture.store.getRaise(first.raiseId, firstAgent.proof, { after: "not-a-cursor" }),
      ).rejects.toThrow("cursor is invalid");
    });

    it("commits a claim once, replays the exact exchange, and rejects a different exchange", async () => {
      const raise = await createHumanRaise("claim-replay");
      const exchangeId = "claim-replay-id-0001";
      const inspection = exchangeInspection(raise.raiseId, raise.ownerClaim, "human", exchangeId);
      const inspected = await fixture.store.inspectClaim(inspection);
      expect(inspected.existingExchange).toBeUndefined();

      const winningCapability = appSessionForExchange(raise.ownerClaim, exchangeId);
      const winningSession = capabilityWrite(
        winningCapability,
        raise.raiseId,
        "human",
        raise.contentKey,
      );
      const command: CommitClaimExchangeCommand = { ...inspection, session: winningSession };
      const committed = await fixture.store.commitClaimExchange(command);
      expect(committed).toMatchObject({
        raiseId: raise.raiseId,
        role: "human",
        sessionCapabilityId: winningCapability.id,
        sessionSecretDigest: winningCapability.secretDigest,
        contentKeyEnvelope: winningSession.contentKeyEnvelope,
      });

      const replayedInspection = await fixture.store.inspectClaim(inspection);
      expect(replayedInspection).toMatchObject({
        raiseId: raise.raiseId,
        role: "human",
        existingExchange: {
          sessionCapabilityId: winningCapability.id,
          sessionSecretDigest: winningCapability.secretDigest,
        },
      });
      expect(replayedInspection).not.toHaveProperty("contentKeyEnvelope");

      const losingCapability = appSessionForExchange(raise.ownerClaim, exchangeId);
      const losingSession = capabilityWrite(
        losingCapability,
        raise.raiseId,
        "human",
        raise.contentKey,
      );
      await expect(
        fixture.store.commitClaimExchange({ ...inspection, session: losingSession }),
      ).resolves.toMatchObject({
        sessionCapabilityId: winningCapability.id,
        sessionSecretDigest: winningCapability.secretDigest,
        contentKeyEnvelope: winningSession.contentKeyEnvelope,
      });

      const differentExchange = exchangeInspection(
        raise.raiseId,
        raise.ownerClaim,
        "human",
        "claim-replay-id-0002",
      );
      await expect(fixture.store.inspectClaim(differentExchange)).rejects.toMatchObject({
        code: "invalid_capability",
      });
      await expect(
        fixture.store.commitClaimExchange({ ...differentExchange, session: losingSession }),
      ).rejects.toMatchObject({ code: "invalid_capability" });
      await expect(
        fixture.store.inspectClaim({ ...inspection, mode: "cookie" }),
      ).rejects.toMatchObject({ code: "invalid_capability" });
    });

    it("preserves encrypted turns through changes, a second result, and acceptance", async () => {
      const raise = await createHumanRaise("turns");
      const human = await claimSession(raise, raise.ownerClaim, "human");
      const agent = await claimSession(raise, raise.targetClaim, "agent");
      const turns = [
        appendCommand(raise, agent, {
          entryId: "e_result_one",
          actionId: "a_review_one",
          role: "agent",
          kind: "result",
          body: "Adjusted the grid.",
          expectedVersion: 1,
        }),
        appendCommand(raise, human, {
          entryId: "e_changes_one",
          actionId: "a_changes_one",
          role: "human",
          kind: "review_decision",
          decision: "request_changes",
          body: "Check 320 px too.",
          expectedVersion: 2,
        }),
        appendCommand(raise, agent, {
          entryId: "e_result_two",
          actionId: "a_review_two",
          role: "agent",
          kind: "result",
          body: "Checked 320 px.",
          expectedVersion: 3,
        }),
        appendCommand(raise, human, {
          entryId: "e_accept",
          actionId: "a_unused_after_accept",
          role: "human",
          kind: "review_decision",
          decision: "accept",
          body: "",
          expectedVersion: 4,
        }),
      ] as const;

      for (const turn of turns) {
        await fixture.store.appendEntry(turn);
      }

      const view = await fixture.store.getRaise(raise.raiseId, human.proof);
      expect(view).toMatchObject({
        lifecycle: "resolved",
        version: 5,
        waitingOn: null,
        pendingAction: null,
      });
      expect(view.permissions).toEqual({
        canReply: false,
        canPostResult: false,
        canReview: false,
        canComment: false,
      });
      expect(view.entries.map((entry) => entry.id)).toEqual([
        raise.entryId,
        "e_result_one",
        "e_changes_one",
        "e_result_two",
        "e_accept",
      ]);
      expect(view.entries.slice(1).map((entry) => entry.bodyEnvelope)).toEqual(
        turns.map((turn) => turn.content.bodyEnvelope),
      );
      expect(view.entries[2]?.decisionEnvelope).toBe(turns[1].content.decisionEnvelope);
      expect(view.entries[4]?.decisionEnvelope).toBe(turns[3].content.decisionEnvelope);

      const persistedView = JSON.stringify(view);
      for (const plaintext of [
        "Adjusted the grid.",
        "Check 320 px too.",
        "Checked 320 px.",
        "request_changes",
      ]) {
        expect(persistedView).not.toContain(plaintext);
      }
    });

    it("rejects wrong-role, stale, invalid, and cross-request credentials", async () => {
      const first = await createHumanRaise("first");
      const second = await createHumanRaise("second");
      await expect(
        fixture.store.inspectClaim({
          ...exchangeInspection(first.raiseId, first.ownerClaim, "human"),
          raiseId: second.raiseId,
        }),
      ).rejects.toMatchObject({ code: "invalid_capability" });
      const firstHuman = await claimSession(first, first.ownerClaim, "human");
      const firstAgent = await claimSession(first, first.targetClaim, "agent");
      const secondHuman = await claimSession(second, second.ownerClaim, "human");
      const wrongRole = appendCommand(first, firstHuman, {
        entryId: "e_wrong_role",
        actionId: "a_wrong_role",
        role: "human",
        kind: "result",
        body: "Should fail.",
        expectedVersion: 1,
      });

      await expect(fixture.store.preflightAppend(wrongRole)).rejects.toMatchObject({
        code: "not_your_turn",
      });
      await expect(fixture.store.appendEntry(wrongRole)).rejects.toMatchObject({
        code: "not_your_turn",
      });

      const winner = appendCommand(first, firstAgent, {
        entryId: "e_winner",
        actionId: "a_winner",
        role: "agent",
        kind: "result",
        body: "Winner.",
        expectedVersion: 1,
      });
      await fixture.store.appendEntry(winner);
      const stale = appendCommand(first, firstAgent, {
        entryId: "e_stale",
        actionId: "a_stale",
        role: "agent",
        kind: "result",
        body: "Stale.",
        expectedVersion: 1,
      });
      await expect(fixture.store.preflightAppend(stale)).rejects.toMatchObject({
        code: "state_conflict",
      });
      await expect(fixture.store.appendEntry(stale)).rejects.toMatchObject({
        code: "state_conflict",
      });
      await expect(fixture.store.getRaise(first.raiseId, secondHuman.proof)).rejects.toMatchObject({
        code: "unauthorized",
      });
      await expect(
        fixture.store.getRaise(first.raiseId, {
          id: firstHuman.proof.id,
          secretDigest: "0".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "unauthorized" });
    });

    it("authorizes attachments without exposing blob references in request metadata", async () => {
      const first = await createHumanRaise("attachment", { attachment: true });
      const second = await createHumanRaise("other-attachment", { attachment: true });
      const firstHuman = await claimSession(first, first.ownerClaim, "human");
      const secondHuman = await claimSession(second, second.ownerClaim, "human");
      const attachment = first.attachments[0] as AttachmentWrite;

      const view = await fixture.store.getRaise(first.raiseId, firstHuman.proof);
      expect(view.entries[0]?.attachments).toEqual([
        {
          id: attachment.id,
          displayNameEnvelope: attachment.displayNameEnvelope,
          width: attachment.width,
          height: attachment.height,
        },
      ]);
      expect(JSON.stringify(view.entries[0]?.attachments)).not.toContain(attachment.blobKey);
      expect(JSON.stringify(view.entries[0]?.attachments)).not.toContain("mobile-header.webp");

      await expect(
        fixture.store.getAttachment(first.raiseId, attachment.id, firstHuman.proof),
      ).resolves.toMatchObject({
        raiseId: first.raiseId,
        role: "human",
        contentKeyEnvelope: firstHuman.contentKeyEnvelope,
        blobKey: attachment.blobKey,
        authorRole: "human",
      });
      await expect(
        fixture.store.getAttachment(first.raiseId, attachment.id, secondHuman.proof),
      ).rejects.toMatchObject({ code: "unauthorized" });
      await expect(
        fixture.store.getAttachment(first.raiseId, "img_missing", firstHuman.proof),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("keeps preflight read-only and atomically rejects one of two competing commits", async () => {
      const raise = await createHumanRaise("race");
      const agent = await claimSession(raise, raise.targetClaim, "agent");
      const first = appendCommand(raise, agent, {
        entryId: "e_race_first",
        actionId: "a_race_first",
        role: "agent",
        kind: "result",
        body: "First candidate.",
        expectedVersion: 1,
      });
      const second = appendCommand(raise, agent, {
        entryId: "e_race_second",
        actionId: "a_race_second",
        role: "agent",
        kind: "result",
        body: "Second candidate.",
        expectedVersion: 1,
      });

      await expect(fixture.store.preflightAppend(first)).resolves.toMatchObject({
        status: "authorized",
        access: {
          raiseId: raise.raiseId,
          role: "agent",
          contentKeyEnvelope: agent.contentKeyEnvelope,
        },
      });
      await expect(fixture.store.preflightAppend(second)).resolves.toMatchObject({
        status: "authorized",
        access: {
          raiseId: raise.raiseId,
          role: "agent",
          contentKeyEnvelope: agent.contentKeyEnvelope,
        },
      });
      const before = await fixture.store.getRaise(raise.raiseId, agent.proof);
      expect(before).toMatchObject({ version: 1, waitingOn: "agent" });
      expect(before.entries).toHaveLength(1);

      const outcomes = await Promise.allSettled([
        fixture.store.appendEntry(first),
        fixture.store.appendEntry(second),
      ]);
      const committed = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      expect(committed).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ code: "state_conflict" });

      const after = await fixture.store.getRaise(raise.raiseId, agent.proof);
      expect(after).toMatchObject({
        version: 2,
        waitingOn: "human",
        pendingAction: "review_result",
      });
      expect(after.entries).toHaveLength(2);
      expect(["e_race_first", "e_race_second"]).toContain(after.entries[1]?.id);
    });

    it("replays one append receipt before stale-version checks and rejects key reuse", async () => {
      const raise = await createHumanRaise("idempotency");
      const human = await claimSession(raise, raise.ownerClaim, "human");
      const agent = await claimSession(raise, raise.targetClaim, "agent");
      const idempotency = {
        keyDigest: digest("shared-idempotency-key"),
        requestDigest: digest("shared-semantic-request"),
      };
      const first = appendCommand(raise, agent, {
        entryId: "e_idempotent_winner",
        actionId: "a_idempotent_winner",
        role: "agent",
        kind: "result",
        body: "The stable result.",
        expectedVersion: 1,
        idempotency,
      });
      const retry = appendCommand(raise, agent, {
        entryId: "e_idempotent_retry",
        actionId: "a_idempotent_retry",
        role: "agent",
        kind: "result",
        body: "The stable result.",
        expectedVersion: 1,
        idempotency,
      });

      const committed = await fixture.store.appendEntry(first);
      expect(committed).toMatchObject({
        status: "committed",
        receipt: { entryId: first.entryId, resultingVersion: 2 },
      });
      await expect(fixture.store.preflightAppend(retry)).resolves.toEqual({
        status: "replayed",
        receipt: committed.receipt,
      });
      await expect(fixture.store.appendEntry(retry)).resolves.toEqual({
        status: "replayed",
        receipt: committed.receipt,
      });

      const mismatched = {
        ...retry,
        idempotency: { ...idempotency, requestDigest: digest("different request") },
      };
      await expect(fixture.store.preflightAppend(mismatched)).rejects.toMatchObject({
        code: "idempotency_conflict",
      });
      await expect(fixture.store.appendEntry(mismatched)).rejects.toMatchObject({
        code: "idempotency_conflict",
      });

      const view = await fixture.store.getRaise(raise.raiseId, agent.proof);
      expect(view).toMatchObject({ version: 2 });
      expect(view.entries.map((entry) => entry.id)).toEqual([raise.entryId, "e_idempotent_winner"]);

      await fixture.store.appendEntry(
        appendCommand(raise, human, {
          entryId: "e_idempotent_later_accept",
          actionId: "a_idempotent_later_accept",
          role: "human",
          kind: "review_decision",
          body: "Looks good.",
          decision: "accept",
          expectedVersion: 2,
        }),
      );
      await expect(fixture.store.preflightAppend(retry)).resolves.toEqual({
        status: "replayed",
        receipt: committed.receipt,
      });
      await expect(fixture.store.appendEntry(retry)).resolves.toEqual({
        status: "replayed",
        receipt: committed.receipt,
      });
    });

    it("authenticates before receipt lookup and does not reserve rejected keys", async () => {
      const first = await createHumanRaise("idempotency-auth-first");
      const second = await createHumanRaise("idempotency-other");
      const firstAgent = await claimSession(first, first.targetClaim, "agent");
      const secondAgent = await claimSession(second, second.targetClaim, "agent");
      const idempotency = {
        keyDigest: digest("auth-first-key"),
        requestDigest: digest("auth-first-request"),
      };
      const winner = appendCommand(first, firstAgent, {
        entryId: "e_auth_first_winner",
        actionId: "a_auth_first_winner",
        role: "agent",
        kind: "result",
        body: "Winner.",
        expectedVersion: 1,
        idempotency,
      });
      await fixture.store.appendEntry(winner);

      await expect(
        fixture.store.preflightAppend({ ...winner, session: secondAgent.proof }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      await expect(
        fixture.store.appendEntry({ ...winner, session: secondAgent.proof }),
      ).rejects.toMatchObject({ code: "unauthorized" });

      const unusedIdempotency = {
        keyDigest: digest("rejected-key-can-be-reused"),
        requestDigest: digest("first rejected request"),
      };
      const rejected = appendCommand(second, secondAgent, {
        entryId: "e_rejected_stale",
        actionId: "a_rejected_stale",
        role: "agent",
        kind: "result",
        body: "Rejected.",
        expectedVersion: 99,
        idempotency: unusedIdempotency,
      });
      await expect(fixture.store.appendEntry(rejected)).rejects.toMatchObject({
        code: "state_conflict",
      });
      const corrected = appendCommand(second, secondAgent, {
        entryId: "e_corrected_after_rejection",
        actionId: "a_corrected_after_rejection",
        role: "agent",
        kind: "result",
        body: "Corrected.",
        expectedVersion: 1,
        idempotency: {
          keyDigest: unusedIdempotency.keyDigest,
          requestDigest: digest("corrected request"),
        },
      });
      await expect(fixture.store.appendEntry(corrected)).resolves.toMatchObject({
        status: "committed",
        receipt: { entryId: corrected.entryId, resultingVersion: 2 },
      });
    });

    it("commits one entry when identical idempotent appends race", async () => {
      const raise = await createHumanRaise("idempotency-race");
      const agent = await claimSession(raise, raise.targetClaim, "agent");
      const idempotency = {
        keyDigest: digest("concurrent-idempotency-key"),
        requestDigest: digest("concurrent-semantic-request"),
      };
      const first = appendCommand(raise, agent, {
        entryId: "e_idempotency_race_first",
        actionId: "a_idempotency_race_first",
        role: "agent",
        kind: "result",
        body: "Same semantic result.",
        expectedVersion: 1,
        idempotency,
      });
      const second = appendCommand(raise, agent, {
        entryId: "e_idempotency_race_second",
        actionId: "a_idempotency_race_second",
        role: "agent",
        kind: "result",
        body: "Same semantic result.",
        expectedVersion: 1,
        idempotency,
      });

      const outcomes = await Promise.all([
        fixture.store.appendEntry(first),
        fixture.store.appendEntry(second),
      ]);
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["committed", "replayed"]);
      expect(outcomes[0]?.receipt).toEqual(outcomes[1]?.receipt);
      const view = await fixture.store.getRaise(raise.raiseId, agent.proof);
      expect(view).toMatchObject({ version: 2 });
      expect(view.entries).toHaveLength(2);
    });
  });
}
