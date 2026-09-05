import { describe, expect, it } from "vitest";
import { prepareImages } from "./images.js";

const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function disguisedDataUrl(content: string) {
  return `data:image/png;base64,${Buffer.from(content).toString("base64")}`;
}

describe("image preparation", () => {
  it("accepts bytes that match the declared supported format", async () => {
    const [prepared] = await prepareImages([
      { name: "pixel.png", mimeType: "image/png", dataUrl: onePixelPng },
    ]);

    expect(prepared).toMatchObject({
      displayName: "pixel.png",
      width: 1,
      height: 1,
    });
    expect(prepared?.data.subarray(0, 4).toString("ascii")).toBe("RIFF");
  });

  it("rejects SVG bytes disguised as a PNG", async () => {
    await expect(
      prepareImages([
        {
          name: "vector.png",
          mimeType: "image/png",
          dataUrl: disguisedDataUrl(
            '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
          ),
        },
      ]),
    ).rejects.toMatchObject({ statusCode: 400, code: "invalid_image" });
  });

  it("rejects GIF bytes disguised as a PNG", async () => {
    await expect(
      prepareImages([
        {
          name: "animation.png",
          mimeType: "image/png",
          dataUrl: disguisedDataUrl("GIF89a"),
        },
      ]),
    ).rejects.toMatchObject({ statusCode: 400, code: "invalid_image" });
  });

  it("rejects supported bytes when they do not match the declared type", async () => {
    await expect(
      prepareImages([
        {
          name: "pixel.jpg",
          mimeType: "image/jpeg",
          dataUrl: onePixelPng.replace("data:image/png", "data:image/jpeg"),
        },
      ]),
    ).rejects.toMatchObject({ statusCode: 400, code: "invalid_image" });
  });
});
