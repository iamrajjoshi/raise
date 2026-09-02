import type {
  AttachmentInput,
  ClaimResponse,
  CreateRaiseInput,
  CreateRaiseResponse,
  PostEntryInput,
  RaiseView,
} from "@raise/protocol";

export class RequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "RequestError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      code?: string;
      message?: string;
    } | null;
    throw new RequestError(
      payload?.code ?? "request_failed",
      payload?.message ?? "That didn’t work. Try again.",
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

export function createRaise(input: CreateRaiseInput) {
  return request<CreateRaiseResponse>("/api/raises", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

const pendingClaimExchanges = new Map<string, string>();
const exchangeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function claimExchangeStorageKey(token: string) {
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `raise.claim-exchange.${key}`;
}

function readStoredExchangeId(key: string) {
  try {
    const value = window.localStorage.getItem(key);
    return value && exchangeIdPattern.test(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredExchangeId(key: string, exchangeId: string) {
  try {
    window.localStorage.setItem(key, exchangeId);
  } catch {
    // The in-memory copy still makes retries safe while this page stays open.
  }
}

function clearStoredExchangeId(key: string) {
  pendingClaimExchanges.delete(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage may be blocked; there is nothing else to clear.
  }
}

async function pendingExchangeFor(token: string) {
  const key = await claimExchangeStorageKey(token);
  const existing = pendingClaimExchanges.get(key) ?? readStoredExchangeId(key);
  if (existing) {
    pendingClaimExchanges.set(key, existing);
    return { key, exchangeId: existing };
  }

  const exchangeId = window.crypto.randomUUID();
  pendingClaimExchanges.set(key, exchangeId);
  writeStoredExchangeId(key, exchangeId);
  return { key, exchangeId };
}

export async function claimRaise(token: string) {
  const { key, exchangeId } = await pendingExchangeFor(token);
  const exchange = () =>
    request<ClaimResponse>("/api/claims", {
      method: "POST",
      body: JSON.stringify({ token, mode: "cookie", expectedRole: "human", exchangeId }),
    });

  try {
    let result: ClaimResponse;
    try {
      result = await exchange();
    } catch (error) {
      if (error instanceof RequestError && error.status < 500) throw error;
      result = await exchange();
    }
    clearStoredExchangeId(key);
    return result;
  } catch (error) {
    if (
      error instanceof RequestError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429
    ) {
      clearStoredExchangeId(key);
    }
    throw error;
  }
}

export function getRaise(raiseId: string) {
  return request<RaiseView>(`/api/raises/${raiseId}`);
}

export function postEntry(raiseId: string, input: PostEntryInput) {
  return request<RaiseView>(`/api/raises/${raiseId}/entries`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function imageFiles(files: File[]): Promise<AttachmentInput[]> {
  const accepted = files.filter((file) =>
    ["image/png", "image/jpeg", "image/webp"].includes(file.type),
  );
  return Promise.all(
    accepted.map(
      (file) =>
        new Promise<AttachmentInput>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () =>
            reject(
              new RequestError(
                "file_read_failed",
                `Couldn’t add ${file.name}. Try that file again.`,
              ),
            );
          reader.onload = () =>
            resolve({
              name: file.name,
              mimeType: file.type as AttachmentInput["mimeType"],
              dataUrl: String(reader.result),
            });
          reader.readAsDataURL(file);
        }),
    ),
  );
}

export function claimTokenFromHash(): string | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get("token");
}
