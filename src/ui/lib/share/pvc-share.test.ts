import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { PersistentVolumeClaimInfo } from "@/generated/types";
import { pvcFactsSection, pvcStatusOf } from "./pvc-share";

const t: T = (section, key, values) => translate("en", section, key, values);
const NOW = Date.parse("2026-10-15T12:00:00Z");

function pvc(
  over: Partial<PersistentVolumeClaimInfo> = {}
): PersistentVolumeClaimInfo {
  return {
    uid: "",
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
    const section = pvcFactsSection(pvc({ capacity: null }), t, null, NOW);
    if (section.body.type !== "facts") throw new Error("expected facts");
    expect(section.body.rows[0].values[0]).toMatchObject({ role: "warn" });
    expect(section.body.rows[0].values[0].text).not.toBe("");
  });

  it("links the bound volume as an object, not a bare string", () => {
    const section = pvcFactsSection(pvc(), t, null, NOW);
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
    expect(pvcStatusOf(pvc({ status: null }), null, NOW)).toBeNull();
  });

  /**
   * Live, orphan-claim named a StorageClass that did not exist and its file
   * said a blue Pending and linked the class. Fails if the file stops saying
   * the class is missing in red, as the page does.
   */
  it("says a class the cluster lacks in red, where the page does", () => {
    const pending = pvc({
      status: "Pending",
      volume: null,
      capacity: null,
      storageClass: "fast-ssd",
      createdAt: "2026-10-13T12:00:00Z",
    });
    const cause = { says: "classMissing", name: "fast-ssd" } as const;
    expect(pvcStatusOf(pending, cause, NOW)).toEqual({
      text: "Pending",
      role: "err",
    });
    const section = pvcFactsSection(pending, t, cause, NOW);
    if (section.body.type !== "facts") throw new Error("expected facts");
    const named = section.body.rows.find(
      (row) => row.label === t("columns", "storageClass")
    );
    expect(named?.values[0]).toEqual({
      text: "fast-ssd does not exist",
      role: "err",
    });
  });

  /** Fails if a claim that waits for its pod by design is filed as unsatisfied. */
  it("files a claim that waits for its pod as a wait, not as a fault", () => {
    const waiting = pvc({ status: "Pending", volume: null, capacity: null });
    const section = pvcFactsSection(
      waiting,
      t,
      { says: "waitsForPod", name: "local-path" },
      NOW
    );
    if (section.body.type !== "facts") throw new Error("expected facts");
    const volume = section.body.rows.find(
      (row) => row.label === t("columns", "volume")
    );
    expect(volume?.values[0]).toEqual({ text: "not bound", role: "pending" });
  });
});
