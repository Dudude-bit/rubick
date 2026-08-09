import { commands } from "@/lib/commands";
import { defineVendor } from "../registry";
import { crd } from "./crd";

/**
 * cert-manager.
 *
 * Tier two: detected, never configured. Its CRDs exist in the API server or
 * they do not, and that is a fact with a yes or a no — no address, no
 * credential, nothing to fill in and nothing guessed. So there is no config
 * form here and no Connect button anywhere.
 *
 * Note what it does *not* provide: the expiry date. `tls.crt` states that
 * itself, the app reads it on any cluster, and putting it behind this would
 * gate the free half of the value on an install.
 *
 * Two facets, and they answer to different rules. `provides` is gated on
 * the backend's CRD scan, because a capability that answered on a cluster
 * without cert-manager would fail at runtime on every request. `crd` is
 * not: a `cert-manager.io` list page can only be reached when the group
 * exists, so the group *is* the detection.
 */
export default defineVendor({
  id: "cert-manager",
  name: "cert-manager",
  gives: "why a certificate has not renewed, from the object that failed",
  provides: {
    "certificate.issuance": ({ namespace, secretName }) =>
      commands.getCertificateIssuance(namespace, secretName),
  },
  crd,
});
