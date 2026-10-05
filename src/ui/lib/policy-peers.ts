/**
 * Who a NetworkPolicy is about, resolved to the pods and namespaces it
 * names, and which policies are about one pod.
 *
 * Rust counts the pods a policy selects; this answers the two questions the
 * count cannot: which pods a rule's peer lets through, and, from the pod's
 * side, who may reach it. Every answer carries whether its inputs were read,
 * so a refused pod list is "cannot say", never "no pods".
 */

import type { NetworkPolicyInfo, PolicyPeer } from "@/generated/types";
import {
  labelSelectorMatches,
  selectorFromQuery,
  type Labels,
} from "@/lib/label-selector";
import type { Known } from "@/lib/known";
import { selectsPod } from "@/lib/network-policy";

export interface LabeledPod {
  name: string;
  namespace: string;
  labels: Labels;
}

export interface LabeledNamespace {
  name: string;
  labels: Labels;
}

/** Whether a peer reaches past the policy's own namespace. */
export const leavesNamespace = (peer: PolicyPeer): boolean =>
  !peer.ipBlock && peer.namespaces.kind !== "notSaid";

export type PeerMatch =
  | { kind: "ipBlock" }
  | {
      kind: "matched";
      /** `null` is every namespace in the cluster. */
      namespaces: string[] | null;
      pods: LabeledPod[];
      /** The pod selector as text, `null` for every pod. */
      selector: string | null;
    }
  /** A list it needs was refused, or (`why: null`) is still being read. */
  | { kind: "cannotSay"; why: string | null }
  /** A selector Kubernetes would not build, which no read can settle. */
  | { kind: "unevaluable" };

/**
 * The pods one peer names. `pods` holds the policy's own namespace when the
 * peer stays in it, and the whole cluster's pods when it does not.
 */
export function peerMatch(
  peer: PolicyPeer,
  home: string,
  pods: Known<LabeledPod[]>,
  namespaces: Known<LabeledNamespace[]>
): PeerMatch {
  if (peer.ipBlock) return { kind: "ipBlock" };

  let inNamespaces: string[] | null;
  switch (peer.namespaces.kind) {
    case "notSaid":
      inNamespaces = [home];
      break;
    case "everything":
      inNamespaces = null;
      break;
    case "written": {
      const selector = selectorFromQuery(peer.namespaces.query);
      if (!selector) return { kind: "unevaluable" };
      if (!namespaces.known) return { kind: "cannotSay", why: namespaces.why };
      const picked: string[] = [];
      for (const namespace of namespaces.value) {
        const answer = labelSelectorMatches(selector, namespace.labels);
        if (answer === null) return { kind: "unevaluable" };
        if (answer) picked.push(namespace.name);
      }
      inNamespaces = picked;
    }
  }

  const query = peer.pods.kind === "written" ? peer.pods.query : null;
  const selector = query === null ? {} : selectorFromQuery(query);
  if (!selector) return { kind: "unevaluable" };
  if (!pods.known) return { kind: "cannotSay", why: pods.why };

  const matched: LabeledPod[] = [];
  for (const pod of pods.value) {
    if (inNamespaces && !inNamespaces.includes(pod.namespace)) continue;
    const answer = labelSelectorMatches(selector, pod.labels);
    if (answer === null) return { kind: "unevaluable" };
    if (answer) matched.push(pod);
  }
  return {
    kind: "matched",
    namespaces: inNamespaces,
    pods: matched,
    selector: query,
  };
}

export type Direction = "ingress" | "egress";

/** What one direction of one pod is under. */
export type PodDirection =
  /** No policy here restricts it: anything may reach it, or it may reach anything. */
  | { state: "open" }
  /** Policies restrict it; only their rules let traffic through. */
  | { state: "isolated"; by: NetworkPolicyInfo[] }
  | { state: "cannotSay"; why: string | null };

export interface PodPolicies {
  selecting: NetworkPolicyInfo[];
  /** Policies whose selector could not be evaluated against this pod. */
  undecided: NetworkPolicyInfo[];
  ingress: PodDirection;
  egress: PodDirection;
}

function directionOf(
  which: Direction,
  selecting: NetworkPolicyInfo[],
  undecided: NetworkPolicyInfo[]
): PodDirection {
  const by = selecting.filter((policy) => policy[which].governed);
  // One policy that isolates settles it; an undecided one could only add
  // rules, never take the isolation away.
  if (by.length > 0) return { state: "isolated", by };
  if (undecided.length > 0) return { state: "cannotSay", why: null };
  return { state: "open" };
}

/** The NetworkPolicies that select one pod, per direction. */
export function podPolicies(
  pod: { namespace: string; labels: Labels },
  policies: Known<{ rows: NetworkPolicyInfo[]; unreadHere: string | null }>
): PodPolicies {
  if (!policies.known || policies.value.unreadHere !== null) {
    const why = policies.known ? policies.value.unreadHere : policies.why;
    const cannot: PodDirection = { state: "cannotSay", why };
    return { selecting: [], undecided: [], ingress: cannot, egress: cannot };
  }
  const selecting: NetworkPolicyInfo[] = [];
  const undecided: NetworkPolicyInfo[] = [];
  for (const policy of policies.value.rows) {
    const answer = selectsPod(policy, pod);
    if (answer === null) undecided.push(policy);
    else if (answer) selecting.push(policy);
  }
  return {
    selecting,
    undecided,
    ingress: directionOf("ingress", selecting, undecided),
    egress: directionOf("egress", selecting, undecided),
  };
}
