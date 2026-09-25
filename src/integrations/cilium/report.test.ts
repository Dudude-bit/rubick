import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

import { reportOf } from "./report";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what a rejected CiliumNetworkPolicy tells a reader with no cluster access", () => {
  it("says why it was rejected rather than reading as enforcing", () => {
    const sections = reportOf(
      {
        group: "cilium.io",
        kind: "CiliumNetworkPolicy",
        namespace: "shop",
        name: "deny-egress",
        spec: {
          endpointSelector: { matchLabels: { app: "api" } },
          egress: [{ toEntities: ["world"] }],
        },
        status: {
          conditions: [
            { type: "Valid", status: "False", message: "invalid CIDR" },
          ],
        },
      },
      t
    );
    if (sections?.[0]?.body.type !== "facts") throw new Error("expected facts");
    expect(sections[0].body.rows[0]).toEqual({
      label: "Status",
      values: [{ text: "invalid CIDR", role: "err" }],
    });
    expect(
      sections[0].body.rows.find(
        (row) => row.label === "Reaches outside the cluster"
      )?.values[0]
    ).toEqual({
      text: "yes",
      role: "warn",
    });
  });
});

describe("what a policy written as specs: tells a reader with no cluster access", () => {
  it("says the rules are not on the wire rather than claiming zero", () => {
    const sections = reportOf(
      {
        group: "cilium.io",
        kind: "CiliumNetworkPolicy",
        namespace: "shop",
        name: "legacy",
        spec: [{ endpointSelector: {} }],
        status: { conditions: [{ type: "Valid", status: "True" }] },
      },
      t
    );
    if (sections?.[0]?.body.type !== "facts") throw new Error("expected facts");
    const selects = sections[0].body.rows.find(
      (row) => row.label === "Selects"
    );
    expect(selects?.values[0]?.text).toBe(
      "not on the wire this report reads, written as a specs: list"
    );
    expect(sections[0].body.rows.some((row) => row.label === "Rules")).toBe(
      false
    );
  });
});

describe("what an object of another vendor's kind gets", () => {
  it("declines a VirtualService: that is Istio's kind, not Cilium's", () => {
    const sections = reportOf(
      {
        group: "networking.istio.io",
        kind: "VirtualService",
        namespace: "shop",
        name: "web",
        spec: {},
        status: {},
      },
      t
    );
    expect(sections).toBeNull();
  });
});
