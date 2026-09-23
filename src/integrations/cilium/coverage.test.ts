import { describe, expect, it } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import { coverageOf, labelsOf, selects } from "./coverage";

/** Shapes recorded from Cilium 1.20.1 on a kind cluster. */
function endpoint(namespace: string, labels: string[]): CustomResourceInfo {
  return {
    name: "pod",
    namespace,
    kind: "CiliumEndpoint",
    spec: null,
    status: { identity: { id: 17798, labels } },
  } as CustomResourceInfo;
}

function policy(
  namespace: string | null,
  spec: unknown,
  valid = true
): CustomResourceInfo {
  return {
    name: "p",
    namespace,
    kind: namespace ? "CiliumNetworkPolicy" : "CiliumClusterwideNetworkPolicy",
    spec,
    status: {
      conditions: [{ type: "Valid", status: valid ? "True" : "False" }],
    },
  } as CustomResourceInfo;
}

const API = endpoint("shop", [
  "k8s:app=api",
  "k8s:io.kubernetes.pod.namespace=shop",
  "reserved:init",
]);

describe("the labels a policy is matched against", () => {
  /**
   * Cilium prefixes what it took from Kubernetes with `k8s:` and mixes in
   * its own (`reserved:`, `container:`). A selector names a Kubernetes
   * label, so only that half may be matched — taking `reserved:init` for a
   * pod label would let a selector match on something no manifest wrote.
   */
  it("keeps the pod's own labels and drops Cilium's", () => {
    expect([...labelsOf(API)]).toEqual([
      ["app", "api"],
      ["io.kubernetes.pod.namespace", "shop"],
    ]);
    expect(labelsOf(endpoint("shop", []))).toEqual(new Map());
  });
});

describe("whether a selector picks an endpoint", () => {
  const labels = labelsOf(API);

  it("reads matchLabels and every expression operator", () => {
    expect(selects({}, labels)).toBe(true);
    expect(selects({ matchLabels: { app: "api" } }, labels)).toBe(true);
    expect(selects({ matchLabels: { app: "db" } }, labels)).toBe(false);
    expect(
      selects(
        { matchExpressions: [{ key: "app", operator: "Exists" }] },
        labels
      )
    ).toBe(true);
    expect(
      selects(
        { matchExpressions: [{ key: "tier", operator: "DoesNotExist" }] },
        labels
      )
    ).toBe(true);
    expect(
      selects(
        {
          matchExpressions: [
            { key: "app", operator: "In", values: ["api", "web"] },
          ],
        },
        labels
      )
    ).toBe(true);
    expect(
      selects(
        {
          matchExpressions: [
            { key: "app", operator: "NotIn", values: ["api"] },
          ],
        },
        labels
      )
    ).toBe(false);
  });

  /**
   * An operator this app does not implement is not one it may answer "no"
   * to. `false` would put the endpoint in the "no policy selects it" pile,
   * which is the reading a reader acts on. `NotIn ()` was answered "yes",
   * which filed every endpoint under a policy Kubernetes would not build.
   */
  it("answers a selector it cannot evaluate with neither yes nor no", () => {
    expect(
      selects(
        { matchExpressions: [{ key: "app", operator: "NotIn", values: [] }] },
        labels
      )
    ).toBeNull();
    expect(
      selects(
        { matchExpressions: [{ key: "app", operator: "Superset" }] },
        labels
      )
    ).toBeNull();
    expect(selects(null, labels)).toBeNull();
    expect(selects("everything", labels)).toBeNull();
  });
});

describe("what covers an endpoint", () => {
  /** A namespaced policy stops at its namespace; a cluster-wide one does not. */
  it("respects the namespace a policy was written in", () => {
    const [shop] = coverageOf(
      [API],
      [
        policy("shop", { endpointSelector: { matchLabels: { app: "api" } } }),
        policy("other", { endpointSelector: { matchLabels: { app: "api" } } }),
      ],
      [policy(null, { endpointSelector: {} })]
    );

    expect(shop.selecting).toHaveLength(2);
    expect(shop.selecting.filter((one) => one.clusterwide)).toHaveLength(1);
    expect(shop.verdict).toBe("covered");
  });

  /**
   * The finding the page exists for. Policies name this endpoint, they are
   * in every list, and the operator threw all of them away — so it reads as
   * covered to a person and is not covered at all.
   */
  it("tells an endpoint covered only by rejected policies from a covered one", () => {
    const [only] = coverageOf(
      [API],
      [
        policy(
          "shop",
          { endpointSelector: { matchLabels: { app: "api" } } },
          false
        ),
      ],
      []
    );
    expect(only.verdict).toBe("onlyRejected");

    const [both] = coverageOf(
      [API],
      [
        policy(
          "shop",
          { endpointSelector: { matchLabels: { app: "api" } } },
          false
        ),
        policy(
          "shop",
          { endpointSelector: { matchLabels: { app: "api" } } },
          true
        ),
      ],
      []
    );
    expect(both.verdict).toBe("covered");
  });

  /** Nothing names it, and that is a fact rather than a gap. */
  it("says an endpoint nothing selects is unrestricted", () => {
    const [alone] = coverageOf(
      [API],
      [policy("shop", { endpointSelector: { matchLabels: { app: "db" } } })],
      []
    );
    expect(alone.verdict).toBe("unrestricted");
    expect(alone.selecting).toEqual([]);
  });

  /**
   * A policy written as `specs:` arrives with no spec, so whether it selects
   * this endpoint is unknown — and one of those makes "nothing selects it" a
   * guess. Fails if an unreadable policy is counted as not selecting.
   */
  it("will not call an endpoint unrestricted while a policy is unreadable", () => {
    const [unknown] = coverageOf([API], [policy("shop", null)], []);
    expect(unknown.verdict).toBe("cannotSay");
    expect(unknown.unreadable).toBe(1);

    // And an enforcing policy still settles it: the unreadable one could only
    // add cover, never take it away.
    const [settled] = coverageOf(
      [API],
      [
        policy("shop", null),
        policy("shop", { endpointSelector: { matchLabels: { app: "api" } } }),
      ],
      []
    );
    expect(settled.verdict).toBe("covered");
  });
});
