/**
 * Whether a GKE Ingress serves a host over TLS.
 *
 * `spec.tls` is the one place GKE's certificate usually is not: a
 * `ManagedCertificate` is named in an annotation and holds its domains in
 * its own spec, and a pre-shared certificate is a name whose domains live in
 * Google. Both are invisible to every surface that reads `spec.tls`, which is
 * all of the core ones.
 */

import { covers } from "@/lib/certificates";
import type { IngressTls } from "../registry";
import { fetchIngressSources } from "./data";
import {
  certificateDomains,
  certificateStatusOf,
  gceClassOf,
  managedCertificateRefs,
  preSharedCerts,
} from "./model";

export async function ingressTls(
  wanted: Array<{ namespace: string; name: string; hosts: string[] }>
): Promise<IngressTls[][]> {
  // One read for the whole list, which is what the positional contract buys.
  const sources = await fetchIngressSources();
  return wanted.map((input) => answerFor(input, sources));
}

function answerFor(
  input: { namespace: string; name: string; hosts: string[] },
  sources: Awaited<ReturnType<typeof fetchIngressSources>>
): IngressTls[] {
  const ingress = sources.ingresses.find(
    (candidate) =>
      candidate.name === input.name && candidate.namespace === input.namespace
  );
  // Not GKE's Ingress, so GKE has no opinion about it — which is different
  // from saying it is served in the clear.
  if (!ingress || gceClassOf(ingress.annotations) === null) return [];

  const named = managedCertificateRefs(ingress.annotations);
  const preShared = preSharedCerts(ingress.annotations);

  return input.hosts.flatMap((host): IngressTls[] => {
    for (const name of named) {
      const found = sources.managedCertificates.find(
        (candidate) =>
          candidate.name === name && candidate.namespace === ingress.namespace
      );
      if (!found || !covers(certificateDomains(found), host)) continue;
      // A certificate that is not yet `Active` terminates nothing today, and
      // saying it does would put an https:// link in front of a connection
      // that is refused. Silence, so `spec.tls` keeps the last word.
      if (certificateStatusOf(found) !== "Active") return [];
      return [
        {
          host,
          terminated: true,
          by: { key: "verbatimLine", values: { said: name } },
        },
      ];
    }
    // Google holds the domains of a pre-shared certificate, so nothing in
    // this cluster says which hosts it covers — but an Ingress carrying one
    // is serving HTTPS, and that much is stated.
    if (preShared.length > 0) {
      return [
        {
          host,
          terminated: true,
          by: {
            key: "verbatimLine",
            values: { said: preShared.join(", ") },
          },
        },
      ];
    }
    return [];
  });
}
