import {
  apiErrorSchema,
  attachmentMimeTypeSchema,
  changesQuerySchema,
  claimResponseSchema,
  createRaiseResponseSchema,
  idempotencyKeySchema,
  postEntrySchema,
  raiseViewSchema,
  type AttachmentInput,
  type ClaimResponse,
  type CreateRaiseInput,
  type CreateRaiseResponse,
  type PostEntryInput,
  type RaiseView,
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

async function responseError(response: Response): Promise<RequestError> {
  const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null));
  const payload = parsed.success ? parsed.data : null;
  return new RequestError(
    payload?.code ?? "request_failed",
    payload?.message ?? "That didn’t work. Try again.",
    response.status,
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function request<T>(
  path: string,
  schema: { parse(value: unknown): T },
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  return schema.parse(await response.json());
}

export function createRaise(input: CreateRaiseInput) {
  return request<CreateRaiseResponse>("/api/raises", createRaiseResponseSchema, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

const pendingClaimExchanges = new Map<string, string>();
const exchangeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function claimExchangeStorageKey(token: string) {
  return `raise.claim-exchange.${await sha256Hex(token)}`;
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

export async function claimRaise(raiseId: string, token: string) {
  const { key, exchangeId } = await pendingExchangeFor(token);
  const exchange = () =>
    request<ClaimResponse>("/api/claims", claimResponseSchema, {
      method: "POST",
      body: JSON.stringify({ raiseId, token, mode: "cookie", expectedRole: "human", exchangeId }),
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
  return request<RaiseView>(`/api/raises/${raiseId}`, raiseViewSchema);
}

export async function getRaiseChanges(
  raiseId: string,
  cursor: string,
  waitSeconds = 20,
  signal?: AbortSignal,
): Promise<RaiseView | null> {
  const query = changesQuerySchema.parse({ cursor, wait: String(waitSeconds) });
  const params = new URLSearchParams({
    cursor: query.cursor,
    wait: String(query.wait),
  });
  const timeout = AbortSignal.timeout(query.wait * 1_000 + 5_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`/api/raises/${raiseId}/changes?${params}`, {
    headers: { "Content-Type": "application/json" },
    signal: requestSignal,
  });
  if (response.status === 204) return null;
  if (!response.ok) {
    throw await responseError(response);
  }
  return raiseViewSchema.parse(await response.json());
}

interface EntryRetryRecord {
  digest: string;
  key: string;
  timestamp: number;
}

const pendingEntryRequests = new Map<string, EntryRetryRecord>();
const entryRetryStoragePrefix = "raise.entry-retry.v1.";
const entryRetryTtlMs = 7 * 60 * 60 * 1_000;

function parseEntryRetryRecord(value: string): EntryRetryRecord | null {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("digest" in parsed) ||
    typeof parsed.digest !== "string" ||
    !("key" in parsed) ||
    typeof parsed.key !== "string" ||
    !("timestamp" in parsed) ||
    typeof parsed.timestamp !== "number"
  ) {
    return null;
  }
  return { digest: parsed.digest, key: parsed.key, timestamp: parsed.timestamp };
}

function normalizedEntry(input: PostEntryInput): PostEntryInput {
  const parsed = postEntrySchema.parse(input);
  return {
    kind: parsed.kind,
    body: parsed.body,
    ...(parsed.url ? { url: parsed.url } : {}),
    ...(parsed.decision ? { decision: parsed.decision } : {}),
    attachments: parsed.attachments.map(({ name, mimeType, dataUrl }) => ({
      name,
      mimeType,
      dataUrl,
    })),
    expectedVersion: parsed.expectedVersion,
  };
}

async function entryDigest(raiseId: string, input: PostEntryInput) {
  const canonicalInput = JSON.stringify([
    raiseId,
    input.kind,
    input.body,
    input.url ?? null,
    input.decision ?? null,
    input.expectedVersion,
    input.attachments.map(({ name, mimeType, dataUrl }) => [name, mimeType, dataUrl]),
  ]);
  return sha256Hex(canonicalInput);
}

function retryRecordIsCurrent(record: EntryRetryRecord, digest: string, now: number) {
  return (
    record.digest === digest &&
    idempotencyKeySchema.safeParse(record.key).success &&
    Number.isFinite(record.timestamp) &&
    record.timestamp <= now &&
    now - record.timestamp < entryRetryTtlMs
  );
}

function entryRetryStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function pruneEntryRetries(now: number) {
  for (const [digest, record] of pendingEntryRequests) {
    if (!retryRecordIsCurrent(record, digest, now)) pendingEntryRequests.delete(digest);
  }

  const storage = entryRetryStorage();
  if (!storage) return;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => Boolean(key?.startsWith(entryRetryStoragePrefix)),
    );
    for (const key of keys) {
      const digest = key.slice(entryRetryStoragePrefix.length);
      try {
        const value = storage.getItem(key);
        const record = value ? parseEntryRetryRecord(value) : null;
        if (!record || !retryRecordIsCurrent(record, digest, now)) storage.removeItem(key);
      } catch {
        storage.removeItem(key);
      }
    }
  } catch {
    // Storage may become unavailable between accesses.
  }
}

function storedEntryRetry(digest: string, now: number): EntryRetryRecord | null {
  const storage = entryRetryStorage();
  if (!storage) return null;

  const storageKey = `${entryRetryStoragePrefix}${digest}`;
  try {
    const value = storage.getItem(storageKey);
    if (!value) return null;
    const record = parseEntryRetryRecord(value);
    if (!record) {
      storage.removeItem(storageKey);
      return null;
    }
    if (retryRecordIsCurrent(record, digest, now)) return record;
    storage.removeItem(storageKey);
  } catch {
    try {
      storage.removeItem(storageKey);
    } catch {
      // Storage may be blocked; the in-memory retry record remains available.
    }
  }
  return null;
}

function storeEntryRetry(record: EntryRetryRecord) {
  const storage = entryRetryStorage();
  if (!storage) return;

  try {
    storage.setItem(`${entryRetryStoragePrefix}${record.digest}`, JSON.stringify(record));
  } catch {
    // The in-memory copy still makes retries safe while this page stays open.
  }
}

function clearEntryRetry(record: EntryRetryRecord) {
  pendingEntryRequests.delete(record.digest);
  const storage = entryRetryStorage();
  if (!storage) return;

  try {
    storage.removeItem(`${entryRetryStoragePrefix}${record.digest}`);
  } catch {
    // Storage may be blocked; there is nothing else to clear.
  }
}

async function entryRetryFor(raiseId: string, input: PostEntryInput) {
  const digest = await entryDigest(raiseId, input);
  const now = Date.now();
  pruneEntryRetries(now);
  const inMemory = pendingEntryRequests.get(digest);
  if (inMemory && retryRecordIsCurrent(inMemory, digest, now)) return inMemory;

  const stored = storedEntryRetry(digest, now);
  if (stored) {
    pendingEntryRequests.set(digest, stored);
    return stored;
  }

  const record = { digest, key: window.crypto.randomUUID(), timestamp: now };
  pendingEntryRequests.set(digest, record);
  storeEntryRetry(record);
  return record;
}

function shouldAutomaticallyRetryEntry(error: unknown) {
  if (!(error instanceof RequestError)) return true;
  return error.status === 0 || error.status === 408 || error.status >= 500;
}

function isDefiniteEntryRejection(error: unknown) {
  return (
    error instanceof RequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

export async function postEntry(raiseId: string, input: PostEntryInput) {
  const normalized = normalizedEntry(input);
  const retryRecord = await entryRetryFor(raiseId, normalized);
  const send = () =>
    request<RaiseView>(`/api/raises/${raiseId}/entries`, raiseViewSchema, {
      method: "POST",
      headers: { "Idempotency-Key": retryRecord.key },
      body: JSON.stringify(normalized),
    });

  try {
    try {
      return await send();
    } catch (error) {
      if (!shouldAutomaticallyRetryEntry(error)) throw error;
      return await send();
    }
  } catch (error) {
    if (isDefiniteEntryRejection(error)) clearEntryRetry(retryRecord);
    throw error;
  }
}

export async function imageFiles(files: File[]): Promise<AttachmentInput[]> {
  const accepted = files.flatMap((file) => {
    const mimeType = attachmentMimeTypeSchema.safeParse(file.type);
    return mimeType.success ? [{ file, mimeType: mimeType.data }] : [];
  });
  return Promise.all(
    accepted.map(
      ({ file, mimeType }) =>
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
              mimeType,
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
