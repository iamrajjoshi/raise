import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import {
  contentTextSchema,
  expectedVersionSchema,
  httpUrlSchema,
  maxAttachmentsPerEntry,
  raiseCursorSchema,
  raiseIdSchema,
  titleInputSchema,
  type ClaimResponse,
  type PostEntryInput,
  type RaiseView,
} from "@raise/protocol";
import * as z from "zod/v4";
import { claimTokenFromUrl, RaiseApiError, RaiseClient } from "./client.js";
import { attachmentsFromPaths } from "./attachments.js";
import type { StoredSession } from "./session.js";
import {
  pendingMutationDigest,
  pendingOpenDigest,
  PendingExchangeStore,
  PendingMutationStore,
  PendingOpenStore,
  SessionStore,
} from "./store.js";

const screenshotPathsSchema = z
  .array(z.string().min(1).max(4_096))
  .max(maxAttachmentsPerEntry)
  .default([]);
const mcpImageBudgetBytes = 6 * 1_024 * 1_024;
const maxInlineImages = 8;
const renderTimeoutMs = 5_000;
const unsavedSessionWarning =
  "Keep this MCP process running; its session could not be saved to disk.";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: unknown, secrets: string[] = []) {
  let message = errorMessage(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function isTerminalApiError(error: unknown) {
  return (
    error instanceof RaiseApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

async function pendingCleanupFailure(clearers: Array<() => Promise<void>>) {
  const results = await Promise.allSettled(clearers.map((clear) => clear()));
  return results.find((item): item is PromiseRejectedResult => item.status === "rejected");
}

async function clearPendingState(error: unknown, clearers: Array<() => Promise<void>>) {
  const cleanupFailure = await pendingCleanupFailure(clearers);
  if (cleanupFailure) {
    throw new Error(`${errorMessage(error)} Local pending retry state could not be cleared.`, {
      cause: cleanupFailure.reason,
    });
  }
}

async function clearTerminalPendingState(error: unknown, clearers: Array<() => Promise<void>>) {
  if (!isTerminalApiError(error)) return;
  await clearPendingState(error, clearers);
}

async function clearSavedClaimState(clearers: Array<() => Promise<void>>) {
  return (await pendingCleanupFailure(clearers))
    ? "The scoped session was saved, but local pending retry state could not be cleared."
    : undefined;
}

function sessionStorageDetails(persisted: boolean, cleanupWarning?: string) {
  const sessionStorage: "saved" | "memory_only" = persisted ? "saved" : "memory_only";
  if (!persisted) return { sessionStorage, warning: unsavedSessionWarning };
  if (cleanupWarning) return { sessionStorage, warning: cleanupWarning };
  return { sessionStorage };
}

function publicView(view: RaiseView) {
  return {
    id: view.id,
    title: view.title,
    lifecycle: view.lifecycle,
    viewerRole: view.viewerRole,
    waitingOn: view.waitingOn,
    pendingAction: view.pendingAction,
    version: view.version,
    cursor: view.cursor,
    entriesMode: view.entriesMode,
    expiresAt: view.expiresAt,
    permissions: view.permissions,
    entries: view.entries.map((entry) => ({
      ...entry,
      attachments: entry.attachments.map(({ url: _url, ...attachment }) => attachment),
    })),
  };
}

async function viewResult(
  client: RaiseClient,
  session: StoredSession,
  view: RaiseView,
  includeImages = true,
  extra?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const content: CallToolResult["content"] = [
    { type: "text", text: JSON.stringify({ ...extra, ...publicView(view) }, null, 2) },
  ];
  if (!includeImages) return { content };

  let imageBytes = 0;
  let imageCount = 0;
  let imageBudgetExhausted = false;
  for (const entry of view.entries) {
    for (const attachment of entry.attachments) {
      if (
        imageCount >= maxInlineImages ||
        imageBudgetExhausted ||
        imageBytes >= mcpImageBudgetBytes
      ) {
        content.push({
          type: "text",
          text: `Screenshot ${attachment.name} was not inlined. Use raise_screenshot with attachmentId ${attachment.id}.`,
        });
        continue;
      }
      const image = await client.image(session, attachment.url, signal);
      content.push({
        type: "text",
        text: `Screenshot: ${attachment.name} (${attachment.width} × ${attachment.height})`,
      });
      if (imageBytes + image.data.byteLength > mcpImageBudgetBytes) {
        imageBudgetExhausted = true;
        content.push({
          type: "text",
          text: `This screenshot falls outside the 6 MB MCP preview budget. Use raise_screenshot with attachmentId ${attachment.id}.`,
        });
      } else {
        imageBytes += image.data.byteLength;
        imageCount += 1;
        content.push({
          type: "image",
          data: image.data.toString("base64"),
          mimeType: image.mimeType,
        });
      }
    }
  }
  return { content };
}

function ownerSession(server: string, claim: ClaimResponse) {
  if (!claim.token) throw new Error("Raise did not return an agent session token.");
  if (claim.role !== "agent") throw new Error("Raise did not return an agent-scoped session.");
  return {
    server: new URL(server).origin,
    raiseId: claim.raiseId,
    role: "agent",
    token: claim.token,
    expiresAt: claim.expiresAt,
  } satisfies StoredSession;
}

export function buildServer(options?: {
  client?: RaiseClient;
  store?: SessionStore;
  pendingExchanges?: PendingExchangeStore;
  pendingMutations?: PendingMutationStore;
  pendingOpens?: PendingOpenStore;
}) {
  const client =
    options?.client ?? new RaiseClient(process.env.RAISE_BASE_URL ?? "http://localhost:8787");
  const store = options?.store ?? new SessionStore();
  const pendingExchanges = options?.pendingExchanges ?? new PendingExchangeStore(store.directory);
  const pendingMutations = options?.pendingMutations ?? new PendingMutationStore(store.directory);
  const pendingOpens = options?.pendingOpens ?? new PendingOpenStore(store.directory);

  async function postMutation(
    session: StoredSession,
    input: PostEntryInput,
    validateCurrent: (view: RaiseView) => void,
  ) {
    const inputDigest = pendingMutationDigest(input);
    const pending = await pendingMutations.getOrCreate(session, inputDigest, input.expectedVersion);
    const clear = () => pendingMutations.clear(session, inputDigest, pending.expectedVersion);

    if (!pending.resumed) {
      let current: RaiseView;
      try {
        current = await client.read(session);
      } catch (error) {
        await clearTerminalPendingState(error, [clear]);
        throw error;
      }
      try {
        validateCurrent(current);
      } catch (error) {
        await clearPendingState(error, [clear]);
        throw error;
      }
    }

    try {
      return await client.post(
        session,
        { ...input, expectedVersion: pending.expectedVersion },
        pending.idempotencyKey,
      );
    } catch (error) {
      await clearTerminalPendingState(error, [clear]);
      throw error;
    }
  }

  const server = new McpServer(
    { name: "raise", version: "0.2.0-alpha.2" },
    {
      instructions:
        "Use raise_open when you need a person to answer, inspect, or review something. Send them the returned humanUrl. When a person gives you an agent link, use raise_claim. Read before replying. Fetch omitted images with raise_screenshot, and use raise_wait only for a bounded wait.",
    },
  );

  server.registerTool(
    "raise_open",
    {
      title: "Open a Raise request",
      description: "Open a request for a human and return the one-time link to send them.",
      inputSchema: z
        .object({
          prompt: contentTextSchema
            .default("")
            .describe("What the human needs to answer or review"),
          title: titleInputSchema.optional(),
          url: httpUrlSchema.optional().describe("A page the human should inspect"),
          screenshotPaths: screenshotPathsSchema,
        })
        .refine((value) => Boolean(value.prompt || value.url || value.screenshotPaths.length), {
          message: "Add text, a URL, or at least one screenshot path.",
        }),
    },
    async ({ prompt, title, url, screenshotPaths }) => {
      let ownerClaimToken: string | undefined;
      try {
        await store.assertWritable();
        const inputDigest = pendingOpenDigest({
          prompt,
          screenshotPaths,
          ...(title ? { title } : {}),
          ...(url ? { url } : {}),
        });
        let created = await pendingOpens.get(inputDigest);
        if (!created) {
          const attachments = await attachmentsFromPaths(screenshotPaths);
          created = await pendingOpens.put(
            inputDigest,
            await client.create({
              origin: "agent",
              prompt,
              attachments,
              ...(title ? { title } : {}),
              ...(url ? { url } : {}),
            }),
          );
        }
        const pendingClaimToken = claimTokenFromUrl(created.ownerClaimUrl, client.baseUrl);
        ownerClaimToken = pendingClaimToken;
        const exchangeId = await pendingExchanges.getOrCreate(client.baseUrl, pendingClaimToken);
        let claim;
        try {
          claim = await client.exchangeClaim(created.ownerClaimUrl, exchangeId);
        } catch (error) {
          await clearTerminalPendingState(error, [
            () => pendingOpens.clear(inputDigest),
            () => pendingExchanges.clear(client.baseUrl, pendingClaimToken),
          ]);
          throw error;
        }
        if (claim.raiseId !== created.raiseId) {
          throw new Error("Raise returned a session for a different request.");
        }
        const session = ownerSession(client.baseUrl, claim);
        const persisted = await store.put(session);
        const cleanupWarning = persisted
          ? await clearSavedClaimState([
              () => pendingOpens.clear(inputDigest),
              () => pendingExchanges.clear(client.baseUrl, pendingClaimToken),
            ])
          : undefined;
        return result({
          raiseId: created.raiseId,
          humanUrl: created.targetClaimUrl,
          requestUrl: created.targetClaimUrl.split("#", 1)[0],
          next: "Send humanUrl to the person whose answer or review you need.",
          ...sessionStorageDetails(persisted, cleanupWarning),
        });
      } catch (error) {
        return failure(error, ownerClaimToken ? [ownerClaimToken] : []);
      }
    },
  );

  server.registerTool(
    "raise_claim",
    {
      title: "Open a shared Raise link",
      description: "Claim a full agent link pasted by a human and save its session locally.",
      inputSchema: z.object({
        claimUrl: httpUrlSchema.describe("The complete Raise URL, including its #token fragment"),
        includeImages: z.boolean().default(true),
      }),
    },
    async ({ claimUrl, includeImages }) => {
      let claimToken: string | undefined;
      try {
        await store.assertWritable();
        const pendingClaimToken = claimTokenFromUrl(claimUrl, client.baseUrl);
        claimToken = pendingClaimToken;
        const exchangeId = await pendingExchanges.getOrCreate(client.baseUrl, pendingClaimToken);
        let claim;
        try {
          claim = await client.exchangeClaim(claimUrl, exchangeId);
        } catch (error) {
          await clearTerminalPendingState(error, [
            () => pendingExchanges.clear(client.baseUrl, pendingClaimToken),
          ]);
          throw error;
        }
        const session = ownerSession(client.baseUrl, claim);
        const view = await client.read(session);
        const persisted = await store.put(session);
        const cleanupWarning = persisted
          ? await clearSavedClaimState([
              () => pendingExchanges.clear(client.baseUrl, pendingClaimToken),
            ])
          : undefined;
        return await viewResult(client, session, view, includeImages, {
          ...sessionStorageDetails(persisted, cleanupWarning),
        });
      } catch (error) {
        return failure(error, claimToken ? [claimToken] : []);
      }
    },
  );

  server.registerTool(
    "raise_read",
    {
      title: "Read a Raise request",
      description: "Read the current request, entries, permissions, and whose turn it is.",
      inputSchema: z.object({
        raiseId: raiseIdSchema,
        includeImages: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ raiseId, includeImages }) => {
      try {
        const session = await store.get(client.baseUrl, raiseId);
        return await viewResult(client, session, await client.read(session), includeImages);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "raise_reply",
    {
      title: "Reply to a Raise request",
      description: "Send the result the request is waiting for.",
      inputSchema: z.object({
        raiseId: raiseIdSchema,
        expectedVersion: expectedVersionSchema,
        body: contentTextSchema.default(""),
        url: httpUrlSchema.optional(),
        screenshotPaths: screenshotPathsSchema,
      }),
    },
    async ({ raiseId, expectedVersion, body, url, screenshotPaths }) => {
      try {
        const session = await store.get(client.baseUrl, raiseId);
        const attachments = await attachmentsFromPaths(screenshotPaths);
        if (!body && !url && !attachments.length)
          throw new Error("Add a reply, URL, or screenshot.");
        const input: PostEntryInput = {
          kind: "result",
          body,
          attachments,
          expectedVersion,
          ...(url ? { url } : {}),
        };
        const updated = await postMutation(session, input, (current) => {
          if (current.version !== expectedVersion) {
            throw new Error(
              `Request is now at version ${current.version}. Read it again before replying.`,
            );
          }
          if (!current.permissions.canPostResult) {
            throw new Error(
              `The agent cannot post a result while the request is waiting on ${current.waitingOn ?? "nobody"}.`,
            );
          }
        });
        return await viewResult(client, session, updated, true);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "raise_screenshot",
    {
      title: "Read one Raise screenshot",
      description:
        "Return one authenticated screenshot by attachment ID when it was not inlined by read or wait.",
      inputSchema: z.object({
        raiseId: raiseIdSchema,
        attachmentId: z.string().min(1),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ raiseId, attachmentId }) => {
      try {
        const session = await store.get(client.baseUrl, raiseId);
        const view = await client.read(session);
        const attachment = view.entries
          .flatMap((entry) => entry.attachments)
          .find((item) => item.id === attachmentId);
        if (!attachment) throw new Error(`No screenshot ${attachmentId} exists on ${raiseId}.`);
        const screenshot = await client.image(
          session,
          attachment.url,
          AbortSignal.timeout(renderTimeoutMs),
        );
        if (screenshot.data.byteLength > mcpImageBudgetBytes) {
          throw new Error("The agent preview is still too large for one MCP response.");
        }
        return {
          content: [
            {
              type: "text",
              text: `${attachment.name} (${attachment.width} × ${attachment.height})`,
            },
            {
              type: "image",
              data: screenshot.data.toString("base64"),
              mimeType: screenshot.mimeType,
            },
          ],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "raise_update",
    {
      title: "Update a Raise request",
      description: "Add a side note without advancing the request to its next turn.",
      inputSchema: z.object({
        raiseId: raiseIdSchema,
        expectedVersion: expectedVersionSchema,
        body: contentTextSchema.min(1),
        url: httpUrlSchema.optional(),
      }),
    },
    async ({ raiseId, expectedVersion, body, url }) => {
      try {
        const session = await store.get(client.baseUrl, raiseId);
        const entry: PostEntryInput = {
          kind: "comment",
          body,
          attachments: [],
          expectedVersion,
          ...(url ? { url } : {}),
        };
        const updated = await postMutation(session, entry, (current) => {
          if (current.version !== expectedVersion) {
            throw new Error(
              `Request is now at version ${current.version}. Read it again before updating.`,
            );
          }
        });
        return await viewResult(client, session, updated, true);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "raise_wait",
    {
      title: "Wait for a Raise reply",
      description:
        "Wait up to 30 seconds for new entries. Pass the cursor from the latest Raise response when possible.",
      inputSchema: z
        .object({
          raiseId: raiseIdSchema,
          cursor: raiseCursorSchema.optional(),
          afterVersion: z.number().int().min(1).optional(),
          timeoutSeconds: z.number().int().min(1).max(30).default(20),
          includeImages: z.boolean().default(true),
        })
        .refine((value) => !(value.cursor && value.afterVersion !== undefined), {
          message: "Pass cursor or afterVersion, not both.",
        }),
      annotations: { readOnlyHint: true },
    },
    async ({ raiseId, cursor, afterVersion, timeoutSeconds, includeImages }) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("Raise did not finish the bounded wait.")),
        timeoutSeconds * 1_000 + 5_000,
      );
      let initial: RaiseView | null = null;
      try {
        const session = await store.get(client.baseUrl, raiseId);
        let waitCursor = cursor;
        if (!waitCursor) {
          initial = await client.read(session, controller.signal);
          if (afterVersion !== undefined) {
            if (initial.version < afterVersion) {
              throw new Error(
                `Request is at version ${initial.version}, so it cannot wait after version ${afterVersion}.`,
              );
            }
            if (initial.version > afterVersion) {
              return await viewResult(
                client,
                session,
                initial,
                includeImages,
                { changed: true },
                AbortSignal.timeout(renderTimeoutMs),
              );
            }
          }
          waitCursor = initial.cursor;
        }

        const changed = await client.changes(
          session,
          waitCursor,
          timeoutSeconds,
          controller.signal,
        );
        if (changed) {
          return await viewResult(
            client,
            session,
            changed,
            includeImages,
            { changed: true },
            AbortSignal.timeout(renderTimeoutMs),
          );
        }

        if (initial) {
          return await viewResult(client, session, initial, false, {
            changed: false,
            waitedSeconds: timeoutSeconds,
          });
        }
        return result({
          changed: false,
          waitedSeconds: timeoutSeconds,
          cursor: waitCursor,
          entriesMode: "delta",
          entries: [],
        });
      } catch (error) {
        return failure(error);
      } finally {
        clearTimeout(timer);
      }
    },
  );

  return server;
}
