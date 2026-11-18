/**
 * The app's own reading of the NetworkPolicies on a flow Hubble dropped as
 * POLICY_DENIED without naming a policy: a default deny names none. It is
 * read through the reader the policy pages use (`podPolicies`,
 * `peerMatch`), and says where it could not look.
 */
import type { FlowEnd, NetworkPolicyInfo, Scoped } from "@/generated/types";
import type { Known } from "@/lib/known";
import {
  peerMatch,
  podPolicies,
  type Direction,
  type LabeledNamespace,
  type LabeledPod,
  type PolicyRows,
} from "@/lib/policy-peers";

/** A pod as the Pods list reads it: its labels and the workload it is filed under. */
export interface WorkloadPod extends LabeledPod {
  workload: { kind: string; name: string } | null;
}

export type PolicyReading =
  /** A list it needs was refused or not read; `why` is the cluster's words. */
  | { says: "unread"; why: string | null }
  /** No NetworkPolicy restricts either end in the direction it would. */
  | { says: "notSelected" }
  /** `end`'s pods are selected by `policies` for `direction`, and no rule of them admits the other end. */
  | {
      says: "noRuleAdmits";
      direction: Direction;
      policies: string[];
    }
  /** A rule admits the other end on some port, or one cannot be settled here (an ipBlock, a selector Kubernetes would not build). */
  | {
      says: "unsettled";
      direction: Direction;
      policies: string[];
    };

/** The pods a flow's end is: its workload's, a CronJob's runs, or the pod itself. */
export function podsOfEnd(
  end: FlowEnd,
  pods: readonly WorkloadPod[]
): WorkloadPod[] | null {
  if (end.is !== "workload") return null;
  const { namespace, kind, name } = end.key;
  return pods.filter((pod) => {
    if (pod.namespace !== namespace) return false;
    if (kind === "Pod") return pod.name === name;
    const workload = pod.workload;
    if (!workload) return false;
    // A CronJob's runs are its Jobs, named after it and a schedule number.
    if (kind === "CronJob")
      return (
        workload.kind === "Job" &&
        workload.name.startsWith(`${name}-`) &&
        /^\d+$/.test(workload.name.slice(name.length + 1))
      );
    return workload.kind === kind && workload.name === name;
  });
}

/** One namespace's NetworkPolicies, as `podPolicies` asks for them. */
export function rowsIn(
  read: Known<Scoped<NetworkPolicyInfo>>,
  namespace: string
): PolicyRows {
  if (!read.known) return read;
  return {
    known: true,
    value: {
      rows: read.value.rows.filter((row) => row.namespace === namespace),
      unreadHere:
        read.value.unread.find((entry) => entry.namespace === namespace)
          ?.message ?? null,
    },
  };
}

type Side =
  | { says: "unread"; why: string | null }
  | { says: "open" }
  | { says: "refuses" | "unsettled"; policies: string[] };

/** What the policies over `held`'s pods say of `other`'s, in `direction`. */
function side(
  direction: Direction,
  held: readonly LabeledPod[],
  other: readonly LabeledPod[],
  policies: PolicyRows,
  namespaces: Known<LabeledNamespace[]>
): Side {
  const isolating = new Map<string, NetworkPolicyInfo>();
  for (const pod of held) {
    const over = podPolicies(pod, policies)[direction];
    if (over.state === "cannotSay") return { says: "unread", why: over.why };
    if (over.state === "isolated")
      for (const policy of over.by) isolating.set(policy.name, policy);
  }
  if (isolating.size === 0) return { says: "open" };
  let unsettled = false;
  for (const policy of isolating.values())
    for (const rule of policy[direction].rules) {
      if (rule.peers.length === 0)
        return { says: "unsettled", policies: [...isolating.keys()] };
      for (const peer of rule.peers) {
        const match = peerMatch(
          peer,
          policy.namespace,
          { known: true, value: [...other] },
          namespaces
        );
        if (match.kind === "cannotSay")
          return { says: "unread", why: match.why };
        if (match.kind === "matched" && match.pods.length > 0)
          return { says: "unsettled", policies: [...isolating.keys()] };
        if (match.kind !== "matched") unsettled = true;
      }
    }
  return {
    says: unsettled ? "unsettled" : "refuses",
    policies: [...isolating.keys()],
  };
}

/**
 * The destination's ingress first, where a denied connection is most often
 * held, then the source's egress. "Refuses" only where every rule over the
 * held pods was read and none names the other end's pods.
 */
export function policyReading(input: {
  from: readonly LabeledPod[];
  to: readonly LabeledPod[];
  /** NetworkPolicies of the destination's namespace, and of the source's. */
  toPolicies: PolicyRows;
  fromPolicies: PolicyRows;
  namespaces: Known<LabeledNamespace[]>;
}): PolicyReading {
  if (input.from.length === 0 || input.to.length === 0)
    return { says: "unread", why: null };
  const tried: Array<[Direction, Side]> = [
    [
      "ingress",
      side("ingress", input.to, input.from, input.toPolicies, input.namespaces),
    ],
    [
      "egress",
      side(
        "egress",
        input.from,
        input.to,
        input.fromPolicies,
        input.namespaces
      ),
    ],
  ];
  for (const [direction, said] of tried)
    if (said.says === "refuses")
      return { says: "noRuleAdmits", direction, policies: said.policies };
  for (const [, said] of tried)
    if (said.says === "unread") return { says: "unread", why: said.why };
  for (const [direction, said] of tried)
    if (said.says === "unsettled")
      return { says: "unsettled", direction, policies: said.policies };
  return { says: "notSelected" };
}
