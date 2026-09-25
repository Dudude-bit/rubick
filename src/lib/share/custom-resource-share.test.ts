import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { ownersSection, statusSummarySection } from "./custom-resource-share";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("owner references", () => {
  it("links each owner as the object it names", () => {
    const section = ownersSection(
      [
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: "payments",
          uid: "u1",
          controller: true,
        },
      ],
      "shop",
      t
    );
    expect(section).not.toBeNull();
    if (!section || section.body.type !== "facts")
      throw new Error("expected facts");
    expect(section.body.rows[0].values[0].ref).toMatchObject({
      kind: "Deployment",
      namespace: "shop",
      stem: "payments",
    });
  });

  it("is absent rather than an empty section for an object with no owner", () => {
    expect(ownersSection([], "shop", t)).toBeNull();
  });
});

describe("the status summary fallback", () => {
  /** The frame already draws `status.conditions` in the standard shape; this section must not repeat it. */
  it("does not duplicate a status the frame already reads as conditions", () => {
    const section = statusSummarySection(
      { conditions: [{ type: "Ready", status: "True" }] },
      t
    );
    expect(section).toBeNull();
  });

  it("reads a scalar-status operator's own words as facts", () => {
    const section = statusSummarySection(
      { phase: "Ready", observedGeneration: 3 },
      t
    );
    expect(section).not.toBeNull();
    if (!section || section.body.type !== "facts")
      throw new Error("expected facts");
    expect(section.body.rows.map((row) => row.label)).toEqual([
      "phase",
      "observedGeneration",
    ]);
  });

  it("is absent for an operator that reports nothing scalar", () => {
    expect(statusSummarySection({ nested: { a: 1 } }, t)).toBeNull();
  });
});
