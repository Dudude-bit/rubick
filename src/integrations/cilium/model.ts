/**
 * What a Cilium policy says, read from the object rather than from its name.
 *
 * The one fact a vanilla list of these cannot give: **a policy Cilium
 * rejected is still an object.** It has a name, an age and a spec; it
 * enforces nothing, and the only place that is written down is a condition
 * inside its status. A reader looking at a list of four policies over a
 * namespace they believe is locked down has no way to tell that one of them
 * is a typo the agent threw away.
 */

import type { CustomResourceInfo } from "@/generated/types";
import { conditionOf, getValueByPath } from "../kit";

/** Whether the agent accepted this policy, and what it said if it did not. */
export type Enforcement =
  | { state: "enforced" }
  | { state: "rejected"; why: string | null }
  /**
   * The agent has not answered about this policy yet, which is not the same
   * as it having accepted one. A policy written a second ago and a policy
   * the agent is not running both look like this.
   */
  | { state: "notSaid" };

export function enforcementOf(policy: CustomResourceInfo): Enforcement {
  const valid = conditionOf(policy, "Valid");
  if (!valid) return { state: "notSaid" };
  if (valid.status === "True") return { state: "enforced" };
  return { state: "rejected", why: valid.message ?? null };
}

/** Which way a rule runs, and whether it allows or denies. */
export interface Directions {
  ingress: number;
  egress: number;
  /** Deny rules are counted apart: one changes what every allow above means. */
  denies: number;
}

export function directionsOf(policy: CustomResourceInfo): Directions {
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
 * Three answers, not two. An **empty** selector is Cilium's "every endpoint
 * in scope" — on a cluster-wide policy, the whole cluster, and the widest
 * thing this app can be asked to draw. A selector written as
 * `matchExpressions` selects a *subset* this column cannot spell in one
 * line, and saying "everything" about it would be the widest claim in the
 * app made about the narrowest policy.
 */
export type Selection =
  | { kind: "all" }
  | { kind: "labels"; said: string }
  /** Narrower than everything, and not sayable in a cell. */
  | { kind: "expressions"; count: number };

export function selectionOf(policy: CustomResourceInfo): Selection {
  const labels = getValueByPath(policy, "spec.endpointSelector.matchLabels") as
    Record<string, string> | undefined;
  const expressions = getValueByPath(
    policy,
    "spec.endpointSelector.matchExpressions"
  );
  const pairs = Object.entries(labels ?? {});
  if (pairs.length > 0) {
    return {
      kind: "labels",
      said: pairs.map(([key, value]) => `${key}=${value}`).join(", "),
    };
  }
  if (Array.isArray(expressions) && expressions.length > 0) {
    return { kind: "expressions", count: expressions.length };
  }
  return { kind: "all" };
}

/** Whether the policy reaches outside the cluster, which is worth saying. */
export function leavesTheCluster(policy: CustomResourceInfo): boolean {
  const egress = getValueByPath(policy, "spec.egress");
  if (!Array.isArray(egress)) return false;
  return egress.some((rule) => {
    const at = (key: string) =>
      Array.isArray((rule as Record<string, unknown>)[key]);
    return at("toFQDNs") || at("toCIDR") || at("toCIDRSet") || at("toEntities");
  });
}
