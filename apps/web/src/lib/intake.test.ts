import { describe, expect, it } from "vitest";
import { maxAttachmentBytesPerEntry } from "@raise/protocol";
import {
  canAddScreenshots,
  classifyFiles,
  displayFilename,
  importTextFiles,
  screenshotBytes,
  unsupportedFileMessage,
} from "./intake";

describe("scratchpad file intake", () => {
  it("classifies screenshots, text files, and unsupported documents", () => {
    const files = [
      new File(["png"], "screen.png", { type: "image/png" }),
      new File(["notes"], "notes.md", { type: "text/markdown" }),
      new File(["pdf"], "report.pdf", { type: "application/pdf" }),
    ];

    const result = classifyFiles(files);
    expect(result.screenshots.map((file) => file.name)).toEqual(["screen.png"]);
    expect(result.textFiles.map((file) => file.name)).toEqual(["notes.md"]);
    expect(result.unsupported.map((file) => file.name)).toEqual(["report.pdf"]);
  });

  it("imports UTF-8 text as editable literal content", async () => {
    const file = new File(["Check <script>alert('no')</script>\nthen retry"], "notes.md", {
      type: "text/markdown",
    });

    await expect(importTextFiles([file], "Existing note")).resolves.toEqual({
      value:
        "Existing note\n\n[Imported from: notes.md]\nCheck <script>alert('no')</script>\nthen retry",
      error: null,
    });
  });

  it("rejects invalid UTF-8 and control characters", async () => {
    const invalidUtf8 = new File([new Uint8Array([0xc3, 0x28])], "broken.txt", {
      type: "text/plain",
    });
    const controls = new File(["hello\u0000world"], "binary.txt", { type: "text/plain" });

    expect((await importTextFiles([invalidUtf8], "")).error).toContain("plain text");
    expect((await importTextFiles([controls], "")).error).toContain("plain text");
  });

  it("rejects imports that exceed the scratchpad limit", async () => {
    const file = new File(["x".repeat(16_001)], "long.txt", { type: "text/plain" });
    const result = await importTextFiles([file], "y".repeat(5_000));

    expect(result.value).toBe("y".repeat(5_000));
    expect(result.error).toContain("too long");
  });

  it("cleans displayed filenames and explains PDF rejection", () => {
    expect(displayFilename("../notes\u0000.md")).toBe(".._notes.md");
    expect(
      unsupportedFileMessage(new File(["pdf"], "brief.pdf", { type: "application/pdf" })),
    ).toContain("export it as .txt or .md");
  });

  it("accepts more than four screenshots when they fit the byte budget", () => {
    const files = Array.from({ length: 5 }, () => ({ size: 1 }));

    expect(canAddScreenshots([], files)).toBe(true);
  });

  it("counts existing screenshots and frees their space when removed", () => {
    const existing = [{ dataUrl: "data:image/png;base64,YQ==" }];
    const fullBudgetFile = [{ size: maxAttachmentBytesPerEntry }];

    expect(screenshotBytes(existing)).toBe(1);
    expect(canAddScreenshots(existing, fullBudgetFile)).toBe(false);
    expect(canAddScreenshots([], fullBudgetFile)).toBe(true);
  });
});
