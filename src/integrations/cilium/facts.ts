/**
 * What Cilium is doing for this cluster right now.
 *
 * One line of counts and one finding, and the finding is the only thing here
 * a reader could not have worked out from the CRD list: **a policy the agent
 * rejected is still an object.** It has a name and an age, it appears in
 * every list beside the ones that work, and the namespace it was meant to
 * close is open. Nothing else in the app says so.
 */

import { crdObjectsPath } from "../kit";
import type { VendorFact } from "../registry";
import { fetchPolicies, KINDS } from "./data";
import { enforcementOf } from "./model";

export async function facts(): Promise<VendorFact[]> {
  const { policies, clusterwide } = await fetchPolicies();
  const all = [...policies, ...clusterwide];

  // Counted in our own words, not with the shared `kindCount`: that one
  // pluralises a kind by adding an `s`, which is right for `Gateway` and
  // gives `CiliumNetworkPolicys` here. A kind name is the cluster's to
  // spell, so it is not bent — it is left out of the sentence instead.
  const lines: VendorFact[] = [
    {
      say: [
        { key: "factCiliumPolicies", values: { n: policies.length } },
        { key: "factCiliumClusterwide", values: { n: clusterwide.length } },
      ],
    },
  ];

  const rejected = all.filter(
    (policy) => enforcementOf(policy).state === "rejected"
  );
  if (rejected.length > 0) {
    lines.push({
      say: { key: "factCiliumRejected", values: { n: rejected.length } },
      tone: "err",
      to: crdObjectsPath(KINDS.policies),
    });
    return lines;
  }

  // Said apart from "none rejected": a cluster the app could not read a
  // policy from has nothing to be reassured about, and the count above
  // already says there are none.
  const unanswered = all.filter(
    (policy) => enforcementOf(policy).state === "notSaid"
  );
  if (unanswered.length > 0) {
    lines.push({
      say: { key: "factCiliumUnanswered", values: { n: unanswered.length } },
      tone: "warn",
      to: crdObjectsPath(KINDS.policies),
    });
  }

  return lines;
}
