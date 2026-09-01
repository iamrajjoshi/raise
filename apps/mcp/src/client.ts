import { createHash } from "node:crypto";
import type {
  ClaimResponse,
  CreateRaiseInput,
  CreateRaiseResponse,
  PostEntryInput,
  RaiseView,
} from "@raise/protocol";

export interface StoredSession {
  server: string;
  raiseId: string;
  role: "human" | "agent";
  token: string;
  expiresAt: string;
}

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

export function claimTokenFromUrl(claimUrl: string, baseUrl: string) {
  let url: URL;
  try {
    url = new URL(claimUrl);
  } catch {
    throw new Error("Paste the full Raise link, including #token=…");
  }
  if (url.origin !== new URL(baseUrl).origin) {
    throw new Error(`That link belongs to ${url.origin}, not ${new URL(baseUrl).origin}.`);
  }
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  if (!token) throw new Error("That link is missing its claim token.");
  return token;
}

export class RaiseClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const parsed = new URL(baseUrl);
    const loopback =
      parsed.hostname === "localhost" ||
      parsed.hostname.endsWith(".localhost") ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]" ||
      /^127\./.test(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      throw new Error("RAISE_BASE_URL must use HTTPS unless it points to a loopback address.");
    }
    this.baseUrl = parsed.origin;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
      signal: init?.signal ?? AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;
      throw new RaiseApiError(
        response.status,
        payload?.code ?? "request_failed",
        payload?.message ?? `Raise returned HTTP ${response.status}.`,
      );
    }
    return response.json() as Promise<T>;
  }

  create(input: CreateRaiseInput) {
    return this.request<CreateRaiseResponse>("/api/raises", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async exchangeClaim(claimUrl: string) {
    const token = claimTokenFromUrl(claimUrl, this.baseUrl);
    const exchangeId = createHash("sha256")
      .update("raise-claim-exchange-v1\0")
      .update(token)
      .digest("base64url");
    const exchange = () =>
      this.request<ClaimResponse>("/api/claims", {
        method: "POST",
        body: JSON.stringify({ token, mode: "token", expectedRole: "agent", exchangeId }),
      });

    try {
      return await exchange();
    } catch (error) {
      if (error instanceof RaiseApiError && error.status < 500) throw error;
      return exchange();
    }
  }

  read(session: StoredSession, signal?: AbortSignal) {
    return this.request<RaiseView>(`/api/raises/${session.raiseId}`, {
      headers: { authorization: `Bearer ${session.token}` },
      ...(signal ? { signal } : {}),
    });
  }

  post(session: StoredSession, input: PostEntryInput) {
    return this.request<RaiseView>(`/api/raises/${session.raiseId}/entries`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
      body: JSON.stringify(input),
    });
  }

  async changed(session: StoredSession, afterVersion: number, signal?: AbortSignal) {
    const response = await this.fetcher(
      `${this.baseUrl}/api/raises/${session.raiseId}/changes?after=${afterVersion}`,
      {
        headers: { authorization: `Bearer ${session.token}` },
        signal: signal ?? AbortSignal.timeout(20_000),
      },
    );
    if (response.status === 204) return null;
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;
      throw new RaiseApiError(
        response.status,
        payload?.code ?? "request_failed",
        payload?.message ?? `Raise returned HTTP ${response.status}.`,
      );
    }
    return response.json() as Promise<RaiseView>;
  }

  async image(session: StoredSession, attachmentUrl: string, signal?: AbortSignal) {
    const url = new URL(attachmentUrl, this.baseUrl);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new Error(`Refusing to send a Raise session to ${url.origin}.`);
    }
    url.searchParams.set("preview", "mcp");
    const response = await this.fetcher(url, {
      headers: { authorization: `Bearer ${session.token}` },
      signal: signal ?? AbortSignal.timeout(20_000),
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
