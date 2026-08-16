/**
 * GKE's answer to "which hostnames reach this Service, and over what".
 *
 * Written for a question that is not about GKE at all: an in-cluster proxy
 * asking whether anything in front of it already holds the certificate. The
 * ordinary managed-cluster shape is a Google load balancer terminating TLS
 * and forwarding plaintext to Traefik's `web:80` — and every page that could
 * only see `spec.tls` called that "served in the clear" on every host at
 * once, which is how a reader learns to stop reading a warning about
 * encryption.
 *
 * GKE is exactly the vendor that cannot be read from `spec.tls`: its
 * certificate is usually a `ManagedCertificate` named in an annotation, or
 * one uploaded to Google and named by a string. So this is what the seam is
 * for — the proxy asks for the power and never learns who answered.
 */

import type { ServiceRoute } from "../registry";
import { covers } from "@/lib/certificates";
import { fetchIngressSources } from "./data";
import {
  certificateDomains,
  certificateStatusOf,
  gceClassOf,
  managedCertificateRefs,
  preSharedCerts,
} from "./model";
import type { CustomResourceInfo, IngressInfo } from "@/generated/types";

/**
 * Whether this Ingress terminates TLS for that host, or `null` where the
 * objects do not settle it.
 *
 * The unsettled cases are real and are not guesses either way. A
 * `ManagedCertificate` that is not yet `Active` is not terminating anything
 * *now* and may be minutes from doing so; a pre-shared certificate is a name
 * in an annotation and Google holds the domains, so nothing in this cluster
 * says which hosts it covers.
 */
function terminates(
  ingress: IngressInfo,
  host: string,
  certificates: CustomResourceInfo[]
): boolean | null {
  if (
    ingress.hasCatchAllTls ||
    covers(ingress.tlsHosts, host) ||
    ingress.tlsConfigs.some((config) => covers(config.hosts, host))
  ) {
    return true;
  }

  const named = managedCertificateRefs(ingress.annotations);
  let pending = false;
  for (const name of named) {
    const found = certificates.find(
      (candidate) =>
        candidate.name === name && candidate.namespace === ingress.namespace
    );
    if (!found) continue;
    if (!covers(certificateDomains(found), host)) continue;
    if (certificateStatusOf(found) === "Active") return true;
    pending = true;
  }
  if (pending) return null;
  if (preSharedCerts(ingress.annotations).length > 0) return null;
  return false;
}

export async function serviceRoutes(input: {
  namespace: string;
  name: string;
}): Promise<ServiceRoute[]> {
  const sources = await fetchIngressSources();
  const found = new Map<string, ServiceRoute>();

  for (const ingress of sources.ingresses) {
    if (gceClassOf(ingress.annotations) === null) continue;
    if (ingress.namespace !== input.namespace) continue;
    for (const rule of ingress.rules) {
      const host = rule.host;
      // A rule with no host answers on the load balancer's address, and there
      // is no name to hand anybody.
      if (!host) continue;
      for (const path of rule.paths) {
        if (path.backendService !== input.name) continue;
        const key = `${host}${path.path || "/"}`;
        const tls = terminates(ingress, host, sources.managedCertificates);
        const already = found.get(key);
        // Two Ingresses on one host and path: if either terminates TLS, a
        // client that asks for it gets it.
        if (already && already.tls === true) continue;
        found.set(key, {
          host,
          path: path.path || "/",
          tls,
          source: {
            kind: "Ingress",
            name: ingress.name,
            namespace: ingress.namespace,
          },
        });
      }
    }
  }

  return [...found.values()].sort(
    (left, right) =>
      left.host.localeCompare(right.host) || left.path.localeCompare(right.path)
  );
}
