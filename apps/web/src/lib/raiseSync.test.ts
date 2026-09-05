/** @vitest-environment happy-dom */
import type { RaiseView } from "@raise/protocol";
import { describe, expect, it } from "vitest";
import { RequestError } from "./api";
import { isTerminalReadError, mergeRaiseView, retryDelayMs, waitForRetry } from "./raiseSync";

function view(overrides: Partial<RaiseView> = {}): RaiseView {
  return {
    id: "r_example12",
    title: "Example",
    origin: "human",
    viewerRole: "human",
    lifecycle: "open",
    waitingOn: "agent",
    pendingAction: "perform_work",
    version: 1,
    cursor: "100-0",
    entriesMode: "snapshot",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-01T02:00:00.000Z",
    permissions: {
      canReply: false,
      canPostResult: false,
      canReview: false,
      canComment: true,
    },
    entries: [
      {
        id: "e_prompt",
        authorRole: "human",
        kind: "prompt",
        body: "Please fix this.",
        createdAt: "2026-09-01T00:00:00.000Z",
        attachments: [],
      },
    ],
    ...overrides,
  };
}

describe("Raise change merging", () => {
  it("replaces local entries with a current snapshot", () => {
    const snapshot = view({
      version: 2,
      cursor: "200-0",
      entries: [
        {
          id: "e_retained",
          authorRole: "agent",
          kind: "comment",
          body: "Retained history.",
          createdAt: "2026-09-01T00:01:00.000Z",
          attachments: [],
        },
      ],
    });

    expect(mergeRaiseView(view(), snapshot)).toEqual(snapshot);
  });

  it("merges a delta once and normalizes local state to a snapshot", () => {
    const nextEntry = {
      id: "e_result",
      authorRole: "agent" as const,
      kind: "result" as const,
      body: "Done.",
      createdAt: "2026-09-01T00:01:00.000Z",
      attachments: [],
    };
    const delta = view({
      version: 2,
      cursor: "200-0",
      entriesMode: "delta",
      entries: [nextEntry],
    });

    const merged = mergeRaiseView(view(), delta);
    expect(merged.entries.map((entry) => entry.id)).toEqual(["e_prompt", "e_result"]);
    expect(merged.entriesMode).toBe("snapshot");
    expect(mergeRaiseView(merged, delta).entries.map((entry) => entry.id)).toEqual([
      "e_prompt",
      "e_result",
    ]);
  });

  it("does not let a delayed lower-version response regress current state", () => {
    const current = view({ version: 3, cursor: "300-0", lifecycle: "resolved" });
    const delayed = view({ version: 2, cursor: "200-0", entriesMode: "delta" });

    expect(mergeRaiseView(current, delayed)).toBe(current);
  });
});

describe("Raise polling recovery", () => {
  it("caps transient retry delays", () => {
    expect([1, 2, 3, 4, 20].map(retryDelayMs)).toEqual([500, 1_000, 2_000, 5_000, 5_000]);
  });

  it("recognizes terminal client failures but lets timeouts and limits retry", () => {
    expect(isTerminalReadError(new RequestError("unauthorized", "Expired.", 401))).toBe(true);
    expect(isTerminalReadError(new RequestError("not_found", "Gone.", 404))).toBe(true);
    expect(isTerminalReadError(new RequestError("timeout", "Try again.", 408))).toBe(false);
    expect(isTerminalReadError(new RequestError("limited", "Slow down.", 429))).toBe(false);
  });

  it("ends a retry delay as soon as polling is aborted", async () => {
    const controller = new AbortController();
    const waiting = waitForRetry(30_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
  });
});
