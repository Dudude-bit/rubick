import { describe, expect, it } from "vite-plus/test";

import type { CustomResourceInfo } from "@/generated/types";
import {
  GROUP,
  KINDS,
  countUnrestricted,
  coverageTone,
  pictureCoverage,
} from "./data";

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
      kubernetes: { read: true as const, policies: [], unread: [] },
    };
    expect(countUnrestricted(picture)).toBe(0);
    expect(coverageTone(picture)).toBe("unchecked");
    expect(coverageTone({ ...picture, policies: [] })).toBeNull();
  });

  /**
   * The number beside the page reads the same join: a policy whose selector
   * key names its source covers the endpoint here too. Fails if the sidebar
   * counts an endpoint the page calls covered.
   */
  it("does not count an endpoint selected by a key written with its source", () => {
    const endpoint = {
      name: "api",
      namespace: "shop",
      kind: "CiliumEndpoint",
      spec: null,
      status: { identity: { id: 1, labels: ["k8s:app=api"] } },
    } as CustomResourceInfo;
    const policy = {
      name: "p",
      namespace: "shop",
      kind: "CiliumNetworkPolicy",
      spec: {
        endpointSelector: { matchLabels: { "k8s:app": "api" } },
        ingress: [{}],
        egress: [{}],
      },
      status: { conditions: [{ type: "Valid", status: "True" }] },
    } as CustomResourceInfo;
    const picture = {
      endpoints: [endpoint],
      policies: [policy],
      clusterwide: [],
      kubernetes: { read: true as const, policies: [], unread: [] },
    };
    expect(countUnrestricted(picture)).toBe(0);
    expect(coverageTone(picture)).toBeNull();
    // And it is the selector that covers it, not an empty picture.
    expect(countUnrestricted({ ...picture, policies: [] })).toBe(1);
  });

  /**
   * The page, the number and the dot read one join: at 5000 pods it is too
   * slow to run three times. Fails if a picture is joined again per reader,
   * or if a new picture is answered with the old one's rows.
   */
  it("joins a picture once, and a new picture again", () => {
    const picture = {
      endpoints: [
        {
          name: "api",
          namespace: "shop",
          kind: "CiliumEndpoint",
          spec: null,
          status: { identity: { id: 1, labels: ["k8s:app=api"] } },
        } as CustomResourceInfo,
      ],
      policies: [],
      clusterwide: [],
      kubernetes: { read: true as const, policies: [], unread: [] },
    };
    expect(pictureCoverage(picture)).toBe(pictureCoverage(picture));
    const refetched = { ...picture, endpoints: [] };
    expect(pictureCoverage(refetched)).toEqual([]);
    expect(pictureCoverage(picture)).toHaveLength(1);
  });

  /**
   * A policy the agent has not answered about is not a rejected one: the
   * endpoint it selects is left out of the count and the dot says so. It
   * was counted as "selected only by rejected policies" on every cluster
   * whose Cilium writes no `Valid` condition.
   */
  it("leaves out an endpoint whose only policy the agent has not answered about", () => {
    const endpoint = {
      name: "api",
      namespace: "shop",
      kind: "CiliumEndpoint",
      spec: null,
      status: { identity: { id: 1, labels: ["k8s:app=api"] } },
    } as CustomResourceInfo;
    const policy = (conditions: unknown[]) =>
      ({
        name: "p",
        namespace: "shop",
        kind: "CiliumNetworkPolicy",
        spec: { endpointSelector: {}, ingress: [{}], egress: [{}] },
        status: { conditions },
      }) as CustomResourceInfo;
    const picture = (conditions: unknown[]) => ({
      endpoints: [endpoint],
      policies: [policy(conditions)],
      clusterwide: [],
      kubernetes: { read: true as const, policies: [], unread: [] },
    });
    expect(countUnrestricted(picture([]))).toBe(0);
    expect(coverageTone(picture([]))).toBe("unchecked");
    // A rejection the agent did write is still counted.
    const rejected = picture([{ type: "Valid", status: "False" }]);
    expect(countUnrestricted(rejected)).toBe(1);
    expect(coverageTone(rejected)).toBeNull();
  });

  /**
   * A refused NetworkPolicy read is not "no NetworkPolicies": the count must
   * not take the endpoint as unrestricted, and the dot says it left it out.
   */
  it("leaves out an endpoint whose NetworkPolicies were refused", () => {
    const endpoint = {
      name: "api",
      namespace: "shop",
      kind: "CiliumEndpoint",
      spec: null,
      status: { identity: { id: 1, labels: ["k8s:app=api"] } },
    } as CustomResourceInfo;
    const picture = {
      endpoints: [endpoint],
      policies: [],
      clusterwide: [],
      kubernetes: { read: false as const, why: "forbidden" },
    };
    expect(countUnrestricted(picture)).toBe(0);
    expect(coverageTone(picture)).toBe("unchecked");
  });
});
