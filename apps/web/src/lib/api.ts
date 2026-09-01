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

  constructor(code: string, message: string) {
    super(message);
    this.name = "RequestError";
    this.code = code;
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
      payload?.message ?? "Something went wrong. Try again.",
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

export function claimRaise(token: string) {
  return request<ClaimResponse>("/api/claims", {
    method: "POST",
    body: JSON.stringify({ token, mode: "cookie" }),
  });
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
                `Couldn't add ${file.name}. Try that file again.`,
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
