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
import {
  holds,
  requirementsOf,
  type LabelSelector,
} from "@/lib/label-selector";
import { selectsPod } from "@/lib/network-policy";
import { getValueByPath } from "../kit";
import {
  directionsOf,
  enforcementOf,
  selectsNodes,
  type Enforcement,
} from "./model";

/** The prefix Cilium puts on a label it took from Kubernetes. */
const FROM_K8S = "k8s:";

/** The source a selector key has when it names none: a label from anywhere. */
const FROM_ANY = "any:";

function identityLabels(endpoint: CustomResourceInfo): string[] {
  const raw = getValueByPath(endpoint, "status.identity.labels");
  return Array.isArray(raw)
    ? raw.filter((entry) => typeof entry === "string")
    : [];
}

/** The pod's own labels, which a NetworkPolicy selects on: the `k8s:` half. */
export function labelsOf(endpoint: CustomResourceInfo): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of identityLabels(endpoint)) {
    if (!entry.startsWith(FROM_K8S)) continue;
    const [key, ...rest] = entry.slice(FROM_K8S.length).split("=");
    labels.set(key, rest.join("="));
  }
  return labels;
}

/** Every label, keyed both ways a Cilium selector names one: `k8s:app`, `any:app`. */
export function sourcedLabelsOf(
  endpoint: CustomResourceInfo
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of identityLabels(endpoint)) {
    const [sourced, ...rest] = entry.split("=");
    const value = rest.join("=");
    labels.set(sourced, value);
    const any = FROM_ANY + sourced.slice(sourced.indexOf(":") + 1);
    if (!labels.has(any)) labels.set(any, value);
  }
  return labels;
}

/** A key that names no source is one from any; verbatim, `k8s:app` matched nothing. */
const sourcedKey = (key: string) => (key.includes(":") ? key : FROM_ANY + key);

/**
 * Whether a selector picks these labels, or `null` where that cannot be
 * said: a policy with no `endpointSelector`, or one Kubernetes would refuse
 * to build. `null` puts the endpoint under "cannot say" rather than in the
 * "no policy selects it" pile a reader acts on.
 */
export function selects(
  selector: unknown,
  sourced: Map<string, string>
): boolean | null {
  return matcherOf(selector)?.(sourced) ?? null;
}

type Matcher = (sourced: Map<string, string>) => boolean;

/** A selector read once, to be asked of every endpoint; `null` as above. */
function matcherOf(selector: unknown): Matcher | null {
  if (selector === undefined || selector === null) return null;
  const requirements = requirementsOf(selector as LabelSelector)?.map(
    (requirement) => ({ ...requirement, key: sourcedKey(requirement.key) })
  );
  if (!requirements) return null;
  return (sourced) =>
    requirements.every((requirement) => holds(requirement, sourced));
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
  /** What the operator said about it. `notSaid` is not `rejected`. */
  enforcement: Enforcement["state"];
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
  /** `partly`: one direction restricted and the other open. */
  verdict: "covered" | "partly" | "onlyRejected" | "unrestricted" | "cannotSay";
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
  if (governing.some((one) => one.enforcement === "accepted")) {
    return "restricted";
  }
  // Only after the enforcing ones: a policy that works beside one that could
  // not be read still restricts the endpoint.
  if (undecided) return "cannotSay";
  // A policy the operator has not answered about may be in force.
  if (governing.some((one) => one.enforcement === "notSaid")) {
    return "cannotSay";
  }
  if (governing.length > 0) return "onlyRejected";
  return "unrestricted";
}

/** A Cilium policy read once; `picks` is `null` where its rules are unread. */
interface Prepared {
  picks: Matcher | null;
  selecting: Selecting;
}

/** `null` for a host policy: nodes, never an endpoint, a known "no". */
function prepare(
  policy: CustomResourceInfo,
  isClusterwide: boolean
): Prepared | null {
  if (selectsNodes(policy)) return null;
  const spec = policy.spec;
  return {
    picks:
      typeof spec === "object" && spec !== null
        ? matcherOf((spec as Record<string, unknown>).endpointSelector)
        : null,
    selecting: {
      kind: policy.kind,
      name: policy.name,
      namespace: policy.namespace,
      clusterwide: isClusterwide,
      enforcement: enforcementOf(policy).state,
      restricts: ciliumRestricts(policy),
    },
  };
}

function byNamespace<T, V>(
  items: T[],
  namespaceOf: (item: T) => string | null,
  read: (item: T) => V | null
): Map<string | null, V[]> {
  const groups = new Map<string | null, V[]>();
  for (const item of items) {
    const value = read(item);
    if (value === null) continue;
    const namespace = namespaceOf(item);
    const group = groups.get(namespace);
    if (group) group.push(value);
    else groups.set(namespace, [value]);
  }
  return groups;
}

export function coverageOf(
  endpoints: CustomResourceInfo[],
  policies: CustomResourceInfo[],
  clusterwide: CustomResourceInfo[],
  kubernetes: KubernetesPolicies
): Coverage[] {
  // Each policy is read once and asked only of its own namespace. Read per
  // endpoint, this was endpoints × every policy in the cluster.
  // ponytail: still one synchronous pass, ~70 ms at 5000 endpoints; a worker
  // if the rig says the picture's arrival stalls.
  const namespaced = byNamespace(
    policies,
    (policy) => policy.namespace,
    (policy) => prepare(policy, false)
  );
  const everywhere = clusterwide.flatMap(
    (policy) => prepare(policy, true) ?? []
  );
  const kubernetesIn = byNamespace(
    kubernetes.read ? kubernetes.policies : [],
    (policy) => policy.namespace,
    (policy) => policy
  );

  return endpoints.map((endpoint) => {
    const labels = labelsOf(endpoint);
    const sourced = sourcedLabelsOf(endpoint);
    const selecting: Selecting[] = [];
    let unreadable = 0;

    const consider = (one: Prepared) => {
      if (one.picks === null) unreadable += 1;
      else if (one.picks(sourced)) selecting.push(one.selecting);
    };
    namespaced.get(endpoint.namespace)?.forEach(consider);
    everywhere.forEach(consider);

    const kubernetesUnread = kubernetesUnreadFor(
      kubernetes,
      endpoint.namespace
    );
    for (const policy of kubernetesIn.get(endpoint.namespace) ?? []) {
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
        enforcement: "accepted",
        restricts: {
          ingress: policy.ingress.governed,
          egress: policy.egress.governed,
        },
      });
    }

    const undecided = unreadable > 0 || kubernetesUnread !== null;
    const directions = {
      ingress: stateOf("ingress", selecting, undecided),
      egress: stateOf("egress", selecting, undecided),
    };
    const states = DIRECTIONS.map((direction) => directions[direction]);
    // The worst direction speaks for the endpoint: an open Egress beside a
    // restricted Ingress was a green "covered".
    const verdict: Coverage["verdict"] = states.every(
      (state) => state === "restricted"
    )
      ? "covered"
      : states.includes("onlyRejected")
        ? "onlyRejected"
        : states.includes("cannotSay")
          ? "cannotSay"
          : states.includes("restricted")
            ? "partly"
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
