import { setTimeout as delay } from "node:timers/promises";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import type { PostEntryInput, RaiseView } from "@raise/protocol";
import * as z from "zod/v4";
import { claimTokenFromUrl, RaiseApiError, RaiseClient, type StoredSession } from "./client.js";
import { attachmentsFromPaths } from "./attachments.js";
import {
  pendingOpenDigest,
  PendingExchangeStore,
  PendingOpenStore,
  SessionStore,
} from "./store.js";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown, secrets: string[] = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function isTerminalClaimError(error: unknown) {
  return (
    error instanceof RaiseApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

async function clearTerminalClaimState(error: unknown, clearers: Array<() => Promise<void>>) {
  if (!isTerminalClaimError(error)) return;
  const results = await Promise.allSettled(clearers.map((clear) => clear()));
  if (results.some((item) => item.status === "rejected")) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Local pending retry state could not be cleared.`,
      { cause: error },
    );
  }
}

async function clearSavedClaimState(clearers: Array<() => Promise<void>>) {
  const results = await Promise.allSettled(clearers.map((clear) => clear()));
  return results.some((item) => item.status === "rejected")
    ? "The scoped session was saved, but local pending retry state could not be cleared."
    : undefined;
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

  const imageBudget = 6 * 1_024 * 1_024;
  let imageBytes = 0;
  let imageCount = 0;
  let imageBudgetExhausted = false;
  for (const entry of view.entries) {
    for (const attachment of entry.attachments) {
      if (imageCount >= 8 || imageBudgetExhausted || imageBytes >= imageBudget) {
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
      if (imageBytes + image.data.byteLength > imageBudget) {
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

function ownerSession(
  server: string,
  claim: {
    raiseId: string;
    role: "human" | "agent";
    token?: string;
    expiresAt?: string;
  },
) {
  if (!claim.token) throw new Error("Raise did not return an agent session token.");
  if (claim.role !== "agent") throw new Error("Raise did not return an agent-scoped session.");
  return {
    server: new URL(server).origin,
    raiseId: claim.raiseId,
    role: "agent",
    token: claim.token,
    expiresAt: claim.expiresAt ?? "9999-12-31T23:59:59.999Z",
  } satisfies StoredSession;
}

export function buildServer(options?: {
  client?: RaiseClient;
  store?: SessionStore;
  pendingExchanges?: PendingExchangeStore;
  pendingOpens?: PendingOpenStore;
  inboxToken?: string;
}) {
  const client =
    options?.client ?? new RaiseClient(process.env.RAISE_BASE_URL ?? "http://localhost:8787");
  const store = options?.store ?? new SessionStore();
  const pendingExchanges = options?.pendingExchanges ?? new PendingExchangeStore(store.directory);
  const pendingOpens = options?.pendingOpens ?? new PendingOpenStore(store.directory);
  const inboxToken = options?.inboxToken ?? process.env.RAISE_INBOX_TOKEN;
  const server = new McpServer(
    { name: "raise", version: "0.2.0-alpha.2" },
    {
      instructions:
        "Use raise_inbox to discover work from a fresh agent session. Use raise_open when you need a person to answer, inspect, or review something, and give them the returned humanUrl. Use raise_claim when a person pastes you an agent link. Read before replying, use raise_screenshot for any image omitted from the inline preview budget, and use raise_wait only for a bounded wait.",
    },
  );

  server.registerTool(
    "raise_open",
    {
      title: "Open a Raise request",
      description: "Open a request for a human and return the one-time link to send them.",
      inputSchema: z
        .object({
          prompt: z
            .string()
            .trim()
            .max(20_000)
            .default("")
            .describe("What the human needs to answer or review"),
          title: z.string().trim().min(1).max(180).optional(),
          url: z.url().max(2_048).optional().describe("A page the human should inspect"),
          screenshotPaths: z.array(z.string().min(1).max(4_096)).max(32).default([]),
          expiresInHours: z.number().int().min(1).max(168).default(24),
        })
        .refine((value) => Boolean(value.prompt || value.url || value.screenshotPaths.length), {
          message: "Add text, a URL, or at least one screenshot path.",
        }),
    },
    async ({ prompt, title, url, screenshotPaths, expiresInHours }) => {
      let ownerClaimToken: string | undefined;
      try {
        await store.assertWritable();
        const inputDigest = pendingOpenDigest({
          prompt,
          screenshotPaths,
          expiresInHours,
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
              expiresInHours,
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
          await clearTerminalClaimState(error, [
            () => pendingOpens.clear(inputDigest),
            () => pendingExchanges.clear(client.baseUrl, pendingClaimToken),
          ]);
          throw error;
        }
        if (claim.raiseId !== created.raiseId) {
          throw new Error("Raise returned a session for a different request.");
        }
        const session = ownerSession(client.baseUrl, claim);
        let expiryUnverified = false;
        if (!claim.expiresAt) {
          try {
            const view = await client.read(session);
            session.expiresAt = view.expiresAt;
          } catch {
            expiryUnverified = true;
          }
        }
        const persisted = await store.put(session);
        const cleanupWarning = persisted
          ? await clearSavedClaimState([
              () => pendingOpens.clear(inputDigest),
              () => pendingExchanges.clear(client.baseUrl, pendingClaimToken),
            ])
          : undefined;
        const warnings = [
          ...(!persisted
            ? ["Keep this MCP process running; its session could not be saved to disk."]
            : []),
          ...(expiryUnverified
            ? [
                "The older Raise server did not provide a session expiry, so it could not be verified.",
              ]
            : []),
          ...(cleanupWarning ? [cleanupWarning] : []),
        ];
        return result({
          raiseId: created.raiseId,
          humanUrl: created.targetClaimUrl,
          requestUrl: created.targetClaimUrl.split("#", 1)[0],
          expiresInHours,
          next: "Send humanUrl to the person whose answer or review you need.",
          sessionStorage: persisted ? "saved" : "memory_only",
          ...(warnings.length ? { warning: warnings.join(" ") } : {}),
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
        claimUrl: z.url().describe("The complete Raise URL, including its #token fragment"),
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
          await clearTerminalClaimState(error, [
            () => pendingExchanges.clear(client.baseUrl, pendingClaimToken),
          ]);
          throw error;
        }
        const session = ownerSession(client.baseUrl, claim);
        const view = await client.read(session);
        session.expiresAt = view.expiresAt;
        const persisted = await store.put(session);
        const cleanupWarning = persisted
          ? await clearSavedClaimState([
              () => pendingExchanges.clear(client.baseUrl, pendingClaimToken),
            ])
          : undefined;
        return await viewResult(client, session, view, includeImages, {
          sessionStorage: persisted ? "saved" : "memory_only",
          ...(!persisted
            ? { warning: "Keep this MCP process running; its session could not be saved to disk." }
            : cleanupWarning
              ? { warning: cleanupWarning }
              : {}),
        });
      } catch (error) {
        return failure(error, claimToken ? [claimToken] : []);
      }
    },
  );

  server.registerTool(
    "raise_inbox",
    {
      title: "List or open the Raise inbox",
      description:
        "List work available to this agent, or open one item and save its scoped session locally.",
      inputSchema: z.object({
        raiseId: z.string().trim().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        includeImages: z.boolean().default(true),
      }),
    },
    async ({ raiseId, limit, includeImages }) => {
      try {
        if (!inboxToken?.trim()) {
          throw new Error("RAISE_INBOX_TOKEN is required to list or open the agent inbox.");
        }
        if (!raiseId) return result(await client.listInbox(inboxToken, limit));

        await store.assertWritable();
        const claim = await client.openInbox(raiseId, inboxToken);
        if (claim.raiseId !== raiseId) {
          throw new Error("Raise returned a session for a different inbox item.");
        }
        const session = ownerSession(client.baseUrl, claim);
        let persisted = await store.put(session);
        const view = await client.read(session);
        if (session.expiresAt !== view.expiresAt) {
          session.expiresAt = view.expiresAt;
          persisted = (await store.put(session)) || persisted;
        }
        return await viewResult(client, session, view, includeImages, {
          sessionStorage: persisted ? "saved" : "memory_only",
          ...(!persisted
            ? { warning: "Keep this MCP process running; its session could not be saved to disk." }
            : {}),
        });
      } catch (error) {
        return failure(error, inboxToken ? [inboxToken] : []);
      }
    },
  );

  server.registerTool(
    "raise_read",
    {
      title: "Read a Raise request",
      description: "Read the current request, entries, permissions, and whose turn it is.",
      inputSchema: z.object({
        raiseId: z.string().min(1),
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
      description: "Send the work result currently requested from the agent.",
      inputSchema: z.object({
        raiseId: z.string().min(1),
        expectedVersion: z.number().int().min(1),
        body: z.string().trim().max(20_000).default(""),
        url: z.url().max(2_048).optional(),
        screenshotPaths: z.array(z.string().min(1).max(4_096)).max(32).default([]),
      }),
    },
    async ({ raiseId, expectedVersion, body, url, screenshotPaths }) => {
      try {
        const session = await store.get(client.baseUrl, raiseId);
        const current = await client.read(session);
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
        const attachments = await attachmentsFromPaths(screenshotPaths);
        if (!body && !url && !attachments.length)
          throw new Error("Add a reply, URL, or screenshot.");
        const updated = await client.post(session, {
          kind: "result",
          body,
          attachments,
          expectedVersion,
          ...(url ? { url } : {}),
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
        raiseId: z.string().min(1),
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
        const screenshot = await client.image(session, attachment.url, AbortSignal.timeout(5_000));
        if (screenshot.data.byteLength > 6 * 1_024 * 1_024) {
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
        raiseId: z.string().min(1),
        expectedVersion: z.number().int().min(1),
        body: z.string().trim().min(1).max(20_000),
        url: z.url().max(2_048).optional(),
      }),
    },
    async ({ raiseId, expectedVersion, body, url }) => {
      try {
        const session = await store.get(client.baseUrl, raiseId);
        const current = await client.read(session);
        if (current.version !== expectedVersion) {
          throw new Error(
            `Request is now at version ${current.version}. Read it again before updating.`,
          );
        }
        const entry: PostEntryInput = {
          kind: "comment",
          body,
          attachments: [],
          expectedVersion,
          ...(url ? { url } : {}),
        };
        return await viewResult(client, session, await client.post(session, entry), true);
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
        "Wait up to 30 seconds for a request version to change, then return its latest state.",
      inputSchema: z.object({
        raiseId: z.string().min(1),
        afterVersion: z.number().int().min(1).optional(),
        timeoutSeconds: z.number().int().min(1).max(30).default(20),
        includeImages: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ raiseId, afterVersion, timeoutSeconds, includeImages }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1_000);
      let initial: RaiseView | null = null;
      try {
        const session = await store.get(client.baseUrl, raiseId);
        initial = await client.read(session, controller.signal);
        const version = afterVersion ?? initial.version;
        if (initial.version < version) {
          throw new Error(
            `Request is at version ${initial.version}, so it cannot wait after version ${version}.`,
          );
        }
        if (initial.version > version) {
          clearTimeout(timer);
          return await viewResult(
            client,
            session,
            initial,
            includeImages,
            { changed: true },
            AbortSignal.timeout(5_000),
          );
        }

        const deadline = Date.now() + timeoutSeconds * 1_000;
        while (Date.now() < deadline) {
          const changed = await client.changed(session, version, controller.signal);
          if (changed) {
            clearTimeout(timer);
            return await viewResult(
              client,
              session,
              changed,
              includeImages,
              { changed: true },
              AbortSignal.timeout(5_000),
            );
          }
          await delay(Math.min(750, Math.max(0, deadline - Date.now())));
        }
        clearTimeout(timer);
        return await viewResult(
          client,
          session,
          initial,
          includeImages,
          { changed: false, waitedSeconds: timeoutSeconds },
          AbortSignal.timeout(5_000),
        );
      } catch (error) {
        if (controller.signal.aborted && initial) {
          return result({
            changed: false,
            waitedSeconds: timeoutSeconds,
            ...publicView(initial),
          });
        }
        return failure(error);
      } finally {
        clearTimeout(timer);
      }
    },
  );

  return server;
}
