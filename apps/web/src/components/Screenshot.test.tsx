/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Screenshot } from "./Screenshot";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Screenshot", () => {
  it("keeps panoramic screenshots whole and exposes a full-size viewer", () => {
    const html = renderToStaticMarkup(
      <Screenshot
        src="data:image/png;base64,abc"
        name="wide-header.png"
        width={744}
        height={142}
        onRemove={() => undefined}
      />,
    );

    expect(html).toContain("screenshot-card-wide");
    expect(html).toContain("Open full-size screenshot: wide-header.png");
    expect(html).toContain("744 × 142");
    expect(html).toContain("<dialog");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Remove wide-header.png");
  });

  it("opens, switches to actual size, and closes", () => {
    act(() => {
      root.render(
        <Screenshot
          src="data:image/png;base64,abc"
          name="wide-header.png"
          width={744}
          height={142}
        />,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      ".screenshot-open",
    ) as HTMLButtonElement;
    const dialog = container.querySelector<HTMLDialogElement>("dialog") as HTMLDialogElement;

    trigger.focus();
    act(() => trigger.click());
    expect(dialog.open).toBe(true);

    const actualSize = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "100%",
    ) as HTMLButtonElement;
    act(() => actualSize.click());
    expect(actualSize.getAttribute("aria-pressed")).toBe("true");
    expect(dialog.querySelector(".screenshot-full-actual")).toBeTruthy();

    const close = Array.from(dialog.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Close"),
    ) as HTMLButtonElement;
    act(() => close.click());
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});
