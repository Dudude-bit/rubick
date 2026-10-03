import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { namespaceLabelsSection, namespaceStatusOf } from "./namespace-share";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("a namespace's status in the file", () => {
  /** Terminating is the state people open this page to diagnose. */
  it("reads Terminating as pending, not as a fault", () => {
    const status = namespaceStatusOf({
      name: "shop",
      uid: "u1",
      status: "Terminating",
      labels: {},
      createdAt: null,
    });
    expect(status.role).toBe("pending");
  });
});

describe("labels as facts", () => {
  /**
   * Every namespaceSelector and allowedRoutes clause in the cluster matches
   * against these exact labels, so a reader with no cluster access is
   * comparing the file's rows against a policy they hold in another tab.
   */
  it("carries every label as its own row", () => {
    const section = namespaceLabelsSection(
      { team: "payments", "kubernetes.io/metadata.name": "shop" },
      t
    );
    expect(section.count).toBe(2);
    if (section.body.type !== "facts") throw new Error("expected facts");
    expect(section.body.rows.map((row) => row.label)).toEqual([
      "team",
      "kubernetes.io/metadata.name",
    ]);
  });
});
