import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { NetworkPolicyInfo, PolicyDirection } from "@/generated/types";
import {
  networkPolicyDirectionSection,
  networkPolicyStats,
} from "./useNetworkPolicyShare";

const t: T = (section, key, values) => translate("en", section, key, values);

const governed = (rules: PolicyDirection["rules"]): PolicyDirection => ({
  governed: true,
  rules,
  opensToEverything: rules.some((r) => r.peers.length === 0),
  deniesEverything: rules.length === 0,
});

const notGoverned: PolicyDirection = {
  governed: false,
  rules: [],
  opensToEverything: false,
  deniesEverything: false,
};

const policy: NetworkPolicyInfo = {
  name: "deny-egress",
  namespace: "shop",
  selects: { kind: "written", query: "app=checkout" },
  selected: 3,
  ingress: governed([
    {
      peers: [
        {
          pods: { kind: "notSaid" },
          namespaces: { kind: "notSaid" },
          ipBlock: null,
        },
      ],
      ports: [{ protocol: "TCP", port: "8080", endPort: null }],
    },
  ]),
  egress: notGoverned,
  labels: {},
  createdAt: null,
};

describe("what a NetworkPolicy report leads with", () => {
  it("names the selector and which directions it governs", () => {
    const stats = networkPolicyStats(policy, t);
    expect(stats).toMatchObject([
      { value: "app=checkout" },
      { value: "Ingress" },
    ]);
  });
});

describe("a governed direction's rules", () => {
  it("turns a rule into a finding of who it lets through and on what port, deleting this breaks the row content", () => {
    const section = networkPolicyDirectionSection(policy.ingress, false, t);
    expect(section?.body).toMatchObject({
      type: "findings",
      items: [{ detail: "TCP/8080", role: "neutral" }],
    });
  });

  it("says a direction denies everything rather than leaving it empty", () => {
    const section = networkPolicyDirectionSection(governed([]), false, t);
    expect(section?.body).toMatchObject({
      type: "findings",
      items: [{ title: "denies all" }],
    });
  });

  it("is left out entirely for a direction this policy does not govern", () => {
    expect(networkPolicyDirectionSection(notGoverned, true, t)).toBeNull();
  });
});
