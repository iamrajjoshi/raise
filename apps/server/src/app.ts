import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import {
  attachmentBudgetMessage,
  attachmentPreviewSchema,
  claimSchema,
  changesQuerySchema,
  createRaiseSchema,
  idempotencyKeySchema,
  postEntrySchema,
  type ApiError,
} from "@raise/protocol";
import Fastify, { type FastifyRequest } from "fastify";
import { ChangeWaiter } from "./change-waiter.js";
import { HttpError } from "./errors.js";
import { renderAgentPreview } from "./images.js";
import { RaiseService } from "./raise-service.js";
import type { BlobStore, RaiseStore } from "./storage.js";

export interface AppOptions {
  publicBaseUrl: string;
  logger?: boolean;
  bodyLimit?: number;
}

export interface AppDependencies {
  raises: RaiseStore;
  blobs: BlobStore;
  changes?: ChangeWaiter;
}

function bearerToken(request: FastifyRequest, raiseId: string): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return request.cookies[`raise_session_${raiseId}`];
}

interface ValidationIssue {
  message: string;
}

function isValidationIssue(value: unknown): value is ValidationIssue {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function isValidationIssueArray(value: unknown): value is ValidationIssue[] {
  return Array.isArray(value) && value.every((issue: unknown) => isValidationIssue(issue));
}

function zodIssues(error: unknown): ValidationIssue[] | null {
  if (!(error instanceof Error) || error.name !== "ZodError" || !("issues" in error)) return null;
  return isValidationIssueArray(error.issues) ? error.issues : null;
}

function hasIssueMessage(issues: ValidationIssue[] | null, message: string): boolean {
  return Boolean(issues?.some((issue) => issue.message === message));
}

function isBodyTooLarge(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE";
}

function errorResponse(error: unknown): { payload: ApiError; statusCode: number } {
  const validationIssues = zodIssues(error);
  if (hasIssueMessage(validationIssues, attachmentBudgetMessage)) {
    return {
      payload: { code: "images_too_large", message: attachmentBudgetMessage },
      statusCode: 413,
    };
  }
  if (isBodyTooLarge(error)) {
    return {
      payload: {
        code: "payload_too_large",
        message: "That request is too large to send. Trim the text or use smaller screenshots.",
      },
      statusCode: 413,
    };
  }
  if (validationIssues) {
    return {
      payload: {
        code: "invalid_request",
        message: "We couldn’t read that request. Check what you entered and try again.",
        details: validationIssues,
      },
      statusCode: 400,
    };
  }
  if (error instanceof HttpError) {
    return {
      payload: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      statusCode: error.statusCode,
    };
  }
  return {
    payload: { code: "internal_error", message: "That didn’t work. Try again." },
    statusCode: 500,
  };
}

export async function createApp(options: AppOptions, dependencies: AppDependencies) {
  const app = Fastify({
    logger: options.logger
      ? {
          redact: {
            paths: [
              "req.headers.authorization",
              "request.headers.authorization",
              "headers.authorization",
              "req.headers.idempotency-key",
              "request.headers.idempotency-key",
              "headers.idempotency-key",
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
  const service = new RaiseService(
    dependencies.raises,
    dependencies.blobs,
    () => options.publicBaseUrl,
  );
  const changes = dependencies.changes ?? new ChangeWaiter();
  await app.register(cookie);

  app.addHook("onRequest", async (_request, reply) => {
    reply
      .header("Cache-Control", "private, no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("X-Robots-Tag", "noindex, nofollow")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
      );
  });

  app.setErrorHandler((error, _request, reply) => {
    const { payload, statusCode } = errorResponse(error);
    if (statusCode === 500) app.log.error(error);
    return reply.code(statusCode).send(payload);
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));

  app.post("/api/raises", async (request, reply) => {
    const input = createRaiseSchema.parse(request.body);
    return reply.code(201).send(await service.createRaise(input));
  });

  app.post("/api/claims", async (request, reply) => {
    const input = claimSchema.parse(request.body);
    const claimed = await service.exchangeClaim(
      input.raiseId,
      input.token,
      input.mode,
      input.expectedRole,
      input.exchangeId,
    );
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
    return service.getRaise(request.params.raiseId, token);
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
      const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
      const view = await service.postEntry(request.params.raiseId, token, input, idempotencyKey);
      changes.notify(request.params.raiseId, view.version);
      return reply.code(201).send(view);
    },
  );

  app.get<{
    Params: { raiseId: string; attachmentId: string };
    Querystring: { preview?: string };
  }>("/api/raises/:raiseId/attachments/:attachmentId", async (request, reply) => {
    const preview = attachmentPreviewSchema.parse(request.query.preview);
    const token = bearerToken(request, request.params.raiseId);
    if (!token)
      throw new HttpError(401, "unauthorized", "Open the request before viewing this screenshot.");
    const attachment = await service.getAttachment(
      request.params.raiseId,
      request.params.attachmentId,
      token,
    );
    if (preview === "mcp") {
      return reply.type(attachment.mediaType).send(await renderAgentPreview(attachment.bytes));
    }
    return reply.type(attachment.mediaType).send(attachment.bytes);
  });

  app.get<{
    Params: { raiseId: string };
    Querystring: { cursor?: string; wait?: string };
  }>("/api/raises/:raiseId/changes", async (request, reply) => {
    const token = bearerToken(request, request.params.raiseId);
    if (!token)
      throw new HttpError(401, "unauthorized", "Open this request from its original access link.");
    const query = changesQuerySchema.parse(request.query);
    const readChanges = () => service.getRaise(request.params.raiseId, token, query.cursor);
    const hasEntries = (view: Awaited<ReturnType<typeof readChanges>>) =>
      view.entriesMode === "snapshot" || view.entries.length > 0;

    const initial = await readChanges();
    if (hasEntries(initial)) return initial;
    if (query.wait === 0) return reply.code(204).send();

    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    try {
      const waiting = changes.wait(
        request.params.raiseId,
        initial.version,
        query.wait * 1_000,
        controller.signal,
      );

      // Register before this read so a write cannot slip between the read and wait.
      const rechecked = await readChanges();
      if (hasEntries(rechecked)) {
        changes.notify(request.params.raiseId, rechecked.version);
        return rechecked;
      }

      const outcome = await waiting;
      if (outcome.reason === "aborted") return reply.code(204).send();

      // A wake is only a hint. Reauthenticate and read authoritative state even on timeout.
      const final = await readChanges();
      return hasEntries(final) ? final : reply.code(204).send();
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
      controller.abort();
    }
  });

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

  app.addHook("preClose", async () => changes.close());
  app.addHook("onClose", async () => service.close());
  return app;
}
