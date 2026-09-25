import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { PersistentVolumeInfo } from "@/generated/types";
import { pvFactsSection } from "./pv-share";

const t: T = (section, key, values) => translate("en", section, key, values);

function pv(over: Partial<PersistentVolumeInfo> = {}): PersistentVolumeInfo {
  return {
    name: "pv-123",
    capacity: "10Gi",
    accessModes: ["ReadWriteOnce"],
    reclaimPolicy: "Retain",
    status: "Bound",
    claim: null,
    storageClass: "standard",
    reason: null,
    labels: {},
    annotations: {},
    createdAt: null,
    ...over,
  };
}

describe("claimRef parsing", () => {
  /**
   * `spec.claimRef` is serialised `namespace/name`; splitting on the wrong
   * side would send the reader to `PersistentVolumeClaim/shop` in `data`'s
   * namespace instead of the other way round.
   */
  it("reads the claim as namespace/name, the same as ClaimRef", () => {
    const section = pvFactsSection(pv({ claim: "shop/data" }), t);
    if (section.body.type !== "facts") throw new Error("expected facts");
    const claimRow = section.body.rows.find((row) => row.label === "Claim");
    expect(claimRow?.values[0]).toMatchObject({
      text: "data",
      ref: { kind: "PersistentVolumeClaim", namespace: "shop", stem: "data" },
    });
  });

  it("warns rather than staying silent about an unbound volume", () => {
    const section = pvFactsSection(pv({ claim: null }), t);
    if (section.body.type !== "facts") throw new Error("expected facts");
    const claimRow = section.body.rows.find((row) => row.label === "Claim");
    expect(claimRow?.values[0].role).toBe("warn");
  });
});

describe("a reclaimed volume's reason", () => {
  it("is only drawn when the cluster gave one", () => {
    const withReason = pvFactsSection(pv({ reason: "quota exceeded" }), t);
    const without = pvFactsSection(pv({ reason: null }), t);
    if (withReason.body.type !== "facts" || without.body.type !== "facts")
      throw new Error("expected facts");
    expect(withReason.body.rows.some((row) => row.label === "Reason")).toBe(
      true
    );
    expect(without.body.rows.some((row) => row.label === "Reason")).toBe(false);
  });
});
