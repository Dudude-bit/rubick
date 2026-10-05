import { describe, expect, it } from "vite-plus/test";

import type {
  NetworkPolicyInfo,
  PolicyDirection,
  PolicyPeer,
} from "@/generated/types";
import type { Known } from "./known";
import {
  peerMatch,
  podPolicies,
  type LabeledNamespace,
  type LabeledPod,
} from "./policy-peers";

const direction = (
  governed: boolean,
  peers: PolicyPeer[] = []
): PolicyDirection => ({
  governed,
  rules: peers.length > 0 ? [{ peers, ports: [] }] : [],
  opensToEverything: false,
  deniesEverything: governed && peers.length === 0,
});

/** The persona cluster's two policies in `net`. */
const DEFAULT_DENY: NetworkPolicyInfo = {
  name: "default-deny-ingress",
  namespace: "net",
  selects: { kind: "everything" },
  selected: 4,
  ingress: direction(true),
  egress: direction(false),
  labels: {},
  createdAt: null,
};

const FRONTEND: PolicyPeer = {
  pods: { kind: "written", query: "role=frontend" },
  namespaces: { kind: "notSaid" },
  ipBlock: null,
};

const API_FROM_FRONTEND: NetworkPolicyInfo = {
  ...DEFAULT_DENY,
  name: "api-from-frontend",
  selects: { kind: "written", query: "app=api" },
  selected: 2,
  ingress: direction(true, [FRONTEND]),
};

const PODS: LabeledPod[] = [
  { name: "web-1", namespace: "net", labels: { app: "web", role: "frontend" } },
  { name: "web-2", namespace: "net", labels: { app: "web", role: "frontend" } },
  { name: "api-1", namespace: "net", labels: { app: "api" } },
  { name: "shop-1", namespace: "shop", labels: { role: "frontend" } },
];

const read = <V>(value: V): Known<V> => ({ known: true, value });

describe("who a NetworkPolicy peer names", () => {
  /** "may web talk to api": the peer resolves to the two web pods. */
  it("resolves a pod selector in the policy's own namespace", () => {
    const match = peerMatch(FRONTEND, "net", read(PODS), read([]));
    expect(match.kind).toBe("matched");
    if (match.kind !== "matched") return;
    expect(match.pods.map((pod) => pod.name)).toEqual(["web-1", "web-2"]);
    expect(match.namespaces).toEqual(["net"]);
  });

  it("follows a namespaceSelector to the namespaces it matches", () => {
    const match = peerMatch(
      { ...FRONTEND, namespaces: { kind: "written", query: "team=shop" } },
      "net",
      read(PODS),
      read<LabeledNamespace[]>([
        { name: "shop", labels: { team: "shop" } },
        { name: "net", labels: {} },
      ])
    );
    expect(match.kind === "matched" && match.pods.map((p) => p.name)).toEqual([
      "shop-1",
    ]);
  });

  /**
   * A refused read is not "no pod matches". Fails if either list's refusal
   * is answered with an empty match.
   */
  it("cannot say when the pods or the namespaces were not read", () => {
    expect(
      peerMatch(FRONTEND, "net", { known: false, why: "forbidden" }, read([]))
    ).toEqual({ kind: "cannotSay", why: "forbidden" });
    expect(
      peerMatch(
        { ...FRONTEND, namespaces: { kind: "written", query: "team=shop" } },
        "net",
        read(PODS),
        { known: false, why: "namespaces is forbidden" }
      )
    ).toEqual({ kind: "cannotSay", why: "namespaces is forbidden" });
  });

  /** A selector no read can settle is said apart from a list not read. */
  it("calls a selector it cannot build unevaluable, not unread", () => {
    expect(
      peerMatch(
        { ...FRONTEND, pods: { kind: "written", query: "app in (" } },
        "net",
        read(PODS),
        read([])
      )
    ).toEqual({ kind: "unevaluable" });
  });

  it("leaves an IP block as the CIDR it is", () => {
    expect(
      peerMatch(
        { ...FRONTEND, ipBlock: { cidr: "10.0.0.0/8", except: [] } },
        "net",
        read(PODS),
        read([])
      )
    ).toEqual({ kind: "ipBlock" });
  });
});

describe("the policies that select one pod", () => {
  const rows = read({
    rows: [DEFAULT_DENY, API_FROM_FRONTEND],
    unreadHere: null,
  });

  /** api pods: ingress isolated by both policies, egress untouched. */
  it("isolates a direction a selecting policy names and leaves the other open", () => {
    const api = podPolicies({ namespace: "net", labels: { app: "api" } }, rows);
    expect(api.ingress.state).toBe("isolated");
    if (api.ingress.state === "isolated") {
      expect(api.ingress.by.map((policy) => policy.name)).toEqual([
        "default-deny-ingress",
        "api-from-frontend",
      ]);
    }
    expect(api.egress).toEqual({ state: "open" });
  });

  /**
   * The thesis on the Pod page: policies nobody could read are not "no
   * policy". Fails if a refused or partial read reads as open.
   */
  it("cannot say when the namespace's policies were not read", () => {
    const pod = { namespace: "net", labels: { app: "api" } };
    const refused = podPolicies(pod, { known: false, why: "forbidden" });
    expect(refused.ingress).toEqual({ state: "cannotSay", why: "forbidden" });
    expect(refused.egress).toEqual({ state: "cannotSay", why: "forbidden" });

    const partly = podPolicies(
      pod,
      read({ rows: [], unreadHere: "networkpolicies is forbidden" })
    );
    expect(partly.ingress.state).toBe("cannotSay");
  });

  it("leaves a pod in another namespace alone", () => {
    const elsewhere = podPolicies(
      { namespace: "shop", labels: { app: "api" } },
      rows
    );
    expect(elsewhere.ingress).toEqual({ state: "open" });
  });
});
