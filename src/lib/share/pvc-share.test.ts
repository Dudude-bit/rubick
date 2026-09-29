import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { PersistentVolumeClaimInfo } from "@/generated/types";
import { pvcFactsSection, pvcStatusOf } from "./pvc-share";

const t: T = (section, key, values) => translate("en", section, key, values);

function pvc(
  over: Partial<PersistentVolumeClaimInfo> = {}
): PersistentVolumeClaimInfo {
  return {
    name: "data",
    namespace: "shop",
    status: "Bound",
    volume: "pvc-123",
    capacity: "10Gi",
    accessModes: ["ReadWriteOnce"],
    storageClass: "standard",
    labels: {},
    annotations: {},
    createdAt: null,
    ...over,
  };
}

describe("a claim's capacity", () => {
  /**
   * A claim not yet provisioned has no capacity at all, printing "–" would
   * read as a healthy claim with a blank field rather than as "not bound".
   */
  it("says not provisioned yet instead of a blank capacity", () => {
    const section = pvcFactsSection(pvc({ capacity: null }), t);
    if (section.body.type !== "facts") throw new Error("expected facts");
    expect(section.body.rows[0].values[0]).toMatchObject({ role: "warn" });
    expect(section.body.rows[0].values[0].text).not.toBe("");
  });

  it("links the bound volume as an object, not a bare string", () => {
    const section = pvcFactsSection(pvc(), t);
    if (section.body.type !== "facts") throw new Error("expected facts");
    const volumeRow = section.body.rows.find((row) => row.values[0].ref);
    expect(volumeRow?.values[0].ref).toMatchObject({
      kind: "PersistentVolume",
    });
    expect(
      volumeRow?.values[0].ref?.stem + volumeRow!.values[0].ref!.tail
    ).toBe("pvc-123");
  });
});

describe("a claim's status", () => {
  it("is absent rather than a claim about a status the cluster never gave", () => {
    expect(pvcStatusOf(pvc({ status: null }))).toBeNull();
  });
});
