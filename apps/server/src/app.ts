import { createReadStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { claimSchema, createRaiseSchema, postEntrySchema, type ApiError } from "@raise/protocol";
import Fastify, { type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { RaiseDatabase } from "./database.js";
import { HttpError } from "./errors.js";
import { storeImages } from "./images.js";

export interface AppOptions {
  databasePath: string;
  dataDir: string;
  publicBaseUrl: string;
  logger?: boolean;
}

function bearerToken(request: FastifyRequest, raiseId: string): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return request.cookies[`raise_session_${raiseId}`];
}

export async function createApp(options: AppOptions) {
  await mkdir(options.dataDir, { recursive: true });
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 24_000_000 });
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

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));

  app.post("/api/raises", async (request, reply) => {
    const input = createRaiseSchema.parse(request.body);
    const created = db.createRaise(input, options.publicBaseUrl);
    await storeImages({
      db,
      dataDir: options.dataDir,
      raiseId: created.raiseId,
      entryId: created.entryId,
      images: input.attachments,
    });
    const { entryId: _entryId, ...response } = created;
    return reply.code(201).send(response);
  });

  app.post("/api/claims", async (request, reply) => {
    const input = claimSchema.parse(request.body);
    const claimed = db.exchangeClaim(input.token);
    if (input.mode === "cookie") {
      const secure = options.publicBaseUrl.startsWith("https://");
      reply.setCookie(`raise_session_${claimed.raiseId}`, claimed.sessionToken, {
        httpOnly: true,
        sameSite: "lax",
        secure,
        path: "/",
        expires: new Date(claimed.expiresAt),
      });
      return { raiseId: claimed.raiseId, role: claimed.role };
    }
    return { raiseId: claimed.raiseId, role: claimed.role, token: claimed.sessionToken };
  });

  app.get<{ Params: { raiseId: string } }>("/api/raises/:raiseId", async (request) => {
    const token = bearerToken(request, request.params.raiseId);
    if (!token) throw new HttpError(401, "unauthorized", "Open an access link for this request.");
    return db.getRaise(request.params.raiseId, token);
  });

  app.post<{ Params: { raiseId: string } }>(
    "/api/raises/:raiseId/entries",
    async (request, reply) => {
      const token = bearerToken(request, request.params.raiseId);
      if (!token) throw new HttpError(401, "unauthorized", "Open an access link for this request.");
      const input = postEntrySchema.parse(request.body);
      const result = db.postEntry(request.params.raiseId, token, input);
      await storeImages({
        db,
        dataDir: options.dataDir,
        raiseId: request.params.raiseId,
        entryId: result.entryId,
        images: input.attachments,
      });
      return reply.code(201).send(db.getRaise(request.params.raiseId, token));
    },
  );

  app.get<{ Params: { raiseId: string; attachmentId: string } }>(
    "/api/raises/:raiseId/attachments/:attachmentId",
    async (request, reply) => {
      const token = bearerToken(request, request.params.raiseId);
      if (!token)
        throw new HttpError(401, "unauthorized", "Open an access link for this screenshot.");
      const storageKey = db.getAttachment(
        request.params.raiseId,
        request.params.attachmentId,
        token,
      );
      return reply.type("image/webp").send(createReadStream(storageKey));
    },
  );

  app.get<{ Params: { raiseId: string }; Querystring: { after?: string } }>(
    "/api/raises/:raiseId/changes",
    async (request, reply) => {
      const token = bearerToken(request, request.params.raiseId);
      if (!token) throw new HttpError(401, "unauthorized", "Open an access link for this request.");
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

  app.setErrorHandler((error, _request, reply) => {
    const payload: ApiError =
      error instanceof ZodError
        ? {
            code: "invalid_request",
            message: "Check the request and try again.",
            details: error.issues,
          }
        : error instanceof HttpError
          ? {
              code: error.code,
              message: error.message,
              ...(error.details ? { details: error.details } : {}),
            }
          : { code: "internal_error", message: "Something went wrong. Try again." };
    const statusCode =
      error instanceof ZodError ? 400 : error instanceof HttpError ? error.statusCode : 500;
    if (statusCode === 500) app.log.error(error);
    return reply.code(statusCode).send(payload);
  });

  app.addHook("onClose", async () => db.close());
  return app;
}
