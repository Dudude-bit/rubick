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
import { labelSelectorMatches, type LabelSelector } from "@/lib/label-selector";
import { getValueByPath } from "../kit";
import { enforcementOf, selectsNodes } from "./model";

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
