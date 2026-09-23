import { describe, expect, it } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import { GROUP, KINDS, countUnrestricted, coverageTone } from "./data";

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

describe("the sidebar's number for Cilium", () => {
  /**
   * The count leaves out an endpoint whose covering policy could not be read,
   * and nothing beside it said so: an undecided endpoint read as a restricted
   * one. Fails if the dot stops marking what the count left out.
   */
  it("marks the count unchecked while an endpoint cannot be decided", () => {
    const endpoint = {
      name: "api",
      namespace: "shop",
      kind: "CiliumEndpoint",
      spec: null,
      status: { identity: { id: 1, labels: ["k8s:app=api"] } },
    } as CustomResourceInfo;
    const unreadable = {
      name: "p",
      namespace: "shop",
      kind: "CiliumNetworkPolicy",
      spec: null,
      status: { conditions: [{ type: "Valid", status: "True" }] },
    } as CustomResourceInfo;

    const picture = {
      endpoints: [endpoint],
      policies: [unreadable],
      clusterwide: [],
    };
    expect(countUnrestricted(picture)).toBe(0);
    expect(coverageTone(picture)).toBe("unchecked");
    expect(coverageTone({ ...picture, policies: [] })).toBeNull();
  });
});
