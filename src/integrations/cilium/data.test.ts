import { describe, expect, it } from "vitest";

import { GROUP, KINDS } from "./data";

describe("the kinds this vendor asks the cluster for", () => {
  /**
   * These strings are the only ones the API server has to recognise, and a
   * typo in one comes back as an empty list — which the row would report as
   * "0 network policies" over a cluster full of them. Recorded from
   * `kubectl get crd` on Cilium 1.20.1; nothing else in the app checks them.
   */
  it("names the plurals Cilium's CRDs actually declare", () => {
    expect(GROUP).toBe("cilium.io");
    expect(KINDS.policies).toBe("ciliumnetworkpolicies.cilium.io");
    expect(KINDS.clusterwide).toBe(
      "ciliumclusterwidenetworkpolicies.cilium.io"
    );
  });
});
