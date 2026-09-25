import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { HelmRevision } from "@/generated/types";
import { helmHistorySection, helmResourcesSection } from "./helm-share";

const t: T = (section, key, values) => translate("en", section, key, values);

function revision(n: number): HelmRevision {
  return {
    revision: n,
    updated: "2026-01-01T00:00:00Z",
    status: "superseded",
    chart: "app-1.0.0",
    appVersion: "1.0.0",
    description: null,
  };
}

describe("release history", () => {
  it("caps the table and says how many revisions were left out", () => {
    const history = Array.from({ length: 55 }, (_, i) => revision(i + 1));
    const section = helmHistorySection(history, t);
    expect(section).not.toBeNull();
    if (!section || section.body.type !== "table")
      throw new Error("expected a table");
    expect(section.body.rows).toHaveLength(50);
    expect(section.body.more).toContain("5");
  });

  it("is absent rather than an empty table for a release with no history read", () => {
    expect(helmHistorySection([], t)).toBeNull();
  });
});

describe("installed resources", () => {
  /**
   * A resource row only ever carries kind, name and namespace, the object
   * this function is handed has no `values` field to leak in the first
   * place, which is the guarantee against a values dump ending up in a link.
   */
  it("links each installed object without carrying anything beyond its identity", () => {
    const section = helmResourcesSection(
      [{ kind: "Deployment", name: "app", namespace: "shop" }],
      t
    );
    expect(section).not.toBeNull();
    if (!section || section.body.type !== "table")
      throw new Error("expected a table");
    expect(Object.keys(section.body.rows[0].cells[1])).not.toContain("values");
    expect(section.body.rows[0].cells[1].ref).toMatchObject({
      kind: "Deployment",
      namespace: "shop",
      stem: "app",
    });
  });
});
