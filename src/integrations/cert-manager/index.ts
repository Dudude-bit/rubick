import { commands } from "@/lib/commands";
import { defineIntegration } from "../registry";

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
 */
export default defineIntegration({
  id: "cert-manager",
  name: "cert-manager",
  gives: "why a certificate has not renewed, from the object that failed",
  provides: {
    "certificate.issuance": ({ namespace, secretName }) =>
      commands.getCertificateIssuance(namespace, secretName),
  },
});
