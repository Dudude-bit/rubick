import { ShieldCheck } from "lucide-react";

import { defineVendor, pageCount } from "../registry";
import { ROUTING_STALE } from "../ingress";
import { crd } from "./crd";
import { fetchIngressSources, INGRESS_SOURCES_KEY } from "./data";
import { facts } from "./facts";
import { serviceEdge } from "./edge";
import { serviceRoutes } from "./service-routes";
import { ingressTls } from "./ingress-tls";
import { mark } from "./mark";
import { countHosts } from "./routes";

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
 * It earns a page on the same grounds Traefik does, and this record used to
 * argue the opposite: that a list of BackendConfigs is not a topology and
 * every one of these objects is a property of something that already has a
 * page. That was written without looking at how they are attached. Each one
 * is joined to the routing table by an *annotation* — `FrontendConfig` and
 * `ManagedCertificate` to the Ingress, `BackendConfig` and the NEG opt-in to
 * the Service — and **host → what terminates it → what answers it** is not a
 * property of any single object. The consequence of not drawing it was
 * concrete: a `ManagedCertificate` stuck on `FailedNotVisible` sat on a list
 * page with no way of saying which hostname it was for.
 */
export const gkeIngress = defineVendor({
  id: "gke-ingress",
  name: "GKE Ingress",
  extension: {
    gives: "googleCloudGives",
    icon: ShieldCheck,
    facts,
  },
  // The second one is asked *about GKE by somebody else*: an in-cluster
  // proxy checking whether the load balancer in front of it already holds the
  // certificate. Its answer lives in an annotation, so no amount of reading
  // `spec.tls` finds it — see `./service-routes`.
  provides: {
    "service.edge": serviceEdge,
    "service.routes": serviceRoutes,
    "ingress.tls": ingressTls,
  },
  page: {
    count: pageCount({
      queryKey: INGRESS_SOURCES_KEY,
      queryFn: fetchIngressSources,
      select: (sources) => countHosts(sources.ingresses),
      staleTime: ROUTING_STALE,
    }),
    load: () => import("./page"),
  },
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
