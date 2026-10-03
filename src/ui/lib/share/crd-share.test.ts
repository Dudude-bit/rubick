import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { CrdCondition } from "@/generated/types";
import { crdConditionsSection, crdVersionsSection } from "./crd-share";
import type { CrdDetailInfo } from "@/generated/types";

const t: T = (section, key, values) => translate("en", section, key, values);

function crd(over: Partial<CrdDetailInfo> = {}): CrdDetailInfo {
  return {
    name: "certificates.cert-manager.io",
    group: "cert-manager.io",
    kind: "Certificate",
    plural: "certificates",
    singular: "certificate",
    scope: "Namespaced",
    versions: [],
    shortNames: [],
    categories: [],
    labels: {},
    annotations: {},
    conditions: [],
    createdAt: null,
    acceptedNames: {
      kind: "Certificate",
      plural: "certificates",
      singular: null,
      shortNames: [],
      categories: [],
      listKind: null,
    },
    ...over,
  };
}

describe("conditions whose field is called conditionType", () => {
  /**
   * The frame's own conditions reader only matches a `type` field, so a CRD
   * with `conditionType` would otherwise show no Conditions section at all –
   * `Established: false` disappearing is not "no conditions", it is a page
   * this app never read.
   */
  it("maps conditionType onto the shape the frame's conditionsSection draws", () => {
    const conditions: CrdCondition[] = [
      {
        conditionType: "Established",
        status: "True",
        reason: "InitialNamesAccepted",
        message: null,
        lastTransitionTime: "2026-01-01T00:00:00Z",
      },
    ];
    const section = crdConditionsSection(conditions, t);
    expect(section).not.toBeNull();
    if (!section || section.body.type !== "conditions")
      throw new Error("expected conditions");
    expect(section.body.rows[0]).toMatchObject({
      type: "Established",
      status: "True",
      role: "ok",
    });
  });

  it("is absent rather than an empty section when the CRD reports none", () => {
    expect(crdConditionsSection([], t)).toBeNull();
  });
});

describe("the versions table", () => {
  it("warns on a version nothing serves", () => {
    const section = crdVersionsSection(
      crd({
        versions: [
          {
            name: "v1alpha1",
            served: false,
            storage: false,
            deprecated: false,
            deprecationWarning: null,
            schema: null,
            additionalPrinterColumns: [],
          },
        ],
      }),
      t
    );
    if (section.body.type !== "table") throw new Error("expected a table");
    expect(section.body.rows[0].cells[1]).toMatchObject({
      text: "no",
      role: "warn",
    });
  });
});
