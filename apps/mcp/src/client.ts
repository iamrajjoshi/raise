import {
  apiErrorSchema,
  changesQuerySchema,
  claimResponseSchema,
  createRaiseResponseSchema,
  idempotencyKeySchema,
  isLoopbackHostname,
  raiseIdSchema,
  raiseViewSchema,
  type ClaimResponse,
  type CreateRaiseInput,
  type CreateRaiseResponse,
  type PostEntryInput,
  type RaiseView,
} from "@raise/protocol";
import type { StoredSession } from "./session.js";

export type { StoredSession } from "./session.js";

const requestTimeoutMs = 20_000;
const longPollGraceMs = 5_000;

export class RaiseApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RaiseApiError";
  }
}

function claimLinkParts(claimUrl: string, baseUrl: string) {
  let url: URL;
  try {
    url = new URL(claimUrl);
  } catch {
    throw new Error("Paste the full Raise link, including #token=…");
  }
  const expectedOrigin = new URL(baseUrl).origin;
  if (url.origin !== expectedOrigin) {
    throw new Error(`That link belongs to ${url.origin}, not ${expectedOrigin}.`);
  }
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  if (!token) throw new Error("That link is missing its claim token.");
  const match = /^\/r\/([^/]+)\/?$/.exec(url.pathname);
  const raiseId = raiseIdSchema.safeParse(match?.[1]);
  if (!raiseId.success) throw new Error("That link is missing its request ID.");
  return { token, raiseId: raiseId.data };
}

export function claimTokenFromUrl(claimUrl: string, baseUrl: string) {
  return claimLinkParts(claimUrl, baseUrl).token;
}

async function apiError(response: Response): Promise<RaiseApiError> {
  const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null));
  const payload = parsed.success ? parsed.data : null;
  return new RaiseApiError(
    response.status,
    payload?.code ?? "request_failed",
    payload?.message ?? `Raise returned HTTP ${response.status}.`,
  );
}

export class RaiseClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))
    ) {
      throw new Error("RAISE_BASE_URL must use HTTPS unless it points to a loopback address.");
    }
    this.baseUrl = parsed.origin;
  }

  private async request<T>(
    path: string,
    schema: { parse(value: unknown): T },
    init?: RequestInit,
  ): Promise<T> {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      throw await apiError(response);
    }
    return schema.parse(await response.json());
  }

  create(input: CreateRaiseInput) {
    return this.request<CreateRaiseResponse>("/api/raises", createRaiseResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async exchangeClaim(claimUrl: string, exchangeId: string) {
    const { token, raiseId } = claimLinkParts(claimUrl, this.baseUrl);
    const exchange = () =>
      this.request<ClaimResponse>("/api/claims", claimResponseSchema, {
        method: "POST",
        body: JSON.stringify({
          raiseId,
          token,
          mode: "token",
          expectedRole: "agent",
          exchangeId,
        }),
      });

    try {
      return await exchange();
    } catch (error) {
      if (
        error instanceof RaiseApiError &&
        error.status !== 408 &&
        error.status !== 429 &&
        error.status < 500
      ) {
        throw error;
      }
      return exchange();
    }
  }

  read(session: StoredSession, signal?: AbortSignal) {
    return this.request<RaiseView>(`/api/raises/${session.raiseId}`, raiseViewSchema, {
      headers: { authorization: `Bearer ${session.token}` },
      ...(signal ? { signal } : {}),
    });
  }

  async post(session: StoredSession, input: PostEntryInput, idempotencyKey: string) {
    if (!idempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new Error("The mutation idempotency key is invalid.");
    }
    const send = () =>
      this.request<RaiseView>(`/api/raises/${session.raiseId}/entries`, raiseViewSchema, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(input),
      });

    try {
      return await send();
    } catch (error) {
      if (error instanceof RaiseApiError) throw error;
      return send();
    }
  }

  async changes(session: StoredSession, cursor: string, waitSeconds: number, signal?: AbortSignal) {
    const query = changesQuerySchema.parse({ cursor, wait: String(waitSeconds) });
    const params = new URLSearchParams({ cursor: query.cursor, wait: String(query.wait) });
    const response = await this.fetcher(
      `${this.baseUrl}/api/raises/${session.raiseId}/changes?${params}`,
      {
        headers: { authorization: `Bearer ${session.token}` },
        signal: signal ?? AbortSignal.timeout(query.wait * 1_000 + longPollGraceMs),
      },
    );
    if (response.status === 204) return null;
    if (!response.ok) {
      throw await apiError(response);
    }
    return raiseViewSchema.parse(await response.json());
  }

  async image(session: StoredSession, attachmentUrl: string, signal?: AbortSignal) {
    const url = new URL(attachmentUrl, this.baseUrl);
    if (url.origin !== this.baseUrl) {
      throw new Error(`Refusing to send a Raise session to ${url.origin}.`);
    }
    url.searchParams.set("preview", "mcp");
    const response = await this.fetcher(url, {
      headers: { authorization: `Bearer ${session.token}` },
      signal: signal ?? AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok)
      throw new RaiseApiError(response.status, "image_failed", "Couldn’t read the screenshot.");
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (!mimeType?.startsWith("image/")) {
      throw new RaiseApiError(
        response.status,
        "image_failed",
        "Raise returned a screenshot without an image content type.",
      );
    }
    return { data: Buffer.from(await response.arrayBuffer()), mimeType };
  }
}
