/** @vitest-environment happy-dom */
import type { RaiseView } from "@raise/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Inbox } from "./Inbox";

function raiseView(id: string, title: string): RaiseView {
  return {
    id,
    title,
    origin: "human",
    viewerRole: "human",
    lifecycle: "open",
    waitingOn: "human",
    pendingAction: "review_result",
    version: 2,
    cursor: "1725552123456-0",
    entriesMode: "snapshot",
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T09:00:00.000Z",
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

describe("Inbox", () => {
  it("shows remembered requests in a compact queue", () => {
    const html = renderToStaticMarkup(
      <Inbox
        groups={{
          yourTurn: [raiseView("r_review12", "Check the mobile nav")],
          waiting: [],
          closed: [],
        }}
        loading={false}
        failed={0}
      />,
    );

    expect(html).toContain("Things in flight");
    expect(html).toContain("Your turn");
    expect(html).toContain("Review the result");
    expect(html).toContain('href="/r/r_review12"');
    expect(html).not.toContain("Nothing waiting");
  });

  it("explains that an empty inbox belongs to this browser", () => {
    const html = renderToStaticMarkup(
      <Inbox groups={{ yourTurn: [], waiting: [], closed: [] }} loading={false} failed={0} />,
    );

    expect(html).toContain("ON THIS DEVICE");
    expect(html).toContain("Nothing waiting");
    expect(html).toContain('href="/"');
  });
});
