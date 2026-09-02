import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import {
  attachmentBudgetMessage,
  claimSchema,
  createRaiseSchema,
  inboxQuerySchema,
  postEntrySchema,
  type ApiError,
} from "@raise/protocol";
import Fastify, { type FastifyRequest } from "fastify";
import { RaiseDatabase } from "./database.js";
import { HttpError } from "./errors.js";
import { prepareImages, renderAgentPreview, storeImages } from "./images.js";

export interface AppOptions {
  databasePath: string;
  dataDir: string;
  publicBaseUrl: string;
  logger?: boolean;
  bodyLimit?: number;
  inboxToken?: string;
}

function bearerToken(request: FastifyRequest, raiseId: string): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return request.cookies[`raise_session_${raiseId}`];
}

function authorizationBearer(request: FastifyRequest): string | undefined {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? "");
  return match?.[1];
}

function secretDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function secretMatches(value: string, expectedDigest: Buffer): boolean {
  return timingSafeEqual(secretDigest(value), expectedDigest);
}

function zodIssues(error: unknown): unknown[] | null {
  if (!(error instanceof Error) || error.name !== "ZodError" || !("issues" in error)) return null;
  const issues = error.issues;
  return Array.isArray(issues) ? issues : null;
}

function hasIssueMessage(issues: unknown[] | null, message: string): boolean {
  return Boolean(
    issues?.some(
      (issue) =>
        typeof issue === "object" &&
        issue !== null &&
        "message" in issue &&
        issue.message === message,
    ),
  );
}

function isBodyTooLarge(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE";
}

