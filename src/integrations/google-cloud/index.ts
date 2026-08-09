import { defineVendor } from "../registry";
import { mark } from "./mark";

/**
 * Google Cloud — GKE.
 *
 * Tier one and nothing else: every fact here is already on the node, in a
 * label GKE writes whether anyone asked or not, and reading it needs no
 * account, no scope and no detection. A cluster we could not authenticate
 * to at all still says all of this about itself.
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
