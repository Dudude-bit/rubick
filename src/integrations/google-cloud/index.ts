import { ShieldCheck } from "lucide-react";

import { defineVendor } from "../registry";
import { crd } from "./crd";
import { facts } from "./facts";
import { serviceEdge } from "./edge";
import { mark } from "./mark";

/**
 * GKE's Ingress stack — tier two, and a second record on purpose.
 *
 * It is deliberately not a facet of the Google Cloud record below, and the
 * reason is the one Settings states out loud: a cluster cannot fail to be on
 * GKE, so "Google Cloud · not installed" is nonsense, and only a vendor
 * declaring an {@link Extension} gets a row. What *can* be absent is the
 * controllers — a GKE cluster with HTTP load balancing turned off has no
 * `BackendConfig` CRD, and every other cluster in the world has none either.
 * So the row names what was actually looked for.
 *
 * Two upstream controllers under one row, because they are installed and
 * turned off together and neither is a product anybody thinks of separately:
 * ingress-gce owns `BackendConfig` and `FrontendConfig`, gke-managed-certs
 * owns `ManagedCertificate`. Same folder as the tier-one record, because
 * "where does GKE's knowledge live" must have exactly one answer.
 *
 * No page, and that is a decision rather than an omission. A page earns
 * itself by owning a topology no core object can host — which is what
 * Traefik's and Istio's hosts are. A list of BackendConfigs is not a
 * topology; every one of these objects is a property of a Service or an
 * Ingress that already has a page, and the two facets below put them there.
 */
export const gkeIngress = defineVendor({
  id: "gke-ingress",
  name: "GKE Ingress",
  extension: {
    gives:
      "what a GKE load balancer was told, and which domains a Google-managed certificate is stuck on",
    icon: ShieldCheck,
    facts,
  },
  provides: { "service.edge": serviceEdge },
  crd,
});

/**
 * Google Cloud — GKE.
 *
 * Tier one: every fact here is already on the node, in a label GKE writes
 * whether anyone asked or not, and reading it needs no account, no scope and
 * no detection. A cluster we could not authenticate to at all still says all
 * of this about itself.
 */
export default defineVendor({
  id: "google-cloud",
  name: "Google Cloud",
  flavours: [
    {
      id: "gke",
      claims: (name, hasWord) => name.startsWith("gke_") || hasWord("gke"),
      label: "GKE",
      nameSeparator: "_",
      mark,
    },
  ],
  nodeLabels: {
    pool: ["cloud.google.com/gke-nodepool"],
    spot: [
      ["cloud.google.com/gke-spot", "true"],
      // Preemptible predates Spot on GKE and is still what an older pool wears.
      ["cloud.google.com/gke-preemptible", "true"],
      // The label that replaced both of the above from GKE 1.25.5-gke.2500.
      ["cloud.google.com/gke-provisioning", "spot"],
      ["cloud.google.com/gke-provisioning", "preemptible"],
    ],
    providerScheme: ["gce", "Google Cloud"],
  },
});
