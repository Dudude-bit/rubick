/**
 * What a Cilium policy says, read from the object rather than from its name.
 *
 * The one fact a vanilla list of these cannot give: **a policy Cilium
 * rejected is still an object.** It has a name, an age and a spec; it
 * enforces nothing, and the only place that is written down is a condition
 * inside its status.
 *
 * Everything else here answers in three parts, because a Cilium policy can
 * be written in more than one shape and only one of them crosses the IPC
 * boundary. `CustomResourceInfo` carries `spec` and `status` and nothing
 * else, so a policy written as a top-level `specs:` list — which the API
 * server accepts, and which the agent marks `Valid` — arrives here with no
 * spec at all. Answering that with a count of zero would say "this policy
 * has no rules" about a policy full of them.
 */

import type { CustomResourceInfo } from "@/generated/types";
import { conditionOf, getValueByPath } from "../kit";

/** Whether the operator accepted this policy, and what it said if it did not. */
export type Enforcement =
  | { state: "accepted" }
  | { state: "rejected"; why: string | null }
  /**
   * The operator has not answered about this policy yet, which is not the
   * same as it having accepted one. A policy written a second ago and a
   * policy nothing is watching both look like this.
   */
  | { state: "notSaid" };

export function enforcementOf(policy: CustomResourceInfo): Enforcement {
  const valid = conditionOf(policy, "Valid");
  if (!valid) return { state: "notSaid" };
  if (valid.status === "True") return { state: "accepted" };
  // `Unknown` is not a rejection. Cilium writes `False` when it threw the
  // policy away; anything else is the operator not having decided.
  if (valid.status === "False") {
    return { state: "rejected", why: valid.message ?? null };
  }
  return { state: "notSaid" };
}

/**
 * Whether the rules are somewhere this app can read them.
 *
 * `specs:` is a legal and accepted shape — a policy written that way is
 * `Valid: True` and enforcing — and it does not cross the IPC boundary. So
 * is a host policy's `nodeSelector`. Every reader below asks this first.
 */
function specIsHere(policy: CustomResourceInfo): boolean {
  return (
    typeof policy.spec === "object" &&
    policy.spec !== null &&
    !Array.isArray(policy.spec)
  );
}

/** Which way a rule runs, or `null` where the rules are not on the wire. */
export interface Directions {
  ingress: number;
  egress: number;
  /** Deny rules are counted apart: one changes what every allow above means. */
  denies: number;
}

export function directionsOf(policy: CustomResourceInfo): Directions | null {
  if (!specIsHere(policy)) return null;
  const at = (path: string) => {
    const rules = getValueByPath(policy, path);
    return Array.isArray(rules) ? rules.length : 0;
  };
  return {
    ingress: at("spec.ingress") + at("spec.ingressDeny"),
    egress: at("spec.egress") + at("spec.egressDeny"),
    denies: at("spec.ingressDeny") + at("spec.egressDeny"),
  };
}

/**
 * What the policy selects.
 *
 * Four answers. An **empty** `endpointSelector` is Cilium's "every endpoint
 * in scope" — on a cluster-wide policy, the whole cluster. A selector
 * written as `matchExpressions` selects a *subset* this column cannot spell
 * in one line. And a policy with no `endpointSelector` at all has not said
 * nothing: it has said it somewhere this app cannot see — `nodeSelector` on
 * a host policy, or inside a `specs:` list.
 */
export type Selection =
  | { kind: "all" }
  | { kind: "labels"; said: string; andExpressions: number }
  /** Narrower than everything, and not sayable in a cell. */
  | { kind: "expressions"; count: number }
  /** Not on the wire. Never "everything". */
  | { kind: "notHere" };

export function selectionOf(policy: CustomResourceInfo): Selection {
  if (!specIsHere(policy)) return { kind: "notHere" };
  const selector = getValueByPath(policy, "spec.endpointSelector");
  if (typeof selector !== "object" || selector === null) {
    return { kind: "notHere" };
  }
  const labels = getValueByPath(policy, "spec.endpointSelector.matchLabels") as
    Record<string, string> | undefined;
  const expressions = getValueByPath(
    policy,
    "spec.endpointSelector.matchExpressions"
  );
  const extra = Array.isArray(expressions) ? expressions.length : 0;
  const pairs = Object.entries(labels ?? {});
  if (pairs.length > 0) {
    return {
      kind: "labels",
      said: pairs.map(([key, value]) => `${key}=${value}`).join(", "),
      andExpressions: extra,
    };
  }
  if (extra > 0) return { kind: "expressions", count: extra };
  return { kind: "all" };
}

/**
 * The entities that are outside the cluster. The rest of Cilium's list —
 * `cluster`, `host`, `remote-node`, `kube-apiserver`, `health`, `init`,
 * `unmanaged`, `none` — name things inside it, and a rule about them is not
 * a rule that leaves.
 */
const OUTSIDE = new Set(["world", "all"]);

/** Whether the policy reaches outside the cluster, where that is readable. */
export function leavesTheCluster(policy: CustomResourceInfo): boolean | null {
  if (!specIsHere(policy)) return null;
  // Deny counts: a rule about `world` is about traffic leaving whether it
  // permits it or forbids it, and the column says where, not whether.
  const rules = ["spec.egress", "spec.egressDeny"].flatMap((path) => {
    const at = getValueByPath(policy, path);
    return Array.isArray(at) ? at : [];
  });
  return rules.some((rule) => {
    const at = (rule ?? {}) as Record<string, unknown>;
    if (
      Array.isArray(at.toFQDNs) ||
      Array.isArray(at.toCIDR) ||
      Array.isArray(at.toCIDRSet)
    ) {
      return true;
    }
    return (
      Array.isArray(at.toEntities) &&
      at.toEntities.some(
        (entity) => typeof entity === "string" && OUTSIDE.has(entity)
      )
    );
  });
}
