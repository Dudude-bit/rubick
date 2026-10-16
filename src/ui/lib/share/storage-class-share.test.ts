import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { StorageClassInfo } from "@/generated/types";
import type { PeekTarget } from "@/hooks/usePeek";
import { CONFIG_STORAGE_SOURCES } from "@/routes/c/$cluster/-peek/peek-sources-storage";
import {
  storageClassFacts,
  storageClassFactsSection,
} from "./storage-class-share";

const t: T = (section, key, values) => translate("en", section, key, values);

function sc(over: Partial<StorageClassInfo> = {}): StorageClassInfo {
  return {
    uid: "",
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

describe("one StorageClass, read the same on every surface", () => {
  /** Refusing to grow is what a reader acts on; "disabled" named no consequence. */
  it("says what a class that refuses expansion means for its claims", () => {
    const row = storageClassFacts(sc({ allowVolumeExpansion: false }), t).find(
      (fact) => fact.label === "Volume expansion"
    );
    expect(row?.text).toBe("not allowed: claims cannot grow");
  });

  /**
   * The list said "disabled", the peek "not allowed" and the page "not
   * allowed: claims cannot grow", and Share left it out. Fails if the peek
   * or Share draws a row the page does not.
   */
  it("draws the page's rows in the peek and in Share", () => {
    const class_ = sc({ allowVolumeExpansion: false, isDefault: true });
    const page = storageClassFacts(class_, t).map(({ label, text }) => [
      label,
      text,
    ]);
    const peek = CONFIG_STORAGE_SOURCES.StorageClass!.summarise(
      class_,
      { kind: "StorageClass", name: "standard" } as PeekTarget,
      t
    ).groups[0].items.map(({ label, value }) => [label, value]);
    const section = storageClassFactsSection(class_, t);
    if (section.body.type !== "facts") throw new Error("expected facts");
    const shared = section.body.rows.map(({ label, values }) => [
      label,
      values[0].text,
    ]);
    expect(peek).toEqual(page);
    expect(shared).toEqual(page);
  });
});