export async function createApp(options: AppOptions) {
  if (options.inboxToken !== undefined && options.inboxToken.length < 32) {
    throw new Error("RAISE_INBOX_TOKEN must be at least 32 characters when set.");
  }
  const inboxTokenDigest = options.inboxToken ? secretDigest(options.inboxToken) : undefined;
  await mkdir(options.dataDir, { recursive: true });
  const app = Fastify({
    logger: options.logger
      ? {
          redact: {
            paths: [
              "req.headers.authorization",
              "request.headers.authorization",
              "headers.authorization",
              "body.token",
              "body.exchangeId",
              "req.body.token",
              "req.body.exchangeId",
              "request.body.token",
              "request.body.exchangeId",
            ],
            censor: "[REDACTED]",
          },
        }
      : false,
    bodyLimit: options.bodyLimit ?? 24_000_000,
  });
  const db = new RaiseDatabase(options.databasePath);
  await app.register(cookie);

  app.addHook("onRequest", async (_request, reply) => {
    reply
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("X-Robots-Tag", "noindex, nofollow")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws://localhost:5173",
      );
  });

  app.setErrorHandler((error, _request, reply) => {
    const validationIssues = zodIssues(error);
    const imagesTooLarge = hasIssueMessage(validationIssues, attachmentBudgetMessage);
    const bodyTooLarge = isBodyTooLarge(error);
    const payload: ApiError = imagesTooLarge
      ? {
          code: "images_too_large",
          message: attachmentBudgetMessage,
        }
      : bodyTooLarge
        ? {
            code: "payload_too_large",
            message: "That request is too large to send. Trim the text or use smaller screenshots.",
          }
        : validationIssues
          ? {
              code: "invalid_request",
              message: "We couldn’t read that request. Check what you entered and try again.",
              details: validationIssues,
            }
          : error instanceof HttpError
            ? {
                code: error.code,
                message: error.message,
                ...(error.details ? { details: error.details } : {}),
              }
            : { code: "internal_error", message: "That didn’t work. Try again." };
    const statusCode =
      imagesTooLarge || bodyTooLarge
        ? 413
        : validationIssues
          ? 400
          : error instanceof HttpError
            ? error.statusCode
            : 500;
    if (statusCode === 500) app.log.error(error);
    return reply.code(statusCode).send(payload);
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));

  function authenticateInbox(request: FastifyRequest) {
    if (!inboxTokenDigest) {
      throw new HttpError(
        503,
        "inbox_disabled",
        "The agent inbox is not configured on this server.",
      );
    }
    const token = authorizationBearer(request);
    if (!token || !secretMatches(token, inboxTokenDigest)) {
      throw new HttpError(401, "unauthorized", "Agent inbox authentication failed.");
    }
  }

  app.get<{ Querystring: Record<string, unknown> }>("/api/inbox", async (request) => {
    authenticateInbox(request);
    const query = inboxQuerySchema.parse(request.query);
    return db.getInbox(query.limit);
  });

  app.post<{ Params: { raiseId: string } }>("/api/inbox/:raiseId/session", async (request) => {
    authenticateInbox(request);
    return db.createInboxSession(request.params.raiseId);
  });

  app.post("/api/raises", async (request, reply) => {
    const input = createRaiseSchema.parse(request.body);
    const images = await prepareImages(input.attachments);
    const created = db.createRaise(input, options.publicBaseUrl);
    await storeImages({
      db,
      dataDir: options.dataDir,
      raiseId: created.raiseId,
      entryId: created.entryId,
      images,
    });
    const { entryId: _entryId, ...response } = created;
    return reply.code(201).send(response);
  });

  app.post("/api/claims", async (request, reply) => {
    const input = claimSchema.parse(request.body);
    const claimed = db.exchangeClaim(input.token, input.mode, input.expectedRole, input.exchangeId);
    if (input.mode === "cookie") {
      const secure = options.publicBaseUrl.startsWith("https://");
      reply.setCookie(`raise_session_${claimed.raiseId}`, claimed.sessionToken, {
        httpOnly: true,
        sameSite: "lax",
        secure,
        path: "/",
        expires: new Date(claimed.expiresAt),
      });
      return { raiseId: claimed.raiseId, role: claimed.role, expiresAt: claimed.expiresAt };
    }
    return {
      raiseId: claimed.raiseId,
      role: claimed.role,
      token: claimed.sessionToken,
      expiresAt: claimed.expiresAt,
    };
  });

  app.get<{ Params: { raiseId: string } }>("/api/raises/:raiseId", async (request) => {
    const token = bearerToken(request, request.params.raiseId);
    if (!token)
      throw new HttpError(401, "unauthorized", "Open this request from its original access link.");
    return db.getRaise(request.params.raiseId, token);
  });

  app.post<{ Params: { raiseId: string } }>(
    "/api/raises/:raiseId/entries",
    async (request, reply) => {
      const token = bearerToken(request, request.params.raiseId);
      if (!token)
        throw new HttpError(
          401,
          "unauthorized",
          "Open this request from its original access link.",
        );
      const input = postEntrySchema.parse(request.body);
      db.assertCanPostEntry(request.params.raiseId, token, input);
      const images = await prepareImages(input.attachments);
      const result = db.postEntry(request.params.raiseId, token, input);
      await storeImages({
        db,
        dataDir: options.dataDir,
        raiseId: request.params.raiseId,
        entryId: result.entryId,
        images,
      });
      return reply.code(201).send(db.getRaise(request.params.raiseId, token));
    },
  );

  app.get<{
    Params: { raiseId: string; attachmentId: string };
    Querystring: { preview?: string };
  }>("/api/raises/:raiseId/attachments/:attachmentId", async (request, reply) => {
    const token = bearerToken(request, request.params.raiseId);
    if (!token)
      throw new HttpError(401, "unauthorized", "Open the request before viewing this screenshot.");
    const storageKey = db.getAttachment(request.params.raiseId, request.params.attachmentId, token);
    if (request.query.preview === "mcp") {
      return reply.type("image/webp").send(await renderAgentPreview(storageKey));
    }
    return reply.type("image/webp").send(createReadStream(storageKey));
  });

  app.get<{ Params: { raiseId: string }; Querystring: { after?: string } }>(
    "/api/raises/:raiseId/changes",
    async (request, reply) => {
      const token = bearerToken(request, request.params.raiseId);
      if (!token)
        throw new HttpError(
          401,
          "unauthorized",
          "Open this request from its original access link.",
        );
      const view = db.getRaise(request.params.raiseId, token);
      const after = Number(request.query.after ?? 0);
      if (view.version <= after) return reply.code(204).send();
      return view;
    },
  );

  const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ code: "not_found", message: "Route not found." });
      }
      return reply.sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => db.close());
  return app;
}
