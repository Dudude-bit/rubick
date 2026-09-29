import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { StorageClassInfo } from "@/generated/types";
import { storageClassFactsSection } from "./storage-class-share";

const t: T = (section, key, values) => translate("en", section, key, values);

function sc(over: Partial<StorageClassInfo> = {}): StorageClassInfo {
  return {
    name: "standard",
    provisioner: "kubernetes.io/gce-pd",
    reclaimPolicy: "Delete",
    volumeBindingMode: "Immediate",
    allowVolumeExpansion: true,
    isDefault: false,
    parameters: {},
    labels: {},
    annotations: {},
    createdAt: null,
    ...over,
  };
}

describe("the one question this page answers", () => {
  /** "does a claim that names no class land here" is what the page exists for. */
  it("says claims land here when the class is the cluster default", () => {
    const section = storageClassFactsSection(sc({ isDefault: true }), t);
    if (section.body.type !== "facts") throw new Error("expected facts");
    const row = section.body.rows.find((r) => r.label === "Default class");
    expect(row?.values[0].text).toContain("this one");
  });

  it("says no otherwise, not a blank field", () => {
    const section = storageClassFactsSection(sc({ isDefault: false }), t);
    if (section.body.type !== "facts") throw new Error("expected facts");
    const row = section.body.rows.find((r) => r.label === "Default class");
    expect(row?.values[0].text).toBe("no");
  });
});
