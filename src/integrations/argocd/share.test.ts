import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { appSetsSection, controllerSection } from "./share";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what the Argo CD screen tells Share about lists it could not read", () => {
  /** A refused ApplicationSet list returned no section, which a reader of
   *  the file takes for "no ApplicationSet is failing". */
  it("marks the ApplicationSets unread when the list was refused", () => {
    const section = appSetsSection(undefined, new Error("forbidden"), t);
    expect(section?.unread).toContain("forbidden");
  });

  it("marks the ApplicationSets unread while the list is still loading", () => {
    expect(appSetsSection(undefined, null, t)?.unread).toBe(
      "Still being read when the report was made."
    );
  });

  it("reports nothing about ApplicationSets that were read and are fine", () => {
    expect(appSetsSection([], null, t)).toBeNull();
  });

  /** Argo's own workloads not yet read are not "every component is ready". */
  it("marks Argo's own workloads unread until they are read", () => {
    expect(controllerSection(undefined, t)?.unread).toBe(
      "Still being read when the report was made."
    );
  });
});
