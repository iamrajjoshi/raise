import type { Role } from "@raise/protocol";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function rejectInvalidCapability(): never {
  throw new HttpError(401, "invalid_capability", "This link has expired or was already opened.");
}

export function rejectUnauthorizedSession(): never {
  throw new HttpError(401, "unauthorized", "Open this request from its original link.");
}

export function rejectWrongRole(actualRole: Role, expectedRole?: Role): never {
  throw new HttpError(
    403,
    "wrong_role",
    `This link is for the ${actualRole}, not the ${expectedRole ?? "requested role"}.`,
  );
}

export function rejectMissingScreenshot(): never {
  throw new HttpError(404, "not_found", "We couldn’t find that screenshot.");
}

export function rejectMissingRaise(): never {
  throw new HttpError(404, "not_found", "We couldn’t find this request.");
}

export function rejectMutation(code: string): never {
  switch (code) {
    case "unauthorized":
      return rejectUnauthorizedSession();
    case "raise_closed":
      throw new HttpError(409, "raise_closed", "This request is closed.");
    case "state_conflict":
      throw new HttpError(409, "state_conflict", "This request changed. Reload and try again.");
    case "idempotency_conflict":
      throw new HttpError(
        409,
        "idempotency_conflict",
        "That retry key was already used for a different update.",
      );
    case "not_your_turn":
      throw new HttpError(403, "not_your_turn", "It isn’t your turn to reply.");
    case "invalid_transition":
      throw new HttpError(
        409,
        "invalid_transition",
        "You can’t send that at this point in the request. Reload and try again.",
      );
    default:
      throw new Error(`Storage rejected a Raise mutation (${code}).`);
  }
}
