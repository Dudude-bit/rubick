/**
 * Which endpoints a policy actually selects, and — the question nobody else
 * in this app can answer — which endpoints no policy selects at all.
 *
 * A `CiliumNetworkPolicy` names labels; a `CiliumEndpoint` carries the
 * labels Cilium itself resolved for a pod. Joining the two is the only way
 * to turn "there are four policies" into "this pod is covered by two of
 * them, and that one by none". A vanilla list of either side cannot say it.
 *
 * Cilium enforces the standard `networking.k8s.io` NetworkPolicy as well,
 * so those are joined too, and a cluster whose NetworkPolicies could not be
 * read has no endpoint here that is unrestricted, only ones it cannot say.
 *
 * The answer is per direction: a default-deny on ingress says nothing about
 * where the pod may connect to.
 */

import type {
  CustomResourceInfo,
  NetworkPolicyInfo,
  UnreadNamespace,
} from "@/generated/types";
import { labelSelectorMatches, type LabelSelector } from "@/lib/label-selector";
import { selectsPod } from "@/lib/network-policy";
import { getValueByPath } from "../kit";
import { directionsOf, enforcementOf, selectsNodes } from "./model";

/** The prefix Cilium puts on a label it took from Kubernetes. */
const FROM_K8S = "k8s:";

/** A pod's labels as Cilium resolved them, without its own prefixes. */
export function labelsOf(endpoint: CustomResourceInfo): Map<string, string> {
  const raw = getValueByPath(endpoint, "status.identity.labels");
  const labels = new Map<string, string>();
  if (!Array.isArray(raw)) return labels;
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.startsWith(FROM_K8S)) continue;
    const [key, ...rest] = entry.slice(FROM_K8S.length).split("=");
    labels.set(key, rest.join("="));
  }
  return labels;
}

/**
 * Whether a selector picks these labels, or `null` where that cannot be
 * said: a policy with no `endpointSelector`, or one Kubernetes would refuse
 * to build. `null` puts the endpoint under "cannot say" rather than in the
 * "no policy selects it" pile a reader acts on.
 */
export function selects(
  selector: unknown,
  labels: Map<string, string>
): boolean | null {
  if (selector === undefined || selector === null) return null;
  return labelSelectorMatches(selector as LabelSelector, labels);
}

export type Direction = "ingress" | "egress";
export const DIRECTIONS: readonly Direction[] = ["ingress", "egress"];

/** The standard NetworkPolicies as read, or why they could not be. */
export type KubernetesPolicies =
  | { read: true; policies: NetworkPolicyInfo[]; unread: UnreadNamespace[] }
  | { read: false; why: string };

/** One policy that selects an endpoint, and what it does to it. */
export interface Selecting {
  kind: string;
  name: string;
  namespace: string | null;
  clusterwide: boolean;
  enforcing: boolean;
  /** The directions this policy puts the endpoint under policy for. */
  restricts: Record<Direction, boolean>;
}

/**
 * One direction, in four answers. `cannotSay` is a policy that might select
 * the endpoint and could not be read, and it never reads as `unrestricted`.
 */
export type DirectionState =
  | "restricted"
  | "onlyRejected"
  | "unrestricted"
  | "cannotSay";

export interface Coverage {
  endpoint: CustomResourceInfo;
  selecting: Selecting[];
  /**
   * A policy that selects this endpoint, or might, and could not be read —
   * its rules are written where this app cannot see them. One of these makes
   * every "no policy selects it" below a guess.
   */
  unreadable: number;
  /** Why this namespace's NetworkPolicies are unknown; `null` once read. */
  kubernetesUnread: string | null;
  directions: Record<Direction, DirectionState>;
  verdict: "covered" | "onlyRejected" | "unrestricted" | "cannotSay";
}

/**
 * A Cilium policy restricts a direction it has rules for, unless it opts
 * out of the default deny for that direction.
 */
