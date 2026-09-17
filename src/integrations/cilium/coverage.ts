/**
 * Which endpoints a policy actually selects, and — the question nobody else
 * in this app can answer — which endpoints no policy selects at all.
 *
 * A `CiliumNetworkPolicy` names labels; a `CiliumEndpoint` carries the
 * labels Cilium itself resolved for a pod. Joining the two is the only way
 * to turn "there are four policies" into "this pod is covered by two of
 * them, and that one by none". A vanilla list of either side cannot say it.
 *
 * **Three verdicts, and the third is the reason for the page.** An endpoint
 * no policy selects is unrestricted, which is a fact. An endpoint selected
 * only by policies the operator threw away *looks* covered — the policies
 * exist, they name it, and they enforce nothing. And an endpoint this app
 * could not decide about, because a policy's rules are not on the wire,
 * says so rather than being counted as either.
 */

import type { CustomResourceInfo } from "@/generated/types";
import { getValueByPath } from "../kit";
import { enforcementOf } from "./model";

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

interface Expression {
  key: string;
  operator: string;
  values?: string[];
}

function expressionHolds(
  expression: Expression,
  labels: Map<string, string>
): boolean {
  const has = labels.has(expression.key);
  const value = labels.get(expression.key);
  const listed = expression.values ?? [];
  switch (expression.operator) {
    case "Exists":
      return has;
    case "DoesNotExist":
      return !has;
    case "In":
      return has && listed.includes(value as string);
    case "NotIn":
      return !has || !listed.includes(value as string);
    default:
      // An operator this app does not know is not one it may guess at.
      return false;
  }
}

/**
 * Whether a selector picks these labels, or `null` where the selector cannot
 * be evaluated — an operator we do not implement, so the answer is unknown
 * rather than "no".
 */
export function selects(
  selector: unknown,
  labels: Map<string, string>
): boolean | null {
  if (typeof selector !== "object" || selector === null) return null;
  const record = selector as Record<string, unknown>;
  const matchLabels = (record.matchLabels ?? {}) as Record<string, string>;
  for (const [key, value] of Object.entries(matchLabels)) {
    if (labels.get(key) !== value) return false;
  }
  const expressions = Array.isArray(record.matchExpressions)
    ? (record.matchExpressions as Expression[])
    : [];
  for (const expression of expressions) {
    if (
      !["Exists", "DoesNotExist", "In", "NotIn"].includes(expression.operator)
    )
      return null;
    if (!expressionHolds(expression, labels)) return false;
  }
  return true;
}

/** What a policy does for one endpoint. */
export interface Selecting {
  policy: CustomResourceInfo;
  /** Cluster-wide policies select across namespaces; namespaced ones do not. */
  clusterwide: boolean;
  enforcing: boolean;
}

export interface Coverage {
  endpoint: CustomResourceInfo;
  selecting: Selecting[];
  /**
   * A policy that selects this endpoint, or might, and could not be read —
   * its rules are written where this app cannot see them. One of these makes
   * every "no policy selects it" below a guess.
   */
  unreadable: number;
  verdict: "covered" | "onlyRejected" | "unrestricted" | "cannotSay";
}

export function coverageOf(
  endpoints: CustomResourceInfo[],
  policies: CustomResourceInfo[],
  clusterwide: CustomResourceInfo[]
): Coverage[] {
  return endpoints.map((endpoint) => {
    const labels = labelsOf(endpoint);
    const selecting: Selecting[] = [];
    let unreadable = 0;

    const consider = (policy: CustomResourceInfo, isClusterwide: boolean) => {
      if (!isClusterwide && policy.namespace !== endpoint.namespace) return;
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
        policy,
        clusterwide: isClusterwide,
        enforcing: enforcementOf(policy).state === "accepted",
      });
    };

    for (const policy of policies) consider(policy, false);
    for (const policy of clusterwide) consider(policy, true);

    const enforcing = selecting.filter((one) => one.enforcing);
    const verdict: Coverage["verdict"] =
      enforcing.length > 0
        ? "covered"
        : // Only after the enforcing ones: a policy that works beside one
          // that was rejected still covers the endpoint.
          unreadable > 0
          ? "cannotSay"
          : selecting.length > 0
            ? "onlyRejected"
            : "unrestricted";

    return { endpoint, selecting, unreadable, verdict };
  });
}
