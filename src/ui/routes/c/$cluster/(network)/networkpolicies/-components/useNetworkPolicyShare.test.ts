// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { NetworkPolicyInfo, PolicyDirection } from "@/generated/types";
import { renderHook } from "@testing-library/react";
import {
  networkPolicyDirectionSection,
  networkPolicyStats,
  useNetworkPolicyShare,
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
  uid: "",
  name: "deny-egress",
  namespace: "shop",
  selects: { kind: "written", query: "app=checkout" },
  selected: 3,
  nearly: null,
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
  it("names the selector, the pods behind it and which directions it governs", () => {
    const stats = networkPolicyStats(policy, t);
    expect(stats).toMatchObject([
      { value: "app=checkout" },
      { value: "3 pods", unread: false },
      { value: "Ingress" },
    ]);
  });

  /** Fails if a refused pod list reaches the file as a count or as none. */
  it("marks pods nobody could read as unread", () => {
    expect(
      networkPolicyStats({ ...policy, selected: null }, t)[1]
    ).toMatchObject({ value: "pods not read", unread: true });
  });

  /**
   * The file of a policy over a misspelled label said what it selects and not
   * that it selects nothing. Fails if the page's cause stops reaching Share.
   */
  it("leads with the cause the page leads with where it selects none", () => {
    const typo: NetworkPolicyInfo = {
      ...policy,
      selects: { kind: "written", query: "app=checkuot" },
      selected: 0,
      nearly: { asked: "app=checkuot", carried: "app=checkout", pods: 1 },
    };
    const { result } = renderHook(() => useNetworkPolicyShare(typo));
    expect(result.current().verdict).toBe(
      "This policy restricts nothing. No pod in shop carries app=checkuot, and 1 pod carries app=checkout, a character or two away. If that is the label meant, correct the selector."
    );
    const { result: selecting } = renderHook(() =>
      useNetworkPolicyShare(policy)
    );
    expect(selecting.current().verdict).toBeNull();
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