function ciliumRestricts(
  policy: CustomResourceInfo
): Record<Direction, boolean> {
  const rules = directionsOf(policy);
  const optOut = getValueByPath(policy, "spec.enableDefaultDeny") as
    | Partial<Record<Direction, unknown>>
    | undefined;
  return {
    ingress: (rules?.ingress ?? 0) > 0 && optOut?.ingress !== false,
    egress: (rules?.egress ?? 0) > 0 && optOut?.egress !== false,
  };
}

function kubernetesUnreadFor(
  kubernetes: KubernetesPolicies,
  namespace: string | null
): string | null {
  if (!kubernetes.read) return kubernetes.why;
  return (
    kubernetes.unread.find((entry) => entry.namespace === namespace)?.message ??
    null
  );
}

function stateOf(
  direction: Direction,
  selecting: Selecting[],
  undecided: boolean
): DirectionState {
  const governing = selecting.filter((one) => one.restricts[direction]);
  if (governing.some((one) => one.enforcing)) return "restricted";
  // Only after the enforcing ones: a policy that works beside one that could
  // not be read still restricts the endpoint.
  if (undecided) return "cannotSay";
  if (governing.length > 0) return "onlyRejected";
  return "unrestricted";
}

export function coverageOf(
  endpoints: CustomResourceInfo[],
  policies: CustomResourceInfo[],
  clusterwide: CustomResourceInfo[],
  kubernetes: KubernetesPolicies
): Coverage[] {
  return endpoints.map((endpoint) => {
    const labels = labelsOf(endpoint);
    const selecting: Selecting[] = [];
    let unreadable = 0;

    const consider = (policy: CustomResourceInfo, isClusterwide: boolean) => {
      if (!isClusterwide && policy.namespace !== endpoint.namespace) return;
      // Nodes, never an endpoint: a known "no", not an unread rule.
      if (selectsNodes(policy)) return;
      const spec = policy.spec;
      if (typeof spec !== "object" || spec === null) {
        unreadable += 1;
        return;
      }
      const answer = selects(
        (spec as Record<string, unknown>).endpointSelector,
        labels
      );
      if (answer === null) {
        unreadable += 1;
        return;
      }
      if (!answer) return;
      selecting.push({
        kind: policy.kind,
        name: policy.name,
        namespace: policy.namespace,
        clusterwide: isClusterwide,
        enforcing: enforcementOf(policy).state === "accepted",
        restricts: ciliumRestricts(policy),
      });
    };

    for (const policy of policies) consider(policy, false);
    for (const policy of clusterwide) consider(policy, true);

    const kubernetesUnread = kubernetesUnreadFor(
      kubernetes,
      endpoint.namespace
    );
    if (kubernetes.read) {
      for (const policy of kubernetes.policies) {
        const answer = selectsPod(policy, {
          namespace: endpoint.namespace,
          labels,
        });
        if (answer === null) {
          unreadable += 1;
          continue;
        }
        if (!answer) continue;
        selecting.push({
          kind: "NetworkPolicy",
          name: policy.name,
          namespace: policy.namespace,
          clusterwide: false,
          // Nothing reports a NetworkPolicy as rejected: Cilium enforces it.
          enforcing: true,
          restricts: {
            ingress: policy.ingress.governed,
            egress: policy.egress.governed,
          },
        });
      }
    }

    const undecided = unreadable > 0 || kubernetesUnread !== null;
    const directions = {
      ingress: stateOf("ingress", selecting, undecided),
      egress: stateOf("egress", selecting, undecided),
    };
    const states = DIRECTIONS.map((direction) => directions[direction]);
    const verdict: Coverage["verdict"] = states.includes("restricted")
      ? "covered"
      : states.includes("cannotSay")
        ? "cannotSay"
        : states.includes("onlyRejected")
          ? "onlyRejected"
          : "unrestricted";

    return {
      endpoint,
      selecting,
      unreadable,
      kubernetesUnread,
      directions,
      verdict,
    };
  });
}
