/**
 * Whether an AGIC Ingress serves a host over TLS.
 *
 * The Application Gateway Ingress Controller reads `spec.tls`, and also — and
 * in preference to it — a certificate already installed on the Application
 * Gateway and named in an annotation. The docs are explicit that the
 * annotation is *ignored* when `spec.tls` is present, which makes the two
 * mutually exclusive rather than additive: an Ingress with the annotation and
 * no `spec.tls` is the ordinary AGIC shape, and it read as plain HTTP
 * everywhere in this app.
 */

import { commands } from "@/lib/commands";
import type { IngressTls } from "../registry";

const PREFIX = "appgw.ingress.kubernetes.io/";
const SSL_CERTIFICATE = `${PREFIX}appgw-ssl-certificate`;
const SSL_REDIRECT = `${PREFIX}ssl-redirect`;
const INGRESS_CLASS_ANNOTATION = "kubernetes.io/ingress.class";

/** What AGIC requires on an Ingress before it will look at it at all. */
const AGIC_CLASS = "azure/application-gateway";

export function claimsIngress(ingress: {
  className: string | null;
  annotations: Record<string, string>;
}): boolean {
  return (
    ingress.annotations[INGRESS_CLASS_ANNOTATION] === AGIC_CLASS ||
    ingress.className === AGIC_CLASS
  );
}

export async function ingressTls(
  wanted: Array<{ namespace: string; name: string; hosts: string[] }>
): Promise<IngressTls[][]> {
  // One `get` per Ingress the caller named, and never one per host. A list
  // page asks for every row at once; a detail page asks for one.
  return Promise.all(wanted.map((input) => answerFor(input).catch(() => [])));
}

async function answerFor(input: {
  namespace: string;
  name: string;
  hosts: string[];
}): Promise<IngressTls[]> {
  const ingress = await commands.getIngress(input.name, input.namespace);
  if (!claimsIngress(ingress)) return [];

  const certificate = ingress.annotations[SSL_CERTIFICATE];
  if (certificate !== undefined && certificate !== "") {
    return input.hosts.map((host) => ({
      host,
      terminated: true,
      by: {
        key: "azureCertOnGateway",
        values: { name: certificate },
      },
    }));
  }
  // A redirect to HTTPS is only ever created beside a listener to redirect
  // to, so it is evidence of one — but of a listener, not of which
  // certificate, which is why nothing is named.
  if (ingress.annotations[SSL_REDIRECT] === "true") {
    return input.hosts.map((host) => ({
      host,
      terminated: true,
      by: { key: "azureSomeCertOnGateway" },
    }));
  }
  return [];
}
