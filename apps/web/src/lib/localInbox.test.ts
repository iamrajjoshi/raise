/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from "vitest";
import type { RaiseView } from "@raise/protocol";
import { RequestError } from "./api";
import {
  groupInboxRaises,
  loadRememberedRaises,
  rememberedRaiseIds,
  rememberRaise,
} from "./localInbox";
import { installTestStorage } from "./testStorage";

const storage = installTestStorage();

function raiseView(
  id: string,
  options: Partial<Pick<RaiseView, "lifecycle" | "viewerRole" | "waitingOn" | "updatedAt">> = {},
): RaiseView {
  return {
    id,
    title: `Request ${id}`,
    origin: "human",
    viewerRole: options.viewerRole ?? "human",
    lifecycle: options.lifecycle ?? "open",
    waitingOn: options.waitingOn ?? "human",
    pendingAction: "review_result",
    version: 2,
    cursor: "1725552123456-0",
    entriesMode: "snapshot",
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-09-01T09:00:00.000Z",
    expiresAt: "2026-09-02T08:00:00.000Z",
    permissions: {
      canReply: false,
      canPostResult: false,
      canReview: true,
      canComment: true,
    },
    entries: [],
  };
}

beforeEach(() => {
  storage.clear();
});

describe("device-local inbox", () => {
  it("stores only valid public IDs, with the newest request first", () => {
    rememberRaise("r_first12");
    rememberRaise("not-a-raise");
    rememberRaise("r_second34");
    rememberRaise("r_first12");

    expect(rememberedRaiseIds()).toEqual(["r_first12", "r_second34"]);
    expect(storage.getItem("raise.inbox.v1")).not.toContain("#token=");
  });

  it("groups work by what the current human needs to do", () => {
    const groups = groupInboxRaises([
      raiseView("r_waiting1", { waitingOn: "agent" }),
      raiseView("r_closed12", { lifecycle: "resolved", waitingOn: null }),
      raiseView("r_turn123", { updatedAt: "2026-09-01T10:00:00.000Z" }),
    ]);

    expect(groups.yourTurn.map((raise) => raise.id)).toEqual(["r_turn123"]);
    expect(groups.waiting.map((raise) => raise.id)).toEqual(["r_waiting1"]);
    expect(groups.closed.map((raise) => raise.id)).toEqual(["r_closed12"]);
  });

  it("drops inaccessible IDs but keeps requests that failed temporarily", async () => {
    rememberRaise("r_missing1");
    rememberRaise("r_retry123");
    rememberRaise("r_loaded12");

    const result = await loadRememberedRaises(async (raiseId) => {
      if (raiseId === "r_missing1") {
        throw new RequestError("not_found", "Gone", 404);
      }
      if (raiseId === "r_retry123") {
        throw new RequestError("internal_error", "Try again", 500);
      }
      return raiseView(raiseId);
    });

    expect(result.raises.map((raise) => raise.id)).toEqual(["r_loaded12"]);
    expect(result.failed).toBe(1);
    expect(rememberedRaiseIds()).toEqual(["r_loaded12", "r_retry123"]);
  });
});
