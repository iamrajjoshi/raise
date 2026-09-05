/** @vitest-environment happy-dom */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShareCard } from "./ShareCard";

describe("ShareCard", () => {
  it("tells a human to send an agent link manually", () => {
    const html = renderToStaticMarkup(
      <ShareCard url="https://raise.test/r/r_example#token=cap_example.secret" target="agent" />,
    );

    expect(html).toContain("Send this one-time link to the agent.");
  });
});
