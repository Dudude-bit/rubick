import { describe, expect, it } from "vite-plus/test";

import type { CustomResourceInfo, NetworkPolicyInfo } from "@/generated/types";
import {
  coverageOf,
  labelsOf,
  selects,
  type KubernetesPolicies,
} from "./coverage";

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

/** A rule in each direction: a policy with none restricts nothing. */
const RULES = { ingress: [{ fromEndpoints: [{}] }], egress: [{}] };

/** Read, and none there. */
const NONE: KubernetesPolicies = { read: true, policies: [], unread: [] };

function networkPolicy(
  query: string | null,
  types: Array<"Ingress" | "Egress">
): NetworkPolicyInfo {
  const direction = (governed: boolean) => ({
    governed,
    rules: [],
    opensToEverything: false,
    deniesEverything: governed,
  });
  return {
    name: "default-deny",
    namespace: "shop",
    selects:
      query === null ? { kind: "everything" } : { kind: "written", query },
    selected: 1,
    ingress: direction(types.includes("Ingress")),
    egress: direction(types.includes("Egress")),
    labels: {},
    createdAt: null,
  };
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
        policy("shop", {
          endpointSelector: { matchLabels: { app: "api" } },
          ...RULES,
        }),
        policy("other", {
          endpointSelector: { matchLabels: { app: "api" } },
          ...RULES,
        }),
      ],
      [policy(null, { endpointSelector: {}, ...RULES })],
      NONE
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
    const rejected = policy(
      "shop",
      { endpointSelector: { matchLabels: { app: "api" } }, ...RULES },
      false
    );
    const [only] = coverageOf([API], [rejected], [], NONE);
    expect(only.verdict).toBe("onlyRejected");

    const [both] = coverageOf(
      [API],
      [
        rejected,
        policy(
          "shop",
          { endpointSelector: { matchLabels: { app: "api" } }, ...RULES },
          true
        ),
      ],
      [],
      NONE
    );
    expect(both.verdict).toBe("covered");
  });

  /** Nothing names it, and that is a fact rather than a gap. */
  it("says an endpoint nothing selects is unrestricted", () => {
    const [alone] = coverageOf(
      [API],
      [
        policy("shop", {
          endpointSelector: { matchLabels: { app: "db" } },
          ...RULES,
        }),
      ],
      [],
      NONE
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
    const [unknown] = coverageOf([API], [policy("shop", null)], [], NONE);
    expect(unknown.verdict).toBe("cannotSay");
    expect(unknown.unreadable).toBe(1);

    // And an enforcing policy still settles it: the unreadable one could only
    // add cover, never take it away.
    const [settled] = coverageOf(
      [API],
      [
        policy("shop", null),
        policy("shop", {
          endpointSelector: { matchLabels: { app: "api" } },
          ...RULES,
        }),
      ],
      [],
      NONE
    );
    expect(settled.verdict).toBe("covered");
  });

  /**
   * A host-firewall policy selects nodes by `nodeSelector` and has no
   * `endpointSelector`. Read as unreadable, one of them put every endpoint
   * in the cluster under "cannot say" and hid every unrestricted one.
   */
  it("does not let a host policy leave an endpoint undecided", () => {
    const [alone] = coverageOf(
      [API],
      [],
      [policy(null, { nodeSelector: { matchLabels: { role: "edge" } } })],
      NONE
    );
    expect(alone.unreadable).toBe(0);
    expect(alone.verdict).toBe("unrestricted");
  });

  /**
   * Restriction is per direction: a policy with only egress rules leaves
   * ingress open, and saying "covered" for both would hide that.
   */
  it("restricts only the directions a Cilium policy has rules for", () => {
    const [egressOnly] = coverageOf(
      [API],
      [
        policy("shop", {
          endpointSelector: { matchLabels: { app: "api" } },
          egress: [{}],
        }),
      ],
      [],
      NONE
    );
    expect(egressOnly.directions).toEqual({
      ingress: "unrestricted",
      egress: "restricted",
    });
  });
});

describe("the standard NetworkPolicies Cilium also enforces", () => {
  /**
   * Cilium enforces `networking.k8s.io` NetworkPolicy. Read only through its
   * own kinds, a pod under default-deny was "unrestricted" while a pod beside
   * it timed out reaching it. Fails if NetworkPolicies are left out again.
   */
  it("restricts a pod selected only by a NetworkPolicy in that direction", () => {
    const kubernetes: KubernetesPolicies = {
      read: true,
      policies: [networkPolicy(null, ["Ingress"])],
      unread: [],
    };
    const [api] = coverageOf([API], [], [], kubernetes);
    expect(api.directions).toEqual({
      ingress: "restricted",
      egress: "unrestricted",
    });
    expect(api.verdict).toBe("partly");
    expect(api.selecting.map((one) => one.kind)).toEqual(["NetworkPolicy"]);
  });

  /** A NetworkPolicy reaches only its own namespace and its own selector. */
  it("leaves a pod its NetworkPolicy does not select unrestricted", () => {
    const elsewhere: KubernetesPolicies = {
      read: true,
      policies: [
        { ...networkPolicy(null, ["Ingress"]), namespace: "other" },
        networkPolicy("app=db", ["Ingress", "Egress"]),
      ],
      unread: [],
    };
    const [api] = coverageOf([API], [], [], elsewhere);
    expect(api.verdict).toBe("unrestricted");
  });

  /**
   * The thesis, on this page: NetworkPolicies nobody could read are not "no
   * NetworkPolicies". Fails if the refused read stops making the endpoint
   * undecided.
   */
  it("cannot say rather than call a pod unrestricted when the read was refused", () => {
    const refused: KubernetesPolicies = {
      read: false,
      why: "networkpolicies is forbidden",
    };
    const [api] = coverageOf([API], [], [], refused);
    expect(api.verdict).toBe("cannotSay");
    expect(api.directions).toEqual({
      ingress: "cannotSay",
      egress: "cannotSay",
    });
    expect(api.kubernetesUnread).toBe("networkpolicies is forbidden");

    // A namespace left unread counts the same as the whole read refused.
    const [partly] = coverageOf([API], [], [], {
      read: true,
      policies: [],
      unread: [{ namespace: "shop", code: "FORBIDDEN", message: "denied" }],
    });
    expect(partly.verdict).toBe("cannotSay");
  });

  /** A Cilium policy that restricts still settles its own direction. */
  it("keeps a direction a Cilium policy restricts while NetworkPolicies are unread", () => {
    const [api] = coverageOf(
      [API],
      [
        policy("shop", {
          endpointSelector: { matchLabels: { app: "api" } },
          ingress: [{}],
        }),
      ],
      [],
      { read: false, why: "forbidden" }
    );
    expect(api.directions).toEqual({
      ingress: "restricted",
      egress: "cannotSay",
    });
    expect(api.verdict).toBe("cannotSay");
  });

  /**
   * The worst direction speaks for the row: one restricted way in beside an
   * egress only a rejected policy meant to close is the rejected finding.
   */
  it("lets a rejected direction outweigh a restricted one", () => {
    const [api] = coverageOf(
      [API],
      [
        policy("shop", {
          endpointSelector: { matchLabels: { app: "api" } },
          ingress: [{}],
        }),
        policy(
          "shop",
          { endpointSelector: { matchLabels: { app: "api" } }, egress: [{}] },
          false
        ),
      ],
      [],
      NONE
    );
    expect(api.verdict).toBe("onlyRejected");
  });
});
