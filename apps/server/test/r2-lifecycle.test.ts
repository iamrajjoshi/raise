import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("the R2 lifecycle deployment policy", () => {
  it("makes only Raise v1 objects deletion-eligible after six hours", async () => {
    const path = new URL("../../../deploy/cloudflare/r2-lifecycle.json", import.meta.url);
    const policy: unknown = JSON.parse(await readFile(path, "utf8"));

    expect(policy).toEqual({
      rules: [
        {
          id: "raise-ephemeral-v1",
          enabled: true,
          conditions: { prefix: "ephemeral/v1/" },
          deleteObjectsTransition: {
            condition: { type: "Age", maxAge: 6 * 60 * 60 },
          },
        },
      ],
    });
  });
});
