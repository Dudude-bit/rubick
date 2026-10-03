/**
 * What Cilium is doing for this cluster right now.
 *
 * Counts, then the findings, then the way in — three kinds of line, in that
 * order, and the middle one is the only thing here a reader could not have
 * worked out from the CRD list: **a policy the operator rejected is still an
 * object.** It has a name and an age, it appears in every list beside the
 * ones that work, and the namespace it was meant to close is open.
 */

import { integrationPagePath } from "../paths";
import type { VendorFact } from "../registry";
import { fetchPolicies } from "./data";
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
  const unanswered = all.filter(
    (policy) => enforcementOf(policy).state === "notSaid"
  );

  // Both, never one instead of the other: a cluster with a rejected policy
  // can perfectly well also have one nobody has answered about, and dropping
  // the second because the first exists hides the quieter of the two.
  if (rejected.length > 0) {
    lines.push({
      say: { key: "factCiliumRejected", values: { n: rejected.length } },
      tone: "err",
    });
  }
  if (unanswered.length > 0) {
    lines.push({
      say: { key: "factCiliumUnanswered", values: { n: unanswered.length } },
      tone: "warn",
    });
  }

  // The link is its own line. A fact carrying both a tone and a `to` is
  // drawn by `IntegrationsCatalog` as a plain blue link and its tone is
  // dropped — so the finding this vendor exists for was blue rather than
  // red. Istio and Traefik split them for the same reason.
  if (all.length > 0) {
    lines.push({
      say: { key: "factShowThem" },
      to: integrationPagePath("cilium"),
    });
  }

  return lines;
}
