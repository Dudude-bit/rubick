import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

import type { NetworkPolicyInfo, PodInfo, Scoped } from "@/generated/types";

// A plain function, not a `vi.fn`: a spy's rejected promise is reported as
// the test's own failure even after the query has handled it.
const answer = vi.hoisted(() => ({
  policies: (): Promise<Scoped<NetworkPolicyInfo>> =>
    Promise.resolve({ rows: [], unread: [] }),
}));

vi.mock("@/lib/commands", () => ({
  commands: new Proxy(
    {},
    {
      get: (_target, name) =>
        name === "listNetworkPoliciesIn"
          ? () => answer.policies()
          : () => Promise.reject(new Error("not read in this test")),
    }
  ),
}));

const { renderWithRouter } = await import("@/test/render");
const { en } = await import("@/i18n/catalogue");
const { PodNetworkPolicies } = await import("./PodNetworkPolicies");

const API_POD = {
  name: "api-585bf77d99-xtwfs",
  namespace: "net",
  labels: { app: "api" },
} as unknown as PodInfo;

const DEFAULT_DENY: NetworkPolicyInfo = {
  name: "default-deny-ingress",
  namespace: "net",
  selects: { kind: "everything" },
  selected: 4,
  ingress: {
    governed: true,
    rules: [],
    opensToEverything: false,
    deniesEverything: true,
  },
  egress: {
    governed: false,
    rules: [],
    opensToEverything: false,
    deniesEverything: false,
  },
  labels: {},
  createdAt: null,
};

describe("the NetworkPolicies on a Pod's page", () => {
  /**
   * The Pod page said nothing about policies, so "who may reach this" had
   * no answer. Ingress is isolated by default-deny, egress is not.
   */
  it("names the policy that isolates the pod and leaves egress open", async () => {
    answer.policies = () =>
      Promise.resolve({ rows: [DEFAULT_DENY], unread: [] });
    await renderWithRouter(<PodNetworkPolicies pod={API_POD} />);

    expect(
      await screen.findByText(en.readings.podIngressIsolated)
    ).toBeInTheDocument();
    expect(screen.getByText(en.readings.podEgressOpen)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /default-deny-ingress/ })
    ).toBeInTheDocument();
  });

  /** A refused read is "cannot say" in both directions, never "open". */
  it("cannot say when the policies were refused", async () => {
    answer.policies = () =>
      Promise.reject(new Error("networkpolicies is forbidden"));
    await renderWithRouter(<PodNetworkPolicies pod={API_POD} />);

    expect(
      await screen.findAllByText(en.readings.podPoliciesCannotSay)
    ).toHaveLength(2);
    expect(screen.queryByText(en.readings.podIngressOpen)).toBeNull();
  });
});
